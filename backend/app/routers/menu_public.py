"""Public menu tree: categories -> subcategories -> items(+variants) + active promos."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..models import Category, Subcategory, Item, ItemImage, Promo

router = APIRouter(prefix="/api", tags=["menu"])


@router.get("/menu/items/{item_id}/image")
def get_item_image(item_id: int, request: Request):
    """Serve an uploaded item photo.

    Cached hard and revalidated with an ETag: the bytes for a given ?v= stamp
    never change (a replacement upload mints a new stamp), so a repeat visitor
    should not be re-downloading the whole menu's photography.
    """
    img = ItemImage.get_by_id(item_id)
    if not img:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No image for this item.")

    stamp = int(img.updated_at.timestamp()) if img.updated_at else 0
    etag = f'W/"{item_id}-{stamp}-{len(img.data)}"'
    headers = {"Cache-Control": "public, max-age=86400", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=img.data, media_type=img.content_type or "image/jpeg",
                    headers=headers)


@router.get("/menu")
def get_menu():
    categories = sorted(
        [c for c in Category.query() if c.active],
        key=lambda c: (c.sort_order, c.name),
    )
    subcategories = [s for s in Subcategory.query() if s.active]
    items = [i for i in Item.query() if i.active]

    # Index active promos so the client can render badges + effective offers.
    promos_by_item: dict[int, dict] = {}
    promos_by_cat: dict[int, dict] = {}
    for p in Promo.query():
        if not p.active:
            continue
        index = promos_by_item if p.scope == "item" else promos_by_cat
        pd = p.to_dict()
        for tid in p.target_id_list():
            index[tid] = pd

    def item_json(it: Item) -> dict:
        d = it.to_dict()
        d["promo"] = promos_by_item.get(it.key.id()) or promos_by_cat.get(it.category_id)
        return d

    subs_by_cat: dict[int, list] = {}
    for s in sorted(subcategories, key=lambda s: (s.sort_order, s.name)):
        subs_by_cat.setdefault(s.category_id, []).append(s)

    items_sorted = sorted(items, key=lambda i: (i.sort_order, i.name))

    tree = []
    for cat in categories:
        cat_json = cat.to_dict()
        cat_json["promo"] = promos_by_cat.get(cat.key.id())
        cat_items = [i for i in items_sorted if i.category_id == cat.key.id()]

        subgroups = []
        for sub in subs_by_cat.get(cat.key.id(), []):
            sub_items = [item_json(i) for i in cat_items if i.subcategory_id == sub.key.id()]
            if sub_items:
                subgroups.append({**sub.to_dict(), "items": sub_items})

        direct_items = [item_json(i) for i in cat_items if not i.subcategory_id]

        cat_json["subcategories"] = subgroups
        cat_json["items"] = direct_items
        if subgroups or direct_items:
            tree.append(cat_json)

    return {"categories": tree}
