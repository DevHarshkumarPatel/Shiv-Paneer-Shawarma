"""FastAPI application entry point for Shiv Paneer Shawarma."""
import secrets

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import settings
from .db import wrap_router_endpoints
from .routers import (
    auth, menu_public, menu_admin, coupons, orders, orders_admin, payments,
    provision, delivery_areas,
)

# Disable the built-in public docs endpoints; we re-serve them below behind
# HTTP Basic auth so the API reference is not open to anyone.
app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,          # required so the JWT cookie is sent
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(menu_public.router)
app.include_router(auth.router)
app.include_router(menu_admin.router)
app.include_router(coupons.router)
app.include_router(orders.router)
app.include_router(orders_admin.router)
app.include_router(payments.router)
app.include_router(provision.router)
app.include_router(delivery_areas.router)

# Every sync endpoint that touches the datastore must run inside an NDB context.
# Wrapping here keeps the routers clean of context boilerplate.
wrap_router_endpoints(app)


# --- Protected API docs -----------------------------------------------------
# /docs, /redoc and /openapi.json are gated behind HTTP Basic auth. Only the
# exact docs_user + docs_password (see config) may view them; everyone else
# gets a 401, so the schema is never exposed publicly.
_docs_security = HTTPBasic()


def _require_docs_auth(credentials: HTTPBasicCredentials = Depends(_docs_security)) -> None:
    user_ok = secrets.compare_digest(credentials.username, settings.docs_user)
    pass_ok = secrets.compare_digest(credentials.password, settings.docs_password)
    if not (user_ok and pass_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


@app.get("/openapi.json", include_in_schema=False)
def protected_openapi(_: None = Depends(_require_docs_auth)):
    return app.openapi()


@app.get("/docs", include_in_schema=False)
def protected_docs(_: None = Depends(_require_docs_auth)):
    return get_swagger_ui_html(openapi_url="/openapi.json", title=f"{settings.app_name} API")


@app.get("/redoc", include_in_schema=False)
def protected_redoc(_: None = Depends(_require_docs_auth)):
    return get_redoc_html(openapi_url="/openapi.json", title=f"{settings.app_name} API")


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.app_name, "env": settings.environment}


@app.get("/api/config")
def public_config():
    """Non-secret runtime config the frontend needs (maps key, delivery fee, UPI display)."""
    return {
        "app_name": settings.app_name,
        "maps_api_key": settings.maps_api_key,
        "delivery_fee": settings.delivery_fee,
        "upi_payee_name": settings.upi_payee_name,
        "currency": "INR",
    }
