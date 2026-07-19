"""Discount coupon codes."""
from datetime import datetime

from google.cloud import ndb


class Coupon(ndb.Model):
    code = ndb.StringProperty(required=True)             # stored upper-cased
    ctype = ndb.StringProperty(choices=["percent", "flat"], required=True)
    value = ndb.FloatProperty(required=True)             # percent (0-100) or flat INR
    min_order = ndb.FloatProperty(default=0.0)
    max_discount = ndb.FloatProperty(default=0.0)        # 0 = no cap
    active = ndb.BooleanProperty(default=True)
    expires_at = ndb.DateTimeProperty()                  # null = never
    usage_limit = ndb.IntegerProperty(default=0)         # 0 = unlimited
    used_count = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

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
        }
