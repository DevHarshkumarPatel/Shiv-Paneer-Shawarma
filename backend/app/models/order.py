"""Customer orders and their embedded structures."""
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


class Order(ndb.Model):
    public_id = ndb.StringProperty(required=True)   # e.g. SPS-260718-0042
    order_type = ndb.StringProperty(choices=["dine_in", "takeaway", "delivery"], required=True)

    items = ndb.StructuredProperty(OrderItem, repeated=True)
    customer = ndb.StructuredProperty(CustomerInfo)
    payment = ndb.StructuredProperty(PaymentInfo)

    subtotal = ndb.FloatProperty(default=0.0)
    promo_discount = ndb.FloatProperty(default=0.0)
    coupon_code = ndb.StringProperty(default="")
    coupon_discount = ndb.FloatProperty(default=0.0)
    delivery_fee = ndb.FloatProperty(default=0.0)
    delivery_area = ndb.StringProperty(default="")   # chosen area name, for delivery orders
    total = ndb.FloatProperty(default=0.0)

    status = ndb.StringProperty(choices=ORDER_STATUSES, default="placed")
    history = ndb.StructuredProperty(StatusEvent, repeated=True)
    notes = ndb.TextProperty(default="")

    created_at = ndb.DateTimeProperty(auto_now_add=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    @classmethod
    def by_public_id(cls, public_id: str) -> "Order | None":
        return cls.query(cls.public_id == public_id.upper().strip()).get()

    def to_dict(self, include_customer: bool = True) -> dict:
        data = {
            "public_id": self.public_id,
            "order_type": self.order_type,
            "items": [i.to_dict() for i in self.items],
            "payment": self.payment.to_dict() if self.payment else None,
            "subtotal": self.subtotal,
            "promo_discount": self.promo_discount,
            "coupon_code": self.coupon_code,
            "coupon_discount": self.coupon_discount,
            "delivery_fee": self.delivery_fee,
            "delivery_area": self.delivery_area,
            "total": self.total,
            "status": self.status,
            "history": [h.to_dict() for h in self.history],
            "notes": self.notes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_customer and self.customer:
            data["customer"] = self.customer.to_dict()
        return data
