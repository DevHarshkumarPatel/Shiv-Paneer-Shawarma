"""Customer-facing order creation and public tracking."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..models import Order, Setting
from ..schemas.models import CreateOrderRequest, QuoteRequest
from ..services.orders import persist_order, price_or_reject
from ..services.pricing import price_cart
from ..services.upi import build_upi_uri, build_qr_data_url
from ..config import settings

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("/quote")
def quote(body: QuoteRequest):
    """Live price preview (subtotal, promos, coupon, delivery)."""
    result = price_cart([c.model_dump() for c in body.cart], body.order_type,
                        body.coupon_code, body.delivery_area_id, body.phone)
    return result.to_dict()


@router.post("")
def create_order(body: CreateOrderRequest):
    # Owner master switch: when ordering is turned off, reject new orders.
    if not Setting.singleton().ordering_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Online ordering is currently closed. Please try again later.")
    if body.order_type not in ("dine_in", "takeaway", "delivery"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid order type")

    priced = price_or_reject(
        [c.model_dump() for c in body.cart], body.order_type, body.coupon_code,
        body.delivery_area_id, body.customer.phone,
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
        priced, order_type=body.order_type, customer=body.customer, notes=body.notes,
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
