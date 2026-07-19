/* Checkout: summary, customer + address/map, UPI QR payment, place order. */
(function () {
  const { money, esc, el, els, toast } = UI;

  const state = {
    mode: Store.get().mode,
    coupon: Store.get().coupon || "",
    quote: null,
    customer: { name: "", phone: "", address: "", lat: null, lng: null },
    areas: [],            // owner-defined delivery areas (id, name, fee)
    deliveryAreaId: "",   // selected area id (string from <select>)
    payment: "cash",   // 'cash' | 'upi'
    upiReference: "",
    qr: null,          // server-generated UPI QR (amount pre-filled)
    placing: false,
  };

  const MODE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    if (!Store.count()) { renderEmpty(); return; }
    try {
      const cfg = await API.get("/api/config");
      window.SPS_CONFIG.runtime = cfg || {};
    } catch { /* non-fatal */ }
    try {
      const { areas } = await API.get("/api/delivery-areas");
      state.areas = areas || [];
    } catch { state.areas = []; }
    // Delivery must be paid online; default others to cash.
    state.payment = state.mode === "delivery" ? "upi" : "cash";
    await refreshQuote();
    render();
  }

  function renderEmpty() {
    el("#checkoutRoot").innerHTML = `<div class="empty"><div class="emoji">🛒</div>
      <h3>Your cart is empty</h3><p class="text-muted">Add some items before checking out.</p>
      <a class="btn btn-primary" href="menu.html">Browse the menu</a></div>`;
  }

  async function refreshQuote() {
    state.quote = await API.post("/api/orders/quote", {
      cart: Store.toCartPayload(), order_type: state.mode, coupon_code: state.coupon,
      delivery_area_id: Number(state.deliveryAreaId) || 0,
    });
    if (state.coupon && state.quote.coupon_error) { toast(state.quote.coupon_error, "err"); state.coupon = ""; Store.setCoupon(""); }
    // Changing the total invalidates any generated QR (amount is baked into it).
    state.qr = null;
  }

  /* ---------------- render ---------------- */
  function render() {
    const q = state.quote;
    el("#checkoutRoot").innerHTML = `
      <div class="checkout-grid">
        <div>
          ${stepOrderType()}
          ${stepDetails()}
          ${stepPayment()}
        </div>
        <aside>
          <div class="card step-card">
            <div class="card-pad">
              <h3 style="margin-top:0;">Order summary</h3>
              <div id="summaryItems">${summaryItems(q)}</div>
              <div class="field" style="margin:var(--sp-3) 0 0;">
                <div class="input-row">
                  <input class="input" id="coCoupon" placeholder="Coupon code" value="${esc(state.coupon)}" />
                  <button class="btn btn-outline" id="coApplyCoupon" type="button">Apply</button>
                </div>
              </div>
              <div style="margin-top:var(--sp-3);">${summaryTotals(q)}</div>
            </div>
          </div>
          <button class="btn btn-primary btn-block btn-lg" id="placeOrder">Place order · ${money(q.total)}</button>
          <p class="text-sm text-muted text-center" style="margin-top:8px;">${placeHint()}</p>
        </aside>
      </div>`;
    bind();
  }

  function stepOrderType() {
    const opt = (m, ico) => `<button data-mode="${m}" class="${state.mode === m ? "active" : ""}">${ico} ${MODE_LABEL[m]}</button>`;
    return `<div class="card step-card"><div class="card-pad">
      <div class="step-head"><span class="step-num">1</span><h3>Order type</h3></div>
      <div class="seg" id="coMode" style="display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-pill);padding:3px;">
        ${opt("dine_in", "🍽️")}${opt("takeaway", "🥡")}${opt("delivery", "🛵")}
      </div>
      <p class="text-sm text-muted" style="margin:10px 0 0;">${state.mode === "delivery"
        ? "Delivery fee applies and payment is collected online before we start."
        : "No extra charge. Pay online now or at the counter."}</p>
    </div></div>`;
  }

  function areaSelectHTML() {
    if (!state.areas.length) {
      return `<select class="select" id="custArea" disabled><option>No delivery areas available yet</option></select>`;
    }
    const opts = [`<option value="" ${state.deliveryAreaId ? "" : "selected"} disabled>Select your area…</option>`]
      .concat(state.areas.map((a) =>
        `<option value="${a.id}" ${String(a.id) === String(state.deliveryAreaId) ? "selected" : ""}>${esc(a.name)} · ${money(a.fee)}</option>`));
    return `<select class="select" id="custArea">${opts.join("")}</select>`;
  }

  function stepDetails() {
    const c = state.customer;
    const delivery = state.mode === "delivery";
    return `<div class="card step-card"><div class="card-pad">
      <div class="step-head"><span class="step-num">2</span><h3>Your details</h3></div>
      <div class="input-row">
        <div class="field grow"><label>Name</label><input class="input" id="custName" value="${esc(c.name)}" placeholder="Your name" /></div>
        <div class="field grow"><label>Phone</label><input class="input" id="custPhone" value="${esc(c.phone)}" placeholder="10-digit mobile" inputmode="numeric" /></div>
      </div>
      ${delivery ? `
        <div class="field"><label>Delivery area <span style="color:var(--err);">*</span></label>
          ${areaSelectHTML()}
          <div class="map-note">Delivery charge is set by the area you choose.</div>
        </div>
        <div class="field"><label>Delivery address</label>
          <textarea class="input" id="custAddress" placeholder="Flat / house, street, area, landmark">${esc(c.address)}</textarea>
        </div>` : ""}
    </div></div>`;
  }

  function stepPayment() {
    const delivery = state.mode === "delivery";
    const methods = delivery ? "" : `
      <div class="pay-methods" id="payMethods">
        <div class="pay-opt ${state.payment === "cash" ? "active" : ""}" data-pay="cash">💵 Pay at counter<div class="sub">Cash / UPI on arrival</div></div>
        <div class="pay-opt ${state.payment === "upi" ? "active" : ""}" data-pay="upi">📱 Pay now (UPI)<div class="sub">GPay · PhonePe · Paytm</div></div>
      </div>`;
    return `<div class="card step-card" id="payStep"><div class="card-pad">
      <div class="step-head"><span class="step-num">3</span><h3>Payment</h3></div>
      ${delivery ? `<p class="text-sm text-muted" style="margin-top:0;">Delivery orders are prepaid via UPI.</p>` : methods}
      <div id="upiArea" style="margin-top:var(--sp-3);">${state.payment === "upi" ? upiArea() : ""}</div>
    </div></div>`;
  }

  function upiArea() {
    if (!state.qr) {
      return `<button class="btn btn-dark btn-block" id="genQr" type="button">Show UPI QR to pay ${money(state.quote.total)}</button>`;
    }
    return `
      <div class="qr-box">
        <div class="qr-amount">${money(state.qr.amount)}</div>
        <div class="text-sm text-muted" style="margin-bottom:8px;">Scan with GPay, PhonePe, Paytm or any UPI app — the amount is already filled in · ${esc(state.qr.payee)}</div>
        <img src="${esc(state.qr.qr_data_url)}" alt="UPI QR code" />
      </div>
      <div class="field" style="margin-top:var(--sp-3);">
        <label>UPI reference / UTR number (after paying)</label>
        <input class="input" id="upiRef" value="${esc(state.upiReference)}" placeholder="e.g. 4051XXXXXXXX" />
        <div class="map-note">We confirm your payment against this reference before starting your order.</div>
      </div>`;
  }

  function summaryItems(q) {
    return q.lines.map((l) => `
      <div class="summary-item">
        <div><div class="si-name">${esc(l.name)} × ${l.quantity}</div>
          <div class="si-sub">${esc(l.variant_label || "")}${l.free_quantity ? ` · 🎉 ${l.free_quantity} free` : ""}</div></div>
        <div class="si-name">${money(l.line_total)}</div>
      </div>`).join("");
  }
  function summaryTotals(q) {
    const rows = [`<div class="summary-line"><span>Subtotal</span><span>${money(q.subtotal)}</span></div>`];
    if (q.promo_discount > 0) rows.push(`<div class="summary-line free-note"><span>Offers (B1G1)</span><span>− ${money(q.promo_discount)}</span></div>`);
    if (q.coupon_discount > 0) rows.push(`<div class="summary-line free-note"><span>Coupon ${esc(q.coupon_code)}</span><span>− ${money(q.coupon_discount)}</span></div>`);
    if (state.mode === "delivery") {
      if (q.delivery_area_required) {
        rows.push(`<div class="summary-line" style="color:var(--err);"><span>Delivery</span><span>Select area</span></div>`);
      } else {
        const label = q.delivery_area_name ? `Delivery · ${esc(q.delivery_area_name)}` : "Delivery fee";
        rows.push(`<div class="summary-line"><span>${label}</span><span>${money(q.delivery_fee)}</span></div>`);
      }
    } else if (q.delivery_fee > 0) {
      rows.push(`<div class="summary-line"><span>Delivery fee</span><span>${money(q.delivery_fee)}</span></div>`);
    }
    rows.push(`<div class="summary-line grand"><span>Total</span><span>${money(q.total)}</span></div>`);
    return rows.join("");
  }
  function placeHint() {
    if (state.mode === "delivery") return "You'll pay online, then we confirm and prepare your order.";
    return state.payment === "upi" ? "Pay online now — enter your UPI reference below." : "Pay at the counter when you arrive.";
  }

  /* ---------------- bind ---------------- */
  function bind() {
    els("#coMode button").forEach((b) => b.addEventListener("click", async () => {
      state.mode = b.dataset.mode; Store.setMode(state.mode);
      state.payment = state.mode === "delivery" ? "upi" : "cash";
      await refreshQuote(); render();
    }));
    const nameEl = el("#custName"); if (nameEl) nameEl.addEventListener("input", (e) => state.customer.name = e.target.value);
    const phoneEl = el("#custPhone"); if (phoneEl) phoneEl.addEventListener("input", (e) => state.customer.phone = e.target.value.replace(/[^0-9]/g, "").slice(0, 10));
    const addrEl = el("#custAddress"); if (addrEl) addrEl.addEventListener("input", (e) => state.customer.address = e.target.value);
    const areaEl = el("#custArea");
    if (areaEl) areaEl.addEventListener("change", async (e) => {
      state.deliveryAreaId = e.target.value;
      await refreshQuote(); render();
    });

    els("[data-pay]").forEach((o) => o.addEventListener("click", () => {
      state.payment = o.dataset.pay;
      els("[data-pay]").forEach((x) => x.classList.toggle("active", x === o));
      el("#upiArea").innerHTML = state.payment === "upi" ? upiArea() : "";
      bindUpi();
    }));
    bindUpi();
    const applyBtn = el("#coApplyCoupon");
    if (applyBtn) applyBtn.addEventListener("click", async () => {
      state.coupon = el("#coCoupon").value.trim().toUpperCase();
      Store.setCoupon(state.coupon);
      await refreshQuote(); render();
    });
    el("#placeOrder").addEventListener("click", placeOrder);
  }

  function bindUpi() {
    const gen = el("#genQr");
    if (gen) gen.addEventListener("click", async () => {
      if (state.mode === "delivery" && !state.deliveryAreaId) return toast("Please select your delivery area first", "err");
      gen.disabled = true; gen.textContent = "Generating…";
      try {
        state.qr = await API.post("/api/payments/upi-qr", {
          cart: Store.toCartPayload(), order_type: state.mode, coupon_code: state.coupon,
          delivery_area_id: Number(state.deliveryAreaId) || 0,
        });
        el("#upiArea").innerHTML = upiArea(); bindUpi();
      } catch (e) { toast(e.message, "err"); gen.disabled = false; gen.textContent = `Show UPI QR to pay ${money(state.quote.total)}`; }
    });
    const ref = el("#upiRef");
    if (ref) ref.addEventListener("input", (e) => state.upiReference = e.target.value.trim());
  }

  /* ---------------- place order ---------------- */
  async function placeOrder() {
    if (state.placing) return;
    const c = state.customer;
    if (!c.name.trim()) return toast("Please enter your name", "err");
    if (!/^[0-9]{10}$/.test(c.phone)) return toast("Enter a valid 10-digit phone number", "err");
    if (state.mode === "delivery" && !state.deliveryAreaId) return toast("Please select your delivery area", "err");
    if (state.mode === "delivery" && !c.address.trim()) return toast("Please enter your delivery address", "err");
    if (state.payment === "upi" && !state.upiReference.trim())
      return toast("Enter your UPI reference after paying", "err");

    const btn = el("#placeOrder");
    state.placing = true; btn.disabled = true; btn.textContent = "Placing your order…";
    try {
      const order = await API.post("/api/orders", {
        cart: Store.toCartPayload(),
        order_type: state.mode,
        coupon_code: state.coupon,
        delivery_area_id: Number(state.deliveryAreaId) || 0,
        customer: c,
        payment_method: state.payment,
        upi_reference: state.upiReference,
      });
      Store.clear();
      renderConfirmation(order);
    } catch (e) {
      toast(e.message, "err");
      state.placing = false; btn.disabled = false; btn.textContent = `Place order · ${money(state.quote.total)}`;
    }
  }

  function renderConfirmation(order) {
    const payMsg = order.payment.method === "upi"
      ? (order.payment.status === "awaiting_verification"
          ? "We're verifying your UPI payment. You'll be updated shortly."
          : "Payment pending.")
      : "Please pay at the counter.";
    el("#checkoutRoot").innerHTML = `
      <div class="card"><div class="confirm-hero">
        <div class="check">✓</div>
        <h2>Order placed!</h2>
        <p class="text-muted">Thank you, ${esc(order.customer ? order.customer.name : "")}. Save your order id:</p>
        <div class="order-id-badge">${esc(order.public_id)}</div>
        <p class="text-sm text-muted">${esc(MODE_LABEL[order.order_type])} · ${money(order.total)} · ${esc(payMsg)}</p>
        <div class="row" style="justify-content:center;margin-top:var(--sp-4);flex-wrap:wrap;">
          <a class="btn btn-primary btn-lg" href="track.html?id=${encodeURIComponent(order.public_id)}">Track this order →</a>
          <a class="btn btn-outline btn-lg" href="menu.html">Order more</a>
        </div>
      </div></div>`;
    window.scrollTo({ top: 0 });
  }
})();
