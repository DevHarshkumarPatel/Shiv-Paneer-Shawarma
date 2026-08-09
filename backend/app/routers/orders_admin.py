"""Staff / owner order management: live board, status updates, payment verify."""
import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..deps import get_current_user, require_owner
from ..models import Order, StatusEvent
from ..models.order import STATUS_FLOW
from ..schemas.models import StatusUpdateRequest, VerifyPaymentRequest

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
        orders.append(o.to_dict())
        if len(orders) >= limit:
            break
    return {"orders": orders}


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
            "Items", "Subtotal (INR)",
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
                _csv_cell(items), f"{o.subtotal:.2f}",
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


@router.get("/{public_id}")
def get_one(public_id: str, user=Depends(get_current_user)):
    order = Order.by_public_id(public_id)
    if not order:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
    return order.to_dict()


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
    return order.to_dict()


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
    return order.to_dict()
