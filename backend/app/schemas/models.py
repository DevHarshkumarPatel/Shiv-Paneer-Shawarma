"""Pydantic request/response schemas."""
from pydantic import BaseModel, EmailStr, Field


# ---- Auth ----
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


# ---- User provisioning (setup-key gated) ----
class UserCreate(BaseModel):
    name: str = ""
    email: EmailStr
    password: str = Field(min_length=6)
    role: str = "staff"          # owner | staff
    active: bool = True


class UserUpdate(BaseModel):
    name: str = ""
    role: str = "staff"
    active: bool = True


class PasswordUpdate(BaseModel):
    password: str = Field(min_length=6)


# ---- Cart / pricing ----
class CartLine(BaseModel):
    item_id: int
    base: str = ""
    size: str = ""
    quantity: int = Field(ge=1, default=1)


class QuoteRequest(BaseModel):
    cart: list[CartLine]
    order_type: str = "takeaway"   # dine_in | takeaway | delivery
    coupon_code: str = ""
    delivery_area_id: int = 0      # required (non-zero) for delivery orders


# ---- Orders ----
class CustomerPayload(BaseModel):
    name: str = ""
    phone: str = ""
    address: str = ""
    lat: float | None = None
    lng: float | None = None


class CreateOrderRequest(BaseModel):
    cart: list[CartLine]
    order_type: str
    coupon_code: str = ""
    delivery_area_id: int = 0
    customer: CustomerPayload = CustomerPayload()
    payment_method: str = "cash"   # "upi" or "cash"
    upi_reference: str = ""
    notes: str = ""


class StatusUpdateRequest(BaseModel):
    status: str


class VerifyPaymentRequest(BaseModel):
    status: str = "paid"   # paid | failed


# ---- Menu admin ----
class VariantPayload(BaseModel):
    base: str = ""
    size: str = ""
    price: float
    available: bool = True


class CategoryPayload(BaseModel):
    name: str
    slug: str = ""
    offer_badge: str = ""
    sort_order: int = 0
    active: bool = True


class SubcategoryPayload(BaseModel):
    category_id: int
    name: str
    slug: str = ""
    sort_order: int = 0
    active: bool = True


class ItemPayload(BaseModel):
    category_id: int
    subcategory_id: int = 0
    name: str
    description: str = ""
    image_url: str = ""
    veg: bool = True
    tags: list[str] = []
    variants: list[VariantPayload]
    active: bool = True
    available: bool = True
    sort_order: int = 0


class AvailabilityPayload(BaseModel):
    """Quick stock toggle, so flipping "sold out" does not require resending the
    whole item (and cannot accidentally overwrite prices while doing it).

    `variants` is positional against Item.variants when present; omit it to
    change only the item-level switch.
    """

    available: bool = True
    variants: list[bool] | None = None


class ReorderPayload(BaseModel):
    order: list[int] = []   # item ids in their new display order


class PromoPayload(BaseModel):
    scope: str                    # item | category
    target_id: int = 0            # legacy single target; optional now
    target_ids: list[int] = []    # one or more item/category ids the promo applies to
    ptype: str          # b2g1 | b1g1 | percent | flat
    value: float = 0.0
    label: str = ""
    active: bool = True


class DeliveryAreaPayload(BaseModel):
    name: str
    fee: float = Field(ge=0, default=0.0)
    active: bool = True
    sort_order: int = 0


# ---- Store settings ----
class SettingsPayload(BaseModel):
    ordering_enabled: bool = True


class CouponPayload(BaseModel):
    code: str
    ctype: str          # percent | flat
    value: float
    min_order: float = 0.0
    max_discount: float = 0.0
    active: bool = True
    usage_limit: int = 0
