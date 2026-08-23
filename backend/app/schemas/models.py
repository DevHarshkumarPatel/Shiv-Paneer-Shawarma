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
    # Needed to price a scratch-card code, which only its winner may redeem.
    phone: str = ""


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
    description: str = ""        # blank means "use the derived copy"
    conditions: str = ""
    active: bool = True


class DeliveryAreaPayload(BaseModel):
    name: str
    fee: float = Field(ge=0, default=0.0)
    active: bool = True
    sort_order: int = 0


# ---- Store settings ----
class SettingsPayload(BaseModel):
    """A partial update: only the switches present in the body are written.

    Every field is optional because these switches live on two different admin
    screens. When the payload replaced the whole row, saving the ordering switch
    from the Settings tab quietly reset the scratch options the owner had set on
    the Scratch tab.
    """

    ordering_enabled: bool | None = None
    promo_banners_enabled: bool | None = None
    scratch_enabled: bool | None = None
    scratch_repeat_batch: bool | None = None


# ---- Scratch cards ----
class ScratchPrizePayload(BaseModel):
    kind: str = "coupon"           # coupon | miss
    coupon_id: int = 0             # the owner coupon this prize hands out
    label: str = ""                # blank = derived from the coupon
    # How many of this card the batch holds — 40 of a batch of 100. The odds are
    # derived from this; there is nothing else to set.
    quantity: int = Field(ge=1, default=1)
    validity_days: int = Field(ge=1, default=7)
    active: bool = True
    sort_order: int = 0


class ScratchDrawRequest(BaseModel):
    phone: str


# ---- Reviews ----
class ReviewQuestionPayload(BaseModel):
    text: str
    help_text: str = ""
    qtype: str = "rating"           # rating | nps | single | multi | yes_no | short_text | long_text
    options: list[str] = []
    scale_max: int = Field(ge=2, le=10, default=5)
    required: bool = False
    active: bool = True
    sort_order: int = 0


class ReviewAnswerPayload(BaseModel):
    question_id: int
    score: int | None = None        # rating / nps / yes_no (1|0)
    text: str = ""
    choices: list[str] = []


class ReviewSubmitRequest(BaseModel):
    order_public_id: str = ""
    name: str = ""
    phone: str = ""
    answers: list[ReviewAnswerPayload] = []


class ReviewSettingsPayload(BaseModel):
    """Kept apart from SettingsPayload so the store switches and the review page
    copy can be saved independently — a PUT of one must never reset the other."""

    reviews_enabled: bool = True
    review_title: str = ""
    review_intro: str = ""
    review_thanks: str = ""
    review_google_url: str = ""


class CouponPayload(BaseModel):
    code: str
    ctype: str          # percent | flat | promo ("promo" = unlocks promos, no ₹ off)
    value: float
    min_order: float = 0.0
    max_discount: float = 0.0
    active: bool = True
    usage_limit: int = 0
    # Promos this code switches on. They stop applying by themselves the moment
    # a coupon claims them, and come back if every coupon lets go.
    promo_ids: list[int] = []
