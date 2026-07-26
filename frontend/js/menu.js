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

  const vAvailable = (v) => !v || v.available !== false;
  const multiVariant = (item) => (item.variants || []).length > 1;
  const itemAvailable = (item) =>
    item.available !== false && (item.variants || []).some(vAvailable);
  /* A value is offerable if at least one available variant carries it — millets
     can be off while wheat is still on. */
  const valueAvailable = (item, group, value) =>
    item.variants.some((v) => v[group] === value && vAvailable(v));

  function selection(item) {
    let sel = picked.get(item.id);
    if (!sel) {
      // Default to the owner's first variant, but never to something that is
      // out of stock — landing on a sold-out default would make an item that is
      // perfectly orderable look unorderable.
      const first = (item.variants || []).find(vAvailable) || item.variants[0] || {};
      sel = { base: first.base || "", size: first.size || "" };
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

  /* Price as a range when the variants differ.
   *
   * The card used to carry the whole option set: a base line plus a pill per
   * priced tier. On a phone that was three rows of controls around one dish
   * name, which wrapped the name, stacked the tags and pushed each card past
   * 260px — unreadable while scrolling and impossible to aim at one-handed.
   *
   * The detail sheet now holds every option, so the card only has to answer
   * "what is it and what does it cost". A range still does the commercial job
   * the pills were there for: it shows there is something above the entry price,
   * which a bare "from ₹129" hides.
   */
  function priceRange(item) {
    const prices = (item.variants || []).filter(vAvailable).map((v) => v.price);
    const all = prices.length ? prices : (item.variants || []).map((v) => v.price);
    if (!all.length) return money(item.base_price);
    const low = Math.min(...all), high = Math.max(...all);
    return low === high ? money(low) : `${money(low)}<span class="dash">–</span>${money(high)}`;
  }

  /* Full item sheet, opened by tapping anywhere on a card.
   *
   * The card is a dense list row by necessity — it has to sit alongside twenty
   * others. This is where an item gets to sell itself: the photo at full width,
   * the description unclipped, and every base/size combination laid out with
   * its own price so nothing about the range is hidden. It opens from the bottom
   * edge, so on a phone the options and the Add button are under the thumb.
   */
  function openDetail(itemId) {
    const item = itemById(itemId);
    if (!item) return;
    const sel = { ...selection(item) };
    const { bases, sizes } = variantShape(item);
    const priced = pricedAxis(item);
    const soldOut = !itemAvailable(item);
    let qty = 1;

    // Only ever the axes that are a real choice; a single-variant item shows
    // none and is just a photo, a description and one price.
    const axes = [{ group: "base", values: bases }, { group: "size", values: sizes }]
      .filter((a) => a.values.length > 1);

    const group = (a) => `
      <div class="opt-label">Choose ${a.group}</div>
      <div class="opt-grid" data-group="${a.group}">
        ${a.values.map((v) => {
          const off = !valueAvailable(item, a.group, v);
          // Price is shown per option on the axis that changes it, so the whole
          // range is legible at a glance instead of one figure at a time.
          const tag = priced && a.group === priced.group
            ? `<small>${money(lowestFor(item, a.group, v))}</small>` : "";
          return `<button class="opt ${v === sel[a.group] ? "active" : ""}" ${off ? "disabled" : ""}
            data-val="${esc(v)}">${esc(v)}${off ? "<small>Sold out</small>" : tag}</button>`;
        }).join("")}
      </div>`;

    const hero = item.image_url
      ? `<div class="sheet-hero"><img src="${esc(API.assetUrl(item.image_url))}" alt="${esc(item.name)}" /></div>`
      : "";
    const tags = (item.tags || [])
      .map((t) => `<span class="badge badge-soft">${esc(t)}</span>`).join("");

    const m = modal({
      title: item.name,
      bodyHTML: `
        ${hero}
        <div class="sheet-meta">
          <span class="dot" title="Pure veg"></span>
          ${soldOut ? `<span class="badge badge-out">Sold out</span>` : ""}
          ${item.promo ? `<span class="badge badge-offer">${esc(item.promo.label || "Offer")}</span>` : ""}
        </div>
        ${item.description ? `<p class="sheet-desc">${esc(item.description)}</p>` : ""}
        ${tags ? `<div class="tags sheet-tags">${tags}</div>` : ""}
        ${axes.map(group).join("")}`,
      footHTML: soldOut
        ? `<button class="btn btn-block btn-lg" disabled>Sold out</button>`
        : `<div class="sheet-foot">
             <div class="stepper" data-qty>
               <button data-step="-1" aria-label="One less">−</button><span id="dQty">1</span><button data-step="1" aria-label="One more">＋</button>
             </div>
             <button class="btn btn-primary btn-lg grow" id="dAdd">Add · <span id="dPrice"></span></button>
           </div>`,
    });

    const priceOf = () => {
      const v = findVariant(item, sel.base, sel.size);
      return (v ? v.price : item.base_price) * qty;
    };
    const refresh = () => {
      const price = el("#dPrice", m.backdrop);
      if (price) price.textContent = money(priceOf());
      const q = el("#dQty", m.backdrop);
      if (q) q.textContent = qty;
    };

    m.backdrop.querySelectorAll("[data-group] .opt").forEach((b) => b.addEventListener("click", () => {
      const g = b.closest("[data-group]").dataset.group;
      b.parentNode.querySelectorAll(".opt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      sel[g] = b.dataset.val;
      refresh();
    }));
    m.backdrop.querySelectorAll("[data-qty] [data-step]").forEach((b) => b.addEventListener("click", () => {
      qty = Math.max(1, qty + Number(b.dataset.step));
      refresh();
    }));
    const addBtn = el("#dAdd", m.backdrop);
    if (addBtn) addBtn.addEventListener("click", () => {
      picked.set(item.id, sel);          // the card keeps showing what was chosen
      const line = selectedLine(item);
      if (!vAvailable(findVariant(item, sel.base, sel.size))) {
        toast(`${item.name} (${line.variant_label}) is sold out`, "err");
        return;
      }
      Store.add({ ...line, quantity: qty });
      toast(`${qty} × ${item.name} added`, "ok");
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
    const control = !itemAvailable(item)
      ? `<button class="btn btn-sm add-btn" disabled>Sold out</button>`
      : !orderingEnabled
      ? `<button class="btn btn-sm add-btn" disabled title="Online ordering is paused">Closed</button>`
      : existing
        ? `<div class="stepper card-stepper">
             <button data-cdec="${item.id}" aria-label="One less">−</button>
             <span>${existing.quantity}</span>
             <button data-cinc="${item.id}" aria-label="One more">＋</button>
           </div>`
        // With a price *range* on the card, a one-tap Add would silently pick the
        // cheapest variant — the exact thing that hides the upgrade. So Add opens
        // the sheet whenever there is a genuine choice, and adds outright when
        // there is not (the bowls, and anything single-variant).
        : multiVariant(item)
          ? `<button class="btn btn-primary btn-sm add-btn" data-detail="${item.id}">Add</button>`
          : `<button class="btn btn-primary btn-sm add-btn" data-add="${item.id}">Add</button>`;
    return `<div class="price-single">${priceRange(item)}</div>${control}`;
  }

  /* catPromoId: the promo the whole category is running, if any. The API copies
     a category promo onto every item in it, so without this check the same
     "Buy 1 Get 1 Free" badge repeats on every card under a heading that already
     says so. Only genuinely item-specific offers get a badge. */
  function itemCard(item, catPromoId) {
    const ownPromo = item.promo && item.promo.id !== catPromoId;
    const offer = ownPromo ? `<span class="badge badge-offer offer-tag">${esc(item.promo.label || "Offer")}</span>` : "";
    // No placeholder frame when there is no photo — an empty box on every card
    // is what made the menu look unfinished. The thumb appears only if real.
    // assetUrl resolves the API-relative path uploads are stored as.
    const thumb = item.image_url
      ? `<div class="thumb"><img src="${esc(API.assetUrl(item.image_url))}" alt="${esc(item.name)}" loading="lazy" /></div>`
      : "";
    const soldOut = !itemAvailable(item);
    return `
      <article class="card item-card ${soldOut ? "sold-out" : ""}" id="item-${item.id}" data-card="${item.id}">
        ${thumb}
        <div class="body">
          <div class="title-row">
            <h3>${esc(item.name)}</h3>
            <span class="dot" title="Pure veg"></span>
            ${soldOut ? `<span class="badge badge-out">Sold out</span>` : ""}
            ${offer}
          </div>
          ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ""}
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
      const detail = e.target.closest("[data-detail]");
      if (detail) return openDetail(+detail.dataset.detail);
      const add = e.target.closest("[data-add]");
      if (add) return addSelected(+add.dataset.add);
      const inc = e.target.closest("[data-cinc]");
      if (inc) return stepCard(+inc.dataset.cinc, +1);
      const dec = e.target.closest("[data-cdec]");
      if (dec) return stepCard(+dec.dataset.cdec, -1);
      // Anything else on the card opens the full item sheet. Checked last so the
      // controls above keep working as one-tap actions rather than opening it.
      const card = e.target.closest("[data-card]");
      if (card) return openDetail(+card.dataset.card);
    });
  }

  /* The card shows a price range, not the selection, so a choice made in the
     sheet only has to refresh the Add/stepper control. */
  const renderCardBody = (item) => refreshSide(item);

  function addSelected(itemId) {
    if (!orderingEnabled) { toast("Online ordering is currently closed", "err"); return; }
    const item = itemById(itemId);
    if (!item) return;
    // Cheap guard against a card rendered before the owner marked it sold out.
    // The backend enforces this too; this is just to fail politely and early.
    const sel = selection(item);
    if (!itemAvailable(item) || !vAvailable(findVariant(item, sel.base, sel.size))) {
      toast(`${item.name} is sold out right now`, "err");
      return;
    }
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

  /* Keyed set of the lines the backend refused to price, so a cart row can show
     its own state instead of the customer having to match a footnote against a
     list. */
  const deadKeys = (q) => new Set((q && q.unavailable ? q.unavailable : [])
    .map((u) => `${u.item_id}|${u.base}|${u.size}`));

  /* Variants of the same item that are still sellable — the swap offer. Sorted
     cheapest first so the suggestion is never an unsolicited upsell. */
  function alternatives(itemId) {
    const item = itemById(itemId);
    if (!item || !itemAvailable(item)) return [];
    return (item.variants || []).filter(vAvailable).slice().sort((a, b) => a.price - b.price);
  }

  function renderCart(target) {
    if (!target) return;
    const { lines } = Store.get();
    if (!lines.length) {
      target.innerHTML = `<div class="empty" style="padding:var(--sp-5) 0;"><div class="emoji">🛒</div><p class="text-muted">Your cart is empty.<br/>Add something tasty!</p></div>`;
      return;
    }
    const q = lastQuote;
    const dead = deadKeys(q);
    const lineHTML = lines.map((l) => {
      const key = Store.lineKey(l);
      const qLine = q && q.lines.find((x) => x.item_id === l.item_id && x.base === l.base && x.size === l.size);
      const freeNote = qLine && qLine.free_quantity ? `<div class="free-note">🎉 ${qLine.free_quantity} free (B1G1)</div>` : "";
      const lineTotal = qLine ? qLine.line_total : l.unit_price * l.quantity;

      /* Sold out since it was added. The row states it, strikes the price it is
         not being charged, and carries the two things the customer would
         otherwise have to work out for themselves: drop it, or move to a variant
         that is still on. Without these the only route was to notice a footnote,
         find the right row, and tap − until it disappeared. */
      if (dead.has(key)) {
        const alts = alternatives(l.item_id).filter((v) => !(v.base === l.base && v.size === l.size));
        const swapBtn = alts.length
          ? `<button class="btn btn-sm btn-primary cl-act" data-swap="${key}" data-to="${esc(alts[0].base)}|${esc(alts[0].size)}">
               Switch to ${esc(alts[0].label || [alts[0].base, alts[0].size].filter(Boolean).join(" · "))} · ${money(alts[0].price)}
             </button>`
          : "";
        return `
          <div class="cart-line dead">
            <div class="cl-main">
              <div class="cl-name">${esc(l.name)} <span class="badge badge-out">Sold out</span></div>
              <div class="cl-variant">${esc(l.variant_label || "")}</div>
              <div class="cl-acts">
                ${swapBtn}
                <button class="btn btn-sm btn-outline cl-act" data-drop="${key}">Remove</button>
              </div>
            </div>
            <div class="cl-price struck">${money(l.unit_price * l.quantity)}</div>
          </div>`;
      }

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
    // A cart survives in localStorage for days; anything that sold out in the
    // meantime is priced out by the backend, so say so instead of letting the
    // total quietly disagree with the lines above it.
    // Only worth a bulk action once there are several: a single dead row already
    // states itself and carries its own Remove, so repeating it below just reads
    // as two ways to do the same thing.
    const gone = dead.size > 1
      ? `<div class="cart-gone">
           <span>${dead.size} items sold out and not charged.</span>
           <button class="btn btn-sm btn-outline" id="dropAllGone">Remove them</button>
         </div>`
      : "";
    target.innerHTML = `
      <div class="cart-items">${lineHTML}</div>
      ${gone}
      <div class="field" style="margin:0 0 var(--sp-3);">
        <div class="input-row">
          <input class="input" id="couponInput" placeholder="Coupon code" value="${esc(couponCode)}" />
          <button class="btn btn-outline" id="applyCoupon">Apply</button>
        </div>
      </div>
      <div class="cart-totals">${totals}</div>
      <button class="btn btn-primary btn-block btn-lg" id="goCheckout" style="margin-top:var(--sp-3);"
        ${orderingEnabled && !dead.size ? "" : "disabled"}>${
          !orderingEnabled ? "Ordering closed"
          : dead.size ? "Sort out sold-out items first"
          : "Proceed to checkout →"}</button>`;

    target.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", () => {
      Store.remove(b.dataset.drop);
      toast("Removed", "ok");
    }));
    target.querySelectorAll("[data-swap]").forEach((b) => b.addEventListener("click", () => {
      const [base, size] = b.dataset.to.split("|");
      const old = Store.get().lines.find((x) => Store.lineKey(x) === b.dataset.swap);
      const item = old && itemById(old.item_id);
      if (!item) return;
      const v = findVariant(item, base, size);
      Store.swap(b.dataset.swap, {
        item_id: item.id, name: item.name, base, size,
        variant_label: v ? v.label : "", unit_price: v ? v.price : item.base_price,
        quantity: old.quantity,
      });
      toast(`Switched to ${v ? v.label : "another option"}`, "ok");
    }));
    const dropAll = el("#dropAllGone", target);
    if (dropAll) dropAll.addEventListener("click", () => {
      Store.removeMany([...dead]);
      toast(dead.size === 1 ? "Removed" : "Sold-out items removed", "ok");
    });
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
