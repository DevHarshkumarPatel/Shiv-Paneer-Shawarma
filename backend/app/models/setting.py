"""Global store settings — a single-row entity holding shop-wide switches.

Currently just `ordering_enabled`: the owner's master switch for whether
customers may place orders from the customer side. Kept as a fixed-id
singleton so there is always exactly one row to read and update.
"""
from google.cloud import ndb

_SINGLETON_ID = "global"


class Setting(ndb.Model):
    ordering_enabled = ndb.BooleanProperty(default=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    @classmethod
    def singleton(cls) -> "Setting":
        """Return the one settings row, creating it (ordering on) if missing."""
        s = cls.get_by_id(_SINGLETON_ID)
        if s is None:
            s = cls(id=_SINGLETON_ID)
            s.put()
        return s

    def to_dict(self) -> dict:
        return {"ordering_enabled": self.ordering_enabled}
