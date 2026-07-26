"""Owner menu management: categories, subcategories, items (prices), promos."""
import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from ..deps import require_owner
from ..models import Category, Subcategory, Item, ItemImage, Variant, Promo
from ..schemas.models import (
    AvailabilityPayload, CategoryPayload, SubcategoryPayload, ItemPayload,
    PromoPayload, ReorderPayload,
)

# Uploads are re-encoded to at most this box and this JPEG quality. The menu
# renders the thumb at 76px (152px on a 2x screen) and the card can grow later,
# so 900px is generous; the point is that an 8 MB phone photo must never reach
# Datastore, whose per-entity limit is 1 MiB.
IMAGE_BOX = 900
IMAGE_QUALITY = 82
MAX_UPLOAD_BYTES = 12 * 1024 * 1024      # reject absurd inputs before decoding
MAX_STORED_BYTES = 900 * 1024            # keep clear of the 1 MiB entity limit
ALLOWED_UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}

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
    return [Variant(base=v.base, size=v.size, price=v.price, available=v.available)
            for v in payloads]


@router.post("/items")
def create_item(body: ItemPayload, _owner=Depends(require_owner)):
    if not body.variants:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "An item needs at least one price variant.")
    item = Item(
        category_id=body.category_id, subcategory_id=body.subcategory_id, name=body.name,
        description=body.description, image_url=body.image_url, veg=body.veg,
        tags=body.tags, variants=_variants(body.variants), active=body.active,
        available=body.available, sort_order=body.sort_order,
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
    item.available = body.available
    item.sort_order = body.sort_order
    item.put()
    return item.to_dict()


@router.delete("/items/{item_id}")
def delete_item(item_id: int, _owner=Depends(require_owner)):
    item = Item.get_by_id(item_id)
    if item:
        # Drop the photo with the item, or its bytes sit in Datastore forever
        # with nothing pointing at them.
        img = ItemImage.get_by_id(item_id)
        if img:
            img.key.delete()
        item.key.delete()
    return {"ok": True}


# ---- Stock toggles ----
@router.patch("/items/{item_id}/availability")
def set_availability(item_id: int, body: AvailabilityPayload, _owner=Depends(require_owner)):
    """Flip "sold out" for a whole item and/or for individual variants.

    Separate from PUT /items/{id} on purpose: marking something sold out happens
    mid-service, often from a phone, and must not require sending prices back —
    a stale form would otherwise quietly overwrite them.
    """
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    item.available = body.available
    if body.variants is not None:
        if len(body.variants) != len(item.variants):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Variant availability list must match the item's variants.",
            )
        for variant, flag in zip(item.variants, body.variants):
            variant.available = flag
    item.put()
    return item.to_dict()


# ---- Item photos ----
def _encode_image(raw: bytes) -> tuple[bytes, int, int]:
    """Downscale and re-encode an upload to a small JPEG.

    Re-encoding rather than storing the original is the whole point: it caps the
    stored size, strips EXIF (which carries the location the photo was taken),
    and normalises HEIC/PNG/WebP to one format the browser will always render.
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:  # pragma: no cover - Pillow ships with qrcode[pil]
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                            "Image support is not installed on the server.")
    try:
        img = Image.open(io.BytesIO(raw))
        # Phone cameras record orientation in EXIF instead of rotating pixels;
        # without this a portrait photo is stored on its side.
        img = ImageOps.exif_transpose(img)
        # Flatten alpha onto white — JPEG has no alpha channel, and pasting onto
        # black would ruin any PNG logo with a transparent background.
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            flat = Image.new("RGB", img.size, (255, 255, 255))
            flat.paste(img, mask=img.split()[-1])
            img = flat
        else:
            img = img.convert("RGB")
        img.thumbnail((IMAGE_BOX, IMAGE_BOX), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=IMAGE_QUALITY, optimize=True, progressive=True)
        return buf.getvalue(), img.width, img.height
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That file could not be read as an image.")


@router.post("/items/{item_id}/image")
def upload_item_image(item_id: int, file: UploadFile = File(...), _owner=Depends(require_owner)):
    """Store a downscaled copy of an uploaded photo against this item.

    Sync on purpose. `wrap_router_endpoints` in main.py only wraps *sync*
    endpoints in an NDB context, so an `async def` here fails with
    "No current context" the moment it touches the datastore. Running in the
    threadpool also keeps the Pillow re-encode off the event loop, which is
    where it belongs — it is CPU-bound.
    """
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    if file.content_type and file.content_type not in ALLOWED_UPLOAD_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Upload a JPEG, PNG or WebP image.")
    # .file is the underlying SpooledTemporaryFile — the sync counterpart of
    # the async .read() coroutine.
    raw = file.file.read()
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "That image is too large. Keep it under 12 MB.")

    data, width, height = _encode_image(raw)
    if len(data) > MAX_STORED_BYTES:      # pathological input (huge canvas of noise)
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "That image is too detailed to store. Try a smaller crop.")

    img = ItemImage(id=item_id, data=data, content_type="image/jpeg",
                    width=width, height=height)
    img.put()

    # Point the item at the serving endpoint. The menu already renders whatever
    # is in image_url, so nothing downstream needs to know where bytes live. The
    # ?v= stamp busts the cached copy of a photo that was just replaced.
    stamp = int(img.updated_at.timestamp()) if img.updated_at else 0
    item.image_url = f"/api/menu/items/{item_id}/image?v={stamp}"
    item.put()
    return {"ok": True, "image_url": item.image_url, "bytes": len(data),
            "width": width, "height": height}


@router.delete("/items/{item_id}/image")
def delete_item_image(item_id: int, _owner=Depends(require_owner)):
    item = Item.get_by_id(item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    img = ItemImage.get_by_id(item_id)
    if img:
        img.key.delete()
    # Only clear an URL we own; an owner-typed external link is left alone.
    if item.image_url.startswith(f"/api/menu/items/{item_id}/image"):
        item.image_url = ""
        item.put()
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
