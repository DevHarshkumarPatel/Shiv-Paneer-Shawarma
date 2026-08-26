"""Phone-number normalisation, shared by ordering and the customer views.

The same customer types 9876543210, +91 98765 43210 and 098765-43210 across
three orders. Every place that asks "is this the same person" has to agree on
one answer, so the rule lives here rather than once per caller.
"""
import re


def norm_phone(raw: str) -> str:
    """Digits only, last 10 kept — one identity per person."""
    digits = re.sub(r"\D", "", raw or "")
    return digits[-10:] if len(digits) >= 10 else digits
