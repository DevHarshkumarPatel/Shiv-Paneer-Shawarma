"""Delivery areas: public list (active only) + owner CRUD with per-area fee."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Branch, DeliveryArea
from ..schemas.models import DeliveryAreaPayload
from ..services.branches import public_branch

router = APIRouter(tags=["delivery-areas"])


# ---- Public: areas the customer can pick at checkout ----
@router.get("/api/delivery-areas")
def public_list(branch: str = ""):
    """The areas the chosen branch delivers to, each at that branch's fee."""
    outlet = public_branch(branch)
    main_id = Branch.main().key.id()
    return {"areas": [a.to_dict() for a in DeliveryArea.active_ordered(outlet.key.id(), main_id)]}


# ---- Owner management ----
@router.get("/api/admin/delivery-areas")
def list_areas(_owner=Depends(require_owner), branch: str = ""):
    """Every area of one branch (Main when none is named), active or not."""
    outlet = public_branch(branch)
    main_id = Branch.main().key.id()
    areas = sorted((a for a in DeliveryArea.query() if a.belongs_to(outlet.key.id(), main_id)),
                   key=lambda a: (a.sort_order, a.name.lower()))
    return {"areas": [a.to_dict() for a in areas], "branch": outlet.to_public()}


@router.post("/api/admin/delivery-areas", status_code=status.HTTP_201_CREATED)
def create_area(body: DeliveryAreaPayload, _owner=Depends(require_owner), branch: str = ""):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Area name is required.")
    outlet = public_branch(branch)
    area = DeliveryArea(name=name, fee=body.fee, active=body.active, sort_order=body.sort_order,
                        branch_id=outlet.key.id())
    area.put()
    return area.to_dict()


@router.put("/api/admin/delivery-areas/{area_id}")
def update_area(area_id: int, body: DeliveryAreaPayload, _owner=Depends(require_owner)):
    area = DeliveryArea.get_by_id(area_id)
    if not area:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Delivery area not found.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Area name is required.")
    area.name = name
    area.fee = body.fee
    area.active = body.active
    area.sort_order = body.sort_order
    area.put()
    return area.to_dict()


@router.delete("/api/admin/delivery-areas/{area_id}")
def delete_area(area_id: int, _owner=Depends(require_owner)):
    area = DeliveryArea.get_by_id(area_id)
    if area:
        area.key.delete()
    return {"ok": True}
