"""Topups (add-ons): extra cheese, extra paneer, an extra dip.

A kind of its own rather than a menu Item with a cheap price, because a topup is
not a thing anyone orders by itself: it never appears in the customer menu, it
carries no variants, no stock grid and no photo, and no promo is ever allowed to
give one away free. What it does have is the one switch an item does not — a
price that is either charged per unit or charged once however many are added.

Owner-owned: only the owner creates, edits, reprices or removes them. Staff can
put them on an order and take them off again, which is the whole point.
"""
from google.cloud import ndb


class Topup(ndb.Model):
    name = ndb.StringProperty(required=True)         # e.g. "Extra Cheese"
    price = ndb.FloatProperty(default=0.0)
    # How the price is charged:
    #   True  -> per unit. 3 × Extra Cheese at ₹20 bills ₹60, and staff get a
    #            +/- stepper on the ticket.
    #   False -> a flat charge. It is on the order or it is not; adding it twice
    #            is meaningless, so the quantity is pinned to 1.
    # Rows written before this property existed read back as None, hence the
    # `is not False` in `charges_per_quantity`.
    per_quantity = ndb.BooleanProperty(default=True)
    description = ndb.StringProperty(default="")     # optional note for the counter
    active = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    def charges_per_quantity(self) -> bool:
        return self.per_quantity is not False

    def charge_for(self, quantity: int) -> tuple[int, float]:
        """(quantity actually billed, amount) for this many of this topup."""
        qty = max(1, int(quantity or 1))
        if not self.charges_per_quantity():
            return 1, float(self.price)
        return qty, float(self.price) * qty

    @classmethod
    def active_ordered(cls) -> list["Topup"]:
        """Active topups in the order the counter should see them."""
        rows = [t for t in cls.query() if t.active]
        return sorted(rows, key=lambda t: (t.sort_order, t.name.lower()))

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "name": self.name,
            "price": self.price,
            "per_quantity": self.charges_per_quantity(),
            "description": self.description,
            "active": self.active,
            "sort_order": self.sort_order,
        }
