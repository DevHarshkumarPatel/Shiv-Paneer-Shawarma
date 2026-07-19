"""Authoritative cart pricing.

The frontend previews totals for UX, but this module is the single source of
truth: it re-resolves every price and promo from the datastore on order create
so the client cannot tamper with amounts.

Cart line input shape (from the client):
    {"item_id": int, "base": str, "size": str, "quantity": int}
"""
from dataclasses import dataclass, field

from ..models import Item, Promo, Coupon, DeliveryArea


@dataclass
class PricedLine:
    item_id: int
    name: str
    variant_label: str
    base: str
    size: str
    unit_price: float
    quantity: int
    free_quantity: int
    line_total: float          # amount charged for this line (after item promo)
    gross: float               # quantity * unit_price (before promo)
    promo_label: str = ""


@dataclass
class PricingResult:
    lines: list[PricedLine] = field(default_factory=list)
    subtotal: float = 0.0          # gross sum, before any discount
    promo_discount: float = 0.0
    coupon_code: str = ""
    coupon_discount: float = 0.0
    coupon_error: str = ""
    delivery_fee: float = 0.0
    delivery_area_id: int = 0
    delivery_area_name: str = ""
    delivery_area_required: bool = False   # delivery order with no valid area chosen
    total: float = 0.0

    def to_dict(self) -> dict:
        return {
            "lines": [
                {
                    "item_id": l.item_id, "name": l.name, "variant_label": l.variant_label,
                    "base": l.base, "size": l.size, "unit_price": l.unit_price,
                    "quantity": l.quantity, "free_quantity": l.free_quantity,
                    "line_total": l.line_total, "promo_label": l.promo_label,
                }
                for l in self.lines
            ],
            "subtotal": round(self.subtotal, 2),
            "promo_discount": round(self.promo_discount, 2),
            "coupon_code": self.coupon_code,
            "coupon_discount": round(self.coupon_discount, 2),
            "coupon_error": self.coupon_error,
            "delivery_fee": round(self.delivery_fee, 2),
            "delivery_area_id": self.delivery_area_id,
            "delivery_area_name": self.delivery_area_name,
            "delivery_area_required": self.delivery_area_required,
            "total": round(self.total, 2),
        }


def _load_active_promos() -> dict[tuple[str, int], Promo]:
    promos: dict[tuple[str, int], Promo] = {}
    for p in Promo.query(Promo.active == True):  # noqa: E712
        promos[(p.scope, p.target_id)] = p
    return promos


def _match_variant(item: Item, base: str, size: str):
    for v in item.variants:
        if v.base == base and v.size == size:
            return v
    # Fall back to the first variant if the client sent nothing / a stale combo
    # but only when the item genuinely has a single variant.
    if len(item.variants) == 1:
        return item.variants[0]
    return None


def _apply_item_promo(promo: Promo | None, unit_price: float, qty: int) -> tuple[int, float, str]:
    """Return (free_quantity, promo_discount_amount, label)."""
    if not promo:
        return 0, 0.0, ""
    if promo.ptype == "b2g1":
        free = qty // 3          # buy 2, get 1 free -> every 3rd unit free
        return free, free * unit_price, promo.label or "Buy 2 Get 1 Free"
    if promo.ptype == "percent":
        disc = unit_price * (promo.value / 100.0) * qty
        return 0, disc, promo.label or f"{promo.value:g}% off"
    if promo.ptype == "flat":
        disc = min(promo.value, unit_price) * qty      # flat INR off each unit
        return 0, disc, promo.label or f"₹{promo.value:g} off"
    return 0, 0.0, ""


def price_cart(cart: list[dict], order_type: str, coupon_code: str = "",
               delivery_area_id: int = 0) -> PricingResult:
    result = PricingResult()
    promos = _load_active_promos()

    for raw in cart:
        item_id = int(raw.get("item_id"))
        qty = max(1, int(raw.get("quantity", 1)))
        item = Item.get_by_id(item_id)
        if not item or not item.active:
            continue
        variant = _match_variant(item, raw.get("base", ""), raw.get("size", ""))
        if not variant:
            continue

        unit_price = float(variant.price)
        gross = unit_price * qty

        # Item-scoped promo wins over a category-scoped promo.
        promo = promos.get(("item", item_id)) or promos.get(("category", item.category_id))
        free_qty, line_discount, promo_label = _apply_item_promo(promo, unit_price, qty)
        line_total = gross - line_discount

        result.lines.append(PricedLine(
            item_id=item_id, name=item.name, variant_label=variant.label(),
            base=variant.base, size=variant.size, unit_price=unit_price,
            quantity=qty, free_quantity=free_qty, line_total=line_total,
            gross=gross, promo_label=promo_label,
        ))
        result.subtotal += gross
        result.promo_discount += line_discount

    after_promo = result.subtotal - result.promo_discount

    # Coupon (applied on the post-promo amount).
    if coupon_code:
        result.coupon_code = coupon_code.upper().strip()
        coupon = Coupon.by_code(result.coupon_code)
        if not coupon:
            result.coupon_error = "Coupon not found."
            result.coupon_code = ""
        else:
            ok, reason = coupon.is_valid_now()
            if not ok:
                result.coupon_error = reason
                result.coupon_code = ""
            elif after_promo < coupon.min_order:
                result.coupon_error = f"Add ₹{coupon.min_order - after_promo:.0f} more to use this coupon."
                result.coupon_code = ""
            else:
                if coupon.ctype == "percent":
                    disc = after_promo * (coupon.value / 100.0)
                    if coupon.max_discount:
                        disc = min(disc, coupon.max_discount)
                else:
                    disc = min(coupon.value, after_promo)
                result.coupon_discount = disc

    # Delivery fee comes from the customer-selected area. A delivery order
    # without a valid, active area is flagged so callers can require one.
    if order_type == "delivery":
        area = DeliveryArea.get_by_id(int(delivery_area_id)) if delivery_area_id else None
        if area and area.active:
            result.delivery_fee = float(area.fee)
            result.delivery_area_id = area.key.id()
            result.delivery_area_name = area.name
        else:
            result.delivery_area_required = True

    result.total = after_promo - result.coupon_discount + result.delivery_fee
    return result
