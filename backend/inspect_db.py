"""Friendly read-only inspector for the Datastore (emulator or live).

Usage (with the emulator running / .env configured):
    python inspect_db.py            # summary counts
    python inspect_db.py summary
    python inspect_db.py menu       # categories -> items with prices
    python inspect_db.py orders     # recent orders
    python inspect_db.py users      # staff/owner accounts
    python inspect_db.py coupons    # coupons
    python inspect_db.py all        # everything
"""
import sys

from app.db import db_context
from app.models import User, Category, Item, Promo, Coupon, Order


def _rupees(n) -> str:
    n = float(n or 0)
    return f"Rs{n:.0f}" if n == int(n) else f"Rs{n:.2f}"


def summary():
    counts = {
        "Users": User.query().count(),
        "Categories": Category.query().count(),
        "Items": Item.query().count(),
        "Promos": Promo.query().count(),
        "Coupons": Coupon.query().count(),
        "Orders": Order.query().count(),
    }
    print("\n  DATABASE SUMMARY")
    print("  " + "-" * 26)
    for k, v in counts.items():
        print(f"  {k:<12} {v:>6}")
    print()


def users():
    print("\n  USERS")
    print("  " + "-" * 50)
    for u in User.query():
        flag = "" if u.active else "  (inactive)"
        print(f"  [{u.role:<5}] {u.email}{flag}")
    print()


def menu():
    print("\n  MENU")
    print("  " + "-" * 60)
    cats = sorted(Category.query(), key=lambda c: (c.sort_order, c.name))
    items = list(Item.query())
    for c in cats:
        badge = f"  ({c.offer_badge})" if c.offer_badge else ""
        status = "" if c.active else "  [hidden]"
        print(f"\n  # {c.name}{badge}{status}")
        cat_items = sorted([i for i in items if i.category_id == c.key.id()],
                           key=lambda i: (i.sort_order, i.name))
        if not cat_items:
            print("      (no items)")
        for it in cat_items:
            prices = [v.price for v in it.variants]
            if prices:
                rng = _rupees(min(prices)) if min(prices) == max(prices) else f"{_rupees(min(prices))}-{_rupees(max(prices))}"
            else:
                rng = "-"
            tag = "" if it.active else " [hidden]"
            print(f"      - {it.name:<26} {rng:<16} {len(it.variants)} variant(s){tag}")
    print()


def orders():
    print("\n  RECENT ORDERS")
    print("  " + "-" * 78)
    rows = sorted(Order.query(), key=lambda o: o.created_at or 0, reverse=True)[:30]
    if not rows:
        print("  (no orders yet)")
        print()
        return
    print(f"  {'ORDER ID':<18}{'TYPE':<10}{'STATUS':<13}{'PAYMENT':<22}{'TOTAL':>8}")
    for o in rows:
        pay = f"{o.payment.method}/{o.payment.status}" if o.payment else "-"
        print(f"  {o.public_id:<18}{o.order_type:<10}{o.status:<13}{pay:<22}{_rupees(o.total):>8}")
    print()


def coupons():
    print("\n  COUPONS")
    print("  " + "-" * 50)
    rows = list(Coupon.query())
    if not rows:
        print("  (none)")
    for c in rows:
        disc = f"{c.value:g}%" if c.ctype == "percent" else _rupees(c.value)
        state = "active" if c.active else "off"
        print(f"  {c.code:<12} {disc:<8} min {_rupees(c.min_order):<8} used {c.used_count}  ({state})")
    print()


ACTIONS = {
    "summary": summary, "users": users, "menu": menu,
    "orders": orders, "coupons": coupons,
}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "summary"
    with db_context():
        if action == "all":
            for fn in (summary, users, menu, coupons, orders):
                fn()
        elif action in ACTIONS:
            ACTIONS[action]()
        else:
            print(f"Unknown option '{action}'. Try: {', '.join(ACTIONS)} or all")


if __name__ == "__main__":
    main()
