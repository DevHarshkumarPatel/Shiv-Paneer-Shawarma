"""Branches (outlets) and the per-branch menu overrides.

One master menu, owned by the owner and edited once. A branch either sells that
menu exactly as it is (`menu_same_as_main`, the default) or keeps a short list of
differences in `BranchMenu` — a dearer price here, an item it does not sell at
all. Anything without a difference falls through to the master, so a branch
that has never been touched prices like Main.

Stock is the exception, and is always per branch whatever that toggle says: it
is what one kitchen has on its shelf right now. Main running out of millet must
not sell out millet at Adajan. So the stock flags on the master Item and Variant
are Main's stock only; every other branch keeps its own in `BranchMenu`
(`sold_out` for the whole item, `VariantOverride.available` per variant), and is
in stock by default.

Why differences and not a full copy of the menu per branch: the owner adds a new
item once and every branch has it. A copied menu drifts the first time one copy
is edited and nobody remembers to edit the other.

Branches are never deleted, only switched off: every order carries its branch's
id, and an old bill must still be able to say where it was paid.
"""
from google.cloud import ndb

# Main has a fixed id so finding it is a key lookup (cached per request), and so
# two first requests racing on a fresh database cannot both create one.
MAIN_ID = 1


class Branch(ndb.Model):
    name = ndb.StringProperty(required=True)          # "Adajan"
    slug = ndb.StringProperty(required=True)          # "adajan", used in ?b= links and QR
    # Order-id prefix, so each branch numbers its own day: SPS-ADJ-261002-0001.
    # Blank only for Main, which keeps the original SPS-YYMMDD-#### so the ids
    # already printed on bills stay in the same sequence.
    code = ndb.StringProperty(default="")
    is_main = ndb.BooleanProperty(default=False)

    address = ndb.TextProperty(default="")
    phone = ndb.StringProperty(default="")
    timings = ndb.StringProperty(default="")          # free text, "11 am – 11 pm"
    map_url = ndb.StringProperty(default="")

    # The branch's own UPI merchant. Each outlet has its own GPay-for-Business
    # account, so the money lands where the food was made. Any field left blank
    # falls back to the shop-wide one from config — that is how Main keeps
    # working without the owner typing its details in again.
    upi_vpa = ndb.StringProperty(default="")          # pa
    upi_payee_name = ndb.StringProperty(default="")   # name shown to the customer
    upi_pn = ndb.StringProperty(default="")           # pn, the account's registered name
    upi_merchant_code = ndb.StringProperty(default="")  # mc
    upi_merchant_aid = ndb.StringProperty(default="")   # aid

    # Per-branch switches. Ordering lives here rather than on the global Setting
    # because one kitchen closing early must not close the other.
    ordering_enabled = ndb.BooleanProperty(default=True)
    menu_same_as_main = ndb.BooleanProperty(default=True)

    active = ndb.BooleanProperty(default=True)
    sort_order = ndb.IntegerProperty(default=0)
    created_at = ndb.DateTimeProperty(auto_now_add=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    @classmethod
    def main(cls) -> "Branch":
        """The main branch, created on first use.

        Created lazily rather than by a migration so a database that predates
        branches needs no script run before deploy: the first request makes
        Main, copies the old shop-wide ordering switch onto it, and every order,
        user and delivery area without a branch id is read as belonging to it.
        """
        b = cls.get_by_id(MAIN_ID)
        if b is not None:
            return b
        from .setting import Setting
        was_open = Setting.singleton().ordering_enabled is not False

        @ndb.transactional()
        def create() -> "Branch":
            row = cls.get_by_id(MAIN_ID)
            if row is None:
                row = cls(id=MAIN_ID, name="Main", slug="main", code="", is_main=True,
                          ordering_enabled=was_open)
                row.put()
            return row
        return create()

    @classmethod
    def ordered(cls, active_only: bool = False) -> list["Branch"]:
        rows = [b for b in cls.query() if b.active or not active_only]
        return sorted(rows, key=lambda b: (not b.is_main, b.sort_order or 0, b.name.lower()))

    def uses_own_menu(self) -> bool:
        return not self.is_main and self.menu_same_as_main is False

    def to_public(self) -> dict:
        """What a customer's browser may see — no merchant ids beyond the VPA,
        which the QR prints anyway."""
        return {
            "id": self.key.id(),
            "name": self.name,
            "slug": self.slug,
            "is_main": bool(self.is_main),
            "address": self.address,
            "phone": self.phone,
            "timings": self.timings,
            "map_url": self.map_url,
            "ordering_enabled": self.ordering_enabled is not False,
        }

    def to_dict(self) -> dict:
        return {
            **self.to_public(),
            "code": self.code,
            "upi_vpa": self.upi_vpa,
            "upi_payee_name": self.upi_payee_name,
            "upi_pn": self.upi_pn,
            "upi_merchant_code": self.upi_merchant_code,
            "upi_merchant_aid": self.upi_merchant_aid,
            "menu_same_as_main": self.menu_same_as_main is not False,
            "active": self.active,
            "sort_order": self.sort_order or 0,
        }


class VariantOverride(ndb.Model):
    """One variant priced or stocked differently at this branch.

    `price` None means "the master price" — a branch can switch a variant off
    without having to restate what it costs.
    """

    base = ndb.StringProperty(default="")
    size = ndb.StringProperty(default="")
    price = ndb.FloatProperty()
    available = ndb.BooleanProperty(default=True)

    def to_dict(self) -> dict:
        return {"base": self.base, "size": self.size, "price": self.price,
                "available": self.available is not False}


class BranchMenu(ndb.Model):
    """A branch's differences for one item. Keyed "{branch_id}:{item_id}" so a
    whole cart's overrides come back from one get_multi, never a query."""

    branch_id = ndb.IntegerProperty(required=True)
    item_id = ndb.IntegerProperty(required=True)
    hidden = ndb.BooleanProperty(default=False)       # not sold at this branch (own menu only)
    sold_out = ndb.BooleanProperty(default=False)     # whole item out at this branch, today
    overrides = ndb.LocalStructuredProperty(VariantOverride, repeated=True)
    updated_at = ndb.DateTimeProperty(auto_now=True)

    @staticmethod
    def key_for(branch_id: int, item_id: int) -> ndb.Key:
        return ndb.Key(BranchMenu, f"{branch_id}:{item_id}")

    def is_empty(self) -> bool:
        """Nothing here differs from Main's menu with everything in stock."""
        return not self.hidden and not self.sold_out and not self.overrides

    def override_for(self, base: str, size: str) -> VariantOverride | None:
        for o in self.overrides:
            if o.base == base and o.size == size:
                return o
        return None

    def to_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "hidden": bool(self.hidden),
            "sold_out": bool(self.sold_out),
            "overrides": [o.to_dict() for o in self.overrides],
        }
