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


def read_branch(user, ref: str | None) -> Branch:
    """One branch for a staff screen that needs exactly one (the counter's
    add-on list). Staff get their own; the owner gets the one picked, or Main
    while "All branches" is picked."""
    if user.role != "owner":
        return user_branch(user)
    b = _lookup(ref)
    return b if b and b.active else Branch.main()


def clean_branch_ids(raw) -> list[int]:
    """Branch ids that exist, de-duplicated. Empty means every branch."""
    known = {b.key.id() for b in Branch.query()}
    return [b for b in dict.fromkeys(int(x) for x in raw or []) if b in known]


# Per-branch shop switches (see models/branch.py). Unset on Main reads the old
# global Setting, so an existing shop keeps what it had; unset elsewhere reads
# the Setting's default.
BRANCH_FLAGS = ("promo_banners_enabled", "scratch_enabled", "scratch_repeat_batch", "scratch_batch_no")


def flag(branch: Branch, name: str):
    value = getattr(branch, name)
    if value is not None:
        return value
    from ..models import Setting
    if branch.is_main:
        return getattr(Setting.singleton(), name)
    return Setting._properties[name]._default


def flags(branch: Branch) -> dict:
    d = {n: flag(branch, n) for n in BRANCH_FLAGS}
    d["scratch_batch_no"] = d["scratch_batch_no"] or 1
    return d


# ---- Menu --------------------------------------------------------------
#
# Two separate things come out of a branch's BranchMenu row:
#   * menu  — its own prices and the items it does not sell. Used only when the
#             branch has "same menu & prices as Main" turned off.
#   * stock — what is sold out there right now. Always its own: the master
#             Item/Variant stock flags are Main's shelf, not every branch's.

def menu_overrides(branch: Branch, item_ids) -> dict[int, BranchMenu]:
    """This branch's rows for the given items, in one batch read. Empty for
    Main, whose prices and stock are the master's own."""
    ids = list(dict.fromkeys(int(i) for i in item_ids))
    if not ids or branch.is_main:
        return {}
    bid = branch.key.id()
    rows = ndb.get_multi([BranchMenu.key_for(bid, i) for i in ids])
    return {r.item_id: r for r in rows if r}


def _variant_stock(bm: BranchMenu | None, base: str, size: str) -> bool:
    ov = bm.override_for(base, size) if bm else None
    return not ov or ov.available is not False


def localise_item(item_dict: dict, bm: BranchMenu | None, branch: Branch) -> dict | None:
    """An item as this branch sells it, from its master `to_dict()`.

    None when the branch does not sell it. A variant out of stock here is
    marked sold out, not removed: the customer sees the grid they know, with
    one square unavailable today.
    """
    if branch.is_main:
        return item_dict
    own = branch.uses_own_menu()
    if own and bm and bm.hidden:
        return None
    variants = []
    for v in item_dict["variants"]:
        ov = bm.override_for(v["base"], v["size"]) if bm else None
        price = ov.price if own and ov and ov.price is not None else v["price"]
        variants.append({**v, "price": price, "available": _variant_stock(bm, v["base"], v["size"])})
    prices = [v["price"] for v in variants]
    return {
        **item_dict,
        "variants": variants,
        "base_price": min(prices) if prices else 0.0,
        "available": not (bm and bm.sold_out) and any(v["available"] for v in variants),
    }


def item_on_sale(item: Item, bm: BranchMenu | None, branch: Branch) -> bool:
    """Whether the item as a whole can be ordered at this branch right now."""
    if branch.is_main:
        return item.is_available()
    if bm and (bm.sold_out or (bm.hidden and branch.uses_own_menu())):
        return False
    return any(_variant_stock(bm, v.base, v.size) for v in item.variants)


def branch_price(item: Item, variant, bm: BranchMenu | None, branch: Branch) -> tuple[float, bool]:
    """(price, in stock) of one master variant at a branch."""
    if branch.is_main:
        return float(variant.price), variant.is_available()
    ov = bm.override_for(variant.base, variant.size) if bm else None
    price = float(variant.price)
    if ov and ov.price is not None and branch.uses_own_menu():
        price = float(ov.price)
    return price, _variant_stock(bm, variant.base, variant.size)
