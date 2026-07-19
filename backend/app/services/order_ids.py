"""Human-friendly, sequential order id generation: SPS-YYMMDD-####."""
from datetime import datetime

from ..models import Counter


def generate_order_id() -> str:
    today = datetime.utcnow().strftime("%y%m%d")
    seq = Counter.next_value(f"order-{today}")
    return f"SPS-{today}-{seq:04d}"
