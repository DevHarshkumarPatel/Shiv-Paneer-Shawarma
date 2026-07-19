"""Public menu tree: categories -> subcategories -> items(+variants) + active promos."""
from fastapi import APIRouter, Depends

from ..models import Category, Subcategory, Item, Promo

router = APIRouter(prefix="/api", tags=["menu"])


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
