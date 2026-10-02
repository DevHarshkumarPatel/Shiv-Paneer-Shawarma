"""Owner-defined delivery zones, each with its own delivery fee.

The customer picks an area at checkout; its fee is what the pricing service
charges for delivery (there is no single flat delivery fee anymore).
"""
from google.cloud import ndb


class DeliveryArea(ndb.Model):
    name = ndb.StringProperty(required=True)
    fee = ndb.FloatProperty(default=0.0)
    active = ndb.BooleanProperty(default=True)
    # Which branch delivers to this area. None means Main (rows from before
    # branches). Two branches can each have a "Near" area at different fees.
    branch_id = ndb.IntegerProperty()
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    def belongs_to(self, branch_id: int, main_id: int) -> bool:
        return (self.branch_id or main_id) == branch_id

    @classmethod
    def active_ordered(cls, branch_id: int, main_id: int) -> list["DeliveryArea"]:
        """One branch's active areas, sorted for the checkout dropdown."""
        areas = [a for a in cls.query() if a.active and a.belongs_to(branch_id, main_id)]
        return sorted(areas, key=lambda a: (a.sort_order, a.name.lower()))

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "name": self.name,
            "fee": self.fee,
            "active": self.active,
            "sort_order": self.sort_order,
            "branch_id": self.branch_id,
        }
