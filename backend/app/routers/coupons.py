"""Public coupon validation + owner coupon management."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Coupon
from ..schemas.models import CouponPayload

router = APIRouter(prefix="/api/coupons", tags=["coupons"])


@router.get("/validate/{code}")
def validate(code: str):
    coupon = Coupon.by_code(code)
    if not coupon:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coupon not found.")
    ok, reason = coupon.is_valid_now()
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, reason)
    return coupon.to_dict()


# ---- Owner management ----
@router.get("")
def list_coupons(_owner=Depends(require_owner)):
    return {"coupons": [c.to_dict() for c in Coupon.query()]}


@router.post("")
def create_coupon(body: CouponPayload, _owner=Depends(require_owner)):
    code = body.code.upper().strip()
    if Coupon.by_code(code):
        raise HTTPException(status.HTTP_409_CONFLICT, "A coupon with this code already exists.")
    coupon = Coupon(
        code=code, ctype=body.ctype, value=body.value, min_order=body.min_order,
        max_discount=body.max_discount, active=body.active, usage_limit=body.usage_limit,
    )
    coupon.put()
    return coupon.to_dict()


@router.put("/{coupon_id}")
def update_coupon(coupon_id: int, body: CouponPayload, _owner=Depends(require_owner)):
    coupon = Coupon.get_by_id(coupon_id)
    if not coupon:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coupon not found.")
    coupon.code = body.code.upper().strip()
    coupon.ctype = body.ctype
    coupon.value = body.value
    coupon.min_order = body.min_order
    coupon.max_discount = body.max_discount
    coupon.active = body.active
    coupon.usage_limit = body.usage_limit
    coupon.put()
    return coupon.to_dict()


@router.delete("/{coupon_id}")
def delete_coupon(coupon_id: int, _owner=Depends(require_owner)):
    coupon = Coupon.get_by_id(coupon_id)
    if coupon:
        coupon.key.delete()
    return {"ok": True}
