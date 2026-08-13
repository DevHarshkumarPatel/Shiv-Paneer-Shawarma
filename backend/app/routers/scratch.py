"""Scratch card: the customer's draw, and the owner's prize pool.

Public side is deliberately thin — a card lookup and a draw, both keyed by the
phone number the customer is already typing into checkout. There is no customer
login to authenticate against, so the protections are structural rather than
identity-based: a phone may hold only one open draw at a time, the pool's own
limits cap the total giveaway, and a won code is bound to the winning phone so
passing it around achieves nothing.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Coupon, ScratchAward, ScratchPrize, Setting
from ..schemas.models import ScratchDrawRequest, ScratchPrizePayload
from ..services.scratch import (
    close_open_awards, coupon_terms, default_label, draw_for_phone, norm_phone,
    reprint_batch,
)

router = APIRouter(tags=["scratch"])


def _pool_is_live() -> bool:
    """A card is only offered when it can actually pay out.

    A pool holding nothing but the "better luck next time" slot is treated as
    empty: a card that cannot win is worse than no card, because the customer
    scratches a guaranteed loss on the way to paying.
    """
    if not Setting.singleton().scratch_enabled:
        return False
    return any(p.kind == "coupon" and p.is_drawable() for p in ScratchPrize.query())


# ---------------- Customer ----------------
@router.get("/api/scratch/card")
def get_card(phone: str = ""):
    """What to show at checkout for this phone: nothing, a fresh card, or the
    card they already scratched and have not yet spent."""
    if not _pool_is_live():
        return {"enabled": False, "state": "off", "award": None}

    key = norm_phone(phone)
    if len(key) != 10:
        # Enabled, but we cannot tell who they are yet — checkout shows the
        # locked card and asks for the phone number.
        return {"enabled": True, "state": "locked", "award": None}

    award = ScratchAward.open_for_phone(key)
    if not award:
        return {"enabled": True, "state": "available", "award": None}
    return {"enabled": True, "state": "revealed", "award": award.to_dict()}


@router.post("/api/scratch/draw")
def draw(body: ScratchDrawRequest):
    """Scratch the card. Repeat calls return the same result, never a reroll."""
    if not Setting.singleton().scratch_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Scratch cards are not running right now.")
    award, error = draw_for_phone(body.phone)
    if error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, error)
    return {"award": award.to_dict()}


# ---------------- Owner: the prize pool ----------------
@router.get("/api/admin/scratch/prizes")
def list_prizes(_owner=Depends(require_owner)):
    """The batch: what is in it, what has gone out, and what the next card is
    likely to be.

    Two different percentages are reported because the owner is asking two
    different questions. `share` is "what did I decide to print" — 40 out of
    100 is 40%, and it does not move. `chance` is "what is the next customer
    likely to get", which shifts every draw as cards come off the deck.
    """
    prizes = sorted(ScratchPrize.query(), key=lambda p: (p.sort_order, p.key.id()))
    setting = Setting.singleton()
    batch_size = sum(p.quantity or 0 for p in prizes if p.active)
    given = sum(p.awarded_count or 0 for p in prizes)
    left = sum(p.remaining() for p in prizes if p.active)

    rows = []
    for p in prizes:
        d = p.to_dict()
        d["share"] = round((p.quantity or 0) / batch_size * 100, 1) if (batch_size and p.active) else 0.0
        d["chance"] = round(p.remaining() / left * 100, 1) if (left and p.is_drawable()) else 0.0
        coupon = Coupon.get_by_id(p.coupon_id) if p.coupon_id else None
        d["coupon_code"] = coupon.code if coupon else ""
        d["coupon_terms"] = coupon_terms(coupon) if coupon else ""
        d["coupon_missing"] = bool(p.kind == "coupon" and not coupon)
        rows.append(d)

    return {
        "prizes": rows,
        "enabled": setting.scratch_enabled,
        "repeat_batch": setting.scratch_repeat_batch,
        "batch_no": setting.scratch_batch_no or 1,
        "batch_size": batch_size,
        "given": given,
        "left": left,
        "live": any(p["drawable"] for p in rows),
    }


def _validate(body: ScratchPrizePayload) -> Coupon | None:
    if body.quantity < 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "How many of this card are in the batch? Enter at least 1.")
    if body.kind == "miss":
        return None
    coupon = Coupon.get_by_id(body.coupon_id) if body.coupon_id else None
    if not coupon:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick one of your coupons for this prize.")
    if coupon.source == "scratch":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code was itself won on a card; pick one of your own coupons.")
    return coupon


@router.post("/api/admin/scratch/prizes")
def create_prize(body: ScratchPrizePayload, _owner=Depends(require_owner)):
    coupon = _validate(body)
    prize = ScratchPrize(
        kind=body.kind,
        coupon_id=coupon.key.id() if coupon else None,
        label=body.label.strip() or (default_label(coupon) if coupon else "Better luck next time!"),
        quantity=body.quantity,
        validity_days=max(1, body.validity_days), active=body.active,
        sort_order=body.sort_order,
    )
    prize.put()
    return prize.to_dict()


@router.put("/api/admin/scratch/prizes/{prize_id}")
def update_prize(prize_id: int, body: ScratchPrizePayload, _owner=Depends(require_owner)):
    prize = ScratchPrize.get_by_id(prize_id)
    if not prize:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Prize not found.")
    coupon = _validate(body)
    # Cutting the count below what has already gone out is allowed and simply
    # stops the slot — the alternative is refusing to let an owner close a tap
    # they have decided is running too fast.
    prize.kind = body.kind
    prize.coupon_id = coupon.key.id() if coupon else None
    prize.label = body.label.strip() or (default_label(coupon) if coupon else "Better luck next time!")
    prize.quantity = body.quantity
    prize.validity_days = max(1, body.validity_days)
    prize.active = body.active
    prize.sort_order = body.sort_order
    prize.put()
    return prize.to_dict()


@router.delete("/api/admin/scratch/prizes/{prize_id}")
def delete_prize(prize_id: int, _owner=Depends(require_owner)):
    prize = ScratchPrize.get_by_id(prize_id)
    if prize:
        prize.key.delete()
    return {"ok": True}


@router.post("/api/admin/scratch/reprint")
def reprint(_owner=Depends(require_owner)):
    """Put every card back on the deck and start the next batch.

    Deliberately explicit: the counts are the owner's give-away budget, and
    clearing them is them deciding to spend it again.
    """
    reprint_batch()
    return list_prizes(_owner=_owner)


@router.get("/api/admin/scratch/awards")
def list_awards(_owner=Depends(require_owner), limit: int = 100, wins_only: bool = True):
    """Who won what, newest first, plus the totals underneath it."""
    awards = list(ScratchAward.query().order(-ScratchAward.created_at))
    stats = {
        "draws": len(awards),
        "wins": sum(1 for a in awards if a.status != "missed"),
        "redeemed": sum(1 for a in awards if a.status == "used"),
        "misses": sum(1 for a in awards if a.status == "missed"),
    }
    stats["outstanding"] = stats["wins"] - stats["redeemed"]
    rows = [a for a in awards if not wins_only or a.status != "missed"][:limit]
    return {"awards": [a.to_dict() for a in rows], "stats": stats}


@router.post("/api/admin/scratch/awards/{award_id}/close")
def close_award(award_id: int, _owner=Depends(require_owner)):
    """Manually settle a stuck draw.

    A customer who scratched and never ordered keeps an open draw forever, which
    blocks their next card. This is the owner's way out of that without touching
    the datastore.
    """
    award = ScratchAward.get_by_id(award_id)
    if not award:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Award not found.")
    close_open_awards(award.phone, order_public_id="", used_code="")
    return {"ok": True}
