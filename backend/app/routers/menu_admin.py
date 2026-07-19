"""Owner menu management: categories, subcategories, items (prices), promos."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_owner
from ..models import Category, Subcategory, Item, Variant, Promo
from ..schemas.models import (
    CategoryPayload, SubcategoryPayload, ItemPayload, PromoPayload, ReorderPayload,
)

router = APIRouter(prefix="/api/admin/menu", tags=["admin-menu"])


def _slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")


# ---- Categories ----
@router.get("/categories")
def list_categories(_owner=Depends(require_owner)):
    cats = sorted(Category.query(), key=lambda c: (c.sort_order, c.name))
    return {"categories": [c.to_dict() for c in cats]}


@router.post("/categories")
def create_category(body: CategoryPayload, _owner=Depends(require_owner)):
    cat = Category(
        name=body.name, slug=body.slug or _slugify(body.name),
        offer_badge=body.offer_badge, sort_order=body.sort_order, active=body.active,
    )
    cat.put()
    return cat.to_dict()


@router.put("/categories/{category_id}")
def update_category(category_id: int, body: CategoryPayload, _owner=Depends(require_owner)):
    cat = Category.get_by_id(category_id)
    if not cat:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    cat.name = body.name
    cat.slug = body.slug or _slugify(body.name)
    cat.offer_badge = body.offer_badge
    cat.sort_order = body.sort_order
    cat.active = body.active
    cat.put()
    return cat.to_dict()


@router.delete("/categories/{category_id}")
def delete_category(category_id: int, _owner=Depends(require_owner)):
    cat = Category.get_by_id(category_id)
    if cat:
        cat.key.delete()
    return {"ok": True}


# ---- Subcategories ----
@router.post("/subcategories")
def create_subcategory(body: SubcategoryPayload, _owner=Depends(require_owner)):
    sub = Subcategory(
        category_id=body.category_id, name=body.name,
        slug=body.slug or _slugify(body.name), sort_order=body.sort_order, active=body.active,
    )
    sub.put()
    return sub.to_dict()


@router.put("/subcategories/{sub_id}")
def update_subcategory(sub_id: int, body: SubcategoryPayload, _owner=Depends(require_owner)):
    sub = Subcategory.get_by_id(sub_id)
    if not sub:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subcategory not found.")
    sub.category_id = body.category_id
    sub.name = body.name
    sub.slug = body.slug or _slugify(body.name)
    sub.sort_order = body.sort_order
    sub.active = body.active
    sub.put()
    return sub.to_dict()


@router.delete("/subcategories/{sub_id}")
def delete_subcategory(sub_id: int, _owner=Depends(require_owner)):
    sub = Subcategory.get_by_id(sub_id)
    if sub:
        sub.key.delete()
    return {"ok": True}


# ---- Items ----
@router.get("/items")
def list_items(_owner=Depends(require_owner)):
    items = sorted(Item.query(), key=lambda i: (i.category_id, i.sort_order, i.name))
    return {"items": [i.to_dict() for i in items]}


@router.post("/items/reorder")
def reorder_items(body: ReorderPayload, _owner=Depends(require_owner)):
    """Persist a new display order: sort_order = position in the given list.

    The client sends the ids of one category's items in their dragged order.
    """
    updated = []
    for idx, item_id in enumerate(body.order):
        item = Item.get_by_id(int(item_id))
        if item:
            item.sort_order = idx
            updated.append(item)
    for item in updated:
        item.put()
    return {"ok": True, "updated": len(updated)}


def _variants(payloads) -> list[Variant]:
    return [Variant(base=v.base, size=v.size, price=v.price) for v in payloads]


@router.post("/items")
def create_item(body: ItemPayload, _owner=Depends(require_owner)):
    if not body.variants:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "An item needs at least one price variant.")
    item = Item(
        category_id=body.category_id, subcategory_id=body.subcategory_id, name=body.name,
        description=body.description, image_url=body.image_url, veg=body.veg,
        tags=body.tags, variants=_variants(body.variants), active=body.active,
        sort_order=body.sort_order,
    )
    item.put()
    return item.to_dict()


@router.put("/items/{item_id}")
def update_item(item_id: int, body: ItemPayload, _owner=Depends(require_owner)):
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    if not body.variants:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "An item needs at least one price variant.")
    item.category_id = body.category_id
    item.subcategory_id = body.subcategory_id
    item.name = body.name
    item.description = body.description
    item.image_url = body.image_url
    item.veg = body.veg
    item.tags = body.tags
    item.variants = _variants(body.variants)
    item.active = body.active
    item.sort_order = body.sort_order
    item.put()
    return item.to_dict()


@router.delete("/items/{item_id}")
def delete_item(item_id: int, _owner=Depends(require_owner)):
    item = Item.get_by_id(item_id)
    if item:
        item.key.delete()
    return {"ok": True}


# ---- Promos ----
@router.get("/promos")
def list_promos(_owner=Depends(require_owner)):
    return {"promos": [p.to_dict() for p in Promo.query()]}


def _targets(body: PromoPayload) -> list[int]:
    """Union of the multi-target list and the legacy single target."""
    ids = list(dict.fromkeys(body.target_ids or []))     # de-dupe, keep order
    if body.target_id and body.target_id not in ids:
        ids.append(body.target_id)
    return ids


@router.post("/promos")
def create_promo(body: PromoPayload, _owner=Depends(require_owner)):
    targets = _targets(body)
    if not targets:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick at least one category or item.")
    promo = Promo(
        scope=body.scope, target_id=targets[0], target_ids=targets, ptype=body.ptype,
        value=body.value, label=body.label, active=body.active,
    )
    promo.put()
    return promo.to_dict()


@router.put("/promos/{promo_id}")
def update_promo(promo_id: int, body: PromoPayload, _owner=Depends(require_owner)):
    promo = Promo.get_by_id(promo_id)
    if not promo:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Promo not found.")
    targets = _targets(body)
    if not targets:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick at least one category or item.")
    promo.scope = body.scope
    promo.target_id = targets[0]
    promo.target_ids = targets
    promo.ptype = body.ptype
    promo.value = body.value
    promo.label = body.label
    promo.active = body.active
    promo.put()
    return promo.to_dict()


@router.delete("/promos/{promo_id}")
def delete_promo(promo_id: int, _owner=Depends(require_owner)):
    promo = Promo.get_by_id(promo_id)
    if promo:
        promo.key.delete()
    return {"ok": True}
