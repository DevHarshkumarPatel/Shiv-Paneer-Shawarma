"""Owner-only customer insight: who comes back, and what they come back for.

There is no Customer entity in the datastore — an order carries the customer's
details inline, and nobody signs up before ordering. So a "customer" here is
derived: every order that shares a phone number is the same person. The phone
is the only field a customer must give on every order type, and it is the one
they retype consistently; names get abbreviated and addresses change.

Everything is aggregated on read rather than kept in a rolled-up entity. That
keeps a single source of truth (the orders) and means an edited or cancelled
order is reflected immediately, at the cost of scanning the window's orders per
request. The window (`days`) bounds that scan against the created_at index, so
the default view never walks the entire order history.
"""
import re
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Order

router = APIRouter(prefix="/api/admin/customers", tags=["admin-customers"])

# A cancelled order still says the person tried to buy, so it counts towards
# how often they order — but never towards money taken.
CANCELLED = "cancelled"

IST_OFFSET = timedelta(hours=5, minutes=30)

# Hard ceiling on entities read in one request, so a runaway history can never
# turn one dashboard load into an unbounded datastore bill.
SCAN_CAP = 4000

# Someone is "repeat" from their second order onwards.
REPEAT_AT = 2

# A regular is expected back roughly every `avg_gap` days. Below this many days
# the gap is too noisy to predict on, so lapsing is judged against this floor.
MIN_LAPSE_DAYS = 21

SORTS = {"recent", "orders", "spend", "name"}


def _norm_phone(raw: str) -> str:
    """Digits only, last 10 kept — one identity per person.

    The same customer types 9876543210, +91 98765 43210 and 098765-43210 across
    three orders. Without this they would show up as three one-time customers,
    which is exactly the thing this page exists to disprove.
    """
    digits = re.sub(r"\D", "", raw or "")
    return digits[-10:] if len(digits) >= 10 else digits


def _item_key(item) -> tuple[str, str]:
    return (item.name or "", item.variant_label or "")


class _Agg:
    """Running totals for one phone number."""

    def __init__(self, phone: str):
        self.phone = phone
        self.name = ""
        self.orders = 0
        self.cancelled = 0
        self.spend = 0.0
        self.first_at: datetime | None = None
        self.last_at: datetime | None = None
        self.types: dict[str, int] = defaultdict(int)
        self.items: dict[tuple[str, str], dict] = {}
        self.addresses: list[str] = []
        self.dates: list[datetime] = []
        self.coupons: dict[str, int] = defaultdict(int)
        self.last_order: dict | None = None

    def add(self, o: Order) -> None:
        c = o.customer
        self.orders += 1
        if o.status == CANCELLED:
            self.cancelled += 1
        else:
            self.spend += o.total or 0.0
        # Latest non-empty name wins: people correct their own spelling, and the
        # most recent version is the one the owner heard on the phone last.
        if c and (c.name or "").strip():
            self.name = c.name.strip()
        if o.created_at:
            self.dates.append(o.created_at)
            if not self.first_at or o.created_at < self.first_at:
                self.first_at = o.created_at
            if not self.last_at or o.created_at > self.last_at:
                self.last_at = o.created_at
                self.last_order = {
                    "public_id": o.public_id,
                    "status": o.status,
                    "total": o.total,
                    "order_type": o.order_type,
                    "created_at": o.created_at.isoformat(),
                }
        self.types[o.order_type] += 1
        if o.coupon_code:
            self.coupons[o.coupon_code] += 1
        addr = " ".join((c.address or "").split()) if c else ""
        if addr and addr not in self.addresses:
            self.addresses.append(addr)
        if o.status != CANCELLED:
            for it in o.items:
                key = _item_key(it)
                row = self.items.setdefault(
                    key,
                    {"name": it.name, "variant_label": it.variant_label or "",
                     "quantity": 0, "free_quantity": 0, "spend": 0.0, "orders": 0},
                )
                row["quantity"] += it.quantity or 0
                row["free_quantity"] += it.free_quantity or 0
                row["spend"] += it.line_total or 0.0
                row["orders"] += 1

    # ---- derived ----

    @property
    def paid_orders(self) -> int:
        return self.orders - self.cancelled

    def avg_gap_days(self) -> float | None:
        """Mean days between consecutive orders. None for a one-time customer."""
        if len(self.dates) < 2:
            return None
        first, last = min(self.dates), max(self.dates)
        return round((last - first).total_seconds() / 86400 / (len(self.dates) - 1), 1)

    def top_items(self, n: int = 3) -> list[dict]:
        rows = sorted(self.items.values(), key=lambda r: (-r["quantity"], -r["spend"], r["name"]))
        return rows[:n]

    def favourite_type(self) -> str:
        if not self.types:
            return ""
        return max(self.types.items(), key=lambda kv: kv[1])[0]

    def to_dict(self, now: datetime) -> dict:
        days_since = (now - self.last_at).days if self.last_at else None
        gap = self.avg_gap_days()
        # "Lapsed" only means something for someone with a rhythm to break.
        lapsed = bool(
            gap and days_since is not None and days_since > max(gap * 2, MIN_LAPSE_DAYS)
        )
        return {
            "phone": self.phone,
            "name": self.name or "Guest",
            "orders": self.orders,
            "cancelled": self.cancelled,
            "total_spent": round(self.spend, 2),
            "avg_order": round(self.spend / self.paid_orders, 2) if self.paid_orders else 0.0,
            "first_order_at": self.first_at.isoformat() if self.first_at else None,
            "last_order_at": self.last_at.isoformat() if self.last_at else None,
            "days_since_last": days_since,
            "avg_gap_days": gap,
            "lapsed": lapsed,
            "is_repeat": self.orders >= REPEAT_AT,
            "types": dict(self.types),
            "favourite_type": self.favourite_type(),
            "top_items": self.top_items(),
            "last_order": self.last_order,
        }


def _scan(days: int | None) -> tuple[dict[str, _Agg], int, bool]:
    """Aggregate orders in the window by phone.

    Returns (by_phone, orders_seen, truncated).
    """
    q = Order.query().order(-Order.created_at)
    if days:
        since = datetime.utcnow() - timedelta(days=days)
        q = Order.query(Order.created_at >= since).order(-Order.created_at)

    by_phone: dict[str, _Agg] = {}
    seen = 0
    truncated = False
    for o in q:
        if seen >= SCAN_CAP:
            truncated = True
            break
        seen += 1
        phone = _norm_phone(o.customer.phone if o.customer else "")
        if not phone:
            # No phone, no identity. A walk-in dine-in order with nothing typed
            # cannot be attributed, and guessing by name would merge strangers.
            continue
        by_phone.setdefault(phone, _Agg(phone)).add(o)
    return by_phone, seen, truncated


@router.get("")
def list_customers(
    _owner=Depends(require_owner),
    days: int = 365,
    repeat_only: bool = True,
    sort: str = "recent",
    q: str | None = None,
    limit: int = 200,
):
    """Customers in the window, with the store-wide summary alongside.

    The summary rides along on this response on purpose: computing it needs the
    same scan, and a second endpoint would double the datastore reads for one
    screen. `days=0` means the whole history.
    """
    if sort not in SORTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"sort must be one of {sorted(SORTS)}.")

    by_phone, seen, truncated = _scan(days if days > 0 else None)
    now = datetime.utcnow()
    rows = [a.to_dict(now) for a in by_phone.values()]

    # Summary is over everyone in the window, before the repeat/search filters,
    # so "repeat rate" stays a rate and not a tautology.
    repeat_rows = [r for r in rows if r["is_repeat"]]
    total_revenue = sum(r["total_spent"] for r in rows)
    repeat_revenue = sum(r["total_spent"] for r in repeat_rows)
    summary = {
        "customers": len(rows),
        "repeat_customers": len(repeat_rows),
        "repeat_rate": round(len(repeat_rows) / len(rows) * 100, 1) if rows else 0.0,
        "orders_scanned": seen,
        "total_revenue": round(total_revenue, 2),
        "repeat_revenue": round(repeat_revenue, 2),
        "repeat_revenue_share": round(repeat_revenue / total_revenue * 100, 1) if total_revenue else 0.0,
        "avg_orders_per_customer": round(sum(r["orders"] for r in rows) / len(rows), 1) if rows else 0.0,
        "lapsed_regulars": sum(1 for r in repeat_rows if r["lapsed"]),
        "truncated": truncated,
        "window_days": days if days > 0 else None,
    }

    if repeat_only:
        rows = repeat_rows
    if q:
        needle = q.strip().lower()
        digits = re.sub(r"\D", "", needle)
        rows = [
            r for r in rows
            if needle in r["name"].lower() or (digits and digits in r["phone"])
        ]

    keys = {
        "recent": lambda r: (r["last_order_at"] or "", r["orders"]),
        "orders": lambda r: (r["orders"], r["total_spent"]),
        "spend": lambda r: (r["total_spent"], r["orders"]),
    }
    if sort == "name":
        rows.sort(key=lambda r: r["name"].lower())
    else:
        rows.sort(key=keys[sort], reverse=True)

    return {"summary": summary, "customers": rows[:limit]}


@router.get("/{phone}")
def customer_detail(phone: str, _owner=Depends(require_owner), days: int = 0):
    """One customer's full history. Defaults to their entire history, not the
    list's window — once the owner has opened a specific person, the question
    is "everything about them", not "them this year"."""
    key = _norm_phone(phone)
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A 10-digit phone number is required.")

    now = datetime.utcnow()
    q = Order.query().order(-Order.created_at)
    if days > 0:
        q = Order.query(Order.created_at >= now - timedelta(days=days)).order(-Order.created_at)

    # One pass builds both the totals and the order list: the aggregate and the
    # history are the same entities read twice otherwise.
    agg = _Agg(key)
    orders: list[dict] = []
    seen = 0
    for o in q:
        if seen >= SCAN_CAP:
            break
        seen += 1
        if _norm_phone(o.customer.phone if o.customer else "") != key:
            continue
        agg.add(o)
        # No customer block: it would just repeat the header of the sheet.
        orders.append(o.to_dict(include_customer=False))

    if not agg.orders:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No orders found for that number.")

    data = agg.to_dict(now)
    data["addresses"] = agg.addresses
    data["coupons"] = dict(agg.coupons)
    data["all_items"] = sorted(
        agg.items.values(), key=lambda r: (-r["quantity"], -r["spend"], r["name"])
    )
    data["orders_list"] = orders

    # Busiest ordering hour, in IST — tells the owner when this person shows up.
    hours: dict[int, int] = defaultdict(int)
    for d in agg.dates:
        hours[(d + IST_OFFSET).hour] += 1
    data["peak_hour"] = max(hours.items(), key=lambda kv: kv[1])[0] if hours else None

    return data
