"""Standalone, setup-key-gated user provisioning.

Reachable only from the dedicated page (frontend/provision.html) by presenting
the X-Setup-Key header — NOT from the owner/staff dashboard. Lets whoever holds
the key create staff/owner accounts and set/reset passwords.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import require_setup_key
from ..models import User
from ..schemas.models import UserCreate, UserUpdate, PasswordUpdate
from ..security import hash_password

router = APIRouter(prefix="/api/setup", tags=["provisioning"],
                   dependencies=[Depends(require_setup_key)])

VALID_ROLES = ("owner", "staff")


def _public(u: User) -> dict:
    return {
        "id": u.key.id(), "email": u.email, "name": u.name,
        "role": u.role, "active": u.active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


def _active_owner_count(exclude_id: int | None = None) -> int:
    n = 0
    for u in User.query():
        if u.role == "owner" and u.active and u.key.id() != exclude_id:
            n += 1
    return n


@router.get("/verify")
def verify():
    """Cheap endpoint the UI calls to confirm the setup key is accepted."""
    return {"ok": True}


@router.get("/users")
def list_users():
    # None-safe: never let a stray entity with a null email/role 500 the list.
    users = sorted(
        User.query(),
        key=lambda u: (u.role != "owner", (u.email or "").lower()),
    )
    return {"users": [_public(u) for u in users]}


@router.post("/users", status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate):
    if body.role not in VALID_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Role must be 'owner' or 'staff'.")
    email = body.email.lower().strip()
    if User.by_email(email):
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists.")
    user = User(
        email=email, name=body.name.strip(), role=body.role, active=body.active,
        password_hash=hash_password(body.password),
    )
    user.put()
    return _public(user)


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserUpdate):
    user = User.get_by_id(user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if body.role not in VALID_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Role must be 'owner' or 'staff'.")
    # Never let the last active owner be demoted or deactivated (avoids lock-out).
    demoting = user.role == "owner" and (body.role != "owner" or not body.active)
    if demoting and _active_owner_count(exclude_id=user_id) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one active owner must remain.")
    user.name = body.name.strip()
    user.role = body.role
    user.active = body.active
    user.put()
    return _public(user)


@router.post("/users/{user_id}/password")
def set_password(user_id: int, body: PasswordUpdate):
    user = User.get_by_id(user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    user.password_hash = hash_password(body.password)
    user.put()
    return {"ok": True, "email": user.email}


@router.delete("/users/{user_id}")
def delete_user(user_id: int):
    user = User.get_by_id(user_id)
    if not user:
        return {"ok": True}
    if user.role == "owner" and user.active and _active_owner_count(exclude_id=user_id) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete the last active owner.")
    user.key.delete()
    return {"ok": True}
