/* Menu page: load menu, render categories/cards, item modal, cart + live quote. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;
  let MENU = null;
  let quoteTimer = null;
  let lastQuote = null;
  let couponCode = Store.get().coupon || "";

  const MODE_HINTS = {
    dine_in: "Eat at the outlet — no extra charge.",
    takeaway: "Pick up yourself — no extra charge.",
    delivery: "Delivered to your door — delivery fee applies, pay online.",
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindMode();
    bindStatic();
    Store.subscribe(onCartChange);
    try {
      const cfg = await API.get("/api/config");
      window.SPS_CONFIG.runtime = cfg || {};
    } catch { /* non-fatal */ }
    await loadMenu();
    syncMode();
    onCartChange();
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
      if (node) window.scrollTo({ top: node.offsetTop - 128, behavior: "smooth" });
    }));
  }

  function variantShape(item) {
    const bases = [...new Set(item.variants.map((v) => v.base).filter(Boolean))];
    const sizes = [...new Set(item.variants.map((v) => v.size).filter(Boolean))];
    return { bases, sizes };
  }
  const findVariant = (item, base, size) =>
    item.variants.find((v) => v.base === base && v.size === size) || item.variants[0];

  function priceBlock(item) {
    const { bases, sizes } = variantShape(item);
    if (bases.length && sizes.length) {
      const head = sizes.map((s) => `<th>${esc(s)}</th>`).join("");
      const rows = bases.map((b) => {
        const cells = sizes.map((s) => {
          const v = findVariant(item, b, s);
          return `<td>${v ? money(v.price) : "—"}</td>`;
        }).join("");
        return `<tr><th>${esc(b)}</th>${cells}</tr>`;
      }).join("");
      return `<table class="price-grid"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    if (sizes.length) {
      const head = sizes.map((s) => `<th>${esc(s)}</th>`).join("");
      const cells = sizes.map((s) => `<td>${money(findVariant(item, "", s).price)}</td>`).join("");
      return `<table class="price-grid"><thead><tr>${head}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
    }
    return `<div class="price-single">${money(item.base_price)}</div>`;
  }

  function itemCard(item, catBadge) {
    const offer = item.promo ? `<span class="badge badge-offer offer-tag">${esc(item.promo.label || "Offer")}</span>` : "";
    const tags = (item.tags || []).map((t) => `<span class="badge badge-soft">${esc(t)}</span>`).join("");
    const img = item.image_url
      ? `<img src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy" />`
      : `<div class="noimg">🌯</div>`;
    return `
      <article class="card item-card" id="item-${item.id}">
        <div class="thumb">${img}${offer}</div>
        <div class="body">
          <div class="title-row">
            <h3>${esc(item.name)}</h3>
            <span class="dot" title="Pure veg"></span>
          </div>
          ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ""}
          ${tags ? `<div class="tags">${tags}</div>` : ""}
          ${priceBlock(item)}
          <button class="btn btn-primary add-btn" data-add="${item.id}">＋ Choose &amp; Add</button>
        </div>
      </article>`;
  }

  function renderMenu() {
    if (!MENU.categories.length) {
      el("#menuContent").innerHTML = `<div class="empty"><div class="emoji">🍽️</div><h3>Menu coming soon</h3></div>`;
      return;
    }
    const html = MENU.categories.map((cat) => {
      const allItems = [...(cat.items || []), ...(cat.subcategories || []).flatMap((s) => s.items)];
      const cards = allItems.map((it) => itemCard(it, cat.offer_badge)).join("");
      const banner = cat.offer_badge ? `<div class="offer-banner">🎉 ${esc(cat.offer_badge)} Free on same item — ${esc(cat.name)} offer!</div>` : "";
      return `
        <section class="cat-block" id="cat-${cat.id}">
          <div class="cat-head"><h2>${esc(cat.name)}</h2>
            ${cat.offer_badge ? `<span class="badge badge-offer">${esc(cat.offer_badge)}</span>` : ""}</div>
          ${banner}
          <div class="item-grid">${cards}</div>
        </section>`;
    }).join("");
    el("#menuContent").innerHTML = html;
    els("[data-add]").forEach((btn) => btn.addEventListener("click", () => openItemModal(+btn.dataset.add)));
  }

  /* ---------- item modal ---------- */
  function allItemsFlat() {
    return MENU.categories.flatMap((c) => [...(c.items || []), ...(c.subcategories || []).flatMap((s) => s.items)]);
  }

  function openItemModal(itemId) {
    const item = allItemsFlat().find((i) => i.id === itemId);
    if (!item) return;
    const { bases, sizes } = variantShape(item);
    let selBase = bases[0] || "";
    let selSize = sizes[0] || "";
    let qty = 1;

    const baseSection = bases.length ? `
      <div class="opt-label">Choose base</div>
      <div class="opt-grid" data-group="base">
        ${bases.map((b) => `<button class="opt ${b === selBase ? "active" : ""}" data-val="${esc(b)}">${esc(b)}</button>`).join("")}
      </div>` : "";
    const sizeSection = sizes.length ? `
      <div class="opt-label">Choose size</div>
      <div class="opt-grid" data-group="size">
        ${sizes.map((s) => `<button class="opt ${s === selSize ? "active" : ""}" data-val="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>` : "";
    const promoNote = item.promo ? `<div class="badge badge-offer" style="margin-bottom:8px;">${esc(item.promo.label)}</div>` : "";

    const m = modal({
      title: item.name,
      bodyHTML: `
        ${promoNote}
        ${baseSection}${sizeSection}
        <div class="opt-label">Quantity</div>
        <div class="row-between">
          <div class="stepper" data-qty>
            <button data-step="-1" aria-label="Decrease">−</button><span id="qtyVal">1</span><button data-step="1" aria-label="Increase">＋</button>
          </div>
          <div class="price-single" id="modalPrice"></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block btn-lg" id="addToCart">Add to cart</button>`,
    });

    const refresh = () => {
      const v = findVariant(item, selBase, selSize);
      el("#modalPrice", m.backdrop).textContent = money((v ? v.price : item.base_price) * qty);
      el("#qtyVal", m.backdrop).textContent = qty;
    };
    m.backdrop.querySelectorAll("[data-group] .opt").forEach((b) => b.addEventListener("click", () => {
      const group = b.closest("[data-group]").dataset.group;
      b.parentNode.querySelectorAll(".opt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      if (group === "base") selBase = b.dataset.val; else selSize = b.dataset.val;
      refresh();
    }));
    m.backdrop.querySelectorAll("[data-qty] [data-step]").forEach((b) => b.addEventListener("click", () => {
      qty = Math.max(1, qty + Number(b.dataset.step)); refresh();
    }));
    el("#addToCart", m.backdrop).addEventListener("click", () => {
      const v = findVariant(item, selBase, selSize);
      Store.add({
        item_id: item.id, name: item.name, base: selBase, size: selSize,
        variant_label: v ? v.label : "", unit_price: v ? v.price : item.base_price, quantity: qty,
      });
      toast(`${qty} × ${item.name} added`, "ok");
      m.close();
    });
    refresh();
  }

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
      <button class="btn btn-primary btn-block btn-lg" id="goCheckout" style="margin-top:var(--sp-3);">Proceed to checkout →</button>`;

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
