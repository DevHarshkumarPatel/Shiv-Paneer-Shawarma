"""Seed the datastore with the reference menu, staff/owner users, promos and a coupon.

Run (with the emulator running and .env configured):
    python seed.py            # create if empty
    python seed.py --reset    # wipe menu/orders/coupons/promos first, then seed
"""
import sys

from app.db import db_context
from app.config import settings
from app.models import (
    User, Category, Subcategory, Item, Variant, Promo, Coupon, Order, Counter,
    DeliveryArea,
)
from app.security import hash_password


# base x size grid for Shawarma / Cheese Delights
def wheat_millet(reg: int, exo: int) -> list[Variant]:
    return [
        Variant(base="Whole Wheat", size="Regular", price=float(reg)),
        Variant(base="Whole Wheat", size="Exotic", price=float(exo)),
        Variant(base="Millets", size="Regular", price=float(reg)),
        Variant(base="Millets", size="Exotic", price=float(exo)),
    ]


# size-only grid for Kullad
def size_only(reg: int, exo: int) -> list[Variant]:
    return [
        Variant(base="", size="Regular", price=float(reg)),
        Variant(base="", size="Exotic", price=float(exo)),
    ]


def single(price: int) -> list[Variant]:
    return [Variant(base="", size="", price=float(price))]


MENU = [
    {
        "name": "Shawarma", "badge": "Buy 2 Get 1",
        "items": [
            {"name": "Signature Paneer", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(129, 159)},
            {"name": "Mexican Paneer", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(149, 179)},
            {"name": "Chilli Garlic Paneer", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(149, 179)},
            {"name": "Peri Peri Paneer", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(149, 179)},
        ],
    },
    {
        "name": "Cheese Delights", "badge": "Buy 2 Get 1",
        "items": [
            {"name": "Cheese Shawarma", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(149, 179)},
            {"name": "Cheese Chilli", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(179, 209)},
            {"name": "Shiv's Elite", "tags": ["Whole Wheat", "Millets"], "v": wheat_millet(199, 239)},
        ],
    },
    {
        "name": "Kullad", "badge": "Buy 2 Get 1",
        "items": [
            {"name": "Classic Kullad", "tags": [], "v": size_only(139, 159)},
            {"name": "Mexican Kullad", "tags": [], "v": size_only(169, 189)},
            {"name": "Cheese Crumble Kullad", "tags": [], "v": size_only(169, 189)},
            {"name": "Peri Peri Kullad", "tags": [], "v": size_only(169, 189)},
        ],
    },
    {
        "name": "Bowl", "badge": "Buy 2 Get 1",
        "items": [
            {"name": "Classic Paneer Bowl", "tags": [], "v": single(179)},
            {"name": "Peri Peri Paneer Bowl", "tags": [], "v": single(199)},
        ],
    },
]


def reset():
    for model in (Item, Subcategory, Category, Promo, Coupon, Order, Counter, DeliveryArea):
        keys = model.query().fetch(keys_only=True)
        if keys:
            from google.cloud import ndb
            ndb.delete_multi(keys)
    print("Wiped menu/orders/coupons/promos/counters.")


def seed_users():
    if not User.by_email(settings.owner_email):
        User(email=settings.owner_email.lower(), name="Owner",
             password_hash=hash_password(settings.owner_password), role="owner").put()
        print(f"Owner:  {settings.owner_email} / {settings.owner_password}")
    if not User.by_email(settings.staff_email):
        User(email=settings.staff_email.lower(), name="Staff",
             password_hash=hash_password(settings.staff_password), role="staff").put()
        print(f"Staff:  {settings.staff_email} / {settings.staff_password}")


def seed_menu():
    if Category.query().get():
        print("Menu already present; skipping (use --reset to rebuild).")
        return
    for ci, cat_def in enumerate(MENU):
        cat = Category(name=cat_def["name"], slug=cat_def["name"].lower().replace(" ", "-"),
                       offer_badge=cat_def["badge"], sort_order=ci, active=True)
        cat.put()
        for ii, it in enumerate(cat_def["items"]):
            Item(category_id=cat.key.id(), name=it["name"], tags=it["tags"],
                 variants=it["v"], veg=True, sort_order=ii, active=True).put()
        # Category-wide Buy-2-Get-1 promo.
        Promo(scope="category", target_id=cat.key.id(), ptype="b2g1",
              label="Buy 2 Get 1 Free", active=True).put()
        print(f"Category '{cat.name}' with {len(cat_def['items'])} items + B2G1 promo.")


def seed_coupon():
    if not Coupon.by_code("SHIV10"):
        Coupon(code="SHIV10", ctype="percent", value=10.0, min_order=200.0,
               max_discount=60.0, active=True).put()
        print("Coupon: SHIV10 (10% off, min ₹200, cap ₹60)")


def seed_delivery_areas():
    if DeliveryArea.query().get():
        print("Delivery areas already present; skipping.")
        return
    areas = [
        ("Near (0-3 km)", 20.0),
        ("Mid (3-6 km)", 40.0),
        ("Far (6-10 km)", 60.0),
    ]
    for i, (name, fee) in enumerate(areas):
        DeliveryArea(name=name, fee=fee, active=True, sort_order=i).put()
    print(f"Delivery areas: {', '.join(n for n, _ in areas)}")


def main():
    with db_context():
        if "--reset" in sys.argv:
            reset()
        seed_users()
        seed_menu()
        seed_coupon()
        seed_delivery_areas()
    print("Seed complete.")


if __name__ == "__main__":
    main()
