"""Human-friendly, sequential order ids, numbered per branch per day.

Main keeps the original SPS-YYMMDD-#### so the ids already on printed bills stay
one sequence. Every other branch puts its code in: SPS-ADJ-YYMMDD-####, with a
counter of its own, so two branches taking an order in the same second can never
hand out the same number.
"""
from datetime import datetime

from ..models import Counter


def generate_order_id(code: str = "") -> str:
    today = datetime.utcnow().strftime("%y%m%d")
    code = (code or "").upper().strip()
    if not code:
        seq = Counter.next_value(f"order-{today}")
        return f"SPS-{today}-{seq:04d}"
    seq = Counter.next_value(f"order-{code}-{today}")
    return f"SPS-{code}-{today}-{seq:04d}"
