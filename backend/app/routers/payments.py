"""Build a UPI payment QR for a computed cart total (pre-order, pay-first flow)."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..config import settings
from ..schemas.models import QuoteRequest
from ..services.pricing import price_cart
from ..services.upi import build_upi_uri, build_qr_data_url

router = APIRouter(prefix="/api/payments", tags=["payments"])


@router.post("/upi-qr")
def upi_qr(body: QuoteRequest):
    """Return a UPI intent link + QR image for the cart's current total."""
    priced = price_cart([c.model_dump() for c in body.cart], body.order_type,
                        body.coupon_code, body.delivery_area_id)
    if body.order_type == "delivery" and priced.delivery_area_required:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please select your delivery area.")
    if priced.total <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to pay for.")
    note = f"{settings.app_name} order"
    uri = build_upi_uri(priced.total, note)
    return {
        "amount": round(priced.total, 2),
        "upi_uri": uri,
        "qr_data_url": build_qr_data_url(uri),
        "payee": settings.upi_payee_name,
        "vpa": settings.upi_vpa,
    }
