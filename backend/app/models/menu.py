"""Menu models: Category -> Subcategory -> Item(with Variants), plus Promos."""
from google.cloud import ndb


class Variant(ndb.Model):
    """A single purchasable configuration of an item.

    Matches the reference grid: Base (Wheat/Millets/None) x Size
    (Regular/Exotic/None). Items without options (e.g. Bowls) have one
    variant with empty base/size.
    """

    base = ndb.StringProperty(default="")   # e.g. "Whole Wheat", "Millets", ""
    size = ndb.StringProperty(default="")   # e.g. "Regular", "Exotic", ""
    price = ndb.FloatProperty(required=True)
    # Per-combination stock flag: millet bases can run out while wheat is still
    # on, so this has to live on the variant and not just on the item. Rows
    # written before this property existed read back as None, hence the
    # `is not False` checks at every use site.
    available = ndb.BooleanProperty(default=True)

    def label(self) -> str:
        parts = [p for p in (self.base, self.size) if p]
        return " · ".join(parts) if parts else "Standard"

    def is_available(self) -> bool:
        return self.available is not False

    def to_dict(self) -> dict:
        return {"base": self.base, "size": self.size,
                "price": self.price, "label": self.label(),
                "available": self.is_available()}


class Category(ndb.Model):
    name = ndb.StringProperty(required=True)
    slug = ndb.StringProperty(required=True)
    offer_badge = ndb.StringProperty(default="")   # e.g. "Buy 2 Get 1"
    sort_order = ndb.IntegerProperty(default=0)
    active = ndb.BooleanProperty(default=True)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "name": self.name,
            "slug": self.slug,
            "offer_badge": self.offer_badge,
            "sort_order": self.sort_order,
            "active": self.active,
        }


class Subcategory(ndb.Model):
    category_id = ndb.IntegerProperty(required=True)
    name = ndb.StringProperty(required=True)
    slug = ndb.StringProperty(default="")
    sort_order = ndb.IntegerProperty(default=0)
    active = ndb.BooleanProperty(default=True)

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "category_id": self.category_id,
            "name": self.name,
            "slug": self.slug,
            "sort_order": self.sort_order,
            "active": self.active,
        }


class Item(ndb.Model):
    category_id = ndb.IntegerProperty(required=True)
    subcategory_id = ndb.IntegerProperty(default=0)   # 0 = directly under category
    name = ndb.StringProperty(required=True)
    description = ndb.TextProperty(default="")
    image_url = ndb.StringProperty(default="")
    veg = ndb.BooleanProperty(default=True)
    tags = ndb.StringProperty(repeated=True)          # e.g. ["Whole Wheat", "Millets"]
    variants = ndb.StructuredProperty(Variant, repeated=True)
    active = ndb.BooleanProperty(default=True)
    # `active` and `available` are deliberately different switches:
    #   active=False    -> the item is off the menu entirely (not rendered)
    #   available=False -> still listed, shown as sold out, cannot be ordered
    # Sold-out is the day-to-day one, and showing it beats hiding it: the
    # customer learns it exists and can ask for it tomorrow.
    available = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    def base_price(self) -> float:
        prices = [v.price for v in self.variants]
        return min(prices) if prices else 0.0

    def is_available(self) -> bool:
        """Sold out when the owner switched it off, or when every variant is."""
        if self.available is False:
            return False
        return any(v.is_available() for v in self.variants) if self.variants else False

    def to_dict(self) -> dict:
        return {
            "id": self.key.id(),
            "category_id": self.category_id,
            "subcategory_id": self.subcategory_id,
            "name": self.name,
            "description": self.description,
            "image_url": self.image_url,
            "veg": self.veg,
            "tags": list(self.tags),
            "variants": [v.to_dict() for v in self.variants],
            "base_price": self.base_price(),
            "active": self.active,
            "available": self.is_available(),
            "sort_order": self.sort_order,
        }


class ItemImage(ndb.Model):
    """An uploaded photo for one item, stored as bytes keyed by the item id.

    Deliberately a separate entity rather than a BlobProperty on Item: the menu
    tree query fetches every Item on every public /api/menu call, and carrying a
    few hundred KB of JPEG per row through that query would make the whole menu
    slow to serve.

    Bytes in Datastore, not a bucket: both Cloud Run services here have
    ephemeral disks (the frontend is a baked nginx image), and there is no GCS
    bucket or google-cloud-storage dependency in this project — adding one means
    provisioning, IAM and public-access config. Uploads are downscaled to well
    under Datastore's 1 MiB entity limit on the way in, which a menu thumbnail
    has no reason to exceed.
    """

    data = ndb.BlobProperty(required=True)
    content_type = ndb.StringProperty(default="image/jpeg")
    width = ndb.IntegerProperty(default=0)
    height = ndb.IntegerProperty(default=0)
    updated_at = ndb.DateTimeProperty(auto_now=True)


class Promo(ndb.Model):
    """Owner-configured promotion, item-wise or category-wise."""

    scope = ndb.StringProperty(choices=["item", "category"], required=True)
    target_id = ndb.IntegerProperty(default=0)         # legacy single target (first of target_ids)
    target_ids = ndb.IntegerProperty(repeated=True)    # Item ids or Category ids the promo applies to
    ptype = ndb.StringProperty(choices=["b2g1", "b1g1", "percent", "flat"], required=True)
    value = ndb.FloatProperty(default=0.0)             # percent (0-100) or flat INR; 0 for b2g1/b1g1
    label = ndb.StringProperty(default="")             # e.g. "Buy 2 Get 1 Free"
    description = ndb.TextProperty(default="")         # customer-facing pitch, shown on the site
    conditions = ndb.TextProperty(default="")          # the fine print shown under the pitch
    active = ndb.BooleanProperty(default=True)
    # True while at least one Coupon lists this promo in its promo_ids. Such a
    # promo is never applied on its own: the cart only gets it when that code is
    # entered. Maintained by the coupon endpoints (see routers/coupons.py) so
    # pricing can filter on a field instead of scanning every coupon per quote.
    coupon_only = ndb.BooleanProperty(default=False)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    def target_id_list(self) -> list[int]:
        """All targets, tolerating rows written before target_ids existed."""
        ids = list(self.target_ids or [])
        if self.target_id and self.target_id not in ids:
            ids.append(self.target_id)
        return ids

    def display_label(self) -> str:
        """The headline. Owner text wins; otherwise derived from the promo type,
        so a promo created without a label is never rendered as a blank band."""
        if self.label:
            return self.label
        if self.ptype == "b1g1":
            return "Buy 1 Get 1 Free"
        if self.ptype == "b2g1":
            return "Buy 2 Get 1 Free"
        if self.ptype == "percent":
            return f"{self.value:g}% off"
        return f"₹{self.value:g} off"

    def display_description(self, targets_text: str = "", codes: list[str] | None = None) -> str:
        """Owner description, else a mechanically accurate one built from ptype.

        The defaults describe exactly what `services/pricing.py` does, so the
        copy on the site cannot drift from what the cart actually charges — a
        coupon-gated promo therefore says which code turns it on rather than
        promising it applies by itself.
        """
        if self.description:
            return self.description
        on = f" on {targets_text}" if targets_text else ""
        from_ = f" from {targets_text}" if targets_text else ""
        how = f" with code {' or '.join(codes)}" if codes else " automatically"
        if self.ptype == "b1g1":
            return (f"Add any 2 eligible items{from_} — the cheaper of the two comes off "
                    f"your bill{how} at checkout.")
        if self.ptype == "b2g1":
            return f"Buy any 2 items{from_} and the 3rd one is free, applied{how} at checkout."
        if self.ptype == "percent":
            return f"{self.value:g}% off every eligible item{on}, applied{how} at checkout."
        return f"₹{self.value:g} off every eligible item{on}, applied{how} at checkout."

    def display_conditions(self, targets_text: str = "", codes: list[str] | None = None) -> str:
        """Owner fine print, else the standing terms every promo here shares."""
        if self.conditions:
            return self.conditions
        applies = f"Applies to {targets_text}. " if targets_text else ""
        code_terms = (
            f"Enter code {' or '.join(codes)} at checkout to switch it on."
            if codes else
            "No coupon code needed — the discount is calculated on the final bill."
        )
        return (f"{applies}{code_terms} Cannot be combined with itself on the "
                "same item twice.")

    def to_dict(self) -> dict:
        targets = self.target_id_list()
        return {
            "id": self.key.id(),
            "scope": self.scope,
            "target_id": targets[0] if targets else 0,   # kept for older clients
            "target_ids": targets,
            "ptype": self.ptype,
            "value": self.value,
            "label": self.label,
            "display_label": self.display_label(),
            "description": self.description,
            "conditions": self.conditions,
            "active": self.active,
            "coupon_only": self.coupon_only,
        }
