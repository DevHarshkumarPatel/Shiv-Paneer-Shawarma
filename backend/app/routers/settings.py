"""Store settings: public read of the shop switches + owner update.

Most switches are per branch now: whether customers may order, the offer
banners and the scratch card all live on each Branch (see models/branch.py and
`services.branches.flag`). What is left on the global Setting row is the
review page, which is still one page for the whole shop, and the counter /
bill switches (required name and number, the QR on printed bills). Both endpoints answer
for one branch — the one named, or Main — so the pages read one flat dict.
"""
from fastapi import APIRouter, Depends

from ..deps import require_owner
from ..models import Setting
from ..schemas.models import SettingsPayload
from ..services.branches import flags, public_branch

router = APIRouter(tags=["settings"])


def _for(outlet) -> dict:
    data = Setting.singleton().to_dict()
    data.update(flags(outlet))
    data["ordering_enabled"] = outlet.ordering_enabled is not False
    data["branch"] = outlet.to_public()
    return data


# ---- Public: customer pages read the switches of the branch they are on ----
@router.get("/api/settings")
def public_settings(branch: str = ""):
    return _for(public_branch(branch))


# ---- Owner management ----
@router.get("/api/admin/settings")
def get_settings(_owner=Depends(require_owner), branch: str = ""):
    return _for(public_branch(branch))


@router.put("/api/admin/settings")
def update_settings(body: SettingsPayload, _owner=Depends(require_owner), branch: str = ""):
    """Write only the switches the caller sent, onto the picked branch.

    `ordering_enabled` is set on the Branches tab; an older screen still
    sending it here changes nothing. The counter / bill switches go on the
    shop-wide Setting row whichever branch is picked.
    """
    outlet = public_branch(branch)
    for field in ("promo_banners_enabled", "scratch_enabled", "scratch_repeat_batch"):
        value = getattr(body, field)
        if value is not None:
            setattr(outlet, field, value)
    outlet.put()
    shop = Setting.singleton()
    shop_fields = ("require_customer_name", "require_customer_phone", "print_payment_qr")
    if any(getattr(body, f) is not None for f in shop_fields):
        for field in shop_fields:
            value = getattr(body, field)
            if value is not None:
                setattr(shop, field, value)
        shop.put()
    return _for(outlet)
