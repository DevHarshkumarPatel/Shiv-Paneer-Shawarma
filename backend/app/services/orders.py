"""Order placement shared by the customer checkout and the staff counter.

Both paths must price a cart, freeze the priced lines onto an order and settle
the coupon/scratch bookkeeping in exactly the same way — an order taken at the
counter is the same bill as one placed online, so it cannot be a second
implementation that drifts. What differs between them (who may order while
online ordering is closed, whether delivery has to be prepaid, whether the
payment is already collected) stays in the routers, which is where the policy
belongs.
"""
from fastapi import HTTPException, status

from ..models import (
    Order, OrderItem, CustomerInfo, PaymentInfo, StatusEvent, Coupon,
)
from ..services.order_ids import generate_order_id
from ..services.phones import norm_phone
from ..services.pricing import PricingResult, price_cart
from ..services.scratch import close_open_awards


def price_or_reject(cart: list[dict], order_type: str, coupon_code: str,
                    delivery_area_id: int, phone: str) -> PricingResult:
    """Price a cart for an order that is about to be placed.

    Refuses rather than quietly placing a short order: a cart lives in
    localStorage (and, at the counter, on a screen someone left open), so
    anything that sold out in the meantime has to be shown before money changes
    hands.
    """
    priced = price_cart(cart, order_type, coupon_code, delivery_area_id, phone)
    if priced.unavailable:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Sold out since you added it: " + ", ".join(u["label"] for u in priced.unavailable)
            + ". Please review your cart and try again.",
        )
    if not priced.lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your cart is empty or items are unavailable.")
    return priced


def persist_order(priced: PricingResult, *, order_type: str, customer, notes: str,
                  payment_method: str, payment_status: str, upi_reference: str,
                  by: str, channel: str = "online", placed_by: str = "",
                  verified_by: str = "") -> Order:
    """Write the priced cart as an order and settle its coupon / scratch card.

    `by` is what the "placed" history event is attributed to ("customer" or the
    staff email); `channel` records where the order came from.
    """
    # Which visit this is for this customer. Counted here rather than derived on
    # read so the number is frozen onto the order, and capped so one regular
    # with a long history can never turn placing an order into an unbounded read.
    phone_key = norm_phone(customer.phone)
    repeat_no = Order.query(Order.phone_key == phone_key).count(limit=1000) + 1 if phone_key else 1

    order = Order(
        public_id=generate_order_id(),
        repeat_no=repeat_no,
        phone_key=phone_key,
        order_type=order_type,
        channel=channel,
        placed_by=placed_by,
        items=[
            OrderItem(
                item_id=l.item_id, name=l.name, variant_label=l.variant_label,
                base=l.base, size=l.size, unit_price=l.unit_price, quantity=l.quantity,
                free_quantity=l.free_quantity, line_total=round(l.line_total, 2),
                promo_label=l.promo_label,
            )
            for l in priced.lines
        ],
        customer=CustomerInfo(
            name=customer.name, phone=customer.phone,
            address=customer.address, lat=customer.lat, lng=customer.lng,
        ),
        payment=PaymentInfo(
            method=payment_method, status=payment_status,
            upi_reference=upi_reference.strip(), amount=round(priced.total, 2),
            verified_by=verified_by,
        ),
        subtotal=round(priced.subtotal, 2),
        promo_discount=round(priced.promo_discount, 2),
        coupon_code=priced.coupon_code,
        coupon_discount=round(priced.coupon_discount, 2),
        delivery_fee=round(priced.delivery_fee, 2),
        delivery_area=priced.delivery_area_name,
        total=round(priced.total, 2),
        status="placed",
        history=[StatusEvent(status="placed", by=by)],
        notes=notes,
    )
    order.put()

    # Increment coupon usage (best-effort; not transactional across the order).
    if priced.coupon_code:
        coupon = Coupon.by_code(priced.coupon_code)
        if coupon:
            coupon.used_count += 1
            coupon.put()

    # Settle this phone's open scratch draw. The card is one per order, so
    # placing the order is exactly what re-arms it for the next one.
    close_open_awards(customer.phone, order.public_id, priced.coupon_code)

    return order
