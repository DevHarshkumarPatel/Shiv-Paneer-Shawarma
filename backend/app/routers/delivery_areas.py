"""Delivery areas: public list (active only) + owner CRUD with per-area fee."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import DeliveryArea
from ..schemas.models import DeliveryAreaPayload

router = APIRouter(tags=["delivery-areas"])


# ---- Public: areas the customer can pick at checkout ----
@router.get("/api/delivery-areas")
def public_list():
    return {"areas": [a.to_dict() for a in DeliveryArea.active_ordered()]}


# ---- Owner management ----
@router.get("/api/admin/delivery-areas")
def list_areas(_owner=Depends(require_owner)):
    areas = sorted(DeliveryArea.query(), key=lambda a: (a.sort_order, a.name.lower()))
    return {"areas": [a.to_dict() for a in areas]}


@router.post("/api/admin/delivery-areas", status_code=status.HTTP_201_CREATED)
def create_area(body: DeliveryAreaPayload, _owner=Depends(require_owner)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Area name is required.")
    area = DeliveryArea(name=name, fee=body.fee, active=body.active, sort_order=body.sort_order)
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
