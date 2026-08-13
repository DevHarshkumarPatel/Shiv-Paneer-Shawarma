"""Scratch-card rewards: the owner's prize batch and the draws made from it.

The batch is a deck of cards, not a set of odds. The owner says "print 100
cards: 40 of this coupon, 40 of that one, 20 of the third", and that is exactly
what gets handed out — cards come off the deck in random order, but the totals
at the end are the ones the owner typed. A slot with `kind="miss"` is a blank
card in the same deck, so "how often does a card win nothing" is set the same
way as everything else: by how many blanks are in the 100.

Odds fall out of the counts rather than being configured separately. With 63
cards left and 27 of them a ₹50-off, the next scratch has a 27-in-63 chance of
being one — and every card that comes off shifts the rest, the way a real deck
does. That is what makes the final split exact instead of approximate.

Winning does not hand out the owner's coupon code itself. It mints a private
one-time copy bound to the winner's phone (see `services/scratch.py`), so a
screenshot of the card is worth nothing to anyone else.
"""
from google.cloud import ndb

PRIZE_KINDS = ["coupon", "miss"]

# A draw is recorded even when it loses, so nobody can reroll by reloading.
AWARD_STATUSES = ["won", "missed", "used"]


class ScratchPrize(ndb.Model):
    kind = ndb.StringProperty(choices=PRIZE_KINDS, default="coupon")
    coupon_id = ndb.IntegerProperty()          # template coupon; unset for a miss
    label = ndb.StringProperty(default="")     # what the card reads when it lands
    # How many of this card are in the batch. This is the whole configuration:
    # 40 here and 60 across the other slots is a batch of 100 that ends up 40/60.
    quantity = ndb.IntegerProperty(default=0)
    awarded_count = ndb.IntegerProperty(default=0)   # given in the current batch
    validity_days = ndb.IntegerProperty(default=7)  # life of the code it mints
    active = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    def remaining(self) -> int:
        """Cards of this kind still in the batch."""
        return max(0, (self.quantity or 0) - (self.awarded_count or 0))

    def is_drawable(self) -> bool:
        return bool(self.active) and self.remaining() > 0

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "kind": self.kind,
            "coupon_id": self.coupon_id,
            "label": self.label,
            "quantity": self.quantity or 0,
            "awarded_count": self.awarded_count or 0,
            "remaining": self.remaining(),
            "validity_days": self.validity_days,
            "active": self.active,
            "sort_order": self.sort_order,
            "drawable": self.is_drawable(),
        }


class ScratchAward(ndb.Model):
    """One draw by one phone number.

    `open` is the anti-reroll latch: a draw stays open until that phone places
    an order, which is what makes the card "one per order". While it is open the
    same result is handed back on every reload, win or miss.
    """

    phone = ndb.StringProperty(required=True)      # normalised, last 10 digits
    prize_id = ndb.IntegerProperty()
    status = ndb.StringProperty(choices=AWARD_STATUSES, default="won")
    label = ndb.StringProperty(default="")
    code = ndb.StringProperty(default="")          # minted coupon code; "" on a miss
    source_code = ndb.StringProperty(default="")   # the owner coupon it was minted from
    terms = ndb.TextProperty(default="")           # frozen human-readable terms
    open = ndb.BooleanProperty(default=True)
    expires_at = ndb.DateTimeProperty()
    created_at = ndb.DateTimeProperty(auto_now_add=True)
    used_at = ndb.DateTimeProperty()
    order_public_id = ndb.StringProperty(default="")

    @classmethod
    def open_for_phone(cls, phone: str) -> "ScratchAward | None":
        return cls.query(cls.phone == phone, cls.open == True).get()  # noqa: E712

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "phone": self.phone,
            "status": self.status,
            "won": self.status != "missed",
            "label": self.label,
            "code": self.code,
            "source_code": self.source_code,
            "terms": self.terms,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "order_public_id": self.order_public_id,
        }
