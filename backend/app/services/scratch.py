"""Drawing a scratch card: take one off the deck, mint the winner's code.

Three rules do the real work here:

* **The batch is a deck, not a set of odds.** A card is picked in proportion to
  how many of it are *left*, which is dealing without replacement: a batch of
  100 set to 40/40/20 finishes on exactly 40/40/20, however the order fell.
  Weighted odds would only get near those numbers.
* **The count is claimed in a transaction.** Two people scratching in the same
  second cannot both take the last card of a kind.
* **One open draw per phone.** A draw stays open until that phone places an
  order, so reloading checkout re-shows the same card instead of rerolling it.
  This is what "one card per order" means in practice.
"""
import random
import re
import string
from datetime import datetime, timedelta

from google.cloud import ndb

from ..models import Coupon, ScratchAward, ScratchPrize, Setting

# No O/0/I/1: the code gets read off a phone screen and typed back in.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_SUFFIX_LEN = 4
MINT_ATTEMPTS = 12


def norm_phone(raw: str) -> str:
    """Digits only, last 10 kept — same identity rule as the customers page."""
    digits = re.sub(r"\D", "", raw or "")
    return digits[-10:] if len(digits) >= 10 else digits


def coupon_terms(coupon: Coupon) -> str:
    """One line a customer can act on: what it takes off, and what it needs."""
    if coupon.ctype == "promo":
        amount = "unlocks a running offer"
    elif coupon.ctype == "percent":
        amount = f"{coupon.value:g}% off"
        if coupon.max_discount:
            amount += f" (up to ₹{coupon.max_discount:g})"
    else:
        amount = f"₹{coupon.value:g} off"
    if coupon.min_order:
        amount += f" on orders over ₹{coupon.min_order:g}"
    return amount


def default_label(coupon: Coupon) -> str:
    if coupon.ctype == "promo":
        return "OFFER UNLOCKED"
    return f"{coupon.value:g}% OFF" if coupon.ctype == "percent" else f"₹{coupon.value:g} OFF"


def _mint_code(source_code: str) -> str:
    """A private one-time code derived from the owner's coupon code.

    Keeping the parent visible (SHIV10-K7X2) means the owner can read a redeemed
    code back to the offer it came from without a lookup.
    """
    base = re.sub(r"[^A-Z0-9]", "", (source_code or "SPS").upper())[:10] or "SPS"
    for _ in range(MINT_ATTEMPTS):
        suffix = "".join(random.choice(CODE_ALPHABET) for _ in range(CODE_SUFFIX_LEN))
        code = f"{base}-{suffix}"
        if not Coupon.by_code(code):
            return code
    # Astronomically unlikely; better a longer code than a collision.
    return f"{base}-{''.join(random.choice(CODE_ALPHABET) for _ in range(CODE_SUFFIX_LEN + 3))}"


@ndb.transactional(retries=3)
def _claim_prize(prize_key: ndb.Key) -> bool:
    """Take one card of this kind off the deck, or report that it just ran out.

    Transactional because the whole point of the batch is that the owner said
    "give away 40 of these", and two simultaneous scratches must not make it 41.
    """
    prize = prize_key.get()
    if not prize or not prize.is_drawable():
        return False
    prize.awarded_count = (prize.awarded_count or 0) + 1
    prize.put()
    return True


def _pick(prizes: list[ScratchPrize]) -> ScratchPrize | None:
    """Draw one card from what is left of the batch.

    The chance of each kind is its remaining count over the total remaining —
    i.e. dealing off a shuffled deck. Because every draw removes the card it
    took, the batch lands on the owner's exact split rather than near it.
    """
    live = [p for p in prizes if p.is_drawable()]
    if not live:
        return None
    total = sum(p.remaining() for p in live)
    roll = random.uniform(0, total)
    upto = 0.0
    for p in live:
        upto += p.remaining()
        if roll <= upto:
            return p
    return live[-1]


def reprint_batch(prizes: list[ScratchPrize] | None = None) -> None:
    """Start the batch over: every card back on the deck, batch number up one.

    Used both by the owner's "start a new batch" button and by the automatic
    reprint, so a fresh batch is one thing and not two slightly different ones.
    """
    for prize in (prizes if prizes is not None else list(ScratchPrize.query())):
        if prize.awarded_count:
            prize.awarded_count = 0
            prize.put()
    setting = Setting.singleton()
    setting.scratch_batch_no = (setting.scratch_batch_no or 1) + 1
    setting.put()


def draw_for_phone(phone: str) -> tuple[ScratchAward | None, str]:
    """Draw a card for `phone`.

    Returns (award, error). An already-open award is returned as-is rather than
    rerolled, so a reload — or a second device — shows the same result.
    """
    phone = norm_phone(phone)
    if len(phone) != 10:
        return None, "Enter your 10-digit phone number to reveal your card."

    existing = ScratchAward.open_for_phone(phone)
    if existing:
        return existing, ""

    prizes = list(ScratchPrize.query())
    if not any(p.is_drawable() for p in prizes):
        # Deck empty. Reprint it if the owner asked for that, otherwise the
        # give-away is over until they say so — silently starting batch two is
        # not a decision this code gets to make.
        if not Setting.singleton().scratch_repeat_batch:
            return None, "No rewards are available right now."
        reprint_batch(prizes)
        prizes = list(ScratchPrize.query())
        if not any(p.is_drawable() for p in prizes):
            return None, "No rewards are available right now."

    # Loop rather than pick-once: a slot can be emptied by someone else between
    # the pick and the claim, and that must fall through to the other slots
    # instead of failing the customer's scratch.
    prize = None
    dead: set[int] = set()
    for _ in range(len(prizes) + 1):
        candidate = _pick([p for p in prizes if p.key.id() not in dead])
        if not candidate:
            break
        if _claim_prize(candidate.key):
            prize = candidate
            break
        dead.add(candidate.key.id())
    if not prize:
        return None, "No rewards are available right now."

    if prize.kind == "miss":
        award = ScratchAward(
            phone=phone, prize_id=prize.key.id(), status="missed",
            label=prize.label or "Better luck next time!",
        )
        award.put()
        return award, ""

    template = Coupon.get_by_id(prize.coupon_id) if prize.coupon_id else None
    if not template:
        # The owner deleted the coupon behind this slot. Give the customer the
        # miss rather than an error — the claim is already spent either way.
        award = ScratchAward(
            phone=phone, prize_id=prize.key.id(), status="missed",
            label="Better luck next time!",
        )
        award.put()
        return award, ""

    days = max(1, prize.validity_days or 7)
    expires_at = datetime.utcnow() + timedelta(days=days)
    code = _mint_code(template.code)
    # Terms are copied, not referenced: the owner may retune SHIV10 tomorrow,
    # and a code someone already won has to keep the deal it was won on.
    Coupon(
        code=code, ctype=template.ctype, value=template.value,
        min_order=template.min_order, max_discount=template.max_discount,
        # The unlocks travel with the copy, so a card won off an offer-carrying
        # coupon gives that offer too, not a code that does nothing.
        promo_ids=list(template.promo_ids or []),
        active=True, expires_at=expires_at, usage_limit=1, used_count=0,
        source="scratch", bound_phone=phone, prize_id=prize.key.id(),
    ).put()

    award = ScratchAward(
        phone=phone, prize_id=prize.key.id(), status="won",
        label=prize.label or default_label(template),
        code=code, source_code=template.code, terms=coupon_terms(template),
        expires_at=expires_at,
    )
    award.put()
    return award, ""


def close_open_awards(phone: str, order_public_id: str, used_code: str = "") -> None:
    """Settle a phone's open draw once they have actually ordered.

    Closing is what re-arms the card for their next order. If the order spent
    the won code, the award is marked used so the owner's report separates
    "won it" from "came back and spent it".
    """
    phone = norm_phone(phone)
    if len(phone) != 10:
        return
    used_code = (used_code or "").upper().strip()
    for award in ScratchAward.query(ScratchAward.phone == phone, ScratchAward.open == True):  # noqa: E712
        award.open = False
        if award.code and award.code == used_code:
            award.status = "used"
            award.used_at = datetime.utcnow()
            award.order_public_id = order_public_id
        award.put()
