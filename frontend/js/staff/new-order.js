/* Counter ordering: staff/owner place an order for a customer standing at the
   till or calling in.

   Everything commercial goes through the same endpoints the customer's own
   checkout uses — /api/orders/quote for the running total and the same pricing
   module behind /api/admin/orders — so offers, B1G1 pools and coupon codes
   behave identically here and on the website. This screen is only a faster way
   to drive them: the whole menu is on one page, an item is one tap, and the
   things a counter needs (walk-in with no phone number, cash on delivery,
   money already in the drawer) are possible without lying to the system. */
(function () {
  const { money, esc, el, els, toast } = UI;

  const CART_KEY = "sps_pos_cart_v1";
  const MODE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
  const MODE_EMOJI = { dine_in: "🍽️", takeaway: "🥡", delivery: "🛵" };

  const state = {
    user: null,
    menu: [],              // flattened items, each with its category name
    categories: [],        // {id, name}
    cat: "all",
    search: "",
    lines: loadCart(),     // {item_id, name, base, size, variant_label, unit_price, quantity}
    mode: "takeaway",
    coupon: "",
    coupons: [],           // owner's own codes, when this user may list them
    quote: null,
    customer: { name: "", phone: "", address: "" },
    areas: [],
    deliveryAreaId: "",
    payment: "cash",
    paymentCollected: false,
    upiReference: "",
    notes: "",
    placing: false,
    placed: null,          // the order once it exists; switches to the receipt view
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    state.user = await Auth.requireAuth();
    el("#whoami").textContent = `${state.user.name || state.user.email} · ${state.user.role}`;
    if (state.user.role === "owner") {
      ["#navMenu", "#navCustomers", "#navReviews"].forEach((s) => el(s).classList.remove("hidden"));
    }
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });

    try {
      const { categories } = await API.get("/api/menu");
      flatten(categories || []);
    } catch (e) {
      el("#posRoot").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><h3>Menu unavailable</h3>
        <p class="text-muted">${esc(e.message)}</p></div>`;
      return;
    }
    try { state.areas = (await API.get("/api/delivery-areas")).areas || []; } catch { state.areas = []; }
    // The code list is owner-only. Staff simply type the code the customer
    // read out, exactly as a customer would on the website, so a 403 here is
    // not an error — it just means no shortcut chips for this user.
    try { state.coupons = ((await API.get("/api/coupons")).coupons || []).filter((c) => c.active); }
    catch { state.coupons = []; }

    await refreshQuote();
    render();
  }

  /* ---------------- menu ---------------- */

  function flatten(tree) {
    state.categories = [];
    state.menu = [];
    tree.forEach((cat) => {
      state.categories.push({ id: cat.id, name: cat.name });
      const push = (items) => (items || []).forEach((it) => state.menu.push({
        ...it, category_id: cat.id, category_name: cat.name,
      }));
      push(cat.items);
      (cat.subcategories || []).forEach((sub) => push(sub.items));
    });
  }

  const vAvailable = (v) => !v || v.available !== false;
  const itemAvailable = (it) => it.available !== false && (it.variants || []).some(vAvailable);
  const itemById = (id) => state.menu.find((i) => i.id === Number(id));

  function visibleItems() {
    const needle = state.search.trim().toLowerCase();
    return state.menu.filter((it) => {
      if (state.cat !== "all" && it.category_id !== Number(state.cat)) return false;
      if (!needle) return true;
      return it.name.toLowerCase().includes(needle)
        || it.category_name.toLowerCase().includes(needle)
        || (it.tags || []).some((t) => String(t).toLowerCase().includes(needle));
    });
  }

  /* The promo label the menu already resolved for this item, if any. A
     coupon-gated offer says so rather than promising a discount the cart will
     not apply until the code is entered. */
  function promoBadge(it) {
    const p = it.promo;
    if (!p) return "";
    const label = p.label || p.display_label || "Offer";
    return `<span class="badge badge-offer">${esc(label)}${p.coupon_only ? " · code" : ""}</span>`;
  }

  function variantOptions(it) {
    return (it.variants || []).map((v, idx) => {
      const label = v.label || [v.base, v.size].filter(Boolean).join(" · ") || it.name;
      const out = !vAvailable(v);
      return `<option value="${idx}" ${out ? "disabled" : ""}>${esc(label)} · ${money(v.price)}${out ? " (sold out)" : ""}</option>`;
    }).join("");
  }

  function itemRow(it) {
    const out = !itemAvailable(it);
    const multi = (it.variants || []).length > 1;
    const first = (it.variants || []).find(vAvailable) || (it.variants || [])[0] || { price: it.base_price };
    return `
      <div class="pos-item ${out ? "out" : ""}">
        <div class="pi-main">
          <div class="pi-name">${esc(it.name)} ${it.veg === false ? "" : `<span class="veg-dot" title="Veg"></span>`}</div>
          <div class="pi-sub">${esc(it.category_name)} ${promoBadge(it)}</div>
        </div>
        ${multi
          ? `<select class="select pi-var" data-var="${it.id}">${variantOptions(it)}</select>`
          : `<span class="pi-price">${money(first.price)}</span>`}
        <button class="btn btn-primary btn-sm" data-add="${it.id}" ${out ? "disabled" : ""}>${out ? "Sold out" : "Add"}</button>
      </div>`;
  }

  function menuPanel() {
    const chips = [{ id: "all", name: "All" }, ...state.categories]
      .map((c) => `<button class="chip ${String(state.cat) === String(c.id) ? "active" : ""}" data-cat="${c.id}">${esc(c.name)}</button>`)
      .join("");
    const rows = visibleItems().map(itemRow).join("")
      || `<div class="empty"><div class="emoji">🔍</div><h3>Nothing matches</h3>
          <p class="text-muted">Try a shorter search, or another category.</p></div>`;
    return `
      <section class="pos-menu">
        <div class="search-field">
          <span class="search-ico">🔍</span>
          <input class="input" id="posSearch" placeholder="Search the menu…" value="${esc(state.search)}" autocomplete="off" />
        </div>
        <div class="chips" id="posCats">${chips}</div>
        <div class="pos-items">${rows}</div>
      </section>`;
  }

  /* ---------------- cart ---------------- */

  function loadCart() {
    // Kept on the device so a mis-tapped refresh, or the browser reclaiming a
    // backgrounded tab mid-order, does not lose a ticket the customer is
    // standing there waiting for.
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.lines)); } catch { /* private mode */ }
  }

  const lineKey = (l) => `${l.item_id}|${l.base}|${l.size}`;
  const cartCount = () => state.lines.reduce((s, l) => s + l.quantity, 0);
  const cartPayload = () => state.lines.map((l) => ({
    item_id: l.item_id, base: l.base, size: l.size, quantity: l.quantity,
  }));

  function addItem(itemId, variantIdx) {
    const it = itemById(itemId);
    if (!it) return;
    const variants = it.variants || [];
    const v = variants[variantIdx] || variants.find(vAvailable) || variants[0];
    if (!v || !vAvailable(v)) return toast("That option is sold out", "err");
    const line = {
      item_id: it.id, name: it.name, base: v.base || "", size: v.size || "",
      variant_label: v.label || [v.base, v.size].filter(Boolean).join(" · "),
      unit_price: v.price, quantity: 1,
    };
    const existing = state.lines.find((l) => lineKey(l) === lineKey(line));
    if (existing) existing.quantity += 1;
    else state.lines.push(line);
    saveCart();
    onCartChange();
  }

  function setQty(key, qty) {
    const l = state.lines.find((x) => lineKey(x) === key);
    if (!l) return;
    l.quantity = qty;
    if (l.quantity <= 0) state.lines = state.lines.filter((x) => lineKey(x) !== key);
    saveCart();
    onCartChange();
  }

  async function onCartChange() {
    await refreshQuote();
    render();
  }

  /* ---------------- quote ---------------- */

  async function refreshQuote() {
    if (!state.lines.length) { state.quote = null; return; }
    try {
      state.quote = await API.post("/api/orders/quote", {
        cart: cartPayload(),
        order_type: state.mode,
        coupon_code: state.coupon,
        delivery_area_id: Number(state.deliveryAreaId) || 0,
        // A scratch-card code only works for the phone that won it, so the
        // preview has to be priced against the number going on the order.
        phone: state.customer.phone,
      });
      if (state.coupon && state.quote.coupon_error) {
        toast(state.quote.coupon_error, "err");
        state.coupon = "";
      }
    } catch (e) {
      toast(e.message, "err");
    }
  }

  const deadList = () => (state.quote && state.quote.unavailable) || [];
  const deadKey = (u) => `${u.item_id}|${u.base}|${u.size}`;

  /* ---------------- ticket ---------------- */

  function cartRows() {
    if (!state.lines.length) {
      return `<div class="empty" style="padding:var(--sp-5) 0;"><div class="emoji">🧾</div>
        <h3>No items yet</h3><p class="text-muted">Tap Add on the menu to start the ticket.</p></div>`;
    }
    const priced = state.lines.map((l) => {
      const key = lineKey(l);
      const q = (state.quote && state.quote.lines || []).find((x) => `${x.item_id}|${x.base}|${x.size}` === key);
      const free = q && q.free_quantity ? ` · 🎉 ${q.free_quantity} free` : "";
      const label = q ? q.promo_label : "";
      return `
        <div class="pos-line">
          <div class="pl-main">
            <div class="pl-name">${esc(l.name)}</div>
            <div class="pl-sub">${esc(l.variant_label || "")}${free}${label ? ` · ${esc(label)}` : ""}</div>
          </div>
          <div class="stepper">
            <button data-dec="${esc(key)}" aria-label="One less">−</button>
            <span>${l.quantity}</span>
            <button data-inc="${esc(key)}" aria-label="One more">+</button>
          </div>
          <div class="pl-amt">${money(q ? q.line_total : l.unit_price * l.quantity)}</div>
        </div>`;
    }).join("");

    // Anything that sold out while the ticket was open. The order is refused
    // until it is dealt with, so each one gets its own row and a Remove rather
    // than a note asking staff to work out which line is the problem.
    const gone = deadList().map((u) => `
      <div class="pos-line dead">
        <div class="pl-main">
          <div class="pl-name">${esc(u.name)} <span class="badge badge-out">Sold out</span></div>
          <div class="pl-sub">${esc(u.variant_label || "")} · not charged</div>
        </div>
        <button class="btn btn-sm btn-outline" data-drop="${esc(deadKey(u))}">Remove</button>
      </div>`).join("");

    return priced + gone;
  }

  function offerRowLabel(q) {
    const labels = [...new Set((q.lines || []).map((l) => l.promo_label).filter(Boolean))];
    return labels.length ? `Offers · ${esc(labels.join(", "))}` : "Offers";
  }

  function totalsHTML() {
    const q = state.quote;
    if (!q) return "";
    const rows = [`<div class="summary-line"><span>Subtotal</span><span>${money(q.subtotal)}</span></div>`];
    if (q.promo_discount > 0) rows.push(`<div class="summary-line free-note"><span>${offerRowLabel(q)}</span><span>− ${money(q.promo_discount)}</span></div>`);
    if (q.coupon_discount > 0) rows.push(`<div class="summary-line free-note"><span>Coupon ${esc(q.coupon_code)}</span><span>− ${money(q.coupon_discount)}</span></div>`);
    else if (q.coupon_code && (q.coupon_promos || []).length) {
      rows.push(`<div class="summary-line free-note"><span>Coupon ${esc(q.coupon_code)}</span><span>${q.coupon_promos.length > 1 ? "Offers" : "Offer"} unlocked</span></div>`);
    }
    if (state.mode === "delivery") {
      rows.push(q.delivery_area_required
        ? `<div class="summary-line" style="color:var(--err);"><span>Delivery</span><span>Select area</span></div>`
        : `<div class="summary-line"><span>${q.delivery_area_name ? `Delivery · ${esc(q.delivery_area_name)}` : "Delivery fee"}</span><span>${money(q.delivery_fee)}</span></div>`);
    }
    rows.push(`<div class="summary-line grand"><span>Total</span><span>${money(q.total)}</span></div>`);
    return rows.join("");
  }

  function couponChips() {
    if (!state.coupons.length) return "";
    return `<div class="pos-codes">${state.coupons.map((c) => `
      <button type="button" class="chip" data-code="${esc(c.code)}" title="${esc(c.description || "")}">
        ${esc(c.code)}</button>`).join("")}</div>`;
  }

  function areaOptions() {
    return `<option value="">Select area…</option>` + state.areas.map((a) =>
      `<option value="${a.id}" ${String(a.id) === String(state.deliveryAreaId) ? "selected" : ""}>${esc(a.name)} · ${money(a.fee)}</option>`
    ).join("");
  }

  function ticketPanel() {
    const c = state.customer;
    const delivery = state.mode === "delivery";
    const q = state.quote;
    const blocked = !state.lines.length || deadList().length;
    return `
      <aside class="pos-ticket">
        <div class="card"><div class="card-pad">
          <div class="seg" id="posMode">
            ${["dine_in", "takeaway", "delivery"].map((m) =>
              `<button data-mode="${m}" class="${state.mode === m ? "active" : ""}">${MODE_EMOJI[m]} ${MODE_LABEL[m]}</button>`).join("")}
          </div>

          <div class="pos-lines">${cartRows()}</div>

          <div class="field" style="margin-top:var(--sp-3);">
            <div class="input-row">
              <input class="input" id="posCoupon" placeholder="Coupon code" value="${esc(state.coupon)}" autocomplete="off" />
              <button class="btn btn-outline" id="posApplyCoupon" type="button">Apply</button>
            </div>
            ${couponChips()}
          </div>

          <div class="pos-totals">${totalsHTML()}</div>
        </div></div>

        <div class="card" style="margin-top:var(--sp-3);"><div class="card-pad">
          <h3 style="margin:0 0 var(--sp-3);font-size:var(--fs-md);">Customer</h3>
          <div class="input-row">
            <div class="field grow"><label>Name${delivery ? " *" : ""}</label>
              <input class="input" id="posName" value="${esc(c.name)}" placeholder="Walk-in" /></div>
            <div class="field grow"><label>Phone${delivery ? " *" : ""}</label>
              <input class="input" id="posPhone" value="${esc(c.phone)}" placeholder="10-digit mobile" inputmode="numeric" /></div>
          </div>
          ${delivery ? `
            <div class="field"><label>Delivery area *</label>
              <select class="select" id="posArea">${areaOptions()}</select></div>
            <div class="field"><label>Delivery address *</label>
              <textarea class="input" id="posAddress" placeholder="Flat / house, street, area, landmark">${esc(c.address)}</textarea></div>`
          : `<p class="text-sm text-muted" style="margin:0;">A phone number is optional for a walk-in, but it is what puts the
             order in the customer's history and lets a reward code work.</p>`}
        </div></div>

        <div class="card" style="margin-top:var(--sp-3);"><div class="card-pad">
          <h3 style="margin:0 0 var(--sp-3);font-size:var(--fs-md);">Payment</h3>
          <div class="seg" id="posPay">
            <button data-pay="cash" class="${state.payment === "cash" ? "active" : ""}">💵 Cash</button>
            <button data-pay="upi" class="${state.payment === "upi" ? "active" : ""}">📱 UPI</button>
          </div>
          ${state.payment === "upi" ? `
            <div class="field" style="margin-top:var(--sp-3);"><label>UPI reference / UTR (optional)</label>
              <input class="input" id="posUpiRef" value="${esc(state.upiReference)}" placeholder="e.g. 4051XXXXXXXX" /></div>` : ""}
          <label class="pill-toggle" style="margin-top:var(--sp-3);">
            <input type="checkbox" id="posPaid" ${state.paymentCollected ? "checked" : ""} />
            <span>Payment received${q ? ` · ${money(q.total)}` : ""}</span>
          </label>
          <div class="field" style="margin-top:var(--sp-3);"><label>Kitchen note</label>
            <textarea class="input" id="posNotes" placeholder="Less spicy, no onion, table 4…">${esc(state.notes)}</textarea></div>
        </div></div>

        <button class="btn btn-primary btn-block btn-lg" id="posPlace" style="margin-top:var(--sp-3);" ${blocked ? "disabled" : ""}>
          ${!state.lines.length ? "Add items to place an order"
            : deadList().length ? "Remove sold-out items to continue"
            : `Place order · ${money(q ? q.total : 0)}`}</button>
        ${state.lines.length ? `<button class="btn btn-ghost btn-block btn-sm" id="posClear" style="margin-top:8px;">Clear ticket</button>` : ""}
      </aside>`;
  }

  /* ---------------- receipt ---------------- */

  function receipt(order) {
    const pay = order.payment || {};
    const payMsg = pay.status === "paid" ? "Paid"
      : pay.status === "awaiting_verification" ? "UPI reference recorded — verify on the board"
      : "Payment pending";
    return `
      <div class="card" style="max-width:520px;margin:var(--sp-5) auto;"><div class="card-pad" style="text-align:center;">
        <div style="font-size:2.4rem;">✅</div>
        <h2 style="margin:var(--sp-2) 0;">Order placed</h2>
        <div class="order-id-badge">${esc(order.public_id)}</div>
        <p class="text-sm text-muted" style="margin-top:var(--sp-3);">
          ${esc(MODE_LABEL[order.order_type])} · ${money(order.total)} · ${esc(payMsg)}<br />
          ${esc((order.customer && order.customer.name) || "Walk-in")}${order.customer && order.customer.phone ? ` · ${esc(order.customer.phone)}` : ""}
          ${order.repeat_no ? ` · visit #${order.repeat_no}` : ""}
        </p>
        <div class="row" style="justify-content:center;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-4);">
          <button class="btn btn-dark" id="posInvoice">🧾 Bill / invoice</button>
          <button class="btn btn-primary" id="posAnother">+ New order</button>
          <a class="btn btn-outline" href="orders.html">Orders board →</a>
        </div>
      </div></div>`;
  }

  /* ---------------- render + bind ---------------- */

  function render() {
    if (state.placed) {
      el("#posRoot").innerHTML = receipt(state.placed);
      el("#posInvoice").addEventListener("click", () => Invoice.open(state.placed));
      el("#posAnother").addEventListener("click", () => { state.placed = null; render(); });
      return;
    }
    el("#posRoot").innerHTML = `<div class="pos-grid">${menuPanel()}${ticketPanel()}</div>`;
    bind();
  }

  function bind() {
    const search = el("#posSearch");
    search.addEventListener("input", (e) => {
      state.search = e.target.value;
      // Only the item list is repainted, so the caret stays in the search box.
      el(".pos-items").innerHTML = visibleItems().map(itemRow).join("")
        || `<div class="empty"><div class="emoji">🔍</div><h3>Nothing matches</h3></div>`;
      bindItems();
    });
    els("#posCats [data-cat]").forEach((b) => b.addEventListener("click", () => {
      state.cat = b.dataset.cat;
      els("#posCats [data-cat]").forEach((x) => x.classList.toggle("active", x === b));
      el(".pos-items").innerHTML = visibleItems().map(itemRow).join("");
      bindItems();
    }));
    bindItems();

    els("#posMode button").forEach((b) => b.addEventListener("click", async () => {
      state.mode = b.dataset.mode;
      await refreshQuote();
      render();
    }));

    els("[data-inc]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.inc);
      setQty(b.dataset.inc, (l ? l.quantity : 0) + 1);
    }));
    els("[data-dec]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.dec);
      setQty(b.dataset.dec, (l ? l.quantity : 0) - 1);
    }));
    els("[data-drop]").forEach((b) => b.addEventListener("click", () => setQty(b.dataset.drop, 0)));

    el("#posApplyCoupon").addEventListener("click", () => applyCoupon());
    el("#posCoupon").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCoupon(); });
    els("[data-code]").forEach((b) => b.addEventListener("click", () => applyCoupon(b.dataset.code)));

    el("#posName").addEventListener("input", (e) => state.customer.name = e.target.value);
    const phone = el("#posPhone");
    phone.addEventListener("input", (e) => {
      state.customer.phone = e.target.value.replace(/[^0-9]/g, "").slice(0, 10);
      e.target.value = state.customer.phone;
    });
    // Re-priced on blur, not per keystroke: the number only changes the total
    // when a phone-bound reward code is on the ticket, and re-rendering
    // mid-typing would take the keyboard away from the field.
    phone.addEventListener("change", async () => {
      if (!state.coupon) return;
      await refreshQuote();
      el(".pos-totals").innerHTML = totalsHTML();
    });
    const area = el("#posArea");
    if (area) area.addEventListener("change", async (e) => {
      state.deliveryAreaId = e.target.value;
      await refreshQuote();
      render();
    });
    const addr = el("#posAddress");
    if (addr) addr.addEventListener("input", (e) => state.customer.address = e.target.value);

    els("#posPay button").forEach((b) => b.addEventListener("click", () => {
      state.payment = b.dataset.pay;
      render();
    }));
    const ref = el("#posUpiRef");
    if (ref) ref.addEventListener("input", (e) => state.upiReference = e.target.value.trim());
    el("#posPaid").addEventListener("change", (e) => state.paymentCollected = e.target.checked);
    el("#posNotes").addEventListener("input", (e) => state.notes = e.target.value);

    el("#posPlace").addEventListener("click", placeOrder);
    const clear = el("#posClear");
    if (clear) clear.addEventListener("click", () => {
      state.lines = [];
      state.coupon = "";
      state.quote = null;
      saveCart();
      render();
    });
  }

  function bindItems() {
    els("[data-add]").forEach((b) => b.addEventListener("click", () => {
      const sel = el(`[data-var="${b.dataset.add}"]`);
      addItem(b.dataset.add, sel ? Number(sel.value) : 0);
    }));
  }

  async function applyCoupon(code) {
    // A code can only be judged against a cart — with nothing on the ticket the
    // quote would come back silent and the code would look accepted until the
    // first item lands and takes it away again.
    if (!state.lines.length) return toast("Add the items first, then apply the code", "err");
    state.coupon = (code || el("#posCoupon").value).trim().toUpperCase();
    await refreshQuote();
    render();
    if (state.coupon && state.quote && state.quote.coupon_code === state.coupon) {
      toast(`Coupon ${state.coupon} applied`, "ok");
    }
  }

  /* ---------------- place ---------------- */

  async function placeOrder() {
    if (state.placing) return;
    if (!state.lines.length) return toast("Add at least one item", "err");
    if (deadList().length) return toast("Remove the sold-out items first", "err");
    const c = state.customer;
    if (c.phone && !/^[0-9]{10}$/.test(c.phone)) return toast("Phone must be 10 digits", "err");
    if (state.mode === "delivery") {
      if (!state.deliveryAreaId) return toast("Select the delivery area", "err");
      if (!c.name.trim()) return toast("Delivery needs the customer's name", "err");
      if (!/^[0-9]{10}$/.test(c.phone)) return toast("Delivery needs a 10-digit phone number", "err");
      if (!c.address.trim()) return toast("Delivery needs an address", "err");
    }

    const btn = el("#posPlace");
    state.placing = true; btn.disabled = true; btn.textContent = "Placing…";
    try {
      const order = await API.post("/api/admin/orders", {
        cart: cartPayload(),
        order_type: state.mode,
        coupon_code: state.coupon,
        delivery_area_id: Number(state.deliveryAreaId) || 0,
        customer: { name: c.name.trim(), phone: c.phone.trim(), address: c.address.trim() },
        payment_method: state.payment,
        payment_collected: state.paymentCollected,
        upi_reference: state.upiReference,
        notes: state.notes,
      });
      // The ticket is done: everything that belongs to it is reset so the next
      // customer cannot inherit the last one's coupon, note or address.
      state.lines = [];
      state.coupon = "";
      state.quote = null;
      state.customer = { name: "", phone: "", address: "" };
      state.deliveryAreaId = "";
      state.payment = "cash";
      state.paymentCollected = false;
      state.upiReference = "";
      state.notes = "";
      saveCart();
      state.placed = order;
      state.placing = false;
      render();
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(e.message, "err");
      state.placing = false;
      render();
    }
  }
})();
