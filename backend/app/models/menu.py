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
    active = ndb.BooleanProperty(default=True)
    created_at = ndb.DateTimeProperty(auto_now_add=True)

    def target_id_list(self) -> list[int]:
        """All targets, tolerating rows written before target_ids existed."""
        ids = list(self.target_ids or [])
        if self.target_id and self.target_id not in ids:
            ids.append(self.target_id)
        return ids

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
            "active": self.active,
        }
