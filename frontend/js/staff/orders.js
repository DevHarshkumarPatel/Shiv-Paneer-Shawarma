/* Staff/owner live orders board: list, advance status, verify payment. */
(function () {
  const { money, esc, el, els, toast, statusLabel, fmtDateTime, fmtTime } = UI;

  const FLOW = {
    delivery: ["placed", "confirmed", "preparing", "packing", "ready", "on_the_way", "delivered"],
    takeaway: ["placed", "confirmed", "preparing", "packing", "ready", "picked_up"],
    dine_in: ["placed", "confirmed", "preparing", "ready", "served"],
  };
  const TYPE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

  let filter = "all";
  let activeOnly = true;
  let user = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    if (user.role === "owner") el("#navMenu").classList.remove("hidden");
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });
    els("[data-filter]").forEach((c) => c.addEventListener("click", () => {
      els("[data-filter]").forEach((x) => x.classList.remove("active"));
      c.classList.add("active"); filter = c.dataset.filter; load();
    }));
    el("#activeOnly").addEventListener("change", (e) => { activeOnly = e.target.checked; load(); });
    el("#refreshBtn").addEventListener("click", load);
    await load();
  }

  async function load() {
    const btn = el("#refreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    let path = `/api/admin/orders?active_only=${activeOnly}`;
    if (filter !== "all") path += `&order_type=${filter}`;
    try {
      const { orders } = await API.get(path);
      render(orders);
      el("#lastUpdated").textContent = `· updated ${fmtTime(new Date())}`;
    } catch (e) {
      if (e.status === 401) { location.href = "login.html"; return; }
      el("#ordersBoard").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh"; }
    }
  }

  function render(orders) {
    if (!orders.length) {
      el("#ordersBoard").innerHTML = `<div class="empty"><div class="emoji">🍽️</div><h3>No ${activeOnly ? "active " : ""}orders</h3>
        <p class="text-muted">New orders appear here automatically.</p></div>`;
      return;
    }
    el("#ordersBoard").innerHTML = `<div class="orders-grid">${orders.map(card).join("")}</div>`;
    els("[data-advance]").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.id, b.dataset.advance)));
    els("[data-cancel]").forEach((b) => b.addEventListener("click", () => {
      if (confirm("Cancel this order?")) setStatus(b.dataset.cancel, "cancelled");
    }));
    els("[data-verify]").forEach((b) => b.addEventListener("click", () => verifyPay(b.dataset.verify, b.dataset.result)));
  }

  function card(o) {
    const steps = FLOW[o.order_type] || FLOW.takeaway;
    const idx = steps.indexOf(o.status);
    const next = idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null;
    const terminal = ["delivered", "picked_up", "served", "cancelled"].includes(o.status);
    const created = o.created_at ? fmtDateTime(o.created_at) : "";

    const items = o.items.map((i) =>
      `<div class="oc-item"><span><span class="q">${i.quantity}×</span> ${esc(i.name)} <span class="text-muted">${esc(i.variant_label || "")}</span>${i.free_quantity ? ` <span class="free-note">+${i.free_quantity} free</span>` : ""}</span>
        <span>${money(i.line_total)}</span></div>`).join("");

    const cust = o.customer ? `<div class="oc-cust">
      👤 ${esc(o.customer.name || "—")} · 📞 ${esc(o.customer.phone || "—")}
      ${o.order_type === "delivery" && o.customer.address ? `<br/>🛵 ${esc(o.customer.address)}` : ""}
      ${o.customer.lat ? `<br/><a href="https://maps.google.com/?q=${o.customer.lat},${o.customer.lng}" target="_blank" rel="noopener">📍 View on map</a>` : ""}
    </div>` : "";

    const payRow = `<div class="row-between" style="margin-bottom:8px;">
      <span class="pay-pill ${o.payment.status}">${esc(payLabel(o.payment))}</span>
      ${o.payment.upi_reference ? `<span class="text-xs text-muted" style="font-size:var(--fs-xs);">UTR: ${esc(o.payment.upi_reference)}</span>` : ""}
    </div>`;

    const verifyBtns = o.payment.status === "awaiting_verification"
      ? `<div class="row" style="margin-bottom:8px;">
           <button class="btn btn-sm btn-primary grow" data-verify="${esc(o.public_id)}" data-result="paid">✓ Confirm payment</button>
           <button class="btn btn-sm btn-danger" data-verify="${esc(o.public_id)}" data-result="failed">Reject</button>
         </div>` : "";

    const actions = terminal
      ? `<div class="text-sm text-muted">Order ${esc(statusLabel(o.status))}.</div>`
      : `<div class="row">
           ${next ? `<button class="btn btn-sm btn-primary grow" data-advance="${esc(next)}" data-id="${esc(o.public_id)}">Mark ${esc(statusLabel(next))} →</button>` : ""}
           <button class="btn btn-sm btn-danger" data-cancel="${esc(o.public_id)}">Cancel</button>
         </div>`;

    return `<article class="order-card type-${o.order_type}">
      <div class="oc-head">
        <div><div class="oc-id">${esc(o.public_id)}</div><div class="oc-meta">${esc(created)}</div></div>
        <div style="text-align:right;">
          <span class="type-tag ${o.order_type}">${esc(TYPE_LABEL[o.order_type])}</span>
          <div style="margin-top:6px;"><span class="status-pill ${o.status}">${esc(statusLabel(o.status))}</span></div>
        </div>
      </div>
      <div class="oc-body">
        ${items}
        <div class="row-between" style="margin-top:8px;font-weight:800;"><span>Total</span><span>${money(o.total)}</span></div>
        ${cust}
      </div>
      <div class="oc-foot">
        ${payRow}
        ${verifyBtns}
        ${actions}
      </div>
    </article>`;
  }

  function payLabel(p) {
    const map = { paid: "Paid", awaiting_verification: "Verify payment", pending: "Unpaid", failed: "Payment failed" };
    return `${p.method === "upi" ? "UPI" : "Cash"} · ${map[p.status] || p.status}`;
  }

  async function setStatus(id, status) {
    try { await API.post(`/api/admin/orders/${encodeURIComponent(id)}/status`, { status }); toast(`${id} → ${statusLabel(status)}`, "ok"); load(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function verifyPay(id, result) {
    try { await API.post(`/api/admin/orders/${encodeURIComponent(id)}/verify-payment`, { status: result }); toast(`Payment ${result}`, result === "paid" ? "ok" : ""); load(); }
    catch (e) { toast(e.message, "err"); }
  }
})();
