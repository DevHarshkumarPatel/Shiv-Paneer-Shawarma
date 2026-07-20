"""Customer-facing order creation and public tracking."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..models import (
    Order, OrderItem, CustomerInfo, PaymentInfo, StatusEvent, Coupon, Setting,
)
from ..schemas.models import CreateOrderRequest, QuoteRequest
from ..services.order_ids import generate_order_id
from ..services.pricing import price_cart
from ..services.upi import build_upi_uri, build_qr_data_url
from ..config import settings

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("/quote")
def quote(body: QuoteRequest):
    """Live price preview (subtotal, promos, coupon, delivery)."""
    result = price_cart([c.model_dump() for c in body.cart], body.order_type,
                        body.coupon_code, body.delivery_area_id)
    return result.to_dict()


@router.post("")
def create_order(body: CreateOrderRequest):
    # Owner master switch: when ordering is turned off, reject new orders.
    if not Setting.singleton().ordering_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Online ordering is currently closed. Please try again later.")
    if body.order_type not in ("dine_in", "takeaway", "delivery"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid order type")

    priced = price_cart(
        [c.model_dump() for c in body.cart], body.order_type, body.coupon_code,
        body.delivery_area_id,
    )
    if not priced.lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your cart is empty or items are unavailable.")

    # Delivery requires a selected area, an address + a paid-upfront UPI payment.
    if body.order_type == "delivery":
        if priced.delivery_area_required:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please select your delivery area.")
        if not (body.customer.address and body.customer.name and body.customer.phone):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Delivery needs name, phone and address.")
        if body.payment_method != "upi":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Delivery orders must be paid online (UPI).")
        if not body.upi_reference.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enter the UPI reference after paying.")

    # Payment status: UPI with a reference -> awaiting verification; cash -> pending.
    if body.payment_method == "upi":
        pay_status = "awaiting_verification" if body.upi_reference.strip() else "pending"
    else:
        pay_status = "pending"

    order = Order(
        public_id=generate_order_id(),
        order_type=body.order_type,
        items=[
            OrderItem(
                item_id=l.item_id, name=l.name, variant_label=l.variant_label,
                base=l.base, size=l.size, unit_price=l.unit_price, quantity=l.quantity,
                free_quantity=l.free_quantity, line_total=round(l.line_total, 2),
            )
            for l in priced.lines
        ],
        customer=CustomerInfo(
            name=body.customer.name, phone=body.customer.phone,
            address=body.customer.address, lat=body.customer.lat, lng=body.customer.lng,
        ),
        payment=PaymentInfo(
            method=body.payment_method, status=pay_status,
            upi_reference=body.upi_reference.strip(), amount=round(priced.total, 2),
        ),
        subtotal=round(priced.subtotal, 2),
        promo_discount=round(priced.promo_discount, 2),
        coupon_code=priced.coupon_code,
        coupon_discount=round(priced.coupon_discount, 2),
        delivery_fee=round(priced.delivery_fee, 2),
        delivery_area=priced.delivery_area_name,
        total=round(priced.total, 2),
        status="placed",
        history=[StatusEvent(status="placed", by="customer")],
        notes=body.notes,
    )
    order.put()

    # Increment coupon usage (best-effort; not transactional across the order).
    if priced.coupon_code:
        coupon = Coupon.by_code(priced.coupon_code)
        if coupon:
            coupon.used_count += 1
            coupon.put()

    return order.to_dict()


@router.get("/{public_id}")
def get_order(public_id: str):
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found. Check the order id.")
    return order.to_dict()


@router.get("/{public_id}/payment")
def order_payment(public_id: str):
    """Return a UPI QR + intent link for paying an order's total."""
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    note = f"{settings.app_name} {order.public_id}"
    uri = build_upi_uri(order.total, note, order.public_id)
    return {
        "public_id": order.public_id,
        "amount": order.total,
        "upi_uri": uri,
        "qr_data_url": build_qr_data_url(uri),
        "payee": settings.upi_payee_name,
        "vpa": settings.upi_vpa,
    }
