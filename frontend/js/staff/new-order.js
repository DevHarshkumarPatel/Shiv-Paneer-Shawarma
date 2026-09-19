/* Counter ordering: staff/owner place an order for a customer standing at the
   till or calling in.

   Everything commercial goes through the same endpoints the customer's own
   checkout uses — /api/orders/quote for the running total and the same pricing
   module behind /api/admin/orders — so offers, B1G1 pools and coupon codes
   behave identically here and on the website. This screen is only a faster way
   to drive them: the whole menu is on one page, an item is one tap, and the
   things a counter needs (walk-in with no phone number, cash on delivery,
   money already in the drawer) are possible without lying to the system.

   The same screen edits an order that already exists — new-order.html?edit=ID.
   It is the same ticket with an order loaded into it rather than a second item
   picker built to look like this one, so staff learn one screen and a change to
   how items are chosen cannot apply to new orders only. What differs is small
   and deliberate: the ticket is never written to the counter's saved cart, the
   button saves instead of placing, and the save comes back with the list of
   what it changed, which the order then carries for good. */
(function () {
  const { money, esc, el, els, toast, fmtDateTime } = UI;

  const CART_KEY = "sps_pos_cart_v1";
  // Add-ons are kept in their own key, not folded into the cart: they are a
  // different shape (no variant, no promo) and a ticket saved by an older build
  // of this screen must still load its items.
  const TOPUP_KEY = "sps_pos_topups_v1";
  // Set once, from the URL: the id of the order being edited, or "" for a new
  // one. Read before `state` is built because it decides whether the ticket
  // starts from the counter's saved cart or from the order.
  const EDIT_ID = new URLSearchParams(location.search).get("edit") || "";
  const MODE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
  const MODE_EMOJI = { dine_in: "🍽️", takeaway: "🥡", delivery: "🛵" };

  const state = {
    user: null,
    menu: [],              // flattened items, each with its category name
    categories: [],        // {id, name}
    cat: "all",
    search: "",
    picked: new Map(),     // item id -> chosen variant index, kept across repaints
    // Phone-sized screens show one panel at a time (menu or ticket), switched
    // from the fixed bar at the bottom. On a desktop both are on screen and
    // this is ignored — the CSS decides, not the JS.
    view: "menu",
    lines: EDIT_ID ? [] : loadCart(),  // {item_id, name, base, size, variant_label, unit_price, quantity}
    topups: [],            // the owner's add-on list, as the counter may use it
    topupLines: EDIT_ID ? [] : loadTopups(),   // {topup_id, quantity}
    // null = decide from the ticket (open when something is on it); once the
    // staff member opens or closes the panel themselves, that wins.
    addonsOpen: null,
    editing: null,         // the order being edited, as it was loaded
    changes: null,         // what the last save changed, straight from the API
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

  const editing = () => !!state.editing;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    state.user = await Auth.requireAuth();
    el("#whoami").textContent = `${state.user.name || state.user.email} · ${state.user.role}`;
    if (state.user.role === "owner") {
      ["#navMenu", "#navCustomers", "#navReviews", "#navEdits"].forEach((s) => el(s).classList.remove("hidden"));
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
    // Add-ons the owner has switched on. An empty list (or a failed call) just
    // means the panel is not drawn — nothing else on this screen depends on it.
    try { state.topups = (await API.get("/api/topups")).topups || []; } catch { state.topups = []; }
    // The code list is owner-only. Staff simply type the code the customer
    // read out, exactly as a customer would on the website, so a 403 here is
    // not an error — it just means no shortcut chips for this user.
    try { state.coupons = ((await API.get("/api/coupons")).coupons || []).filter((c) => c.active); }
    catch { state.coupons = []; }

    if (EDIT_ID) {
      try {
        await loadForEdit(EDIT_ID);
      } catch (e) {
        el("#posRoot").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><h3>Cannot open that order</h3>
          <p class="text-muted">${esc(e.message)}</p>
          <p><a class="btn btn-outline" href="orders.html">← Back to the board</a></p></div>`;
        return;
      }
    }

    await refreshQuote();
    render();
  }

  /* ---------------- edit mode ---------------- */

  /* Fill the ticket from an order that has already been placed.

     Everything the edit screen can change is read back off the order, so the
     first thing staff see is the order exactly as it stands — anything they do
     not touch saves back unchanged, and the log stays about what they meant to
     change rather than about what the screen forgot to load. */
  async function loadForEdit(id) {
    const o = await API.get(`/api/admin/orders/${encodeURIComponent(id)}`);
    state.editing = o;
    state.mode = o.order_type;
    /* The charged quantity only. Free items are what an offer decides, and the
       re-price works them out again — carrying them back onto the ticket would
       bill the customer for a B2G1 gift. */
    state.lines = (o.items || []).map((i) => ({
      item_id: i.item_id, name: i.name, base: i.base || "", size: i.size || "",
      variant_label: i.variant_label || "", unit_price: i.unit_price, quantity: i.quantity,
    }));
    /* Add-ons as the order carries them. Only the id and the count are taken:
       the name and the price are re-resolved by the re-price, so an add-on the
       owner has repriced since saves at today's price rather than silently
       keeping the old one — and one that has been withdrawn is reported. */
    state.topupLines = (o.topups || [])
      .filter((t) => t.topup_id)
      .map((t) => ({ topup_id: t.topup_id, quantity: t.quantity || 1 }));
    state.coupon = o.coupon_code || "";
    const c = o.customer || {};
    state.customer = { name: c.name || "", phone: c.phone || "", address: c.address || "" };
    /* An order stores the delivery area's *name*, because that is what a bill
       has to keep saying after the area is renamed or its fee changes. The id
       the select needs is looked back up here, and an area that no longer
       exists simply leaves the field empty to be chosen again. */
    const area = state.areas.find((a) => a.name === o.delivery_area);
    state.deliveryAreaId = area ? String(area.id) : "";
    const p = o.payment || {};
    state.payment = p.method === "upi" ? "upi" : "cash";
    state.paymentCollected = p.status === "paid";
    state.upiReference = p.upi_reference || "";
    state.notes = o.notes || "";
  }

  // Throw away what has been typed and start again from the saved order. The
  // counter's own "Clear ticket" would be the wrong offer here — nobody edits
  // an order in order to empty it.
  async function revertEdit() {
    if (!state.editing) return;
    await loadForEdit(state.editing.public_id);
    await refreshQuote();
    render();
    toast("Back to the saved order", "ok");
  }

  /* The banner that says this is not a new order. Carries the order id, when it
     was placed and how many times it has already been changed, because an order
     on its fourth correction is worth a second look before a fifth. */
  function editBanner() {
    const o = state.editing;
    if (!o) return "";
    const n = (o.edits || []).length;
    return `<div class="pos-editing">
      <span>✏️ Editing <strong>${esc(o.public_id)}</strong>
        · placed ${esc(fmtDateTime(o.created_at))}
        ${n ? `· changed ${n} time${n > 1 ? "s" : ""} before` : ""}</span>
      <a class="btn btn-ghost btn-sm" href="orders.html">Cancel</a>
    </div>`;
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

  function variantOptionsFor(it) {
    return (it.variants || []).map((v, idx) => {
      const label = v.label || [v.base, v.size].filter(Boolean).join(" · ") || it.name;
      const out = !vAvailable(v);
      return `<option value="${idx}" ${idx === pickedIdx(it) ? "selected" : ""} ${out ? "disabled" : ""}>${
        esc(label)} · ${money(v.price)}${out ? " (sold out)" : ""}</option>`;
    }).join("");
  }

  /* Which variant a row is showing. Remembered per item because the list is
     repainted after every tap: without this, choosing "Exotic" and then adding
     it would snap the row back to the first variant, and the next tap would
     silently sell the wrong thing. */
  function pickedIdx(it) {
    if (state.picked.has(it.id)) return state.picked.get(it.id);
    const variants = it.variants || [];
    const idx = Math.max(0, variants.findIndex(vAvailable));
    return idx;
  }

  const lineFor = (it, idx) => {
    const v = (it.variants || [])[idx];
    if (!v) return null;
    return state.lines.find((l) => lineKey(l) === `${it.id}|${v.base || ""}|${v.size || ""}`) || null;
  };

  /* The buy control doubles as the quantity display: once a variant is on the
     ticket its row turns into a stepper, so a second helping is one tap on the
     menu instead of a trip to the ticket and back. */
  function buyControl(it) {
    if (!itemAvailable(it)) return `<span class="pi-out">Sold out</span>`;
    const idx = pickedIdx(it);
    const line = lineFor(it, idx);
    if (!line) return `<button class="btn btn-primary" data-add="${it.id}">Add</button>`;
    const key = lineKey(line);
    return `<div class="stepper">
      <button data-dec="${esc(key)}" aria-label="One less">−</button>
      <span>${line.quantity}</span>
      <button data-inc="${esc(key)}" aria-label="One more">+</button>
    </div>`;
  }

  function itemRow(it) {
    const out = !itemAvailable(it);
    const multi = (it.variants || []).length > 1;
    const v = (it.variants || [])[pickedIdx(it)] || { price: it.base_price };
    return `
      <div class="pos-item ${out ? "out" : ""} ${multi ? "" : "single"}" data-row="${it.id}">
        <div class="pi-main">
          <div class="pi-name">${it.veg === false ? "" : `<span class="veg-dot" title="Veg"></span>`}${esc(it.name)}</div>
          <div class="pi-sub">${esc(it.category_name)}${promoBadge(it)}</div>
        </div>
        <div class="pi-buy">
          ${multi ? `<select class="select pi-var" data-var="${it.id}" aria-label="Choose an option">${variantOptionsFor(it)}</select>` : ""}
          <span class="pi-price">${money(v.price)}</span>
          ${buyControl(it)}
        </div>
      </div>`;
  }

  /* Repaint just the item list. Used for search, the category chips and every
     add/remove, so the ticket and the page scroll position stay where they are
     while someone is working down a long order. */
  function refreshMenuList() {
    const list = el(".pos-items");
    if (!list) return;
    list.innerHTML = itemsHTML();
    bindItems();
  }

  function itemsHTML() {
    return visibleItems().map(itemRow).join("")
      || `<div class="empty"><div class="emoji">🔍</div><h3>Nothing matches</h3>
          <p class="text-muted">Try a shorter search, or another category.</p></div>`;
  }

  function menuPanel() {
    const chips = [{ id: "all", name: "All" }, ...state.categories]
      .map((c) => `<button class="chip ${String(state.cat) === String(c.id) ? "active" : ""}" data-cat="${c.id}">${esc(c.name)}</button>`)
      .join("");
    return `
      <section class="pos-menu">
        <div class="search-field">
          <span class="search-ico">🔍</span>
          <input class="input" id="posSearch" placeholder="Search the menu…" value="${esc(state.search)}"
                 autocomplete="off" enterkeyhint="search" />
        </div>
        <div class="chips" id="posCats">${chips}</div>
        <div class="pos-items">${itemsHTML()}</div>
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
    // An edit borrows this screen; it must not borrow the counter's ticket.
    // Without this, opening an order to fix one line would overwrite the
    // half-built order someone else left on the till.
    if (editing()) return;
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.lines)); } catch { /* private mode */ }
  }

  function loadTopups() {
    try {
      const raw = JSON.parse(localStorage.getItem(TOPUP_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function saveTopups() {
    if (editing()) return;   // same reason as saveCart(): an edit is not the till's ticket
    try { localStorage.setItem(TOPUP_KEY, JSON.stringify(state.topupLines)); } catch { /* private mode */ }
  }

  const lineKey = (l) => `${l.item_id}|${l.base}|${l.size}`;
  const cartCount = () => state.lines.reduce((s, l) => s + l.quantity, 0);
  const cartPayload = () => state.lines.map((l) => ({
    item_id: l.item_id, base: l.base, size: l.size, quantity: l.quantity,
  }));
  const topupPayload = () => state.topupLines.map((t) => ({
    topup_id: t.topup_id, quantity: t.quantity,
  }));

  const topupById = (id) => state.topups.find((t) => t.id === Number(id));
  const topupLineFor = (id) => state.topupLines.find((t) => t.topup_id === Number(id));
  /* A flat-charge add-on is on the order or it is not, so its count never
     leaves 1 — the ticket shows it a Remove button instead of a stepper. */
  const topupStep = (t) => (t && t.per_quantity ? 1 : 0);

  function setTopupQty(id, qty) {
    const topup = topupById(id);
    const max = topup && !topup.per_quantity ? 1 : 99;
    const n = Math.min(max, Math.max(0, qty));
    const line = topupLineFor(id);
    if (n <= 0) state.topupLines = state.topupLines.filter((t) => t.topup_id !== Number(id));
    else if (line) line.quantity = n;
    else state.topupLines.push({ topup_id: Number(id), quantity: n });
    onTopupChange();
  }

  /* Only the ticket moves when an add-on changes — the menu list knows nothing
     about them, so repainting it would throw away the scroll position for
     nothing. Painted before and after the quote so the tap lands instantly and
     the money follows. */
  async function onTopupChange() {
    saveTopups();
    paintTicket();
    await refreshQuote();
    paintTicket();
  }

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

  /* A tap on Add repaints the item list and the ticket, never the whole page:
     the search box keeps its text and the menu keeps its scroll position, so a
     long order is one continuous run down the list. */
  async function onCartChange() {
    refreshMenuList();
    paintTicket();
    await refreshQuote();
    refreshMenuList();
    paintTicket();
  }

  /* ---------------- quote ---------------- */

  async function refreshQuote() {
    if (!state.lines.length) { state.quote = null; return; }
    try {
      state.quote = await API.post("/api/orders/quote", {
        cart: cartPayload(),
        // Priced by the server like everything else on this ticket — the screen
        // never adds an add-on's price into a total by itself.
        topups: topupPayload(),
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
    const gone = deadList().map((u) => (u.kind === "topup" ? `
      <div class="pos-line dead">
        <div class="pl-main">
          <div class="pl-name">${esc(u.name)} <span class="badge badge-out">Withdrawn</span></div>
          <div class="pl-sub">This add-on is no longer offered · not charged</div>
        </div>
        <button class="btn btn-sm btn-outline" data-drop-topup="${u.topup_id}">Remove</button>
      </div>` : `
      <div class="pos-line dead">
        <div class="pl-main">
          <div class="pl-name">${esc(u.name)} <span class="badge badge-out">Sold out</span></div>
          <div class="pl-sub">${esc(u.variant_label || "")} · not charged</div>
        </div>
        <button class="btn btn-sm btn-outline" data-drop="${esc(deadKey(u))}">Remove</button>
      </div>`)).join("");

    return priced + gone;
  }

  /* ---------------- add-ons ----------------

     The panel sits under the ticket lines rather than in the menu list: an
     add-on is something the customer asks for while the order is being read
     back ("and extra cheese on that"), so it belongs next to the ticket and
     the total, not forty items up the page. Folded away when nothing is on it,
     because most orders have none and the totals must stay reachable by thumb.

     Per-quantity add-ons get the same stepper as an item. A flat-charge add-on
     gets Add / Remove instead — its price does not move, so a stepper would be
     a control that changes nothing. */
  function topupAmount(t, line) {
    const priced = ((state.quote && state.quote.topups) || [])
      .find((x) => x.topup_id === t.id);
    if (priced) return priced.line_total;
    return t.per_quantity ? t.price * (line ? line.quantity : 1) : t.price;
  }

  function topupRow(t) {
    const line = topupLineFor(t.id);
    const sub = [t.per_quantity ? `${money(t.price)} each` : `${money(t.price)} flat`, t.description]
      .filter(Boolean).join(" · ");
    const control = !line
      ? `<button class="btn btn-outline btn-sm" data-topup-add="${t.id}">Add</button>`
      : t.per_quantity
        ? `<div class="stepper">
             <button data-topup-dec="${t.id}" aria-label="One less">−</button>
             <span>${line.quantity}</span>
             <button data-topup-inc="${t.id}" aria-label="One more">+</button>
           </div>`
        : `<button class="btn btn-sm btn-outline" data-topup-off="${t.id}">Remove</button>`;
    return `
      <div class="pos-addon ${line ? "on" : ""}">
        <div class="pa-main">
          <div class="pa-name">${esc(t.name)}</div>
          <div class="pa-sub">${esc(sub)}</div>
        </div>
        <div class="pa-buy">
          ${line ? `<span class="pa-amt">${money(topupAmount(t, line))}</span>` : ""}
          ${control}
        </div>
      </div>`;
  }

  function addonsPanel() {
    if (!state.topups.length) return "";
    const picked = state.topupLines.length;
    const total = state.quote ? (state.quote.topups_total || 0)
      : state.topupLines.reduce((sum, l) => {
          const t = topupById(l.topup_id);
          return sum + (t ? topupAmount(t, l) : 0);
        }, 0);
    const open = state.addonsOpen === null ? picked > 0 : state.addonsOpen;
    return `
      <details class="pos-addons" id="posAddons" ${open ? "open" : ""}>
        <summary>🧀 Add-ons${picked ? ` · ${picked} on this order · ${money(total)}` : ""}</summary>
        <div class="pos-addon-list">${state.topups.map(topupRow).join("")}</div>
      </details>`;
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
    if (q.topups_total > 0) {
      // Below the discounts on purpose: nothing above it applies to an add-on,
      // and a bill that showed them inside the subtotal would look as though an
      // offer had failed to come off them.
      rows.push(`<div class="summary-line"><span>Add-ons</span><span>${money(q.topups_total)}</span></div>`);
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

          ${addonsPanel()}

          <div class="field pos-coupon">
            <div class="input-row">
              <input class="input" id="posCoupon" placeholder="Coupon code" value="${esc(state.coupon)}"
                     autocomplete="off" autocapitalize="characters" enterkeyhint="done" />
              <button class="btn btn-outline" id="posApplyCoupon" type="button">Apply</button>
            </div>
            ${couponChips()}
          </div>

          <div class="pos-totals">${totalsHTML()}</div>
        </div></div>

        <div class="card" style="margin-top:var(--sp-3);"><div class="card-pad">
          <h3 style="margin:0 0 var(--sp-3);font-size:var(--fs-md);">Customer</h3>
          <div class="input-row">
            <div class="field grow"><label>Name *</label>
              <input class="input" id="posName" value="${esc(c.name)}" placeholder="Customer name"
                     autocomplete="off" autocapitalize="words" enterkeyhint="next" /></div>
            <div class="field grow"><label>Phone *</label>
              <input class="input" id="posPhone" value="${esc(c.phone)}" placeholder="10-digit mobile"
                     type="tel" inputmode="numeric" autocomplete="tel" enterkeyhint="done" /></div>
          </div>
          ${delivery ? `
            <div class="field"><label>Delivery area *</label>
              <select class="select" id="posArea">${areaOptions()}</select></div>
            <div class="field"><label>Delivery address *</label>
              <textarea class="input" id="posAddress" placeholder="Flat / house, street, area, landmark">${esc(c.address)}</textarea></div>`
          : `<p class="text-sm text-muted" style="margin:0;">Both are needed on every order — the number is what puts the
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
              <input class="input" id="posUpiRef" value="${esc(state.upiReference)}" placeholder="e.g. 4051XXXXXXXX"
                     inputmode="numeric" autocomplete="off" /></div>` : ""}
          <label class="pill-toggle" style="margin-top:var(--sp-3);">
            <input type="checkbox" id="posPaid" ${state.paymentCollected ? "checked" : ""} />
            <span>Payment received${q ? ` · ${money(q.total)}` : ""}</span>
          </label>
          <div class="field" style="margin-top:var(--sp-3);"><label>Kitchen note</label>
            <textarea class="input" id="posNotes" placeholder="Less spicy, no onion, table 4…">${esc(state.notes)}</textarea></div>
        </div></div>

        <button class="btn btn-primary btn-block btn-lg pos-place-wide" id="posPlace" ${blocked ? "disabled" : ""}>
          ${placeLabel()}</button>
        ${editing()
          ? `<button class="btn btn-outline btn-block btn-sm" id="posRevert">↺ Undo my changes</button>`
          : state.lines.length ? `<button class="btn btn-outline btn-block btn-sm" id="posClear">Clear ticket</button>` : ""}
      </aside>`;
  }

  /* ---------------- receipt ---------------- */

  /* What the save changed, straight from the server's own log.

     Shown on the receipt rather than only on the board because this is the one
     moment the person who made the change is still looking — a re-price that
     moved the total, or a coupon that dropped off when the items changed, has
     to be visible now and not discovered at hand-over. */
  function changeList() {
    const changes = state.changes;
    if (!changes) return "";
    if (!changes.length) {
      return `<p class="text-sm text-muted" style="margin:var(--sp-3) 0 0;">Nothing changed — the order is as it was.</p>`;
    }
    const val = (v, kind) => (v === "" || v == null) ? "—" : (kind === "money" ? money(v) : esc(v));
    return `<div class="pos-changes">
      <h3>Saved ${changes.length} change${changes.length > 1 ? "s" : ""}</h3>
      ${changes.map((ch) => `<div class="pc-row">
        <span class="pc-label">${esc(ch.label)}</span>
        <span class="pc-move"><s>${val(ch.old, ch.kind)}</s> → <strong>${val(ch.new, ch.kind)}</strong></span>
      </div>`).join("")}
    </div>`;
  }

  function receipt(order) {
    const pay = order.payment || {};
    const payMsg = pay.status === "paid" ? "Paid"
      : pay.status === "awaiting_verification" ? "UPI reference recorded — verify on the board"
      : "Payment pending";
    const edited = editing();
    return `
      <div class="card pos-receipt"><div class="card-pad" style="text-align:center;">
        <div style="font-size:2.4rem;">${edited ? "✏️" : "✅"}</div>
        <h2 style="margin:var(--sp-2) 0;">${edited ? "Order updated" : "Order placed"}</h2>
        <div class="order-id-badge">${esc(order.public_id)}</div>
        <p class="text-sm text-muted" style="margin-top:var(--sp-3);">
          ${esc(MODE_LABEL[order.order_type])} · ${money(order.total)} · ${esc(payMsg)}<br />
          ${esc((order.customer && order.customer.name) || "Walk-in")}${order.customer && order.customer.phone ? ` · ${esc(order.customer.phone)}` : ""}
          ${order.repeat_no ? ` · visit #${order.repeat_no}` : ""}
        </p>
        ${edited ? changeList() : ""}
        <p class="text-sm text-muted" id="posPrintState" style="margin:var(--sp-2) 0 0;"></p>
        <div class="pr-actions">
          <button class="btn btn-primary btn-lg" id="posAnother">${edited ? "✏️ Keep editing" : "+ New order"}</button>
          <button class="btn btn-dark" id="posPrint">🖨 Print bill</button>
          <button class="btn btn-outline" id="posInvoice">🧾 Bill / invoice</button>
          <a class="btn btn-outline" href="orders.html">Orders board →</a>
        </div>
      </div></div>`;
  }

  /* ---------------- render + bind ----------------

     The page is painted in three independent pieces — the item list, the
     ticket and the bottom bar — because on a phone every one of them changes
     for a different reason. Repainting the lot on each tap took the keyboard
     off the search box and threw away the menu scroll position, which on a
     40-item menu is the whole order. */

  function render() {
    if (state.placed) {
      el("#posRoot").innerHTML = receipt(state.placed);
      el("#posInvoice").addEventListener("click", () => Invoice.open(state.placed));
      el("#posAnother").addEventListener("click", () => {
        state.placed = null;
        state.changes = null;
        render();
      });
      /* The only print that may open the picker, because this one is a click.
         Everything else about it is the automatic print. */
      el("#posPrint").addEventListener("click", () => printBill(state.placed, true));
      document.body.classList.remove("has-pos-bar");
      return;
    }
    el("#posRoot").innerHTML = `
      ${editBanner()}
      <div class="pos-grid" data-view="${state.view}">${menuPanel()}${ticketPanel()}</div>
      ${bottomBar()}`;
    // Reserves room under the fixed bar so the last card is never trapped
    // behind it — including under an iPhone's home indicator.
    document.body.classList.add("has-pos-bar");
    bind();
  }

  /* Repaint the ticket in place. Text the staff member has typed lives in
     `state`, not in the DOM, so it survives — only the caret moves, and the
     only things that trigger this are taps elsewhere. */
  function paintTicket() {
    const old = el(".pos-ticket");
    if (!old) return;
    old.outerHTML = ticketPanel();
    bindTicket();
    paintBar();
  }

  /* Whether this device has a direct route to the thermal printer at all. On an
     iPhone, or in desktop Safari and Firefox, there is none, and the button
     must not promise a bill it cannot print. */
  const canPrint = () => typeof BTPrint !== "undefined" && BTPrint.supported();

  function placeLabel() {
    if (editing()) {
      if (!state.lines.length) return "An order needs at least one item";
      if (deadList().length) return "Remove sold-out items to continue";
      return `Save changes · ${money(state.quote ? state.quote.total : 0)}`;
    }
    if (!state.lines.length) return "Add items to place an order";
    if (deadList().length) return "Remove sold-out items to continue";
    const total = money(state.quote ? state.quote.total : 0);
    // One tap places the order and prints the bill, so the button says the part
    // the counter is waiting for.
    return canPrint() ? `Print bill · ${total}` : `Place order · ${total}`;
  }

  /* The fixed bar is the phone's whole navigation: it always says what the
     ticket holds, and its button is the next thing to do — see the ticket
     while on the menu, place the order while on the ticket. It is hidden on a
     desktop, where both panels are already side by side. */
  function bottomBar() {
    const n = cartCount();
    const total = state.quote ? state.quote.total : 0;
    const onTicket = state.view === "ticket";
    const blocked = !state.lines.length || deadList().length;
    return `
      <div class="pos-bar" id="posBar">
        <button class="pb-side" id="posBarBack" ${onTicket ? "" : "hidden"}>‹ Menu</button>
        <div class="pb-info">
          <strong>${n ? `${n} item${n > 1 ? "s" : ""}` : "Empty ticket"}</strong>
          <span>${n ? money(total) : "Tap Add to start"}</span>
        </div>
        <button class="btn btn-primary pb-action" id="posBarAction" ${onTicket && blocked ? "disabled" : ""}>
          ${onTicket ? placeLabel() : `Ticket ›`}</button>
      </div>`;
  }

  function paintBar() {
    const bar = el("#posBar");
    if (!bar) return;
    bar.outerHTML = bottomBar();
    bindBar();
  }

  function setView(view) {
    state.view = view;
    const grid = el(".pos-grid");
    if (grid) grid.dataset.view = view;
    paintBar();
    window.scrollTo({ top: 0 });
  }

  function bind() {
    const search = el("#posSearch");
    search.addEventListener("input", (e) => {
      state.search = e.target.value;
      // Only the item list is repainted, so the caret stays in the search box.
      refreshMenuList();
    });
    els("#posCats [data-cat]").forEach((b) => b.addEventListener("click", () => {
      state.cat = b.dataset.cat;
      els("#posCats [data-cat]").forEach((x) => x.classList.toggle("active", x === b));
      refreshMenuList();
    }));
    bindItems();
    bindTicket();
    bindBar();
  }

  function bindBar() {
    const back = el("#posBarBack");
    if (back) back.addEventListener("click", () => setView("menu"));
    const action = el("#posBarAction");
    if (action) action.addEventListener("click", () => {
      if (state.view === "ticket") placeOrder();
      else setView("ticket");
    });
  }

  function bindTicket() {
    els("#posMode button").forEach((b) => b.addEventListener("click", async () => {
      state.mode = b.dataset.mode;
      await refreshQuote();
      paintTicket();
    }));

    els(".pos-ticket [data-inc]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.inc);
      setQty(b.dataset.inc, (l ? l.quantity : 0) + 1);
    }));
    els(".pos-ticket [data-dec]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.dec);
      setQty(b.dataset.dec, (l ? l.quantity : 0) - 1);
    }));
    els("[data-drop]").forEach((b) => b.addEventListener("click", () => setQty(b.dataset.drop, 0)));
    els("[data-drop-topup]").forEach((b) => b.addEventListener("click", () => setTopupQty(b.dataset.dropTopup, 0)));

    els(".pos-addons [data-topup-add]").forEach((b) => b.addEventListener("click", () => setTopupQty(b.dataset.topupAdd, 1)));
    els(".pos-addons [data-topup-off]").forEach((b) => b.addEventListener("click", () => setTopupQty(b.dataset.topupOff, 0)));
    els(".pos-addons [data-topup-inc]").forEach((b) => b.addEventListener("click", () => {
      const line = topupLineFor(b.dataset.topupInc);
      setTopupQty(b.dataset.topupInc, (line ? line.quantity : 0) + 1);
    }));
    els(".pos-addons [data-topup-dec]").forEach((b) => b.addEventListener("click", () => {
      const line = topupLineFor(b.dataset.topupDec);
      setTopupQty(b.dataset.topupDec, (line ? line.quantity : 0) - 1);
    }));
    // Whether the panel is open is the staff member's choice from here on: the
    // ticket is repainted on every tap, and it must not spring shut under them.
    const addons = el("#posAddons");
    if (addons) addons.addEventListener("toggle", () => { state.addonsOpen = addons.open; });

    el("#posApplyCoupon").addEventListener("click", () => applyCoupon());
    el("#posCoupon").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCoupon(); });
    els("[data-code]").forEach((b) => b.addEventListener("click", () => applyCoupon(b.dataset.code)));

    el("#posName").addEventListener("input", (e) => state.customer.name = e.target.value);
    const phone = el("#posPhone");
    phone.addEventListener("input", (e) => {
      state.customer.phone = e.target.value.replace(/[^0-9]/g, "").slice(0, 10);
      e.target.value = state.customer.phone;
    });
    // Re-priced when the field is left, not per keystroke: the number only
    // changes the total when a phone-bound reward code is on the ticket, and
    // repainting mid-typing would take the keyboard away from the field.
    phone.addEventListener("change", async () => {
      if (!state.coupon) return;
      await refreshQuote();
      el(".pos-totals").innerHTML = totalsHTML();
      paintBar();
    });
    const area = el("#posArea");
    if (area) area.addEventListener("change", async (e) => {
      state.deliveryAreaId = e.target.value;
      await refreshQuote();
      paintTicket();
    });
    const addr = el("#posAddress");
    if (addr) addr.addEventListener("input", (e) => state.customer.address = e.target.value);

    els("#posPay button").forEach((b) => b.addEventListener("click", () => {
      state.payment = b.dataset.pay;
      paintTicket();
    }));
    const ref = el("#posUpiRef");
    if (ref) ref.addEventListener("input", (e) => state.upiReference = e.target.value.trim());
    el("#posPaid").addEventListener("change", (e) => state.paymentCollected = e.target.checked);
    el("#posNotes").addEventListener("input", (e) => state.notes = e.target.value);

    el("#posPlace").addEventListener("click", placeOrder);
    const revert = el("#posRevert");
    if (revert) revert.addEventListener("click", revertEdit);
    const clear = el("#posClear");
    if (clear) clear.addEventListener("click", () => {
      state.lines = [];
      state.topupLines = [];
      state.coupon = "";
      state.quote = null;
      saveCart();
      saveTopups();
      refreshMenuList();
      paintTicket();
    });
  }

  function bindItems() {
    els(".pos-items [data-add]").forEach((b) => b.addEventListener("click", () => {
      const it = itemById(b.dataset.add);
      addItem(b.dataset.add, it ? pickedIdx(it) : 0);
    }));
    els(".pos-items [data-inc]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.inc);
      setQty(b.dataset.inc, (l ? l.quantity : 0) + 1);
    }));
    els(".pos-items [data-dec]").forEach((b) => b.addEventListener("click", () => {
      const l = state.lines.find((x) => lineKey(x) === b.dataset.dec);
      setQty(b.dataset.dec, (l ? l.quantity : 0) - 1);
    }));
    // Choosing another size/base repaints that one row, so its price and its
    // Add/stepper describe the option now selected rather than the last one.
    els(".pos-items [data-var]").forEach((sel) => sel.addEventListener("change", (e) => {
      const id = Number(sel.dataset.var);
      state.picked.set(id, Number(e.target.value));
      const row = el(`.pos-items [data-row="${id}"]`);
      const it = itemById(id);
      if (row && it) { row.outerHTML = itemRow(it); bindItems(); }
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

  /* ---------------- printing ---------------- */

  /* Send the bill to the counter's thermal printer.
   *
   * Called twice for one order and deliberately so: once on its own the moment
   * the order lands, which is the whole point — the printer was picked once for
   * this session and placing the order is meant to be the last tap — and again
   * from the Print button when the first attempt found no printer, or the paper
   * jammed, or someone wants a second copy.
   *
   * `fromClick` is the difference between them. Only a click may open the
   * browser's device picker, so the automatic attempt stays silent when there is
   * nothing to reach and leaves the button to do the asking. */
  async function printBill(order, fromClick) {
    const say = (text) => {
      const box = el("#posPrintState");
      if (box) box.textContent = text;
    };
    const btn = el("#posPrint");
    if (btn) btn.disabled = true;
    say(fromClick ? "Connecting to the printer…" : "Printing the bill…");
    try {
      const r = await Invoice.autoPrint(order, { force: !!fromClick });
      if (r.ok) {
        say("Bill sent to the printer.");
        toast("Bill printed", "ok");
      } else if (r.reason === "unsupported") {
        say("This browser cannot print over Bluetooth — open Bill / invoice and use Dialog.");
      } else {
        say("No printer connected yet — tap Print bill to pick it once for this session.");
      }
    } catch (e) {
      if (e && e.name === "NotFoundError") {
        say("No printer picked — tap Print bill when the printer is on.");
      } else {
        /* Nothing here can tell a sleeping printer from one that speaks SPP, so
           name what the counter can actually check. */
        say(`Print failed: ${e && e.message ? e.message : e}. Check the printer is on, then tap Print bill.`);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* Make sure there is a printer to print to, while the tap that asked for it
     is still fresh.

     This runs before the order is posted, and that order matters: the browser
     only opens its device picker inside a few seconds of a real click, and a
     POST plus a render spends them. Picking first is what lets one tap place
     the order and print the bill on the very first order of a session.

     Never fatal. A dismissed picker, a printer left switched off, a browser
     with no Bluetooth — all of them still place the order, and the receipt
     screen keeps its own Print button for the second try. */
  async function ensurePrinter() {
    if (!canPrint()) return;
    try {
      if (await BTPrint.ready()) return;
      await BTPrint.connect();
    } catch (e) {
      /* Reported after the order lands, not here: the order is the thing being
         placed, and a print problem must not read like a failed order. */
    }
  }

  /* ---------------- place ---------------- */

  async function placeOrder() {
    if (state.placing) return;
    if (!state.lines.length) return toast("Add at least one item", "err");
    if (deadList().length) return toast("Remove the sold-out items first", "err");
    const c = state.customer;
    /* Name and number are asked for on every order, walk-in included. They are
       what the order is found by afterwards — history, reward codes, a call
       back about a wrong bill — and a counter that can skip them ends up with
       a day of orders belonging to nobody. */
    if (!c.name.trim()) return toast("Customer name is needed", "err");
    if (!/^[0-9]{10}$/.test(c.phone)) return toast("A 10-digit phone number is needed", "err");
    if (state.mode === "delivery") {
      if (!state.deliveryAreaId) return toast("Select the delivery area", "err");
      if (!c.address.trim()) return toast("Delivery needs an address", "err");
    }

    // Both buttons say the same thing: the wide one in the ticket on a desktop
    // and the one in the fixed bar on a phone.
    state.placing = true;
    const working = editing() ? "Saving…" : "Placing…";
    els("#posPlace, #posBarAction").forEach((b) => { b.disabled = true; b.textContent = working; });
    await ensurePrinter();
    try {
      const body = {
        cart: cartPayload(),
        topups: topupPayload(),
        order_type: state.mode,
        coupon_code: state.coupon,
        delivery_area_id: Number(state.deliveryAreaId) || 0,
        customer: { name: c.name.trim(), phone: c.phone.trim(), address: c.address.trim() },
        payment_method: state.payment,
        payment_collected: state.paymentCollected,
        upi_reference: state.upiReference,
        notes: state.notes,
      };
      /* A save comes back as {order, changes}; a new order comes back as the
         order itself. The changes are what the backend actually wrote to the
         log, not what this screen thinks it sent — a re-price can move the
         total on its own, and the receipt should say so. */
      let order;
      if (editing()) {
        const saved = await API.put(`/api/admin/orders/${encodeURIComponent(state.editing.public_id)}`, body);
        order = saved.order;
        state.changes = saved.changes || [];
        state.editing = order;
      } else {
        order = await API.post("/api/admin/orders", body);
        // The ticket is done: everything that belongs to it is reset so the next
        // customer cannot inherit the last one's coupon, note or address.
        state.lines = [];
        state.topupLines = [];
        state.addonsOpen = null;
        state.coupon = "";
        state.quote = null;
        state.customer = { name: "", phone: "", address: "" };
        state.deliveryAreaId = "";
        state.payment = "cash";
        state.paymentCollected = false;
        state.upiReference = "";
        state.notes = "";
        saveCart();
        saveTopups();
      }
      state.placed = order;
      state.placing = false;
      state.view = "menu";
      render();
      window.scrollTo({ top: 0 });
      // Not awaited: the receipt is already on screen and the print reports
      // itself into it. A printer that has gone to sleep takes a few seconds to
      // answer, and nothing on this screen should wait for it.
      printBill(order, false);
    } catch (e) {
      toast(e.message, "err");
      state.placing = false;
      render();
    }
  }
})();
