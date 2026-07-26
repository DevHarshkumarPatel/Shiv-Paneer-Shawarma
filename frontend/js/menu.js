/* Menu page: load menu, render categories/cards, item modal, cart + live quote. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;
  let MENU = null;
  let quoteTimer = null;
  let lastQuote = null;
  let couponCode = Store.get().coupon || "";
  let orderingEnabled = true;   // owner master switch (from /api/settings)

  const MODE_HINTS = {
    dine_in: "Eat at the outlet — no extra charge.",
    takeaway: "Pick up yourself — no extra charge.",
    delivery: "Delivered to your door — delivery fee applies, pay online.",
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindMode();
    bindStatic();
    bindMenuClicks();
    Store.subscribe(onCartChange);
    try {
      const cfg = await API.get("/api/config");
      window.SPS_CONFIG.runtime = cfg || {};
    } catch { /* non-fatal */ }
    try {
      const s = await API.get("/api/settings");
      orderingEnabled = s.ordering_enabled !== false;
    } catch { /* default to enabled if unreachable */ }
    await loadMenu();
    applyOrderingState();
    syncMode();
    onCartChange();
  }

  /* When the owner has turned ordering off, keep the menu browsable but block
     placing orders: show a banner and disable the "add" buttons. */
  function applyOrderingState() {
    const layout = document.querySelector(".menu-layout");
    const existing = el("#orderingClosedBanner");
    if (orderingEnabled) { if (existing) existing.remove(); return; }
    if (!existing && layout) {
      layout.insertAdjacentHTML("beforebegin",
        `<div class="notice-banner" id="orderingClosedBanner">🔔 <strong>We're not accepting online orders right now.</strong>
          You're welcome to explore our menu — please check back a little later to place your order.</div>`);
    }
    // sideHTML() renders the disabled control itself, so the cards only need
    // re-drawing once the flag is known.
    refreshAllSides();
  }

  async function loadMenu() {
    try {
      MENU = await API.get("/api/menu");
      renderChips();
      renderMenu();
    } catch (e) {
      el("#menuContent").innerHTML = `<div class="empty"><div class="emoji">😕</div>
        <h3>Couldn't load the menu</h3><p class="text-muted">${esc(e.message)}</p>
        <button class="btn btn-primary" onclick="location.reload()">Retry</button></div>`;
    }
  }

  /* ---------- rendering ---------- */
  function renderChips() {
    const chips = MENU.categories.map((c, i) => `
      <button class="chip ${i === 0 ? "active" : ""}" data-cat="cat-${c.id}">
        ${esc(c.name)} ${c.offer_badge ? `<span class="tag">B1G1</span>` : ""}
      </button>`).join("");
    el("#catChips").innerHTML = `<button class="chip active" data-cat="__all">All</button>` + chips;
    els("#catChips .chip").forEach((chip) => chip.addEventListener("click", () => {
      els("#catChips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const target = chip.dataset.cat;
      if (target === "__all") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      const node = document.getElementById(target);
      // Clear both sticky rows (site header + the order-type/chips bar).
      if (node) window.scrollTo({ top: node.offsetTop - 150, behavior: "smooth" });
    }));
  }

  function variantShape(item) {
    const bases = [...new Set(item.variants.map((v) => v.base).filter(Boolean))];
    const sizes = [...new Set(item.variants.map((v) => v.size).filter(Boolean))];
    return { bases, sizes };
  }
  const findVariant = (item, base, size) =>
    item.variants.find((v) => v.base === base && v.size === size) || item.variants[0];

  /* Which base/size each card is currently showing. Adding an item used to mean
     opening a modal and confirming there, even for items with a single variant —
     three taps to buy one shawarma. The choice now lives on the card itself,
     pre-selected, so "Add" is one tap and the modal is gone entirely. */
  const picked = new Map();   // item id -> { base, size }

  function selection(item) {
    let sel = picked.get(item.id);
    if (!sel) {
      const { bases, sizes } = variantShape(item);
      sel = { base: bases[0] || "", size: sizes[0] || "" };
      picked.set(item.id, sel);
    }
    return sel;
  }

  const selectedLine = (item) => {
    const sel = selection(item);
    const v = findVariant(item, sel.base, sel.size);
    return {
      item_id: item.id, name: item.name, base: sel.base, size: sel.size,
      variant_label: v ? v.label : "", unit_price: v ? v.price : item.base_price,
    };
  };

  const inCart = (item) => {
    const key = Store.lineKey(selectedLine(item));
    return Store.get().lines.find((l) => Store.lineKey(l) === key) || null;
  };

  /* Cheapest variant carrying a given base (or size) value. */
  function lowestFor(item, group, value) {
    const prices = item.variants.filter((v) => v[group] === value).map((v) => v.price);
    return prices.length ? Math.min(...prices) : item.base_price;
  }

  /* Which axis actually moves the price.
   *
   * This matters commercially, not just visually. With one price on the card and
   * every option behind a dropdown, the only figure a customer ever saw was the
   * cheapest one — the upgrade was invisible unless they went looking, so the
   * kitchen never got asked for it. Whichever axis changes the total is put on
   * the card with its premium spelled out ("Exotic +₹30"); the axis that costs
   * the same either way (wheat vs millet, here) does not need the space and goes
   * behind the quiet line above it.
   */
  function pricedAxis(item) {
    const { bases, sizes } = variantShape(item);
    const varies = (group, values) =>
      values.length > 1 && new Set(values.map((v) => lowestFor(item, group, v))).size > 1;
    if (varies("size", sizes)) return { group: "size", values: sizes };
    if (varies("base", bases)) return { group: "base", values: bases };
    return null;
  }

  /* The remaining axis — a real choice for the customer, but free, so it is a
     one-line summary that opens a sheet rather than a row of buttons. */
  function freeAxis(item) {
    const { bases, sizes } = variantShape(item);
    const priced = pricedAxis(item);
    const candidates = [{ group: "base", values: bases }, { group: "size", values: sizes }];
    return candidates.find((c) => c.values.length > 1 && (!priced || c.group !== priced.group)) || null;
  }

  /* The free axis, as one quiet line with a chevron. Opens the sheet. */
  function pickLine(item) {
    const free = freeAxis(item);
    if (!free) return "";
    const sel = selection(item);
    return `<button class="variant-btn" data-opts="${item.id}">
        <span>${esc(sel[free.group])}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>`;
  }

  /* The priced axis, on the card, with what each upgrade costs over the cheapest
     option. Both figures are visible without opening anything. */
  function pricedRow(item) {
    const priced = pricedAxis(item);
    if (!priced) return "";
    const sel = selection(item);
    const floor = Math.min(...priced.values.map((v) => lowestFor(item, priced.group, v)));
    const pills = priced.values.map((v) => {
      const extra = lowestFor(item, priced.group, v) - floor;
      const plus = extra > 0 ? `<b>+${money(extra)}</b>` : "";
      return `<button class="tier ${v === sel[priced.group] ? "active" : ""}"
        data-tier="${item.id}" data-group="${priced.group}" data-val="${esc(v)}">${esc(v)}${plus}</button>`;
    }).join("");
    return `<div class="tiers" data-group="${priced.group}">${pills}</div>`;
  }

  /* Options as a bottom sheet: on a phone .modal-backdrop anchors to the bottom
     edge, so the choices and the confirm button land under the thumb instead of
     mid-screen. Opened only by someone who wants a non-default variant. */
  function openOptions(itemId) {
    const item = itemById(itemId);
    if (!item) return;
    const sel = { ...selection(item) };
    // Only the axes that are not already on the card, so the same choice is
    // never offered in two places at once.
    const onCard = pricedAxis(item);
    const { bases, sizes } = variantShape(item);
    const sheetAxes = [{ group: "base", values: bases }, { group: "size", values: sizes }]
      .filter((a) => a.values.length > 1 && (!onCard || a.group !== onCard.group));

    const group = (name, values, active) => `
      <div class="opt-label">Choose ${name}</div>
      <div class="opt-grid" data-group="${name}">
        ${values.map((v) => `<button class="opt ${v === active ? "active" : ""}" data-val="${esc(v)}">${esc(v)}</button>`).join("")}
      </div>`;

    const m = modal({
      title: item.name,
      bodyHTML: sheetAxes.map((a) => group(a.group, a.values, sel[a.group])).join(""),
      footHTML: `<button class="btn btn-primary btn-block btn-lg" id="optDone">Add · <span id="optPrice"></span></button>`,
    });

    const priceOf = () => {
      const v = findVariant(item, sel.base, sel.size);
      return v ? v.price : item.base_price;
    };
    const refresh = () => { el("#optPrice", m.backdrop).textContent = money(priceOf()); };

    m.backdrop.querySelectorAll("[data-group] .opt").forEach((b) => b.addEventListener("click", () => {
      const g = b.closest("[data-group]").dataset.group;
      b.parentNode.querySelectorAll(".opt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      sel[g] = b.dataset.val;
      refresh();
    }));
    el("#optDone", m.backdrop).addEventListener("click", () => {
      picked.set(item.id, sel);          // the card keeps showing this choice
      addSelected(item.id);
      renderCardBody(item);
      m.close();
    });
    refresh();
  }

  /* Price of the current selection plus either Add or, once it is in the cart,
     a stepper — so quantity is changed in place instead of in a dialog. */
  function sideHTML(item) {
    const line = selectedLine(item);
    const existing = inCart(item);
    const control = !orderingEnabled
      ? `<button class="btn btn-sm add-btn" disabled title="Online ordering is paused">Closed</button>`
      : existing
        ? `<div class="stepper card-stepper">
             <button data-cdec="${item.id}" aria-label="One less">−</button>
             <span>${existing.quantity}</span>
             <button data-cinc="${item.id}" aria-label="One more">＋</button>
           </div>`
        : `<button class="btn btn-primary btn-sm add-btn" data-add="${item.id}">Add</button>`;
    return `<div class="price-single">${money(line.unit_price)}</div>${control}`;
  }

  /* catPromoId: the promo the whole category is running, if any. The API copies
     a category promo onto every item in it, so without this check the same
     "Buy 1 Get 1 Free" badge repeats on every card under a heading that already
     says so. Only genuinely item-specific offers get a badge. */
  function itemCard(item, catPromoId) {
    const ownPromo = item.promo && item.promo.id !== catPromoId;
    const offer = ownPromo ? `<span class="badge badge-offer offer-tag">${esc(item.promo.label || "Offer")}</span>` : "";
    // Items are tagged with their own bases ("Whole Wheat", "Millets"), which
    // are now selectable pills right below — printing both said everything twice
    // and made the card taller for it. Only tags that are not a choice survive.
    const { bases, sizes } = variantShape(item);
    const choices = new Set([...bases, ...sizes].map((v) => v.toLowerCase()));
    const tags = (item.tags || [])
      .filter((t) => !choices.has(String(t).toLowerCase()))
      .map((t) => `<span class="badge badge-soft">${esc(t)}</span>`).join("");
    // No placeholder frame when there is no photo — an empty box on every card
    // is what made the menu look unfinished. The thumb appears only if real.
    const thumb = item.image_url
      ? `<div class="thumb"><img src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy" /></div>`
      : "";
    return `
      <article class="card item-card" id="item-${item.id}" data-card="${item.id}">
        ${thumb}
        <div class="body">
          <div class="title-row">
            <h3>${esc(item.name)}</h3>
            <span class="dot" title="Pure veg"></span>
          </div>
          ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ""}
          ${tags || offer ? `<div class="tags">${tags}${offer}</div>` : ""}
          ${pickLine(item)}
          ${pricedRow(item)}
        </div>
        <div class="side" data-side="${item.id}">${sideHTML(item)}</div>
      </article>`;
  }

  function renderMenu() {
    if (!MENU.categories.length) {
      el("#menuContent").innerHTML = `<div class="empty"><div class="emoji">🍽️</div><h3>Menu coming soon</h3></div>`;
      return;
    }
    const html = MENU.categories.map((cat) => {
      const allItems = [...(cat.items || []), ...(cat.subcategories || []).flatMap((s) => s.items)];
      const catPromoId = cat.promo ? cat.promo.id : null;
      const cards = allItems.map((it) => itemCard(it, catPromoId)).join("");
      // The offer is stated once, here. It used to also run as a full-width
      // banner under this heading and as a badge on every card below it.
      const offer = cat.offer_badge ? `<span class="offer">${esc(cat.offer_badge)} Free</span>` : "";
      return `
        <section class="cat-block" id="cat-${cat.id}">
          <div class="cat-head">
            <h2>${esc(cat.name)}</h2>${offer}
            <span class="count">${allItems.length} item${allItems.length === 1 ? "" : "s"}</span>
          </div>
          <div class="item-grid">${cards}</div>
        </section>`;
    }).join("");
    el("#menuContent").innerHTML = html;
  }

  /* One delegated listener for the whole menu: the cards are re-rendered as the
     cart changes, so per-node listeners would have to be re-bound each time. */
  function bindMenuClicks() {
    el("#menuContent").addEventListener("click", (e) => {
      const tier = e.target.closest("[data-tier]");
      if (tier) return chooseTier(tier);
      const opts = e.target.closest("[data-opts]");
      if (opts) return openOptions(+opts.dataset.opts);
      const add = e.target.closest("[data-add]");
      if (add) return addSelected(+add.dataset.add);
      const inc = e.target.closest("[data-cinc]");
      if (inc) return stepCard(+inc.dataset.cinc, +1);
      const dec = e.target.closest("[data-cdec]");
      if (dec) return stepCard(+dec.dataset.cdec, -1);
    });
  }

  function chooseTier(btn) {
    const item = itemById(+btn.dataset.tier);
    if (!item) return;
    selection(item)[btn.dataset.group] = btn.dataset.val;
    btn.closest(".tiers").querySelectorAll(".tier").forEach((b) => b.classList.toggle("active", b === btn));
    refreshSide(item);   // the price and what Add will add both follow the tier
  }

  /* After the options sheet changes the selection, the card's variant line and
     its price/control both have to catch up. */
  function renderCardBody(item) {
    const card = el(`[data-card="${item.id}"]`);
    if (!card) return;
    const label = card.querySelector(".variant-btn span");
    const sel = selection(item);
    if (label) label.textContent = [sel.base, sel.size].filter(Boolean).join(" · ");
    refreshSide(item);
  }

  function addSelected(itemId) {
    if (!orderingEnabled) { toast("Online ordering is currently closed", "err"); return; }
    const item = itemById(itemId);
    if (!item) return;
    Store.add({ ...selectedLine(item), quantity: 1 });
    toast(`${item.name} added`, "ok");
  }

  function stepCard(itemId, delta) {
    const item = itemById(itemId);
    const existing = item && inCart(item);
    if (!existing) return;
    Store.setQty(Store.lineKey(existing), existing.quantity + delta);
  }

  const refreshSide = (item) => {
    const side = el(`[data-side="${item.id}"]`);
    if (side) side.innerHTML = sideHTML(item);
  };
  /* Keep every visible card's control in step with the cart — including changes
     made from the cart panel or the drawer, not just from the card itself. */
  const refreshAllSides = () => els("[data-side]").forEach((side) => {
    const item = itemById(+side.dataset.side);
    if (item) side.innerHTML = sideHTML(item);
  });

  /* Flat item lookup. Card handlers get an id out of the DOM and need the item
     record behind it. */
  function allItemsFlat() {
    return MENU.categories.flatMap((c) => [...(c.items || []), ...(c.subcategories || []).flatMap((s) => s.items)]);
  }
  const itemById = (id) => allItemsFlat().find((i) => i.id === id) || null;

  /* ---------- cart + quote ---------- */
  function bindMode() {
    els("#modeSeg button").forEach((b) => b.addEventListener("click", () => { Store.setMode(b.dataset.mode); syncMode(); requestQuote(); }));
  }
  function syncMode() {
    const mode = Store.get().mode;
    els("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    el("#modeHint").textContent = MODE_HINTS[mode] || "";
  }
  function bindStatic() {
    el("#clearCart").addEventListener("click", () => { Store.clear(); couponCode = ""; });
    el("#cartBar").addEventListener("click", openCartDrawer);
    el("#headerCart").addEventListener("click", openCartDrawer);
  }

  function onCartChange() {
    const n = Store.count();
    const hc = el("#headerCartCount");
    hc.textContent = n; hc.classList.toggle("hidden", n === 0);
    el("#clearCart").classList.toggle("hidden", n === 0);
    el("#cbCount").textContent = `${n} item${n === 1 ? "" : "s"}`;
    el("#cartBar").classList.toggle("show", n > 0);
    renderCart(el("#cartBody"));
    refreshAllSides();
    requestQuote();
  }

  function requestQuote() {
    clearTimeout(quoteTimer);
    const lines = Store.toCartPayload();
    if (!lines.length) { lastQuote = null; renderCart(el("#cartBody")); refreshDrawer(); return; }
    quoteTimer = setTimeout(async () => {
      try {
        lastQuote = await API.post("/api/orders/quote", { cart: lines, order_type: Store.get().mode, coupon_code: couponCode });
        if (couponCode && lastQuote.coupon_error) { toast(lastQuote.coupon_error, "err"); couponCode = ""; }
        Store.setCoupon(couponCode);
        el("#cbTotal").textContent = money(lastQuote.total);
        renderCart(el("#cartBody"));
        refreshDrawer();
      } catch (e) { /* keep previous */ }
    }, 250);
  }

  function renderCart(target) {
    if (!target) return;
    const { lines } = Store.get();
    if (!lines.length) {
      target.innerHTML = `<div class="empty" style="padding:var(--sp-5) 0;"><div class="emoji">🛒</div><p class="text-muted">Your cart is empty.<br/>Add something tasty!</p></div>`;
      return;
    }
    const q = lastQuote;
    const lineHTML = lines.map((l) => {
      const key = Store.lineKey(l);
      const qLine = q && q.lines.find((x) => x.item_id === l.item_id && x.base === l.base && x.size === l.size);
      const freeNote = qLine && qLine.free_quantity ? `<div class="free-note">🎉 ${qLine.free_quantity} free (B1G1)</div>` : "";
      const lineTotal = qLine ? qLine.line_total : l.unit_price * l.quantity;
      return `
        <div class="cart-line">
          <div class="cl-main">
            <div class="cl-name">${esc(l.name)}</div>
            <div class="cl-variant">${esc(l.variant_label || "")}</div>
            ${freeNote}
            <div class="stepper" style="margin-top:4px;">
              <button data-dec="${key}">−</button><span>${l.quantity}</span><button data-inc="${key}">＋</button>
            </div>
          </div>
          <div class="cl-price">${money(lineTotal)}</div>
        </div>`;
    }).join("");

    const totals = q ? totalsHTML(q) : `<div class="center-load"><div class="spinner"></div></div>`;
    target.innerHTML = `
      <div class="cart-items">${lineHTML}</div>
      <div class="field" style="margin:0 0 var(--sp-3);">
        <div class="input-row">
          <input class="input" id="couponInput" placeholder="Coupon code" value="${esc(couponCode)}" />
          <button class="btn btn-outline" id="applyCoupon">Apply</button>
        </div>
      </div>
      <div class="cart-totals">${totals}</div>
      <button class="btn btn-primary btn-block btn-lg" id="goCheckout" style="margin-top:var(--sp-3);" ${orderingEnabled ? "" : "disabled"}>${orderingEnabled ? "Proceed to checkout →" : "Ordering closed"}</button>`;

    target.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => {
      const l = Store.get().lines.find((x) => Store.lineKey(x) === b.dataset.inc); Store.setQty(b.dataset.inc, l.quantity + 1);
    }));
    target.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => {
      const l = Store.get().lines.find((x) => Store.lineKey(x) === b.dataset.dec); Store.setQty(b.dataset.dec, l.quantity - 1);
    }));
    const applyBtn = el("#applyCoupon", target);
    if (applyBtn) applyBtn.addEventListener("click", () => { couponCode = el("#couponInput", target).value.trim().toUpperCase(); requestQuote(); });
    const co = el("#goCheckout", target);
    if (co) co.addEventListener("click", () => { location.href = "checkout.html"; });
  }

  function totalsHTML(q) {
    const rows = [];
    rows.push(rowLine("Subtotal", money(q.subtotal)));
    if (q.promo_discount > 0) rows.push(rowLine("Offers (B1G1)", "− " + money(q.promo_discount), "free-note"));
    if (q.coupon_discount > 0) rows.push(rowLine(`Coupon ${esc(q.coupon_code)}`, "− " + money(q.coupon_discount), "free-note"));
    if (q.delivery_fee > 0) rows.push(rowLine("Delivery fee", money(q.delivery_fee)));
    return rows.join("") + `<div class="row-between grand"><span>Total</span><span>${money(q.total)}</span></div>`;
  }
  const rowLine = (label, val, cls = "") => `<div class="row-between"><span class="${cls}">${label}</span><span class="${cls}">${val}</span></div>`;

  /* ---------- mobile cart drawer ---------- */
  let drawer = null;
  function openCartDrawer() {
    if (!Store.count()) { toast("Your cart is empty", ""); return; }
    drawer = modal({ title: "Your order", bodyHTML: `<div id="drawerBody"></div>` });
    drawer.backdrop.addEventListener("click", (e) => { if (e.target === drawer.backdrop) drawer = null; });
    refreshDrawer();
  }
  function refreshDrawer() {
    if (drawer && document.body.contains(drawer.backdrop)) renderCart(el("#drawerBody", drawer.backdrop));
    else drawer = null;
  }
})();
