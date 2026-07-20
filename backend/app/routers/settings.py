"""Store settings: public read of the ordering switch + owner update.

`ordering_enabled` is the owner's master switch. When it is off, the
customer side cannot place orders (enforced in the orders router); the
public endpoint lets the customer pages reflect that state in the UI.
"""
from fastapi import APIRouter, Depends

from ..deps import require_owner
from ..models import Setting
from ..schemas.models import SettingsPayload

router = APIRouter(tags=["settings"])


# ---- Public: customer pages read whether ordering is open ----
@router.get("/api/settings")
def public_settings():
    return Setting.singleton().to_dict()


# ---- Owner management ----
@router.get("/api/admin/settings")
def get_settings(_owner=Depends(require_owner)):
    return Setting.singleton().to_dict()


@router.put("/api/admin/settings")
def update_settings(body: SettingsPayload, _owner=Depends(require_owner)):
    s = Setting.singleton()
    s.ordering_enabled = body.ordering_enabled
    s.put()
    return s.to_dict()
