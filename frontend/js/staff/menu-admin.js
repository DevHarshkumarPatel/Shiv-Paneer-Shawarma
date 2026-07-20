/* Owner menu admin: categories, items (+variants/prices), promos, coupons. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;

  let data = { categories: [], items: [], promos: [], coupons: [], areas: [], settings: { ordering_enabled: true } };
  let tab = "items";

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });
    if (user.role !== "owner") {
      el("#adminRoot").innerHTML = `<div class="empty"><div class="emoji">🔒</div><h3>Owner access only</h3>
        <p class="text-muted">Ask the owner to manage the menu and offers.</p><a class="btn btn-primary" href="orders.html">Go to orders</a></div>`;
      return;
    }
    await load();
  }

  const catName = (id) => (data.categories.find((c) => c.id === id) || {}).name || `#${id}`;
  const itemName = (id) => (data.items.find((i) => i.id === id) || {}).name || `#${id}`;

  async function load() {
    try {
      const [cats, items, promos, coupons, areas, settings] = await Promise.all([
        API.get("/api/admin/menu/categories"),
        API.get("/api/admin/menu/items"),
        API.get("/api/admin/menu/promos"),
        API.get("/api/coupons"),
        API.get("/api/admin/delivery-areas"),
        API.get("/api/admin/settings"),
      ]);
      data = { categories: cats.categories, items: items.items, promos: promos.promos, coupons: coupons.coupons, areas: areas.areas, settings };
      render();
    } catch (e) {
      if (e.status === 401) { location.href = "login.html"; return; }
      el("#adminRoot").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    }
  }

  function render() {
    const tabBtn = (id, label) => `<button class="chip ${tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`;
    el("#adminRoot").innerHTML = `
      <div class="section-tabs">
        ${tabBtn("items", "🌯 Items & Prices")}
        ${tabBtn("categories", "🗂️ Categories")}
        ${tabBtn("promos", "🎉 Promos")}
        ${tabBtn("coupons", "🏷️ Coupons")}
        ${tabBtn("areas", "🛵 Delivery Areas")}
        ${tabBtn("settings", "⚙️ Settings")}
      </div>
      <div id="tabBody"></div>`;
    els("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
    ({ items: renderItems, categories: renderCategories, promos: renderPromos, coupons: renderCoupons, areas: renderAreas, settings: renderSettings }[tab])();
  }

  function toolbar(title, addLabel, onAdd) {
    const wrap = document.createElement("div");
    wrap.className = "row-between";
    wrap.style.margin = "0 0 var(--sp-3)";
    wrap.innerHTML = `<h2 style="margin:0;">${esc(title)}</h2><button class="btn btn-primary" id="addBtn">＋ ${esc(addLabel)}</button>`;
    return wrap;
  }

  /* ---------------- Categories ---------------- */
  function renderCategories() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Categories", "Add category", null));
    const rows = data.categories.map((c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td>${c.offer_badge ? `<span class="badge badge-offer">${esc(c.offer_badge)}</span>` : "—"}</td>
        <td>${c.sort_order}</td>
        <td>${c.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${c.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${c.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Name</th><th>Offer badge</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(5)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => categoryForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => categoryForm(data.categories.find((c) => c.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/menu/categories/${b.dataset.del}`, "Delete this category?")));
  }

  function categoryForm(cat) {
    const c = cat || { name: "", offer_badge: "", sort_order: 0, active: true };
    const m = modal({
      title: cat ? "Edit category" : "Add category",
      bodyHTML: `
        <div class="field"><label>Name</label><input class="input" id="fName" value="${esc(c.name)}" /></div>
        <div class="field"><label>Offer badge (optional)</label><input class="input" id="fBadge" value="${esc(c.offer_badge)}" placeholder="e.g. Buy 2 Get 1" /></div>
        <div class="input-row">
          <div class="field grow"><label>Sort order</label><input class="input" id="fSort" type="number" value="${c.sort_order}" /></div>
          <div class="field grow"><label>Active</label><select class="select" id="fActive"><option value="true" ${c.active ? "selected" : ""}>Active</option><option value="false" ${!c.active ? "selected" : ""}>Hidden</option></select></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save category</button>`,
    });
    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const payload = {
        name: el("#fName", m.backdrop).value.trim(),
        offer_badge: el("#fBadge", m.backdrop).value.trim(),
        sort_order: +el("#fSort", m.backdrop).value || 0,
        active: el("#fActive", m.backdrop).value === "true",
      };
      if (!payload.name) return toast("Name is required", "err");
      await save(cat ? "put" : "post", cat ? `/api/admin/menu/categories/${cat.id}` : "/api/admin/menu/categories", payload, m);
    });
  }

  /* ---------------- Items ---------------- */
  function itemRow(i) {
    const prices = i.variants.map((v) => v.price);
    const range = prices.length ? (Math.min(...prices) === Math.max(...prices) ? money(prices[0]) : `${money(Math.min(...prices))}–${money(Math.max(...prices))}`) : "—";
    return `<tr draggable="true" data-id="${i.id}">
      <td class="drag-handle text-muted" title="Drag to reorder" style="cursor:grab;user-select:none;width:1%;">⠿</td>
      <td><strong>${esc(i.name)}</strong>${i.tags.length ? `<br/><span class="text-sm text-muted">${esc(i.tags.join(", "))}</span>` : ""}</td>
      <td>${i.variants.length} variant(s)</td>
      <td>${range}</td>
      <td>${i.active ? "✅" : "⛔"}</td>
      <td class="row"><button class="btn btn-sm btn-outline" data-edit="${i.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-del="${i.id}">Delete</button></td>
    </tr>`;
  }

  function renderItems() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Items & Prices", "Add item", null));
    body.insertAdjacentHTML("beforeend", `<p class="text-muted text-sm" style="margin:0 0 var(--sp-3);">Drag ⠿ to reorder items within a category — the order is saved automatically and used on the customer menu.</p>`);

    // One draggable table per category (ordering is within a category).
    const groups = data.categories.map((c) => ({ cat: c, items: data.items.filter((i) => i.category_id === c.id) }));
    const known = new Set(data.categories.map((c) => c.id));
    const orphans = data.items.filter((i) => !known.has(i.category_id));
    if (orphans.length) groups.push({ cat: { id: 0, name: "Uncategorized" }, items: orphans });

    if (!data.items.length) {
      body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><tbody>${emptyRow(6)}</tbody></table></div>`);
    }
    groups.forEach(({ cat, items }) => {
      if (!items.length) return;
      const rows = items.map(itemRow).join("");
      body.insertAdjacentHTML("beforeend", `
        <h3 style="margin:var(--sp-4) 0 var(--sp-2);">${esc(cat.name)}</h3>
        <div class="table-wrap"><table class="admin-table"><thead><tr><th></th><th>Item</th><th>Variants</th><th>Price</th><th>Active</th><th></th></tr></thead>
          <tbody data-cat="${cat.id}">${rows}</tbody></table></div>`);
    });

    el("#addBtn").addEventListener("click", () => itemForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => itemForm(data.items.find((i) => i.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/menu/items/${b.dataset.del}`, "Delete this item?")));
    els("tbody[data-cat]", body).forEach((tbody) => makeSortable(tbody, () => persistItemOrder(tbody)));
  }

  /* Drag-to-reorder rows within one <tbody>. Calls onReorder() only if the
     order actually changed. */
  function makeSortable(tbody, onReorder) {
    let dragEl = null;
    let before = [];
    const idsOf = (tb) => els("tr[data-id]", tb).map((r) => r.dataset.id);
    els("tr[data-id]", tbody).forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        dragEl = row; before = idsOf(tbody);
        row.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", row.dataset.id); } catch (_) {}
      });
      row.addEventListener("dragend", () => {
        if (!dragEl) return;
        dragEl.style.opacity = "";
        dragEl = null;
        if (idsOf(tbody).join(",") !== before.join(",")) onReorder();
      });
    });
    tbody.addEventListener("dragover", (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const after = dragAfterRow(tbody, e.clientY);
      if (after == null) tbody.appendChild(dragEl);
      else tbody.insertBefore(dragEl, after);
    });
  }

  function dragAfterRow(tbody, y) {
    let closest = null, closestOffset = Number.NEGATIVE_INFINITY;
    els("tr[data-id]", tbody).forEach((row) => {
      if (row.style.opacity === "0.4") return;   // skip the row being dragged
      const box = row.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = row; }
    });
    return closest;
  }

  async function persistItemOrder(tbody) {
    const order = els("tr[data-id]", tbody).map((r) => +r.dataset.id);
    try {
      await API.post("/api/admin/menu/items/reorder", { order });
      order.forEach((id, idx) => { const it = data.items.find((i) => i.id === id); if (it) it.sort_order = idx; });
      data.items.sort((a, b) => a.category_id - b.category_id || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      toast("Order saved", "ok");
    } catch (e) {
      toast(e.message, "err");
      renderItems();   // revert the DOM to the last known-good order
    }
  }

  // Category <option>s + a sentinel that opens the inline "new category" row.
  const NEW_CAT = "__new__";
  const catOptionsHTML = (selectedId) =>
    data.categories.map((c) => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${esc(c.name)}</option>`).join("") +
    `<option value="${NEW_CAT}">＋ New category…</option>`;

  function itemForm(item) {
    const it = item || { name: "", category_id: data.categories[0] && data.categories[0].id, subcategory_id: 0, description: "", tags: [], veg: true, active: true, sort_order: 0, variants: [{ base: "", size: "", price: 0 }] };
    const m = modal({
      title: item ? "Edit item" : "Add item",
      bodyHTML: `
        <div class="field"><label>Name</label><input class="input" id="fName" value="${esc(it.name)}" /></div>
        <div class="input-row">
          <div class="field grow"><label>Category</label><select class="select" id="fCat">${catOptionsHTML(it.category_id)}</select></div>
          <div class="field grow"><label>Active</label><select class="select" id="fActive"><option value="true" ${it.active ? "selected" : ""}>Active</option><option value="false" ${!it.active ? "selected" : ""}>Hidden</option></select></div>
        </div>
        <div class="field" id="newCatWrap" style="display:none;">
          <label>New category name</label>
          <div class="input-row">
            <input class="input grow" id="fNewCat" placeholder="e.g. Rolls" />
            <input class="input" id="fNewCatBadge" placeholder="Offer badge (optional)" />
            <button class="btn btn-outline" id="createCatBtn" type="button">Create</button>
          </div>
        </div>
        <div class="field"><label>Description (optional)</label><input class="input" id="fDesc" value="${esc(it.description)}" /></div>
        <div class="field"><label>Tags (comma separated)</label><input class="input" id="fTags" value="${esc(it.tags.join(", "))}" placeholder="Whole Wheat, Millets" /></div>
        <div class="opt-label">Variants &amp; prices</div>
        <div id="variantRows"></div>
        <button class="btn btn-sm btn-outline" id="addVar" type="button" style="margin-top:8px;">＋ Add variant</button>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save item</button>`,
    });

    // Inline "add category" from the item form's dropdown — no need to leave for the Categories tab.
    const catSel = el("#fCat", m.backdrop);
    const newCatWrap = el("#newCatWrap", m.backdrop);
    let prevCat = catSel.value;   // remembered so we can restore if creation is cancelled
    catSel.addEventListener("change", () => {
      if (catSel.value === NEW_CAT) {
        newCatWrap.style.display = "block";
        el("#fNewCat", m.backdrop).focus();
      } else {
        newCatWrap.style.display = "none";
        prevCat = catSel.value;
      }
    });
    if (catSel.value === NEW_CAT) newCatWrap.style.display = "block";   // no categories exist yet
    el("#createCatBtn", m.backdrop).addEventListener("click", async () => {
      const name = el("#fNewCat", m.backdrop).value.trim();
      if (!name) return toast("Category name is required", "err");
      try {
        const cat = await API.post("/api/admin/menu/categories", {
          name,
          offer_badge: el("#fNewCatBadge", m.backdrop).value.trim(),
          sort_order: data.categories.length,
          active: true,
        });
        data.categories.push(cat);
        catSel.innerHTML = catOptionsHTML(cat.id);   // rebuild so the new one is selectable + selected
        prevCat = String(cat.id);
        newCatWrap.style.display = "none";
        el("#fNewCat", m.backdrop).value = "";
        el("#fNewCatBadge", m.backdrop).value = "";
        toast("Category added", "ok");
      } catch (e) { toast(e.message, "err"); }
    });

    const rowsWrap = el("#variantRows", m.backdrop);
    const addRow = (v = { base: "", size: "", price: "" }) => {
      const row = document.createElement("div");
      row.className = "input-row"; row.style.marginBottom = "8px";
      row.innerHTML = `
        <input class="input v-base" placeholder="Base (e.g. Millets)" value="${esc(v.base)}" />
        <input class="input v-size" placeholder="Size (e.g. Regular)" value="${esc(v.size)}" />
        <input class="input v-price" type="number" step="1" placeholder="₹" value="${v.price === "" ? "" : v.price}" style="max-width:90px;" />
        <button class="icon-btn v-del" type="button" title="Remove">×</button>`;
      row.querySelector(".v-del").addEventListener("click", () => row.remove());
      rowsWrap.appendChild(row);
    };
    (it.variants.length ? it.variants : [{ base: "", size: "", price: "" }]).forEach(addRow);
    el("#addVar", m.backdrop).addEventListener("click", () => addRow());

    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const variants = els(".input-row", rowsWrap).map((r) => ({
        base: r.querySelector(".v-base").value.trim(),
        size: r.querySelector(".v-size").value.trim(),
        price: parseFloat(r.querySelector(".v-price").value),
      })).filter((v) => !Number.isNaN(v.price));
      if (!variants.length) return toast("Add at least one variant with a price", "err");
      if (el("#fCat", m.backdrop).value === NEW_CAT) return toast("Create the new category first, or pick an existing one", "err");
      const payload = {
        name: el("#fName", m.backdrop).value.trim(),
        category_id: +el("#fCat", m.backdrop).value,
        subcategory_id: it.subcategory_id || 0,
        description: el("#fDesc", m.backdrop).value.trim(),
        tags: el("#fTags", m.backdrop).value.split(",").map((s) => s.trim()).filter(Boolean),
        veg: true,
        active: el("#fActive", m.backdrop).value === "true",
        // New items append to the end of their category; edits keep their place. Reorder via drag.
        sort_order: item ? it.sort_order : data.items.filter((i) => i.category_id === +el("#fCat", m.backdrop).value).length,
        variants,
      };
      if (!payload.name) return toast("Name is required", "err");
      await save(item ? "put" : "post", item ? `/api/admin/menu/items/${item.id}` : "/api/admin/menu/items", payload, m);
    });
  }

  /* ---------------- Promos ---------------- */
  function renderPromos() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Promos", "Add promo", null));
    const rows = data.promos.map((p) => `
      <tr>
        <td>${esc(p.label || "—")}</td>
        <td>${esc(p.scope)}: ${esc(((p.target_ids && p.target_ids.length ? p.target_ids : [p.target_id]).map((id) => p.scope === "item" ? itemName(id) : catName(id)).join(", ")))}</td>
        <td>${esc(p.ptype)}${p.ptype === "percent" || p.ptype === "flat" ? ` (${p.value}${p.ptype === "percent" ? "%" : "₹"})` : ""}</td>
        <td>${p.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${p.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Label</th><th>Applies to</th><th>Type</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(5)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => promoForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => promoForm(data.promos.find((p) => p.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/menu/promos/${b.dataset.del}`, "Delete this promo?")));
  }

  function promoForm(promo) {
    const p = promo || { scope: "category", target_ids: [data.categories[0] && data.categories[0].id].filter((x) => x != null), ptype: "b2g1", value: 0, label: "", active: true };
    const selectedTargets = new Set((p.target_ids && p.target_ids.length ? p.target_ids : [p.target_id]).filter((x) => x != null));
    const m = modal({
      title: promo ? "Edit promo" : "Add promo",
      bodyHTML: `
        <div class="input-row">
          <div class="field grow"><label>Scope</label><select class="select" id="fScope">
            <option value="category" ${p.scope === "category" ? "selected" : ""}>Whole category</option>
            <option value="item" ${p.scope === "item" ? "selected" : ""}>Single item</option></select></div>
          <div class="field grow"><label id="fTargetLabel">Categories</label>
            <div class="ms" id="fTargetMs">
              <button type="button" class="select ms-toggle" id="fTargetToggle"><span class="ms-summary placeholder" id="fTargetSummary">Choose…</span><span class="ms-caret">▾</span></button>
              <div class="ms-panel" id="fTargetPanel" hidden>
                <div class="ms-bar"><span id="fTargetCount">0 selected</span><span class="ms-actions"><button type="button" id="fTargetAll">Select all</button> · <button type="button" id="fTargetNone">Clear</button></span></div>
                <div id="fTargetOpts"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="input-row">
          <div class="field grow"><label>Type</label><select class="select" id="fType">
            <option value="b2g1" ${p.ptype === "b2g1" ? "selected" : ""}>Buy 2 Get 1 Free</option>
            <option value="b1g1" ${p.ptype === "b1g1" ? "selected" : ""}>Buy 1 Get 1 Free</option>
            <option value="percent" ${p.ptype === "percent" ? "selected" : ""}>Percent off</option>
            <option value="flat" ${p.ptype === "flat" ? "selected" : ""}>Flat ₹ off (per unit)</option></select></div>
          <div class="field grow" id="valWrap"><label>Value</label><input class="input" id="fValue" type="number" value="${p.value}" /></div>
        </div>
        <p class="text-muted text-sm" id="b1g1Hint" style="display:none;">Buy 1 Get 1 applies to the items in every category/item you select. Eligible items are pooled together and, for every 2 of them in a cart, the cheaper one is free. Select all categories to run it store-wide.</p>
        <div class="field"><label>Label shown to customers</label><input class="input" id="fLabel" value="${esc(p.label)}" placeholder="Buy 2 Get 1 Free" /></div>
        <div class="field"><label>Active</label><select class="select" id="fActive"><option value="true" ${p.active ? "selected" : ""}>Active</option><option value="false" ${!p.active ? "selected" : ""}>Off</option></select></div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save promo</button>`,
    });
    const scopeSel = el("#fScope", m.backdrop);
    const typeSel = el("#fType", m.backdrop);

    /* ----- checkbox multi-select for targets ----- */
    const targetList = () => (scopeSel.value === "item" ? data.items : data.categories);
    const renderTargetOpts = () => {
      el("#fTargetOpts", m.backdrop).innerHTML = targetList().map((x) =>
        `<label class="ms-opt"><input type="checkbox" value="${x.id}" ${selectedTargets.has(x.id) ? "checked" : ""}/> <span>${esc(x.name)}</span></label>`).join("")
        || `<div class="ms-opt text-muted">Nothing to select yet.</div>`;
      els("#fTargetOpts input[type=checkbox]", m.backdrop).forEach((cb) =>
        cb.addEventListener("change", () => { cb.checked ? selectedTargets.add(+cb.value) : selectedTargets.delete(+cb.value); updateTargetSummary(); }));
    };
    const updateTargetSummary = () => {
      const names = targetList().filter((x) => selectedTargets.has(x.id)).map((x) => x.name);
      const sum = el("#fTargetSummary", m.backdrop);
      sum.textContent = names.length ? (names.length <= 2 ? names.join(", ") : `${names.length} selected`) : "Choose…";
      sum.classList.toggle("placeholder", !names.length);
      el("#fTargetCount", m.backdrop).textContent = `${names.length} selected`;
    };
    el("#fTargetToggle", m.backdrop).addEventListener("click", () => {
      const ms = el("#fTargetMs", m.backdrop), panel = el("#fTargetPanel", m.backdrop);
      const open = panel.hidden;
      panel.hidden = !open; ms.classList.toggle("open", open);
    });
    el("#fTargetAll", m.backdrop).addEventListener("click", () => { targetList().forEach((x) => selectedTargets.add(x.id)); renderTargetOpts(); updateTargetSummary(); });
    el("#fTargetNone", m.backdrop).addEventListener("click", () => { selectedTargets.clear(); renderTargetOpts(); updateTargetSummary(); });

    const syncTarget = () => {
      selectedTargets.clear();   // category ids and item ids aren't interchangeable
      el("#fTargetLabel", m.backdrop).textContent = scopeSel.value === "item" ? "Items" : "Categories";
      renderTargetOpts(); updateTargetSummary();
    };
    const noValueType = (t) => t === "b2g1" || t === "b1g1";
    const syncVal = () => {
      el("#valWrap", m.backdrop).style.display = noValueType(typeSel.value) ? "none" : "block";
      el("#b1g1Hint", m.backdrop).style.display = typeSel.value === "b1g1" ? "block" : "none";
    };
    scopeSel.addEventListener("change", syncTarget);
    typeSel.addEventListener("change", syncVal);
    renderTargetOpts(); updateTargetSummary();
    syncVal();
    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const ptype = typeSel.value;
      const targetIds = [...selectedTargets];
      if (!targetIds.length) return toast(`Pick at least one ${scopeSel.value === "item" ? "item" : "category"}`, "err");
      const payload = {
        scope: scopeSel.value,
        target_ids: targetIds,
        ptype,
        value: noValueType(ptype) ? 0 : (parseFloat(el("#fValue", m.backdrop).value) || 0),
        label: el("#fLabel", m.backdrop).value.trim() || (ptype === "b2g1" ? "Buy 2 Get 1 Free" : ptype === "b1g1" ? "Buy 1 Get 1 Free" : ""),
        active: el("#fActive", m.backdrop).value === "true",
      };
      await save(promo ? "put" : "post", promo ? `/api/admin/menu/promos/${promo.id}` : "/api/admin/menu/promos", payload, m);
    });
  }

  /* ---------------- Coupons ---------------- */
  function renderCoupons() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Coupons", "Add coupon", null));
    const rows = data.coupons.map((c) => `
      <tr>
        <td><strong>${esc(c.code)}</strong></td>
        <td>${c.ctype === "percent" ? `${c.value}%` : money(c.value)}${c.max_discount ? ` (max ${money(c.max_discount)})` : ""}</td>
        <td>${c.min_order ? `≥ ${money(c.min_order)}` : "—"}</td>
        <td>${c.used_count}${c.usage_limit ? ` / ${c.usage_limit}` : ""}</td>
        <td>${c.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${c.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${c.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Code</th><th>Discount</th><th>Min order</th><th>Used</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(6)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => couponForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => couponForm(data.coupons.find((c) => c.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/coupons/${b.dataset.del}`, "Delete this coupon?")));
  }

  function couponForm(coupon) {
    const c = coupon || { code: "", ctype: "percent", value: 10, min_order: 0, max_discount: 0, usage_limit: 0, active: true };
    const m = modal({
      title: coupon ? "Edit coupon" : "Add coupon",
      bodyHTML: `
        <div class="field"><label>Code</label><input class="input" id="fCode" value="${esc(c.code)}" style="text-transform:uppercase;" placeholder="SHIV10" /></div>
        <div class="input-row">
          <div class="field grow"><label>Type</label><select class="select" id="fType"><option value="percent" ${c.ctype === "percent" ? "selected" : ""}>Percent</option><option value="flat" ${c.ctype === "flat" ? "selected" : ""}>Flat ₹</option></select></div>
          <div class="field grow"><label>Value</label><input class="input" id="fValue" type="number" value="${c.value}" /></div>
        </div>
        <div class="input-row">
          <div class="field grow"><label>Min order (₹)</label><input class="input" id="fMin" type="number" value="${c.min_order}" /></div>
          <div class="field grow"><label>Max discount (₹, 0=none)</label><input class="input" id="fMax" type="number" value="${c.max_discount}" /></div>
        </div>
        <div class="input-row">
          <div class="field grow"><label>Usage limit (0=∞)</label><input class="input" id="fLimit" type="number" value="${c.usage_limit}" /></div>
          <div class="field grow"><label>Active</label><select class="select" id="fActive"><option value="true" ${c.active ? "selected" : ""}>Active</option><option value="false" ${!c.active ? "selected" : ""}>Off</option></select></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save coupon</button>`,
    });
    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const payload = {
        code: el("#fCode", m.backdrop).value.trim().toUpperCase(),
        ctype: el("#fType", m.backdrop).value,
        value: parseFloat(el("#fValue", m.backdrop).value) || 0,
        min_order: parseFloat(el("#fMin", m.backdrop).value) || 0,
        max_discount: parseFloat(el("#fMax", m.backdrop).value) || 0,
        usage_limit: parseInt(el("#fLimit", m.backdrop).value) || 0,
        active: el("#fActive", m.backdrop).value === "true",
      };
      if (!payload.code) return toast("Code is required", "err");
      await save(coupon ? "put" : "post", coupon ? `/api/coupons/${coupon.id}` : "/api/coupons", payload, m);
    });
  }

  /* ---------------- Delivery Areas ---------------- */
  function renderAreas() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Delivery Areas", "Add area", null));
    const rows = data.areas.map((a) => `
      <tr>
        <td><strong>${esc(a.name)}</strong></td>
        <td>${money(a.fee)}</td>
        <td>${a.sort_order}</td>
        <td>${a.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${a.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${a.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Area</th><th>Delivery fee</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(5)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => areaForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => areaForm(data.areas.find((a) => a.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/delivery-areas/${b.dataset.del}`, "Delete this delivery area?")));
  }

  function areaForm(area) {
    const a = area || { name: "", fee: 0, sort_order: 0, active: true };
    const m = modal({
      title: area ? "Edit delivery area" : "Add delivery area",
      bodyHTML: `
        <div class="field"><label>Area name</label><input class="input" id="fName" value="${esc(a.name)}" placeholder="e.g. Near (0-3 km)" /></div>
        <div class="input-row">
          <div class="field grow"><label>Delivery fee (₹)</label><input class="input" id="fFee" type="number" min="0" step="1" value="${a.fee}" /></div>
          <div class="field grow"><label>Sort order</label><input class="input" id="fSort" type="number" value="${a.sort_order}" /></div>
        </div>
        <div class="field"><label>Active</label><select class="select" id="fActive"><option value="true" ${a.active ? "selected" : ""}>Active</option><option value="false" ${!a.active ? "selected" : ""}>Hidden</option></select></div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save area</button>`,
    });
    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const payload = {
        name: el("#fName", m.backdrop).value.trim(),
        fee: parseFloat(el("#fFee", m.backdrop).value) || 0,
        sort_order: parseInt(el("#fSort", m.backdrop).value) || 0,
        active: el("#fActive", m.backdrop).value === "true",
      };
      if (!payload.name) return toast("Area name is required", "err");
      if (payload.fee < 0) return toast("Fee cannot be negative", "err");
      await save(area ? "put" : "post", area ? `/api/admin/delivery-areas/${area.id}` : "/api/admin/delivery-areas", payload, m);
    });
  }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    const body = el("#tabBody");
    const on = !!data.settings.ordering_enabled;
    body.innerHTML = `
      <h2 style="margin:0 0 var(--sp-3);">Settings</h2>
      <div class="card"><div class="card-pad">
        <div class="row-between" style="gap:var(--sp-4);flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">Accept customer orders</div>
            <p class="text-muted text-sm" style="margin:4px 0 0;max-width:46ch;">
              When this is on, customers can place orders from the customer site.
              Turn it off to temporarily stop taking new orders (the menu stays visible).</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="orderingToggle" ${on ? "checked" : ""} />
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div class="text-sm ${on ? "" : "text-muted"}" id="orderingState" style="margin-top:var(--sp-3);">
          ${on ? "🟢 Ordering is <strong>open</strong> — customers can place orders." : "🔴 Ordering is <strong>closed</strong> — customers cannot place orders."}
        </div>
      </div></div>`;
    el("#orderingToggle").addEventListener("change", async (e) => {
      const enabled = e.target.checked;
      e.target.disabled = true;
      try {
        data.settings = await API.put("/api/admin/settings", { ordering_enabled: enabled });
        toast(enabled ? "Ordering turned on" : "Ordering turned off", "ok");
      } catch (err) {
        toast(err.message, "err");
        e.target.checked = !enabled;   // revert on failure
      } finally {
        e.target.disabled = false;
        renderSettings();
      }
    });
  }

  /* ---------------- shared ---------------- */
  const emptyRow = (cols) => `<tr><td colspan="${cols}" class="text-center text-muted" style="padding:var(--sp-5);">Nothing here yet.</td></tr>`;

  async function save(method, path, payload, m) {
    try {
      await API[method === "put" ? "put" : "post"](path, payload);
      toast("Saved", "ok");
      m.close();
      await load();
    } catch (e) { toast(e.message, "err"); }
  }

  async function del(path, confirmMsg) {
    if (!confirm(confirmMsg)) return;
    try { await API.del(path); toast("Deleted", "ok"); await load(); }
    catch (e) { toast(e.message, "err"); }
  }
})();
