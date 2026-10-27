"""Customer-facing order creation and public tracking."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..models import Branch, Order
from ..schemas.models import CreateOrderRequest, QuoteRequest
from ..services.branches import public_branch
from ..services.orders import persist_order, price_or_reject
from ..services.pricing import price_cart
from ..services.upi import build_upi_uri, build_qr_data_url, merchant
from ..config import settings

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("/quote")
def quote(body: QuoteRequest, branch: str = ""):
    """Live price preview (subtotal, promos, add-ons, coupon, delivery).

    Add-ons are priced here because the counter screen previews its ticket
    through this endpoint. Quoting one costs nothing and creates nothing — only
    the staff order endpoints accept topups on an order that gets written.

    `branch` prices the cart as that branch sells it. The counter screen sends
    its own branch here too; that is only a preview — the order it then writes
    is priced at the branch on the staff member's login, whatever this said.
    """
    result = price_cart([c.model_dump() for c in body.cart], body.order_type,
                        body.coupon_code, body.delivery_area_id, body.phone,
                        [t.model_dump() for t in body.topups], public_branch(branch))
    return result.to_dict()


@router.post("")
def create_order(body: CreateOrderRequest, branch: str = ""):
    # Owner switch, per branch: one kitchen closing early closes only itself.
    outlet = public_branch(branch)
    if outlet.ordering_enabled is False:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            f"Online ordering at {outlet.name} is currently closed. Please try again later.")
    if body.order_type not in ("dine_in", "takeaway", "delivery"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid order type")

    priced = price_or_reject(
        [c.model_dump() for c in body.cart], body.order_type, body.coupon_code,
        body.delivery_area_id, body.customer.phone, branch=outlet,
    )

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

    order = persist_order(
        priced, branch=outlet, order_type=body.order_type, customer=body.customer, notes=body.notes,
        payment_method=body.payment_method, payment_status=pay_status,
        upi_reference=body.upi_reference, by="customer", channel="online",
    )
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
    # Paid into the branch that took the order, not wherever the bill is
    # being reprinted from.
    outlet = (Branch.get_by_id(order.branch_id) if order.branch_id else None) or Branch.main()
    note = f"{settings.app_name} {order.public_id}"
    uri = build_upi_uri(order.total, note, order.public_id, outlet)
    m = merchant(outlet)
    return {
        "public_id": order.public_id,
        "amount": order.total,
        "upi_uri": uri,
        "qr_data_url": build_qr_data_url(uri),
        "payee": m["payee"],
        "vpa": m["vpa"],
    }
