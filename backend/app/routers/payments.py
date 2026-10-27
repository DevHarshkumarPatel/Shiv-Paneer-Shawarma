"""Build a UPI payment QR for a computed cart total (pre-order, pay-first flow)."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..config import settings
from ..schemas.models import QuoteRequest
from ..services.branches import public_branch
from ..services.pricing import price_cart
from ..services.upi import build_upi_uri, build_qr_data_url, merchant

router = APIRouter(prefix="/api/payments", tags=["payments"])


@router.post("/upi-qr")
def upi_qr(body: QuoteRequest, branch: str = ""):
    """Return a UPI intent link + QR image for the cart's current total, paid
    into the chosen branch's own account."""
    outlet = public_branch(branch)
    # The phone goes in so a scratch-card code prices the same here as it will
    # at order creation — otherwise the QR would carry the undiscounted amount.
    priced = price_cart([c.model_dump() for c in body.cart], body.order_type,
                        body.coupon_code, body.delivery_area_id, body.phone,
                        branch=outlet)
    if body.order_type == "delivery" and priced.delivery_area_required:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please select your delivery area.")
    # Never hand out a QR for a cart that order creation is going to refuse.
    # A cart with one live line and one sold-out line still totals more than
    # zero, so the check below does not catch it: the customer would scan, pay,
    # and only then hit the 409 from POST /api/orders — money gone, no order.
    # This mirrors the guard in create_order deliberately; both must agree.
    if priced.unavailable:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Sold out since you added it: " + ", ".join(u["label"] for u in priced.unavailable)
            + ". Please review your cart before paying.",
        )
    if priced.total <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to pay for.")
    note = f"{settings.app_name} order"
    uri = build_upi_uri(priced.total, note, branch=outlet)
    m = merchant(outlet)
    return {
        "amount": round(priced.total, 2),
        "upi_uri": uri,
        "qr_data_url": build_qr_data_url(uri),
        "payee": m["payee"],
        "vpa": m["vpa"],
    }
