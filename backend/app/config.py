"""Application settings, loaded from environment / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # App
    app_name: str = "Shiv Paneer Shawarma"
    environment: str = "development"
    cors_origins: str = "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080"

    # Datastore / NDB
    gcp_project_id: str = "shiv-paneer-shawarma"
    datastore_emulator_host: str = "localhost:8081"
    # Named Datastore database to use. Empty string => the "(default)" database.
    datastore_database: str = ""

    # Auth
    jwt_secret: str = "dev-insecure-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720
    cookie_name: str = "sps_token"
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # API docs (/docs, /redoc, /openapi.json) are gated behind HTTP Basic auth.
    # Only this exact username+password may view them.
    docs_user: str = "harsh@gmail.com"
    docs_password: str = "change-this-docs-password"

    # Standalone user-provisioning page is gated by this key (sent as X-Setup-Key).
    # Empty string disables provisioning entirely. Change it for production.
    setup_key: str = "change-this-setup-key"

    # Seed users
    owner_email: str = "owner@shivpaneer.com"
    owner_password: str = "owner123"
    staff_email: str = "staff@shivpaneer.com"
    staff_password: str = "staff123"

    # Ordering / payments
    delivery_fee: float = 40.0
    # Restaurant UPI *merchant* (P2M) identity, taken from the GPay-for-Business QR.
    # A bare upi://pay?pa=...&am=... link to a merchant VPA is rejected by UPI apps
    # ("this kind of transaction is not allowed"); the merchant fields below are what
    # make the intent acceptable, so the QR opens with the amount pre-filled.
    upi_vpa: str = "9429271514-2@okbizaxis"          # payee address (pa)
    upi_payee_name: str = "Shiv Paneer Shawarma"     # display name shown to customers
    upi_payee_vpa_name: str = "VIRALKUMAR"           # pn — the account's registered name
    upi_merchant_code: str = "5812"                  # MCC (5812 = eating places / restaurants)
    upi_merchant_aid: str = "uGICAgMDS4_a_XQ"        # Google merchant app id (aid)
    upi_qr_ver: str = "01"                           # ver
    upi_qr_mode: str = "01"                          # mode
    upi_txn_ref: str = "BCR2DN4T5LE5JELG"            # base transaction ref (tr) fallback

    # Maps
    maps_api_key: str = "YOUR_GOOGLE_MAPS_API_KEY"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
