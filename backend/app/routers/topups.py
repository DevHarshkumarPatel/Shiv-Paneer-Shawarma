"""Topups (add-ons): the staff list, and owner-only CRUD.

Two audiences, two gates. Any logged-in staff member reads the list, because
putting extra cheese on a ticket is counter work. Everything that decides what
an add-on *is* — its existence, its name, its price, whether that price is per
unit or flat — is owner-only, like the menu itself.

There is no public endpoint on purpose: add-ons are taken across the counter,
not chosen on the website, so nothing a customer's browser can reach needs to
know they exist.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import get_current_user, require_owner
from ..models import Branch, Topup
from ..schemas.models import TopupPayload
from ..services.branches import public_branch, read_branch

router = APIRouter(tags=["topups"])


# ---- Staff: what can go on a ticket ----
@router.get("/api/topups")
def list_active(user=Depends(get_current_user), branch: str = ""):
    """The add-ons at this counter's branch."""
    outlet = read_branch(user, branch)
    return {"topups": [t.to_dict() for t in Topup.active_ordered(outlet.key.id(), Branch.main().key.id())]}


# ---- Owner management ----
def _of(outlet: Branch) -> list[Topup]:
    main_id = Branch.main().key.id()
    return sorted((t for t in Topup.query() if t.belongs_to(outlet.key.id(), main_id)),
                  key=lambda t: (t.sort_order, t.name.lower()))


@router.get("/api/admin/topups")
def list_all(_owner=Depends(require_owner), branch: str = ""):
    """One branch's add-ons (Main when none is named)."""
    outlet = public_branch(branch)
    return {"topups": [t.to_dict() for t in _of(outlet)], "branch": outlet.to_public()}


@router.post("/api/admin/topups/copy-from-main")
def copy_from_main(_owner=Depends(require_owner), branch: str = ""):
    """Start a branch's add-on list from Main's — same names and prices, which
    the owner then edits. Only adds what the branch does not already have."""
    outlet = public_branch(branch)
    if outlet.is_main:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick a branch other than Main.")
    have = {t.name.lower() for t in _of(outlet)}
    added = 0
    for t in _of(Branch.main()):
        if t.name.lower() in have:
            continue
        Topup(name=t.name, price=t.price, per_quantity=t.per_quantity, description=t.description,
              active=t.active, sort_order=t.sort_order, branch_id=outlet.key.id()).put()
        added += 1
    return {"added": added}


def _clean(body: TopupPayload) -> str:
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give the add-on a name.")
    if body.price < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Price cannot be negative.")
    return name


@router.post("/api/admin/topups", status_code=status.HTTP_201_CREATED)
def create_topup(body: TopupPayload, _owner=Depends(require_owner), branch: str = ""):
    topup = Topup(
        branch_id=public_branch(branch).key.id(),
        name=_clean(body), price=body.price, per_quantity=body.per_quantity,
        description=body.description.strip(), active=body.active,
        sort_order=body.sort_order,
    )
    topup.put()
    return topup.to_dict()


@router.put("/api/admin/topups/{topup_id}")
def update_topup(topup_id: int, body: TopupPayload, _owner=Depends(require_owner)):
    """Rename or reprice an add-on.

    Orders already placed keep the name and price frozen on their own lines
    (see `OrderTopup`), so this changes what the next ticket is charged and
    never what an old bill says.
    """
    topup = Topup.get_by_id(topup_id)
    if not topup:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Add-on not found.")
    topup.name = _clean(body)
    topup.price = body.price
    topup.per_quantity = body.per_quantity
    topup.description = body.description.strip()
    topup.active = body.active
    topup.sort_order = body.sort_order
    topup.put()
    return topup.to_dict()


@router.delete("/api/admin/topups/{topup_id}")
def delete_topup(topup_id: int, _owner=Depends(require_owner)):
    """Remove an add-on from the counter's list.

    Safe to do mid-service: past orders carry their own copy of what they
    charged, and a ticket still holding this one is told it is gone at the
    moment it is priced rather than billed for something the shop withdrew.
    """
    topup = Topup.get_by_id(topup_id)
    if topup:
        topup.key.delete()
    return {"ok": True}
