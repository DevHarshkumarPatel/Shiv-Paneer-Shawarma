"""Staff / owner order management: live board, status updates, payment verify."""
import csv
import io
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..deps import get_current_user, require_owner
from ..models import (
    Coupon, CustomerInfo, Order, OrderItem, OrderTopup, PaymentInfo, StatusEvent,
)
from ..models.order import STATUS_FLOW
from ..schemas.models import (
    OrderEditRequest, StaffOrderRequest, StatusUpdateRequest, VerifyPaymentRequest,
)
from ..services.order_edit import record_edit, snapshot
from ..services.orders import persist_order, price_or_reject
from ..services.phones import norm_phone

router = APIRouter(prefix="/api/admin/orders", tags=["admin-orders"])

# Statuses that end an order's lifecycle.
TERMINAL = {"delivered", "picked_up", "served", "cancelled"}

# IST is UTC+5:30. created_at is stored as naive UTC, so an IST calendar day
# maps to the UTC window [day 00:00 IST, next day 00:00 IST).
IST_OFFSET = timedelta(hours=5, minutes=30)


def _ist_day_utc_window(date_str: str) -> tuple[datetime, datetime]:
    """Given an IST date 'YYYY-MM-DD', return its [start, end) as naive UTC."""
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "date must be YYYY-MM-DD.")
    start_utc = day - IST_OFFSET
    return start_utc, start_utc + timedelta(days=1)


@router.get("")
def list_orders(
    user=Depends(get_current_user),
    order_type: str | None = None,
    active_only: bool = False,
    date: str | None = None,
    limit: int = 100,
):
    q = Order.query().order(-Order.created_at)
    if date:
        start_utc, end_utc = _ist_day_utc_window(date)
        q = q.filter(Order.created_at >= start_utc, Order.created_at < end_utc)
    orders = []
    for o in q:
        if order_type and o.order_type != order_type:
            continue
        if active_only and o.status in TERMINAL:
            continue
        orders.append(o.to_dict(include_edits=True))
        if len(orders) >= limit:
            break
    return {"orders": orders}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_counter_order(body: StaffOrderRequest, user=Depends(get_current_user)):
    """Place an order on a customer's behalf — counter, phone call or walk-in.

    Prices through the same module as the customer's own checkout, so every
    offer, B1G1 pool and coupon (including a scratch-card code, which still only
    works for the phone that won it) behaves identically. Three things differ,
    and only these three:

    * the owner's online-ordering switch is not consulted — closing online
      ordering closes the website, not the shop;
    * delivery need not be prepaid, because staff can hand a cash order to the
      rider — an area and an address are still required;
    * staff can record that the money is already in hand, which the customer's
      own checkout must never be able to say about itself.

    Add-ons (extra cheese, extra paneer) ride along on this path only, for the
    same reason: they are asked for across the counter, so the website has no
    way to post one.
    """
    if body.order_type not in ("dine_in", "takeaway", "delivery"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid order type")
    if body.payment_method not in ("cash", "upi"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Payment method must be 'cash' or 'upi'.")

    # Name and number are required on every counter order, walk-ins included.
    # They are how an order is found again afterwards — the customer's history,
    # a reward code, a call back about a wrong bill — and an order with neither
    # belongs to nobody. Checked here as well as on the counter screen because
    # this endpoint is what actually writes the order.
    if not body.customer.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Customer name is needed.")
    if not re.fullmatch(r"[0-9]{10}", body.customer.phone.strip()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A 10-digit phone number is needed.")

    priced = price_or_reject(
        [c.model_dump() for c in body.cart], body.order_type, body.coupon_code,
        body.delivery_area_id, body.customer.phone,
        [t.model_dump() for t in body.topups],
    )
    # A coupon the staff member typed that did not hold up is reported rather
    # than dropped: they are standing in front of the customer who handed it
    # over, so the bill must not quietly come out at full price.
    if body.coupon_code and not priced.coupon_code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            priced.coupon_error or "That coupon cannot be used on this order.")

    if body.order_type == "delivery":
        if priced.delivery_area_required:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Select the delivery area.")
        if not body.customer.address.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Delivery needs an address.")

    if body.payment_collected:
        pay_status = "paid"
    elif body.payment_method == "upi" and body.upi_reference.strip():
        pay_status = "awaiting_verification"
    else:
        pay_status = "pending"

    order = persist_order(
        priced, order_type=body.order_type, customer=body.customer, notes=body.notes,
        payment_method=body.payment_method, payment_status=pay_status,
        upi_reference=body.upi_reference, by=user.email, channel="counter",
        placed_by=user.email,
        verified_by=user.email if pay_status == "paid" else "",
    )
    return order.to_dict(include_edits=True)


@router.get("/latest")
def latest_order(user=Depends(get_current_user)):
    """Cheap probe for new-order alerts: just the newest order's id + timestamp.

    Deliberately tiny (no full serialization, single get) so the owner dashboard
    can poll it frequently without the Cloud Run cost of listing every order.
    Declared before ``/{public_id}`` so 'latest' isn't captured as a public_id.
    """
    o = Order.query().order(-Order.created_at).get()
    if not o:
        return {"latest_id": None, "latest_created_at": None}
    return {
        "latest_id": o.public_id,
        "latest_created_at": o.created_at.isoformat() if o.created_at else None,
    }


def _csv_cell(value: str) -> str:
    """One spreadsheet-safe line of text.

    Addresses are free text a customer typed, so two things are fixed here:
    embedded newlines are flattened (otherwise one order spans several rows in
    the sheet), and a leading =, +, - or @ is escaped — Excel and Sheets treat
    those as a formula, which is how a pasted address turns into a live cell.
    """
    text = " ".join((value or "").split())
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


@router.get("/export.csv")
def export_orders_csv(
    start: str,
    end: str,
    include_items: bool = False,
    _owner=Depends(require_owner),
):
    """Owner-only CSV of the orders placed between two IST dates, inclusive.

    Customer contact details always; the item lines and the bill amount only if
    asked for, because the usual reason to pull this file is a contact list and
    not an accounts report. Declared before ``/{public_id}`` so the path is not
    swallowed as an order id.
    """
    start_utc, _ = _ist_day_utc_window(start)
    _, end_utc = _ist_day_utc_window(end)
    if end_utc <= start_utc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "End date must not be before the start date.")

    orders = list(
        Order.query(Order.created_at >= start_utc, Order.created_at < end_utc)
        .order(Order.created_at)
    )

    header = ["Order ID", "Date (IST)", "Order type", "Customer name", "Phone", "Address"]
    if include_items:
        header += [
            "Items", "Subtotal (INR)", "Add-ons (INR)",
            "Offer applied", "Offer discount (INR)",
            "Coupon code", "Coupon discount (INR)",
            "Delivery fee (INR)", "Total paid (INR)",
        ]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for o in orders:
        c = o.customer
        placed_ist = (o.created_at + IST_OFFSET).strftime("%Y-%m-%d %H:%M") if o.created_at else ""
        row = [
            o.public_id,
            placed_ist,
            o.order_type.replace("_", "-"),
            _csv_cell(c.name if c else ""),
            _csv_cell(c.phone if c else ""),
            _csv_cell(c.address if c else ""),
        ]
        if include_items:
            items = "; ".join(
                f"{i.name}"
                + (f" ({i.variant_label})" if i.variant_label else "")
                + f" x{i.quantity}"
                for i in o.items
            )
            # Add-ons are part of what was sold, so they belong in the same
            # cell — marked with a + so a row still reads as food first.
            if o.topups:
                items += "; " + "; ".join(f"+{t.name} x{t.quantity}" for t in o.topups)
            # The promo is named from the labels frozen on the lines. Orders
            # placed before those were stored still show a discount, so fall
            # back to a generic name rather than an empty cell next to an
            # amount — "none" has to mean no offer, not "we lost the name".
            labels = list(dict.fromkeys(i.promo_label for i in o.items if i.promo_label))
            if labels:
                offer = ", ".join(labels)
            else:
                offer = "Offer (name not recorded)" if o.promo_discount > 0 else ""
            row += [
                _csv_cell(items), f"{o.subtotal:.2f}", f"{o.topups_total or 0:.2f}",
                _csv_cell(offer), f"{o.promo_discount:.2f}",
                _csv_cell(o.coupon_code or ""), f"{o.coupon_discount:.2f}",
                f"{o.delivery_fee:.2f}", f"{o.total:.2f}",
            ]
        writer.writerow(row)

    # utf-8-sig: Excel (and Google Sheets on a phone) reads a plain UTF-8 CSV as
    # latin-1 without the BOM, which mangles every non-ASCII name and address.
    body = buf.getvalue().encode("utf-8-sig")
    filename = f"orders-{start}-to-{end}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/edits/recent")
def recent_edits(date: str | None = None, scan: int = 400, _owner=Depends(require_owner)):
    """Owner-only feed of order edits, newest first — the audit screen.

    Walks back through the most recently touched orders and flattens their edit
    logs. Recently touched, not recently placed, because the whole point of this
    screen is a correction made today to an order taken last week, and `date`
    filters on when the *edit* happened rather than when the order did.

    Bounded by `scan` rather than paged: every status change also bumps
    ``updated_at``, so the orders worth reading sit near the front, and a
    deliberate ceiling is better here than a query that grows with the year.
    """
    start_utc = end_utc = None
    if date:
        start_utc, end_utc = _ist_day_utc_window(date)

    rows = []
    for o in Order.query().order(-Order.updated_at).fetch(max(1, min(scan, 1000))):
        for e in o.edits:
            if start_utc and not (e.at and start_utc <= e.at < end_utc):
                continue
            row = e.to_dict()
            row.update({
                "order_public_id": o.public_id,
                "order_type": o.order_type,
                "order_status": o.status,
                "customer_name": o.customer.name if o.customer else "",
                "customer_phone": o.customer.phone if o.customer else "",
            })
            rows.append(row)
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    return {"edits": rows, "scanned": scan}


@router.get("/{public_id}")
def get_one(public_id: str, user=Depends(get_current_user)):
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order.to_dict(include_edits=True)


def _may_edit(user, order) -> None:
    """Who may still change this order, and until when.

    Staff edit an order while it is live — the window in which the food has not
    been handed over and a correction is still just a correction. Once it is
    delivered, picked up, served or cancelled, only the owner can reopen it,
    because at that point the edit is no longer fixing an order but restating a
    bill that has already been paid. Either way the edit is logged; the role
    decides what is possible, the log is what makes it answerable.
    """
    if user.role == "owner":
        return
    if order.status in TERMINAL:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"This order is {order.status.replace('_', ' ')} — ask the owner to change it.",
        )


@router.put("/{public_id}")
def edit_order(public_id: str, body: OrderEditRequest, user=Depends(get_current_user)):
    """Correct an order that has already been placed, and log what changed.

    Re-prices from scratch through the same module the counter and the website
    use, so an edited order is priced exactly as it would have been had it been
    taken this way in the first place — today's offers included. Three things
    are deliberately frozen and never move:

    * `public_id`, because it is printed on a bill someone is holding;
    * `created_at`, because the order was placed when it was placed;
    * `repeat_no`, because "your 3rd order" was true when it was written and
      recomputing it here would renumber a customer's history on every edit.

    What the customer's own scratch draw was settled against is also left
    alone: that card was opened and closed when the order was placed, and an
    edit afterwards is not a second draw.
    """
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    _may_edit(user, order)

    if body.order_type not in ("dine_in", "takeaway", "delivery"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid order type")
    if body.payment_method not in ("cash", "upi"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Payment method must be 'cash' or 'upi'.")
    if not body.customer.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Customer name is needed.")
    if not re.fullmatch(r"[0-9]{10}", body.customer.phone.strip()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A 10-digit phone number is needed.")

    priced = price_or_reject(
        [c.model_dump() for c in body.cart], body.order_type, body.coupon_code,
        body.delivery_area_id, body.customer.phone,
        [t.model_dump() for t in body.topups],
    )
    if body.coupon_code and not priced.coupon_code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            priced.coupon_error or "That coupon cannot be used on this order.")
    if body.order_type == "delivery":
        if priced.delivery_area_required:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Select the delivery area.")
        if not body.customer.address.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Delivery needs an address.")

    # Taken before anything is touched: this is the "old" half of every line the
    # log is about to write.
    before = snapshot(order)

    old_pay = order.payment
    if body.payment_collected:
        pay_status = "paid"
    elif old_pay and old_pay.status == "failed" and old_pay.method == body.payment_method:
        # A rejected payment stays rejected unless someone actually says the
        # money arrived. Recomputing it would quietly turn "failed" back into
        # "unpaid" every time the kitchen note was fixed.
        pay_status = "failed"
    elif body.payment_method == "upi" and body.upi_reference.strip():
        pay_status = "awaiting_verification"
    else:
        pay_status = "pending"

    order.order_type = body.order_type
    order.items = [
        OrderItem(
            item_id=l.item_id, name=l.name, variant_label=l.variant_label,
            base=l.base, size=l.size, unit_price=l.unit_price, quantity=l.quantity,
            free_quantity=l.free_quantity, line_total=round(l.line_total, 2),
            promo_label=l.promo_label,
        )
        for l in priced.lines
    ]
    order.topups = [
        OrderTopup(
            topup_id=t.topup_id, name=t.name, unit_price=t.unit_price,
            quantity=t.quantity, per_quantity=t.per_quantity,
            line_total=round(t.line_total, 2),
        )
        for t in priced.topups
    ]
    order.customer = CustomerInfo(
        name=body.customer.name, phone=body.customer.phone,
        address=body.customer.address, lat=body.customer.lat, lng=body.customer.lng,
    )
    # Follows the number on the order so the customer's history keeps finding
    # it. `repeat_no` stays where it was — see the docstring.
    order.phone_key = norm_phone(body.customer.phone)

    # Orders written before the payment block existed have none; an edit is a
    # reasonable place to give them one rather than to fail.
    if not order.payment:
        order.payment = PaymentInfo()
    order.payment.method = body.payment_method
    order.payment.status = pay_status
    order.payment.upi_reference = body.upi_reference.strip()
    order.payment.amount = round(priced.total, 2)
    if pay_status == "paid":
        order.payment.verified_by = user.email

    order.subtotal = round(priced.subtotal, 2)
    order.promo_discount = round(priced.promo_discount, 2)
    order.coupon_discount = round(priced.coupon_discount, 2)
    order.delivery_fee = round(priced.delivery_fee, 2)
    order.delivery_area = priced.delivery_area_name
    order.topups_total = round(priced.topups_total, 2)
    order.total = round(priced.total, 2)
    order.notes = body.notes

    # A coupon taken off an order gives its use back, and one put on takes a
    # use — otherwise a code with a usage limit is spent by an edit that
    # removed it. Best-effort, like the counting at placement.
    old_code = before["coupon_code"]
    new_code = priced.coupon_code or ""
    if old_code != new_code:
        if old_code:
            c = Coupon.by_code(old_code)
            if c and c.used_count > 0:
                c.used_count -= 1
                c.put()
        order.coupon_code = new_code
        if new_code:
            c = Coupon.by_code(new_code)
            if c:
                c.used_count += 1
                c.put()

    changes = record_edit(order, before, user)
    order.put()
    return {"order": order.to_dict(include_edits=True), "changes": changes}


@router.post("/{public_id}/status")
def update_status(public_id: str, body: StatusUpdateRequest, user=Depends(get_current_user)):
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")

    new_status = body.status
    allowed = set(STATUS_FLOW.get(order.order_type, [])) | {"cancelled"}
    if new_status not in allowed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"'{new_status}' is not valid for a {order.order_type} order.",
        )
    order.status = new_status
    order.history.append(StatusEvent(status=new_status, by=user.email))
    order.put()
    return order.to_dict(include_edits=True)


@router.post("/{public_id}/verify-payment")
def verify_payment(public_id: str, body: VerifyPaymentRequest, user=Depends(get_current_user)):
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    if not order.payment:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Order has no payment record.")
    if body.status not in ("paid", "failed"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status must be 'paid' or 'failed'.")
    order.payment.status = body.status
    order.payment.verified_by = user.email
    order.put()
    return order.to_dict(include_edits=True)
