"""Branches: the public list, and everything the owner sets per branch.

Owner-only, all of it: the outlet's details and payment QR, its two switches
(taking orders, own menu or Main's), its price differences, and the staff logins
that work there. Branches are never deleted — orders point at them — so there is
no DELETE for a branch, only `active`.
"""
import re

from fastapi import APIRouter, Depends, HTTPException, status
from google.cloud import ndb

from ..deps import require_owner
from ..models import Branch, BranchMenu, Item, User, VariantOverride
from ..schemas.models import (
    AvailabilityPayload, BranchMenuPayload, BranchPayload, BranchStaffCreate, BranchStaffUpdate, PasswordUpdate,
)
from ..security import hash_password

router = APIRouter(tags=["branches"])


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def _get(branch_id: int) -> Branch:
    b = Branch.get_by_id(branch_id)
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Branch not found.")
    return b


def _staff_of(branch: Branch, main_id: int) -> list[User]:
    return [u for u in User.query()
            if u.role != "owner" and (u.branch_id or main_id) == branch.key.id()]


# ---- Public ----
@router.get("/api/branches")
def public_branches():
    """Branches a customer can pick. Switched-off ones are left out; one that
    is only closed for orders stays, so its menu can still be browsed."""
    Branch.main()   # make sure a fresh database has one to show
    return {"branches": [b.to_public() for b in Branch.ordered(active_only=True)]}


# ---- Owner: branch details ----
@router.get("/api/admin/branches")
def list_branches(_owner=Depends(require_owner)):
    main = Branch.main()
    main_id = main.key.id()
    users = [u for u in User.query() if u.role != "owner"]
    out = []
    for b in Branch.ordered():
        d = b.to_dict()
        d["staff_count"] = sum(1 for u in users if u.active and (u.branch_id or main_id) == b.key.id())
        out.append(d)
    return {"branches": out}


def _apply(branch: Branch, body: BranchPayload) -> None:
    """Validate and copy the payload onto `branch` (not yet saved)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give the branch a name.")
    slug = _slugify(body.slug or name)
    if not slug:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The link name needs a letter or a digit.")
    code = re.sub(r"[^A-Z0-9]", "", (body.code or "").upper())
    if not branch.is_main and not code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Give the branch a short code for its order ids, e.g. ADJ.")
    if len(code) > 6:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keep the code to 6 letters or fewer.")

    me = branch.key.id() if branch.key else None
    for other in Branch.query():
        if other.key.id() == me:
            continue
        if other.slug == slug:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Another branch already uses the link “{slug}”.")
        if code and (other.code or "") == code:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Another branch already uses the code {code}.")

    if branch.is_main and not body.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Main cannot be switched off — older orders and logins fall back to it.")

    branch.name = name
    branch.slug = slug
    # Main's code is left as it is: changing it would start a second sequence
    # of ids for the same till halfway through a day.
    if not branch.is_main or not branch.key:
        branch.code = code
    branch.address = body.address.strip()
    branch.phone = body.phone.strip()
    branch.timings = body.timings.strip()
    branch.map_url = body.map_url.strip()
    branch.upi_vpa = body.upi_vpa.strip()
    branch.upi_payee_name = body.upi_payee_name.strip()
    branch.upi_pn = body.upi_pn.strip()
    branch.upi_merchant_code = body.upi_merchant_code.strip()
    branch.upi_merchant_aid = body.upi_merchant_aid.strip()
    branch.ordering_enabled = body.ordering_enabled
    branch.menu_same_as_main = True if branch.is_main else body.menu_same_as_main
    branch.active = body.active
    branch.sort_order = body.sort_order


@router.post("/api/admin/branches", status_code=status.HTTP_201_CREATED)
def create_branch(body: BranchPayload, _owner=Depends(require_owner)):
    Branch.main()   # the first branch made by hand is never mistaken for Main
    b = Branch()
    _apply(b, body)
    b.put()
    return b.to_dict()


@router.put("/api/admin/branches/{branch_id}")
def update_branch(branch_id: int, body: BranchPayload, _owner=Depends(require_owner)):
    """Save a branch. Switching one off while staff are still attached is
    allowed — they fall back to Main until moved — but the reply says so."""
    b = _get(branch_id)
    was_active = b.active
    _apply(b, body)
    b.put()
    out = b.to_dict()
    if was_active and not b.active:
        n = len([u for u in _staff_of(b, Branch.main().key.id()) if u.active])
        if n:
            out["warning"] = (f"{n} staff login{'s' if n != 1 else ''} still belong to {b.name}; "
                              "they will see Main until you move them.")
    return out


# ---- Owner: the branch's menu differences ----
@router.get("/api/admin/branches/{branch_id}/menu")
def branch_menu(branch_id: int, _owner=Depends(require_owner)):
    b = _get(branch_id)
    rows = BranchMenu.query(BranchMenu.branch_id == b.key.id())
    return {
        "branch": b.to_dict(),
        "items": {str(r.item_id): r.to_dict() for r in rows},
    }


def _save_row(row: BranchMenu) -> dict:
    """Store the row, or delete it once nothing in it differs any more — so a
    master price change still reaches every branch that never changed it."""
    if row.is_empty():
        row.key.delete()
    else:
        row.put()
    return row.to_dict()


def _row(b: Branch, item_id: int) -> BranchMenu:
    key = BranchMenu.key_for(b.key.id(), item_id)
    return key.get() or BranchMenu(key=key, branch_id=b.key.id(), item_id=item_id)


def _stock_only(row: BranchMenu) -> None:
    """Drop the menu half of a row (prices, not-sold-here), keep its stock.
    Going back to Main's prices is a menu decision; it must not quietly put
    back on sale what this kitchen ran out of an hour ago."""
    row.hidden = False
    row.overrides = [VariantOverride(base=o.base, size=o.size, price=None, available=False)
                     for o in row.overrides if o.available is False]


@router.put("/api/admin/branches/{branch_id}/menu/{item_id}")
def set_branch_item(branch_id: int, item_id: int, body: BranchMenuPayload,
                    _owner=Depends(require_owner)):
    """Set how this branch sells one item: prices, not-sold-here, and stock
    per variant. Only real differences are stored. The item-level sold-out
    switch is left as it is — that is the Items tab's quick toggle."""
    b = _get(branch_id)
    if b.is_main:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Main sells the master menu — edit the item itself.")
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    master = {(v.base, v.size): v for v in item.variants}
    overrides = []
    for v in body.variants:
        mv = master.get((v.base, v.size))
        if not mv:
            continue      # a variant the master no longer has
        price = None if v.price is None or abs(v.price - mv.price) < 0.005 else round(v.price, 2)
        if price is None and v.available:
            continue
        overrides.append(VariantOverride(base=v.base, size=v.size, price=price,
                                         available=v.available))
    row = _row(b, item_id)
    row.hidden = body.hidden
    row.overrides = overrides
    return _save_row(row)


@router.patch("/api/admin/branches/{branch_id}/stock/{item_id}")
def set_branch_stock(branch_id: int, item_id: int, body: AvailabilityPayload,
                     _owner=Depends(require_owner)):
    """Sold out / back in stock at this branch only — the Items tab's quick
    toggle while a branch other than Main is picked. Prices are not touched."""
    b = _get(branch_id)
    if b.is_main:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Main's stock is the item's own switch.")
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    row = _row(b, item_id)
    row.sold_out = not body.available
    if body.variants is not None:
        if len(body.variants) != len(item.variants):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Variant availability list must match the item's variants.")
        kept = []
        for v, flag in zip(item.variants, body.variants):
            ov = row.override_for(v.base, v.size)
            price = ov.price if ov else None
            if price is not None or not flag:
                kept.append(VariantOverride(base=v.base, size=v.size, price=price, available=flag))
        row.overrides = kept
    return _save_row(row)


@router.delete("/api/admin/branches/{branch_id}/menu/{item_id}")
def reset_branch_item(branch_id: int, item_id: int, _owner=Depends(require_owner)):
    """Back to Main's prices for this item. Its stock here stays as it is."""
    row = BranchMenu.key_for(_get(branch_id).key.id(), item_id).get()
    if not row:
        return {"item_id": item_id, "hidden": False, "sold_out": False, "overrides": []}
    _stock_only(row)
    return _save_row(row)


@router.post("/api/admin/branches/{branch_id}/menu/reset")
def reset_branch_menu(branch_id: int, _owner=Depends(require_owner)):
    """Copy Main's menu again: every price and not-sold-here difference is
    dropped. What is sold out at this branch stays sold out."""
    b = _get(branch_id)
    rows = list(BranchMenu.query(BranchMenu.branch_id == b.key.id()))
    for row in rows:
        _stock_only(row)
    gone = [r.key for r in rows if r.is_empty()]
    if gone:
        ndb.delete_multi(gone)
    keep = [r for r in rows if not r.is_empty()]
    if keep:
        ndb.put_multi(keep)
    return {"ok": True, "cleared": len(rows)}


# ---- Owner: staff logins per branch ----
def _staff_public(u: User, main_id: int) -> dict:
    return {
        "id": u.key.id(), "email": u.email, "name": u.name, "active": u.active,
        "branch_id": u.branch_id or main_id,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@router.get("/api/admin/branches/{branch_id}/staff")
def branch_staff(branch_id: int, _owner=Depends(require_owner)):
    b = _get(branch_id)
    main_id = Branch.main().key.id()
    rows = sorted(_staff_of(b, main_id), key=lambda u: (not u.active, (u.email or "").lower()))
    return {"staff": [_staff_public(u, main_id) for u in rows]}


@router.post("/api/admin/branches/{branch_id}/staff", status_code=status.HTTP_201_CREATED)
def create_branch_staff(branch_id: int, body: BranchStaffCreate, _owner=Depends(require_owner)):
    """A staff login that works at this branch only. Owner logins are not made
    here — those stay on the setup-key page."""
    b = _get(branch_id)
    email = body.email.lower().strip()
    if User.by_email(email):
        raise HTTPException(status.HTTP_409_CONFLICT, "A login with this email already exists.")
    u = User(email=email, name=body.name.strip(), role="staff", active=True,
             branch_id=b.key.id(), password_hash=hash_password(body.password))
    u.put()
    return _staff_public(u, Branch.main().key.id())


def _staff_user(user_id: int) -> User:
    u = User.get_by_id(user_id)
    if not u or u.role == "owner":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staff login not found.")
    return u


@router.put("/api/admin/staff/{user_id}")
def update_branch_staff(user_id: int, body: BranchStaffUpdate, _owner=Depends(require_owner)):
    """Rename, switch off, or move a staff login to another branch. A move
    takes effect on their very next request — the branch is read from this
    row every time, not from their session."""
    u = _staff_user(user_id)
    target = _get(body.branch_id)
    if not target.active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{target.name} is switched off.")
    u.name = body.name.strip()
    u.active = body.active
    u.branch_id = target.key.id()
    u.put()
    return _staff_public(u, Branch.main().key.id())


@router.post("/api/admin/staff/{user_id}/password")
def set_branch_staff_password(user_id: int, body: PasswordUpdate, _owner=Depends(require_owner)):
    u = _staff_user(user_id)
    u.password_hash = hash_password(body.password)
    u.put()
    return {"ok": True, "email": u.email}
