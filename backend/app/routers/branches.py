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
    BranchMenuPayload, BranchPayload, BranchStaffCreate, BranchStaffUpdate, PasswordUpdate,
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


@router.put("/api/admin/branches/{branch_id}/menu/{item_id}")
def set_branch_item(branch_id: int, item_id: int, body: BranchMenuPayload,
                    _owner=Depends(require_owner)):
    """Set how this branch sells one item.

    Only real differences are stored: a variant priced as the master and in
    stock is dropped, and a row left with nothing different is deleted. So a
    master price change still reaches every branch that never changed it.
    """
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
    key = BranchMenu.key_for(b.key.id(), item_id)
    if not overrides and not body.hidden:
        key.delete()
        return {"item_id": item_id, "hidden": False, "overrides": []}
    row = BranchMenu(key=key, branch_id=b.key.id(), item_id=item_id,
                     hidden=body.hidden, overrides=overrides)
    row.put()
    return row.to_dict()


@router.delete("/api/admin/branches/{branch_id}/menu/{item_id}")
def reset_branch_item(branch_id: int, item_id: int, _owner=Depends(require_owner)):
    """Back to Main's price and stock for this item."""
    BranchMenu.key_for(_get(branch_id).key.id(), item_id).delete()
    return {"ok": True}


@router.post("/api/admin/branches/{branch_id}/menu/reset")
def reset_branch_menu(branch_id: int, _owner=Depends(require_owner)):
    """Copy Main's menu again: every difference this branch has is dropped."""
    b = _get(branch_id)
    keys = BranchMenu.query(BranchMenu.branch_id == b.key.id()).fetch(keys_only=True)
    if keys:
        ndb.delete_multi(keys)
    return {"ok": True, "cleared": len(keys)}


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
