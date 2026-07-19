"""Staff / owner order management: live board, status updates, payment verify."""
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import get_current_user
from ..models import Order, StatusEvent
from ..models.order import STATUS_FLOW
from ..schemas.models import StatusUpdateRequest, VerifyPaymentRequest

router = APIRouter(prefix="/api/admin/orders", tags=["admin-orders"])

# Statuses that end an order's lifecycle.
TERMINAL = {"delivered", "picked_up", "served", "cancelled"}


@router.get("")
def list_orders(
    user=Depends(get_current_user),
    order_type: str | None = None,
    active_only: bool = False,
    limit: int = 100,
):
    q = Order.query().order(-Order.created_at)
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
