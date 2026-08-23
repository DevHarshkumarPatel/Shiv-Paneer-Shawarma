"""Public coupon validation + owner coupon management."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Coupon, Promo
from ..schemas.models import CouponPayload

router = APIRouter(prefix="/api/coupons", tags=["coupons"])

CTYPES = ("percent", "flat", "promo")


def _clean_promo_ids(raw: list[int]) -> list[int]:
    """Keep the promo ids that still exist, de-duplicated and in order.

    Ids of deleted promos are dropped rather than rejected: the owner should be
    able to save a coupon whose promo someone removed last week, and a dangling
    id would gate nothing anyway.
    """
    out: list[int] = []
    for pid in raw or []:
        pid = int(pid)
        if pid in out:
            continue
        if Promo.get_by_id(pid):
            out.append(pid)
    return out


def _set_gate(pid: int, gated: bool) -> None:
    promo = Promo.get_by_id(pid)
    if promo and promo.coupon_only != gated:
        promo.coupon_only = gated
        promo.put()


def _sync_promo_gates(attached: set[int], released: set[int], ignore_key=None) -> None:
    """Keep `coupon_only` true for exactly those promos some coupon claims.

    Called from the owner screens only; pricing then reads a plain boolean and
    never scans the coupon table on a customer's quote.

    A released promo is re-checked against the other coupons rather than simply
    un-gated — detaching it from one code must not put it back on the open menu
    while a second code still hands it out. That check re-reads each candidate
    by key: the query index may still list the coupon row we just changed or
    deleted, but the entity behind the key is current.
    """
    for pid in attached:
        _set_gate(pid, True)
    for pid in released - attached:
        claimed = False
        for candidate in Coupon.query(Coupon.promo_ids == pid):
            if ignore_key and candidate.key == ignore_key:
                continue
            fresh = candidate.key.get()
            if fresh and pid in (fresh.promo_ids or []):
                claimed = True
                break
        _set_gate(pid, claimed)


def _validate(body: CouponPayload) -> tuple[str, list[int]]:
    code = body.code.upper().strip()
    if not code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A coupon code is required.")
    if body.ctype not in CTYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown coupon type.")
    promo_ids = _clean_promo_ids(body.promo_ids)
    # A code that neither takes money off nor unlocks anything would silently do
    # nothing at checkout, which reads as a bug to whoever typed it in.
    if body.ctype == "promo" and not promo_ids:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Pick at least one promo for an offer-only coupon.",
        )
    return code, promo_ids


def _unlocked_promos(coupon: Coupon) -> list[dict]:
    """The promos this code hands out, as the customer-facing summary."""
    out = []
    for pid in coupon.promo_ids or []:
        promo = Promo.get_by_id(pid)
        if promo and promo.active:
            out.append({"id": pid, "label": promo.display_label(), "ptype": promo.ptype})
    return out


@router.get("/validate/{code}")
def validate(code: str):
    coupon = Coupon.by_code(code)
    if not coupon:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coupon not found.")
    ok, reason = coupon.is_valid_now()
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, reason)
    return {**coupon.to_dict(), "promos": _unlocked_promos(coupon)}


# ---- Owner management ----
@router.get("")
def list_coupons(_owner=Depends(require_owner)):
    """The owner's own coupons.

    Codes minted by the scratch card are excluded: there is one per winner, so
    within a busy month they would bury the handful of codes the owner actually
    manages. They are reported on the scratch card screen instead.
    """
    return {"coupons": [c.to_dict() for c in Coupon.query() if c.source != "scratch"]}


@router.post("")
def create_coupon(body: CouponPayload, _owner=Depends(require_owner)):
    code, promo_ids = _validate(body)
    if Coupon.by_code(code):
        raise HTTPException(status.HTTP_409_CONFLICT, "A coupon with this code already exists.")
    coupon = Coupon(
        code=code, ctype=body.ctype,
        value=0.0 if body.ctype == "promo" else body.value,
        min_order=body.min_order,
        max_discount=body.max_discount, active=body.active, usage_limit=body.usage_limit,
        promo_ids=promo_ids,
    )
    coupon.put()
    _sync_promo_gates(set(promo_ids), set())
    return coupon.to_dict()


@router.put("/{coupon_id}")
def update_coupon(coupon_id: int, body: CouponPayload, _owner=Depends(require_owner)):
    coupon = Coupon.get_by_id(coupon_id)
    if not coupon:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coupon not found.")
    code, promo_ids = _validate(body)
    was = set(coupon.promo_ids or [])
    coupon.code = code
    coupon.ctype = body.ctype
    coupon.value = 0.0 if body.ctype == "promo" else body.value
    coupon.min_order = body.min_order
    coupon.max_discount = body.max_discount
    coupon.active = body.active
    coupon.usage_limit = body.usage_limit
    coupon.promo_ids = promo_ids
    coupon.put()
    now = set(promo_ids)
    _sync_promo_gates(now - was, was - now, ignore_key=coupon.key)
    return coupon.to_dict()


@router.delete("/{coupon_id}")
def delete_coupon(coupon_id: int, _owner=Depends(require_owner)):
    coupon = Coupon.get_by_id(coupon_id)
    if coupon:
        released = set(coupon.promo_ids or [])
        key = coupon.key
        key.delete()
        # Deleting the only code that gated a promo puts that promo back on the
        # menu for everyone, which is the sane reading of "the offer stays, the
        # code is gone" — the owner can switch the promo off if they meant both.
        _sync_promo_gates(set(), released, ignore_key=key)
    return {"ok": True}
