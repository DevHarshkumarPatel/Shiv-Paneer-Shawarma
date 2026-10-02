"""Which branch a request is about, and what that branch's menu looks like.

Two kinds of caller, two rules:

* A customer's browser names its branch (`?branch=<slug or id>`) — from the QR
  on the table, a link, or the picker. Nothing they can name gives them more
  than a different menu, so it is taken at its word. No branch named means Main.
* A staff login never names anything. Its branch is the one on its own User row,
  read fresh on every request; whatever the browser sends is ignored. Only the
  owner chooses, and the owner may also choose "all branches" for the screens
  that read (the board, the customer list, the edit log). Anything that writes
  an order needs one actual branch.
"""
from fastapi import HTTPException, status
from google.cloud import ndb

from ..models import Branch, BranchMenu, Item, Order

ALL = None   # an owner scope meaning every branch


def _lookup(ref: str | int | None) -> Branch | None:
    ref = str(ref or "").strip()
    if not ref:
        return None
    if ref.isdigit():
        b = Branch.get_by_id(int(ref))
        if b:
            return b
    return Branch.query(Branch.slug == ref.lower()).get()


def public_branch(ref: str | None) -> Branch:
    """The branch a customer page is talking to. Blank means Main; an unknown
    or switched-off branch is refused, so a stale QR cannot take an order for
    an outlet that has closed."""
    if not (ref or "").strip():
        return Branch.main()
    b = _lookup(ref)
    if not b or not b.active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That branch is not available.")
    return b


def order_branch_id(order: Order, main_id: int | None = None) -> int:
    """An order's branch, reading orders from before branches as Main's."""
    return order.branch_id or (main_id if main_id is not None else Branch.main().key.id())


def user_branch(user) -> Branch:
    """A staff member's own branch. Falls back to Main for a login made before
    branches, or one whose branch was switched off — they still need to work."""
    if user.branch_id:
        b = Branch.get_by_id(user.branch_id)
        if b and b.active:
            return b
    return Branch.main()


def scope(user, ref: str | None) -> int | None:
    """The branch id a staff screen reads, or ALL for an owner looking at every
    branch. Staff always get their own branch, whatever was asked for."""
    if user.role != "owner":
        return user_branch(user).key.id()
    b = _lookup(ref)
    return b.key.id() if b else ALL


def write_branch(user, ref: str | None) -> Branch:
    """The branch a new order is written for. The owner must have picked one:
    an order stamped with a guessed branch is a bill in the wrong till."""
    if user.role != "owner":
        return user_branch(user)
    b = _lookup(ref)
    if not b or not b.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Pick the branch this order is for (top of the screen).")
    return b


def in_scope(order: Order, scope_id: int | None, main_id: int) -> bool:
    return scope_id is ALL or order_branch_id(order, main_id) == scope_id


def ensure_visible(user, order: Order | None) -> Order:
    """404 for an order outside a staff member's branch — the same answer as an
    order that does not exist, so ids from another branch cannot be probed."""
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    if user.role != "owner" and order_branch_id(order) != user_branch(user).key.id():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order


# ---- Menu --------------------------------------------------------------

def menu_overrides(branch: Branch, item_ids) -> dict[int, BranchMenu]:
    """This branch's differences for the given items, in one batch read.
    Empty for Main and for any branch selling the master menu as it is."""
    ids = list(dict.fromkeys(int(i) for i in item_ids))
    if not ids or not branch.uses_own_menu():
        return {}
    bid = branch.key.id()
    rows = ndb.get_multi([BranchMenu.key_for(bid, i) for i in ids])
    return {r.item_id: r for r in rows if r}


def localise_item(item_dict: dict, bm: BranchMenu | None) -> dict | None:
    """An item as this branch sells it, from its master `to_dict()`.

    None when the branch does not sell it. A variant switched off here is
    marked sold out, not removed: the customer sees the grid they know, with
    one square unavailable today. The item is sold out only when the master
    says so or every variant is.
    """
    if bm is None:
        return item_dict
    if bm.hidden:
        return None
    variants = []
    for v in item_dict["variants"]:
        ov = bm.override_for(v["base"], v["size"])
        if ov:
            v = {**v,
                 "price": ov.price if ov.price is not None else v["price"],
                 "available": v["available"] and ov.available is not False}
        variants.append(v)
    prices = [v["price"] for v in variants]
    return {
        **item_dict,
        "variants": variants,
        "base_price": min(prices) if prices else 0.0,
        "available": item_dict["available"] and any(v["available"] for v in variants),
    }


def branch_price(item: Item, variant, bm: BranchMenu | None) -> tuple[float, bool]:
    """(price, sellable) of one master variant at a branch."""
    ov = bm.override_for(variant.base, variant.size) if bm else None
    if not ov:
        return float(variant.price), True
    price = float(ov.price) if ov.price is not None else float(variant.price)
    return price, ov.available is not False
