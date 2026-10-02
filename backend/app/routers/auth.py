"""Staff / owner authentication (JWT in an httpOnly cookie)."""
from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..deps import get_current_user
from ..models import User
from ..schemas.models import LoginRequest
from ..security import create_token, set_auth_cookie, clear_auth_cookie, verify_password
from ..services.branches import user_branch

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginRequest, response: Response):
    user = User.by_email(body.email)
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    token = create_token(user.key.id(), user.role, user.email)
    set_auth_cookie(response, token)
    return _session(user)


@router.post("/logout")
def logout(response: Response):
    clear_auth_cookie(response)
    return {"ok": True}


def _session(user: User) -> dict:
    """The user, plus the branch a staff login works at — the name the staff
    screens show in their header. The owner has none: they pick one."""
    data = user.to_public()
    if user.role != "owner":
        data["branch"] = user_branch(user).to_public()
    return {"user": data}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return _session(user)
