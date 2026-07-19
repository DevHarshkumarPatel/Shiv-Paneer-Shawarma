"""Build a UPI payment intent URI and a QR-code image (data URL)."""
import base64
import io
from urllib.parse import quote

import qrcode

from ..config import settings


def build_upi_uri(amount: float, note: str, txn_ref: str = "") -> str:
    """Construct a UPI *merchant* (P2M) intent link — upi://pay?...

    Scanned by GPay / PhonePe / Paytm; the amount is pre-filled. This mirrors the
    restaurant's real GPay-for-Business QR (VPA + merchant code + Google aid + mode)
    and only adds the amount. A bare P2P link (just pa + am) to a merchant VPA is
    rejected by UPI apps ("this kind of transaction is not allowed"), which is why
    the merchant fields below are required.
    """
    # `tr` must be plain alphanumeric; strip separators from ids like SPS-260718-0042.
    tr = "".join(ch for ch in (txn_ref or settings.upi_txn_ref) if ch.isalnum())
    params = [
        ("pa", settings.upi_vpa),
        ("pn", settings.upi_payee_vpa_name),
        ("mc", settings.upi_merchant_code),
        ("aid", settings.upi_merchant_aid),
        ("ver", settings.upi_qr_ver),
        ("mode", settings.upi_qr_mode),
        ("tr", tr),
        ("am", f"{amount:.2f}"),
        ("cu", "INR"),
        ("tn", note),
    ]
    # Skip any field the owner left blank (e.g. no aid configured yet).
    return "upi://pay?" + "&".join(f"{k}={quote(str(v))}" for k, v in params if v)


def build_qr_data_url(data: str) -> str:
    """Render `data` as a QR PNG and return it as a base64 data URL."""
    qr = qrcode.QRCode(box_size=8, border=2)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"
