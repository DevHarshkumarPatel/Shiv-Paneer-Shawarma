/* Public order tracking: lookup by id + status timeline (manual refresh). */
(function () {
  const { money, esc, el, statusLabel, fmtDateTime, fmtTime } = UI;

  const FLOW = {
    delivery: ["placed", "confirmed", "preparing", "packing", "ready", "on_the_way", "delivered"],
    takeaway: ["placed", "confirmed", "preparing", "packing", "ready", "picked_up"],
    dine_in: ["placed", "confirmed", "preparing", "ready", "served"],
  };
  const STEP_LABEL = {
    placed: "Order placed", confirmed: "Confirmed", preparing: "Preparing",
    packing: "Packing", ready: "Ready", on_the_way: "On the way",
    delivered: "Delivered", picked_up: "Picked up", served: "Served",
  };
  const PAY_LABEL = {
    pending: "Payment pending", awaiting_verification: "Verifying payment",
    paid: "Paid", failed: "Payment failed",
  };

  let currentId = "";

  document.addEventListener("DOMContentLoaded", () => {
    el("#trackBtn").addEventListener("click", () => track(el("#orderIdInput").value));
    el("#orderIdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") track(el("#orderIdInput").value); });
    const q = new URLSearchParams(location.search).get("id");
    if (q) { el("#orderIdInput").value = q; track(q); }
  });

  async function track(id) {
    id = (id || "").trim().toUpperCase();
    if (!id) return;
    currentId = id;
    el("#trackResult").innerHTML = `<div class="center-load"><div class="spinner"></div><div>Finding your order…</div></div>`;
    await load();
  }

  async function load() {
    const rb = el("#refreshTrack");
    if (rb) { rb.disabled = true; rb.textContent = "Refreshing…"; }
    try {
      const order = await API.get(`/api/orders/${encodeURIComponent(currentId)}`);
      render(order);
    } catch (e) {
      el("#trackResult").innerHTML = `<div class="empty"><div class="emoji">🔍</div>
        <h3>Order not found</h3><p class="text-muted">${esc(e.message)}</p></div>`;
    }
  }

  function render(order) {
    if (order.status === "cancelled") {
      el("#trackResult").innerHTML = cancelledCard(order);
      return;
    }
    const steps = FLOW[order.order_type] || FLOW.takeaway;
    const curIdx = steps.indexOf(order.status);
    const times = {};
    (order.history || []).forEach((h) => { times[h.status] = h.at; });

    const timeline = steps.map((s, i) => {
      const cls = i < curIdx ? "done" : i === curIdx ? "current" : "pending";
      const t = times[s] ? fmtDateTime(times[s]) : "";
      return `<div class="tl-step ${cls}"><div class="tl-title">${esc(STEP_LABEL[s] || statusLabel(s))}</div>
        ${t ? `<div class="tl-time">${esc(t)}</div>` : ""}</div>`;
    }).join("");

    const payCls = order.payment.status === "paid" ? "badge-veg"
      : order.payment.status === "failed" ? "badge-status" : "badge-soft";
    const items = order.items.map((i) =>
      `<div class="summary-item"><div><div class="si-name">${esc(i.name)} × ${i.quantity}</div>
        <div class="si-sub">${esc(i.variant_label || "")}${i.free_quantity ? ` · ${i.free_quantity} free` : ""}</div></div>
        <div class="si-name">${money(i.line_total)}</div></div>`).join("");

    el("#trackResult").innerHTML = `
      <div class="card step-card"><div class="card-pad">
        <div class="row-between wrap">
          <div><div class="text-sm text-muted">Order id</div><div class="order-id-badge" style="font-size:var(--fs-lg);margin:2px 0;">${esc(order.public_id)}</div></div>
          <div style="text-align:right;">
            <span class="badge badge-offer" style="text-transform:capitalize;">${esc(statusLabel(order.status))}</span>
            <div style="margin-top:6px;"><span class="badge ${payCls}">${esc(PAY_LABEL[order.payment.status] || order.payment.status)}</span></div>
          </div>
        </div>
        <div class="text-sm text-muted" style="margin-top:8px;text-transform:capitalize;">${esc(order.order_type.replace("_", "-"))} · ${money(order.total)}</div>
      </div></div>

      <div class="card step-card"><div class="card-pad">
        <div class="row-between wrap" style="align-items:center;gap:8px;">
          <h3 style="margin:0;">Status</h3>
          <div class="row" style="align-items:center;gap:10px;">
            <span class="text-sm text-muted" id="trackChecked"></span>
            <button class="btn btn-outline btn-sm" id="refreshTrack">↻ Refresh</button>
          </div>
        </div>
        <div class="timeline" style="margin-top:var(--sp-3);">${timeline}</div>
      </div></div>

      <div class="card step-card"><div class="card-pad">
        <h3 style="margin-top:0;">Items</h3>
        ${items}
        <div class="summary-line grand" style="margin-top:var(--sp-3);"><span>Total</span><span>${money(order.total)}</span></div>
        ${order.customer && order.customer.address ? `<p class="text-sm text-muted" style="margin-top:var(--sp-3);">🛵 ${esc(order.customer.address)}</p>` : ""}
      </div></div>`;

    const rb = el("#refreshTrack");
    if (rb) rb.addEventListener("click", load);
    const chk = el("#trackChecked");
    if (chk) chk.textContent = `Checked ${fmtTime(new Date())}`;
  }

  function cancelledCard(order) {
    return `<div class="card step-card"><div class="card-pad">
      <div class="order-id-badge">${esc(order.public_id)}</div>
      <p style="margin-top:var(--sp-3);"><span class="badge badge-status" style="color:var(--err);">Cancelled</span></p>
      <p class="text-muted text-sm">This order was cancelled. If this is unexpected, please contact the outlet.</p>
    </div></div>`;
  }
})();
