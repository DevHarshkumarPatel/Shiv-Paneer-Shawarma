"""FastAPI dependencies for auth and role enforcement."""
from fastapi import Cookie, Depends, Header, HTTPException, status

from .config import settings
from .db import with_ndb_context
from .models import User
from .security import decode_token


def require_setup_key(x_setup_key: str | None = Header(default=None)) -> bool:
    """Gate the standalone provisioning endpoints with the shared setup key.

    Provisioning is disabled unless SETUP_KEY is configured to a non-default,
    non-empty value, and the caller presents the exact key.
    """
    key = (settings.setup_key or "").strip()
    if not key or key == "change-this-setup-key":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "User provisioning is disabled. Set a strong SETUP_KEY in the server .env.")
    if not x_setup_key or x_setup_key != key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid setup key.")
    return True


@with_ndb_context
def get_current_user(sps_token: str | None = Cookie(default=None)) -> User:
    """Resolve the logged-in staff/owner from the JWT cookie.

    Decorated with `with_ndb_context` so the datastore lookup runs inside an
    active NDB context (dependencies run in their own threadpool worker).
    """
    if not sps_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    payload = decode_token(sps_token)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session")
    user = User.get_by_id(int(payload["sub"]))
    if not user or not user.active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer active")
    return user


def require_owner(user: User = Depends(get_current_user)) -> User:
    if user.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Owner access required")
    return user
