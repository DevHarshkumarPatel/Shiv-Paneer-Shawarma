/* Checkout: summary, customer + address/map, UPI QR payment, place order. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;

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
    orderingEnabled: true,   // owner master switch (from /api/settings)
  };

  const MODE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    // Check the ordering switch first so the customer is notified immediately,
    // even before we look at the cart.
    try {
      const s = await API.get("/api/settings");
      state.orderingEnabled = s.ordering_enabled !== false;
    } catch { /* default to enabled if unreachable */ }
    if (!state.orderingEnabled) { renderClosed(); return; }
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

  function renderClosed() {
    el("#checkoutRoot").innerHTML = `
      <div class="notice-banner">🔔 <strong>We're not accepting online orders right now.</strong>
        You're welcome to explore our menu — please check back a little later to place your order.</div>
      <div class="empty"><div class="emoji">🔔</div>
        <h3>Online ordering is paused</h3>
        <p class="text-muted">Your cart is saved on this device — you'll be able to place your order once ordering reopens.</p>
        <a class="btn btn-primary" href="menu.html">Back to menu</a></div>`;
  }

  async function refreshQuote() {
    state.quote = await API.post("/api/orders/quote", {
      cart: Store.toCartPayload(), order_type: state.mode, coupon_code: state.coupon,
      delivery_area_id: Number(state.deliveryAreaId) || 0,
    });
    if (state.coupon && state.quote.coupon_error) { toast(state.quote.coupon_error, "err"); state.coupon = ""; Store.setCoupon(""); }
    // Changing the total invalidates any generated QR (amount is baked into it).
    state.qr = null;
    // A reference typed against a now-void QR would be a reference for the wrong
    // amount, so it goes with it.
    state.upiReference = "";
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
          <button class="btn btn-primary btn-block btn-lg" id="placeOrder" ${deadList(q).length ? "disabled" : ""}>${
            deadList(q).length ? "Remove sold-out items to continue" : `Place order · ${money(q.total)}`}</button>
          <p class="text-sm text-muted text-center" style="margin-top:8px;">${placeHint()}</p>
        </aside>
      </div>`;
    bind();
  }

  function stepOrderType() {
    // .seg is styled in components.css; icons come from the sprite in checkout.html.
    const opt = (m, ico) => `<button data-mode="${m}" class="${state.mode === m ? "active" : ""}">
      <svg><use href="#${ico}"/></svg> ${MODE_LABEL[m]}</button>`;
    return `<div class="card step-card"><div class="card-pad">
      <div class="step-head"><span class="step-num">1</span><h3>Order type</h3></div>
      <div class="seg" id="coMode">
        ${opt("dine_in", "i-dine")}${opt("takeaway", "i-bag")}${opt("delivery", "i-scooter")}
      </div>
      <p class="text-sm text-muted" style="margin:10px 0 0;">${state.mode === "delivery"
        ? "Delivery fee applies and payment is collected online before we start."
        : "No extra charge. Pay online now or at the counter."}</p>
    </div></div>`;
  }

  /* Delivery area, without a native <select>.
   *
   * A native select draws its option list as an OS popup: CSS cannot reach it, so
   * it came up in the platform's own light colours over this dark page, and the
   * browser positions it wherever it likes — a full-screen takeover on a phone,
   * a panel off to one side in desktop emulation.
   *
   * The replacement adapts to how many areas the owner has defined, because that
   * count is open-ended — an outlet may list twenty or more:
   *   - up to AREA_INLINE_MAX: every area inline, each with its fee visible, no
   *     extra tap and nothing hidden;
   *   - beyond it: a summary row that opens a searchable sheet, because thirty
   *     inline rows would be longer than the rest of the form and scrolling to
   *     find a neighbourhood is worse than typing three letters of it.
   */
  const AREA_INLINE_MAX = 6;

  const areaById = (id) => state.areas.find((a) => String(a.id) === String(id));

  const areaOptHTML = (a) => `
    <button type="button" class="area-opt ${String(a.id) === String(state.deliveryAreaId) ? "active" : ""}"
            data-area="${a.id}">
      <span class="an">${esc(a.name)}</span>
      <span class="af">${money(a.fee)}</span>
    </button>`;

  function areaSelectHTML() {
    if (!state.areas.length) {
      return `<p class="text-muted text-sm" style="margin:0;">No delivery areas available yet — please pick dine-in or takeaway.</p>`;
    }
    if (state.areas.length <= AREA_INLINE_MAX) {
      // Few enough to show at once: every fee visible, no extra tap.
      return `<div class="area-grid" id="custArea">${state.areas.map(areaOptHTML).join("")}</div>`;
    }
    // Many areas: a summary row that opens a searchable sheet. Typing beats
    // scrolling a list of thirty neighbourhoods on a phone.
    const chosen = areaById(state.deliveryAreaId);
    return `<button type="button" class="area-picker ${chosen ? "chosen" : ""}" id="areaPicker">
        <span class="ap-label">${chosen ? esc(chosen.name) : "Select your area…"}</span>
        ${chosen ? `<span class="af">${money(chosen.fee)}</span>` : ""}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>`;
  }

  /* Searchable area sheet. Only used past AREA_INLINE_MAX. */
  function openAreaPicker() {
    const m = modal({
      title: "Delivery area",
      bodyHTML: `
        <input class="input" id="areaSearch" placeholder="Search your area or pin code…" autocomplete="off" />
        <div class="area-list" id="areaList">${state.areas.map(areaOptHTML).join("")}</div>
        <p class="text-muted text-sm" id="areaNone" style="display:none;margin:var(--sp-3) 0 0;">
          No area matches that. Try fewer letters.</p>`,
    });

    const list = el("#areaList", m.backdrop);
    const none = el("#areaNone", m.backdrop);
    const search = el("#areaSearch", m.backdrop);

    const bindRows = () => els("[data-area]", list).forEach((b) => b.addEventListener("click", async () => {
      state.deliveryAreaId = b.dataset.area;
      m.close();
      await refreshQuote();
      render();
    }));
    bindRows();

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const hits = state.areas.filter((a) => a.name.toLowerCase().includes(q));
      list.innerHTML = hits.map(areaOptHTML).join("");
      none.style.display = hits.length ? "none" : "block";
      bindRows();
    });
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
        <div class="pay-opt ${state.payment === "cash" ? "active" : ""}" data-pay="cash"><svg class="pi"><use href="#i-cash"/></svg>Pay at counter<div class="sub">Cash / UPI on arrival</div></div>
        <div class="pay-opt ${state.payment === "upi" ? "active" : ""}" data-pay="upi"><svg class="pi"><use href="#i-phone"/></svg>Pay now (UPI)<div class="sub">GPay · PhonePe · Paytm</div></div>
      </div>`;
    return `<div class="card step-card" id="payStep"><div class="card-pad">
      <div class="step-head"><span class="step-num">3</span><h3>Payment</h3></div>
      ${delivery ? `<p class="text-sm text-muted" style="margin-top:0;">Delivery orders are prepaid via UPI.</p>` : methods}
      <div id="upiArea" style="margin-top:var(--sp-3);">${state.payment === "upi" ? upiArea() : ""}</div>
    </div></div>`;
  }

  function upiArea() {
    /* Paying is blocked while any line is sold out. Without this the customer
       could scan, pay, and only then be refused at order creation — the total is
       still positive whenever at least one line survives, so "nothing to pay
       for" never catches it. The backend refuses the QR too; this is the part
       that explains why. */
    if (deadList(state.quote).length) {
      return `<div class="notice-banner" style="margin:0;">Remove the sold-out items from your order summary first — we can't take payment for an order we can't make.</div>`;
    }
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

  const deadKey = (u) => `${u.item_id}|${u.base}|${u.size}`;
  const deadList = (q) => (q && q.unavailable) || [];

  function summaryItems(q) {
    const priced = q.lines.map((l) => `
      <div class="summary-item">
        <div><div class="si-name">${esc(l.name)} × ${l.quantity}</div>
          <div class="si-sub">${esc(l.variant_label || "")}${l.free_quantity ? ` · 🎉 ${l.free_quantity} free` : ""}</div></div>
        <div class="si-name">${money(l.line_total)}</div>
      </div>`).join("");

    /* Anything that sold out between filling the cart and reaching checkout.
       Listed as its own row with a Remove, because the order is blocked until it
       is dealt with and "review your cart" is not an instruction anyone can act
       on without being told which row is the problem. Switching variants happens
       on the menu, where the alternatives and their prices are — from here the
       useful action is to drop it or go back. */
    const gone = deadList(q).map((u) => `
      <div class="summary-item dead">
        <div><div class="si-name">${esc(u.name)} <span class="badge badge-out">Sold out</span></div>
          <div class="si-sub">${esc(u.variant_label || "")} · not charged</div></div>
        <button class="btn btn-sm btn-outline" data-drop="${esc(deadKey(u))}">Remove</button>
      </div>`).join("");

    return priced + gone;
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
    // No footnote here: summaryItems() now lists each sold-out line above with
    // its own "not charged" note and a Remove, which is both clearer and
    // actionable. (This used to join q.unavailable, which became a list of
    // objects when it gained the fields needed to identify a line.)
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
    els("[data-area]").forEach((b) => b.addEventListener("click", async () => {
      state.deliveryAreaId = b.dataset.area;
      // Paint the selection immediately; the quote round-trip re-renders after.
      els("[data-area]").forEach((x) => x.classList.toggle("active", x === b));
      await refreshQuote(); render();
    }));
    const picker = el("#areaPicker");
    if (picker) picker.addEventListener("click", openAreaPicker);

    els("[data-drop]").forEach((b) => b.addEventListener("click", async () => {
      Store.remove(b.dataset.drop);
      if (!Store.count()) { renderEmpty(); return; }
      await refreshQuote();
      render();
    }));

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
      if (deadList(state.quote).length) return toast("Remove the sold-out items before paying", "err");
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
    if (!state.orderingEnabled) { renderClosed(); return; }
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
