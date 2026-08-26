"""Fill repeat_no / phone_key on orders placed before those fields existed.

An order records which visit it was for that customer, written when the order
is created. Orders from before that change have neither field, so the invoice
prints no repeat count for them. This walks the history oldest-first and
numbers each customer's visits in the order they actually happened.

Safe to re-run: an order already carrying the right values is left untouched.

Run from backend/, with the emulator running and .env configured:
    python backfill_repeat_numbers.py --dry-run   # report only, write nothing
    python backfill_repeat_numbers.py             # write
"""
import sys

from app.db import db_context
from app.models import Order
from app.services.phones import norm_phone


def main(dry_run: bool) -> None:
    with db_context():
        # Oldest first: the repeat number is a running count, so the pass has to
        # see a customer's orders in the sequence they were placed.
        orders = sorted(Order.query(), key=lambda o: (o.created_at is None, o.created_at))
        if not orders:
            print("No orders — nothing to backfill.")
            return

        visits: dict[str, int] = {}
        touched = 0
        for o in orders:
            key = norm_phone(o.customer.phone if o.customer else "")
            if key:
                visits[key] = visits.get(key, 0) + 1
                repeat_no = visits[key]
            else:
                # No usable phone: the order can't be tied to anyone, so it
                # counts as that person's first and only visit.
                repeat_no = 1
            if (o.repeat_no, o.phone_key or "") == (repeat_no, key):
                continue
            o.repeat_no, o.phone_key = repeat_no, key
            touched += 1
            if not dry_run:
                o.put()

        print(f"{len(orders)} orders scanned, {'would update' if dry_run else 'updated'} {touched}.")
        repeats = sum(1 for count in visits.values() if count > 1)
        print(f"{len(visits)} customers, {repeats} of them repeat.")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
