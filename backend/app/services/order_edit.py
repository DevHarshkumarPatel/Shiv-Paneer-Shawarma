"""Editing an order that has already been placed, and the log that leaves.

An order on this system is two promises at once: food the kitchen is about to
make, and money the customer is about to hand over. Both of them get corrected
at the counter — a wrong size, one more shawarma, a number typed with a digit
missing, cash that turned out to be UPI. Doing that by overwriting the order
would be the easy half; the half that matters is that afterwards anyone can
still see what the bill used to say, who changed it and when.

So every save writes an `OrderEdit` onto the order: the fields that actually
moved, each with its old and new value, the totals either side, the email of
whoever saved it, and the time (naive UTC, shown as IST by the staff screens,
like every other timestamp here). Nothing is ever removed from that list.
"""
import json

from ..models.order import OrderEdit

# How many edits an order keeps. Well past anything a real order sees — it is
# here only so one screen left open with a stuck finger cannot grow a single
# entity towards the 1 MB Datastore limit. The oldest go first.
EDIT_LOG_CAP = 60

TYPE_LABEL = {"dine_in": "Dine-in", "takeaway": "Takeaway", "delivery": "Delivery"}
PAY_METHOD_LABEL = {"cash": "Cash", "upi": "UPI"}
PAY_STATUS_LABEL = {
    "pending": "Unpaid",
    "awaiting_verification": "Awaiting verification",
    "paid": "Paid",
    "failed": "Failed",
}

# The plain fields an edit may touch, in the order they read best in the log:
# what was ordered, who it is for, then what it cost.
FIELDS = [
    ("order_type", "Order type", "text"),
    ("customer_name", "Customer name", "text"),
    ("customer_phone", "Phone", "text"),
    ("customer_address", "Address", "text"),
    ("delivery_area", "Delivery area", "text"),
    ("coupon_code", "Coupon", "text"),
    ("payment_method", "Payment method", "text"),
    ("payment_status", "Payment status", "text"),
    ("upi_reference", "UPI reference", "text"),
    ("notes", "Kitchen note", "text"),
    ("subtotal", "Subtotal", "money"),
    ("topups_total", "Add-ons", "money"),
    ("promo_discount", "Offer discount", "money"),
    ("coupon_discount", "Coupon discount", "money"),
    ("delivery_fee", "Delivery fee", "money"),
    ("total", "Total", "money"),
]


def _line_key(item) -> str:
    return f"{item.item_id}|{item.base or ''}|{item.size or ''}"


def _line_label(item) -> str:
    return f"{item.name} · {item.variant_label}" if item.variant_label else item.name


def _topup_key(topup) -> str:
    """Identity of an add-on line. Falls back to the name for an add-on the
    owner has since deleted, which still has to diff against itself."""
    return str(topup.topup_id or topup.name)


def snapshot(order) -> dict:
    """Everything about an order that an edit is allowed to move.

    Deliberately flat and made of plain values: it is taken before the order is
    touched and compared with a second one taken after, and a snapshot holding
    live NDB sub-entities would quietly change under the first one.
    """
    c = order.customer
    p = order.payment
    return {
        "order_type": order.order_type or "",
        "items": {
            _line_key(i): {"label": _line_label(i), "quantity": i.quantity}
            for i in order.items
        },
        "topups": {
            _topup_key(t): {"label": t.name, "quantity": t.quantity}
            for t in (order.topups or [])
        },
        "customer_name": (c.name if c else "") or "",
        "customer_phone": (c.phone if c else "") or "",
        "customer_address": (c.address if c else "") or "",
        "delivery_area": order.delivery_area or "",
        "coupon_code": order.coupon_code or "",
        "payment_method": (p.method if p else "") or "",
        "payment_status": (p.status if p else "") or "",
        "upi_reference": (p.upi_reference if p else "") or "",
        "notes": order.notes or "",
        "subtotal": round(order.subtotal or 0.0, 2),
        "promo_discount": round(order.promo_discount or 0.0, 2),
        "coupon_discount": round(order.coupon_discount or 0.0, 2),
        "delivery_fee": round(order.delivery_fee or 0.0, 2),
        "topups_total": round(order.topups_total or 0.0, 2),
        "total": round(order.total or 0.0, 2),
    }


def _pretty(field: str, value) -> str:
    """The value as the log should read it, not as the database stores it."""
    if field == "order_type":
        return TYPE_LABEL.get(value, value or "")
    if field == "payment_method":
        return PAY_METHOD_LABEL.get(value, value or "")
    if field == "payment_status":
        return PAY_STATUS_LABEL.get(value, value or "")
    if isinstance(value, float):
        return f"{value:.2f}"
    return "" if value is None else str(value)


def _line_changes(before: dict, after: dict, noun: str) -> list[dict]:
    """Added, removed and re-counted lines, one entry each.

    One row per line rather than a before/after dump of the whole ticket: the
    question being asked of this log months later is "what did we add to this
    order", and a diff of two long item lists does not answer it.

    `noun` is what the rows call the thing — the same walk reads the food lines
    and the add-ons, and the log has to keep them apart ("extra cheese was
    added" is a different conversation from "a shawarma was added").
    """
    changes = []
    for key, now in after.items():
        was = before.get(key)
        if was is None:
            changes.append({"label": f"{noun} added", "old": "",
                            "new": f"{now['quantity']} × {now['label']}", "kind": "text"})
        elif was["quantity"] != now["quantity"]:
            changes.append({"label": f"Quantity · {now['label']}",
                            "old": f"{was['quantity']} ×", "new": f"{now['quantity']} ×",
                            "kind": "text"})
    for key, was in before.items():
        if key not in after:
            changes.append({"label": f"{noun} removed",
                            "old": f"{was['quantity']} × {was['label']}", "new": "",
                            "kind": "text"})
    return changes


def diff(before: dict, after: dict) -> list[dict]:
    """The changes between two snapshots, as rows a person can read."""
    changes = _line_changes(before["items"], after["items"], "Item")
    # `.get`, not `[...]`: a snapshot taken by an older build of this module has
    # no add-ons key, and an edit must not fail on an order placed last week.
    changes += _line_changes(before.get("topups", {}), after.get("topups", {}), "Add-on")
    for field, label, kind in FIELDS:
        old, new = before.get(field), after.get(field)
        if old == new:
            continue
        changes.append({"label": label, "old": _pretty(field, old),
                        "new": _pretty(field, new), "kind": kind})
    return changes


def record_edit(order, before: dict, user) -> list[dict]:
    """Append this save to the order's edit log. Returns the changes recorded.

    An empty list means the save moved nothing — the caller decides what to do
    about that (this module writes no entry for it, because a log full of
    "opened the screen and pressed Save" hides the edits that mattered).
    """
    after = snapshot(order)
    changes = diff(before, after)
    if not changes:
        return []
    order.edits.append(OrderEdit(
        by=user.email,
        by_role=user.role,
        changes_json=json.dumps(changes, ensure_ascii=False),
        total_before=before["total"],
        total_after=after["total"],
    ))
    if len(order.edits) > EDIT_LOG_CAP:
        order.edits = order.edits[-EDIT_LOG_CAP:]
    return changes
