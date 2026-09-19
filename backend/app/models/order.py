"""Customer orders and their embedded structures."""
import json

from google.cloud import ndb

# Canonical status vocabulary. Terminal states end a lifecycle.
ORDER_STATUSES = [
    "placed", "confirmed", "preparing", "packing", "ready",
    "on_the_way", "delivered", "picked_up", "served", "cancelled",
]

# Allowed forward transitions per order type (customer + staff share this).
STATUS_FLOW = {
    "delivery": ["placed", "confirmed", "preparing", "packing", "ready", "on_the_way", "delivered"],
    "takeaway": ["placed", "confirmed", "preparing", "packing", "ready", "picked_up"],
    "dine_in": ["placed", "confirmed", "preparing", "ready", "served"],
}


class OrderItem(ndb.Model):
    item_id = ndb.IntegerProperty()
    name = ndb.StringProperty(required=True)
    variant_label = ndb.StringProperty(default="")
    base = ndb.StringProperty(default="")
    size = ndb.StringProperty(default="")
    unit_price = ndb.FloatProperty(required=True)
    quantity = ndb.IntegerProperty(required=True)
    free_quantity = ndb.IntegerProperty(default=0)   # from B2G1-type promos
    line_total = ndb.FloatProperty(required=True)    # after item promo, before coupon
    # The offer that discounted this line, as it read when the order was placed.
    # Kept on the order rather than looked up later: promos get edited and
    # switched off, and an old bill must still say what it actually gave.
    promo_label = ndb.StringProperty(default="")

    def to_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "name": self.name,
            "variant_label": self.variant_label,
            "base": self.base,
            "size": self.size,
            "unit_price": self.unit_price,
            "quantity": self.quantity,
            "free_quantity": self.free_quantity,
            "line_total": self.line_total,
            "promo_label": self.promo_label,
        }


class OrderTopup(ndb.Model):
    """A topup (add-on) as it was charged on this order.

    Frozen like the item lines and for the same reason: the owner reprices
    "Extra Cheese" next week and a bill already handed over still has to say
    what it charged. `per_quantity` is stored too, so a reprinted bill explains
    its own arithmetic instead of leaving ₹20 next to "3 ×".
    """

    topup_id = ndb.IntegerProperty()
    name = ndb.StringProperty(required=True)
    unit_price = ndb.FloatProperty(required=True)
    quantity = ndb.IntegerProperty(default=1)
    per_quantity = ndb.BooleanProperty(default=True)
    line_total = ndb.FloatProperty(required=True)

    def to_dict(self) -> dict:
        return {
            "topup_id": self.topup_id,
            "name": self.name,
            "unit_price": self.unit_price,
            "quantity": self.quantity,
            "per_quantity": self.per_quantity is not False,
            "line_total": self.line_total,
        }


class CustomerInfo(ndb.Model):
    name = ndb.StringProperty(default="")
    phone = ndb.StringProperty(default="")
    address = ndb.TextProperty(default="")
    lat = ndb.FloatProperty()
    lng = ndb.FloatProperty()

    def to_dict(self) -> dict:
        return {
            "name": self.name, "phone": self.phone, "address": self.address,
            "lat": self.lat, "lng": self.lng,
        }


class PaymentInfo(ndb.Model):
    # method: "upi" (pay now) or "cash" (pay at counter / on delivery — not offered for delivery)
    method = ndb.StringProperty(choices=["upi", "cash"], default="cash")
    # status: pending -> awaiting_verification (UPI ref submitted) -> paid / failed
    status = ndb.StringProperty(
        choices=["pending", "awaiting_verification", "paid", "failed"], default="pending"
    )
    upi_reference = ndb.StringProperty(default="")
    verified_by = ndb.StringProperty(default="")
    amount = ndb.FloatProperty(default=0.0)

    def to_dict(self) -> dict:
        return {
            "method": self.method, "status": self.status,
            "upi_reference": self.upi_reference, "amount": self.amount,
        }


class StatusEvent(ndb.Model):
    status = ndb.StringProperty(required=True)
    at = ndb.DateTimeProperty(auto_now_add=True)
    by = ndb.StringProperty(default="")   # "customer" / staff email / "system"

    def to_dict(self) -> dict:
        return {"status": self.status, "at": self.at.isoformat() if self.at else None, "by": self.by}


class OrderEdit(ndb.Model):
    """One save of the edit screen, and everything that save changed.

    Kept on the order rather than in a kind of its own so the board gets an
    order's whole edit history in the single read it already does — a second
    query per card would be a hundred queries on a busy day.

    `changes_json` is JSON rather than a repeated sub-model because ndb refuses
    a repeated StructuredProperty whose model itself holds a repeated property,
    and an edit is a list of changes inside a list of edits. Each entry is
    ``{"label", "old", "new", "kind"}`` — `kind` is "money" when the two values
    are amounts the screen should render as currency, "text" otherwise.

    `at` is stored naive UTC like every other timestamp here; the staff screens
    format it as IST.
    """

    at = ndb.DateTimeProperty(auto_now_add=True)
    by = ndb.StringProperty(default="")        # staff / owner email
    by_role = ndb.StringProperty(default="")   # role as it was at the time
    changes_json = ndb.TextProperty(default="[]")
    total_before = ndb.FloatProperty(default=0.0)
    total_after = ndb.FloatProperty(default=0.0)

    def to_dict(self) -> dict:
        try:
            changes = json.loads(self.changes_json or "[]")
        except ValueError:
            changes = []
        return {
            "at": self.at.isoformat() if self.at else None,
            "by": self.by,
            "by_role": self.by_role,
            "changes": changes,
            "total_before": self.total_before,
            "total_after": self.total_after,
        }


class Order(ndb.Model):
    public_id = ndb.StringProperty(required=True)   # e.g. SPS-260718-0042
    order_type = ndb.StringProperty(choices=["dine_in", "takeaway", "delivery"], required=True)

    # Which visit this is for this customer — 1 on their first ever order.
    # Written at creation and never recomputed: a bill already handed over has
    # to keep saying what it said, whatever the history does afterwards.
    repeat_no = ndb.IntegerProperty()
    # Last 10 digits of the customer's phone. Stored so "how many orders has
    # this person placed" is one indexed query rather than a scan — the raw
    # phone is typed differently every time (+91, spaces, a leading 0).
    phone_key = ndb.StringProperty(default="")

    # Where the order came from: the customer's own checkout, or a staff member
    # taking it at the counter / over the phone. Orders written before counter
    # ordering existed have no value stored and read back as "online", which is
    # what they were.
    channel = ndb.StringProperty(choices=["online", "counter"], default="online")
    placed_by = ndb.StringProperty(default="")   # staff email, for counter orders

    items = ndb.StructuredProperty(OrderItem, repeated=True)
    # Add-ons staff put on the ticket. Their own lines rather than something
    # hidden inside an item line: the counter adds and removes them separately,
    # and no offer ever discounts one — see services/pricing.py.
    topups = ndb.StructuredProperty(OrderTopup, repeated=True)
    customer = ndb.StructuredProperty(CustomerInfo)
    payment = ndb.StructuredProperty(PaymentInfo)

    subtotal = ndb.FloatProperty(default=0.0)
    promo_discount = ndb.FloatProperty(default=0.0)
    coupon_code = ndb.StringProperty(default="")
    coupon_discount = ndb.FloatProperty(default=0.0)
    delivery_fee = ndb.FloatProperty(default=0.0)
    delivery_area = ndb.StringProperty(default="")   # chosen area name, for delivery orders
    topups_total = ndb.FloatProperty(default=0.0)    # add-ons, charged at full price
    total = ndb.FloatProperty(default=0.0)

    status = ndb.StringProperty(choices=ORDER_STATUSES, default="placed")
    history = ndb.StructuredProperty(StatusEvent, repeated=True)
    # Every change made to this order after it was placed, oldest first.
    # An order is money owed and food promised, so a correction has to say
    # who made it and what it moved — never just overwrite the old figure.
    edits = ndb.StructuredProperty(OrderEdit, repeated=True)
    notes = ndb.TextProperty(default="")

    created_at = ndb.DateTimeProperty(auto_now_add=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    @classmethod
    def by_public_id(cls, public_id: str) -> "Order | None":
        return cls.query(cls.public_id == public_id.upper().strip()).get()

    def to_dict(self, include_customer: bool = True, include_edits: bool = False) -> dict:
        """Serialise the order.

        `include_edits` is off by default and deliberately so: the edit log
        carries the email and role of whoever made each change, and the order
        itself is readable without a login — the customer's track page fetches
        it by id. Only the staff endpoints ask for it.
        """
        data = {
            "public_id": self.public_id,
            "order_type": self.order_type,
            "repeat_no": self.repeat_no,
            "channel": self.channel or "online",
            "placed_by": self.placed_by,
            "items": [i.to_dict() for i in self.items],
            "topups": [t.to_dict() for t in self.topups],
            "payment": self.payment.to_dict() if self.payment else None,
            "subtotal": self.subtotal,
            "promo_discount": self.promo_discount,
            "coupon_code": self.coupon_code,
            "coupon_discount": self.coupon_discount,
            "delivery_fee": self.delivery_fee,
            "delivery_area": self.delivery_area,
            "topups_total": self.topups_total or 0.0,
            "total": self.total,
            "status": self.status,
            "history": [h.to_dict() for h in self.history],
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_edits:
            data["edits"] = [e.to_dict() for e in self.edits]
        if include_customer and self.customer:
            data["customer"] = self.customer.to_dict()
        return data
