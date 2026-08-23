"""Public menu tree: categories -> subcategories -> items(+variants) + active promos."""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..models import Category, Subcategory, Item, ItemImage, Promo, Coupon, Setting

router = APIRouter(prefix="/api", tags=["menu"])


def _claimable_gated(promos: list[Promo]) -> set[int]:
    """Ids of the coupon-gated promos that some live code can still unlock.

    The codes themselves never leave the server for a public page. A gated offer
    is advertised as "apply your coupon code" — whoever the owner handed the code
    to already has it, and printing it on the menu would hand a private offer to
    everyone. This only answers the other question the public pages need: is
    there any code out there that still turns this offer on? If not, the offer is
    unclaimable and must not be advertised at all.

    Only looked up when some promo is gated. Scratch-card mints are skipped:
    those are one private code per winner, not a standing public offer.
    """
    gated = {p.key.id() for p in promos if p.coupon_only}
    if not gated:
        return set()
    claimable: set[int] = set()
    for c in Coupon.query():
        if c.source == "scratch" or not c.active:
            continue
        ok, _ = c.is_valid_now()
        if not ok:
            continue
        claimable.update(pid for pid in (c.promo_ids or []) if pid in gated)
    return claimable


def _join_names(names: list[str]) -> str:
    """"a, b & c" — reads as sentence copy, which is where these names end up."""
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " & " + names[-1]


@router.get("/promos")
def list_public_promos():
    """Every active promo, with its targets resolved to names and its customer
    copy filled in.

    The public pages render their offer banners from this instead of hard-coded
    text, so turning a promo off in the admin takes it off the site, and the
    banner always names the categories the promo actually covers.

    The owner's banner switch is answered here rather than in the browser: with
    it off this returns nothing, and every band, strip, running-offer line and
    FAQ entry on every page empties itself with no page-by-page change. The
    promos keep discounting the cart — this hides the advertising, not the
    offer.
    """
    if not Setting.singleton().promo_banners_enabled:
        return {"promos": []}

    cats = {c.key.id(): c for c in Category.query() if c.active}
    items = {i.key.id(): i for i in Item.query() if i.active}

    promos = sorted(
        [p for p in Promo.query() if p.active],
        key=lambda p: (p.created_at or datetime.min, p.key.id()),
    )
    claimable = _claimable_gated(promos)
    # A gated promo whose codes have all expired or been switched off unlocks
    # nothing, so it is not an offer anyone can claim — leave it off the site.
    promos = [p for p in promos if not p.coupon_only or p.key.id() in claimable]

    # Identical offers running on several categories (the shape the seed creates:
    # one b1g1 row per category) merge into a single banner listing all of them,
    # instead of four bands on the landing page that all say the same thing.
    # They only merge when every word a customer would read is the same.
    merged: dict[tuple, dict] = {}
    for p in promos:
        targets = p.target_id_list()
        pool = items if p.scope == "item" else cats
        names = [pool[t].name for t in targets if t in pool]
        # A promo whose every target is gone or switched off discounts nothing,
        # so advertising it would be a promise the cart will not keep.
        if not names:
            continue
        gated = p.coupon_only
        key = (p.ptype, p.value, p.display_label(), p.description, p.conditions, gated)
        row = merged.setdefault(key, {
            "id": p.key.id(),
            "scope": p.scope,
            "ptype": p.ptype,
            "value": p.value,
            "label": p.display_label(),
            "applies_to": [],
            "requires_coupon": gated,
            "_cat_ids": set(),
            "_promo": p,
        })
        for n in names:
            if n not in row["applies_to"]:
                row["applies_to"].append(n)
        if p.scope == "category":
            row["_cat_ids"].update(targets)

    out = []
    for row in merged.values():
        p = row.pop("_promo")
        store_wide = bool(cats) and set(cats).issubset(row.pop("_cat_ids"))
        targets_text = "the whole menu" if store_wide else _join_names(row["applies_to"])
        out.append({
            **row,
            "description": p.display_description(targets_text, row["requires_coupon"]),
            "conditions": p.display_conditions(targets_text, row["requires_coupon"]),
            "applies_to_text": targets_text,
            "store_wide": store_wide,
        })
    return {"promos": out}


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
    active_promos = [p for p in Promo.query() if p.active]
    claimable = _claimable_gated(active_promos)
    for p in active_promos:
        # A gated promo with no live code behind it cannot be claimed, so it
        # must not put an offer badge on the menu.
        if p.coupon_only and p.key.id() not in claimable:
            continue
        index = promos_by_item if p.scope == "item" else promos_by_cat
        # `coupon_only` rides along so the badge can say a code is needed: the
        # cart will not apply a gated promo by itself, and a plain "B1G1" chip
        # would be a promise it breaks.
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
