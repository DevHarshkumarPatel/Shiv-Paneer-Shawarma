"""Owner-defined delivery zones, each with its own delivery fee.

The customer picks an area at checkout; its fee is what the pricing service
charges for delivery (there is no single flat delivery fee anymore).
"""
from google.cloud import ndb


class DeliveryArea(ndb.Model):
    name = ndb.StringProperty(required=True)
    fee = ndb.FloatProperty(default=0.0)
    active = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    @classmethod
    def active_ordered(cls) -> list["DeliveryArea"]:
        """Active areas, sorted for display in the checkout dropdown."""
        areas = [a for a in cls.query() if a.active]
        return sorted(areas, key=lambda a: (a.sort_order, a.name.lower()))

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "name": self.name,
            "fee": self.fee,
            "active": self.active,
            "sort_order": self.sort_order,
        }
