"""Discount coupon codes."""
from datetime import datetime

from google.cloud import ndb


class Coupon(ndb.Model):
    code = ndb.StringProperty(required=True)             # stored upper-cased
    # "promo" is a code that carries no money discount of its own: all it does
    # is switch on the promos listed in promo_ids. value is ignored for it.
    ctype = ndb.StringProperty(choices=["percent", "flat", "promo"], required=True)
    value = ndb.FloatProperty(required=True)             # percent (0-100) or flat INR; 0 for "promo"
    min_order = ndb.FloatProperty(default=0.0)
    max_discount = ndb.FloatProperty(default=0.0)        # 0 = no cap
    active = ndb.BooleanProperty(default=True)
    expires_at = ndb.DateTimeProperty()                  # null = never
    usage_limit = ndb.IntegerProperty(default=0)         # 0 = unlimited
    used_count = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    # ---- scratch-card mints ----
    # "manual" is a code the owner typed and advertises; "scratch" is a private
    # one-time copy minted when someone won it on a scratch card. The two are
    # kept in one kind so pricing, validation and usage counting stay in a
    # single place — the owner's coupon screen filters the mints back out.
    source = ndb.StringProperty(choices=["manual", "scratch"], default="manual")
    # When set, only this phone number may redeem the code. That is what makes
    # a won code safe to show on screen: a screenshot is useless to anyone else.
    bound_phone = ndb.StringProperty(default="")
    prize_id = ndb.IntegerProperty()                     # pool slot it came from

    # ---- coupon-gated promos ----
    # Promo ids this code unlocks. Those promos are flagged coupon_only, so the
    # cart never applies them on its own — only a cart carrying this code gets
    # them. A coupon may both take money off (percent/flat) and unlock promos;
    # ctype "promo" is the case where unlocking is all it does.
    promo_ids = ndb.IntegerProperty(repeated=True)

    @classmethod
    def by_code(cls, code: str) -> "Coupon | None":
        return cls.query(cls.code == code.upper().strip()).get()

    def is_valid_now(self) -> tuple[bool, str]:
        if not self.active:
            return False, "This coupon is not active."
        if self.expires_at and self.expires_at < datetime.utcnow():
            return False, "This coupon has expired."
        if self.usage_limit and self.used_count >= self.usage_limit:
            return False, "This coupon has reached its usage limit."
        return True, ""

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "code": self.code,
            "ctype": self.ctype,
            "value": self.value,
            "min_order": self.min_order,
            "max_discount": self.max_discount,
            "active": self.active,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "usage_limit": self.usage_limit,
            "used_count": self.used_count,
            "promo_ids": list(self.promo_ids or []),
            "source": self.source,
            "bound_phone": self.bound_phone,
        }
