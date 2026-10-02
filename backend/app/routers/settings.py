"""Store settings: public read of the shop-wide switches + owner update.

`ordering_enabled` is the owner's master switch. When it is off, the
customer side cannot place orders (enforced in the orders router); the
public endpoint lets the customer pages reflect that state in the UI.
`promo_banners_enabled` hides the offer banners without touching the promos
themselves, so the discounts keep working while the advertising stops.
"""
from fastapi import APIRouter, Depends

from ..deps import require_owner
from ..models import Setting
from ..schemas.models import SettingsPayload
from ..services.branches import public_branch

router = APIRouter(tags=["settings"])


# ---- Public: customer pages read whether ordering is open ----
@router.get("/api/settings")
def public_settings(branch: str = ""):
    """Shop-wide switches, with `ordering_enabled` answered for the branch the
    page is on — that switch lives on each branch now (see models/branch.py)."""
    data = Setting.singleton().to_dict()
    outlet = public_branch(branch)
    data["ordering_enabled"] = outlet.ordering_enabled is not False
    data["branch"] = outlet.to_public()
    return data


# ---- Owner management ----
@router.get("/api/admin/settings")
def get_settings(_owner=Depends(require_owner)):
    return Setting.singleton().to_dict()


@router.put("/api/admin/settings")
def update_settings(body: SettingsPayload, _owner=Depends(require_owner)):
    """Write only the switches the caller sent, leaving the rest alone."""
    s = Setting.singleton()
    # `ordering_enabled` is no longer written here: it is per branch, and set
    # on the Branches tab. An older screen still sending it changes nothing.
    for field in ("promo_banners_enabled", "scratch_enabled", "scratch_repeat_batch"):
        value = getattr(body, field)
        if value is not None:
            setattr(s, field, value)
    s.put()
    return s.to_dict()
