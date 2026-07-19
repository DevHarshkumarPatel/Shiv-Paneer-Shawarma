/* Owner menu admin: categories, items (+variants/prices), promos, coupons. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;

  let data = { categories: [], items: [], promos: [], coupons: [], areas: [] };
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
      const [cats, items, promos, coupons, areas] = await Promise.all([
        API.get("/api/admin/menu/categories"),
        API.get("/api/admin/menu/items"),
        API.get("/api/admin/menu/promos"),
        API.get("/api/coupons"),
        API.get("/api/admin/delivery-areas"),
      ]);
      data = { categories: cats.categories, items: items.items, promos: promos.promos, coupons: coupons.coupons, areas: areas.areas };
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
      </div>
      <div id="tabBody"></div>`;
    els("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
    ({ items: renderItems, categories: renderCategories, promos: renderPromos, coupons: renderCoupons, areas: renderAreas }[tab])();
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
  function renderItems() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Items & Prices", "Add item", null));
    const rows = data.items.map((i) => {
      const prices = i.variants.map((v) => v.price);
      const range = prices.length ? (Math.min(...prices) === Math.max(...prices) ? money(prices[0]) : `${money(Math.min(...prices))}–${money(Math.max(...prices))}`) : "—";
      return `<tr>
        <td><strong>${esc(i.name)}</strong>${i.tags.length ? `<br/><span class="text-sm text-muted">${esc(i.tags.join(", "))}</span>` : ""}</td>
        <td>${esc(catName(i.category_id))}</td>
        <td>${i.variants.length} variant(s)</td>
        <td>${range}</td>
        <td>${i.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${i.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${i.id}">Delete</button></td>
      </tr>`;
    }).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Item</th><th>Category</th><th>Variants</th><th>Price</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(6)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => itemForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => itemForm(data.items.find((i) => i.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/menu/items/${b.dataset.del}`, "Delete this item?")));
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
        sort_order: it.sort_order || 0,
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
        <td>${esc(p.scope)}: ${esc(p.scope === "item" ? itemName(p.target_id) : catName(p.target_id))}</td>
        <td>${esc(p.ptype)}${p.ptype !== "b2g1" ? ` (${p.value}${p.ptype === "percent" ? "%" : "₹"})` : ""}</td>
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
    const p = promo || { scope: "category", target_id: data.categories[0] && data.categories[0].id, ptype: "b2g1", value: 0, label: "", active: true };
    const targetOptions = (scope) => (scope === "item" ? data.items : data.categories)
      .map((x) => `<option value="${x.id}" ${x.id === p.target_id ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    const m = modal({
      title: promo ? "Edit promo" : "Add promo",
      bodyHTML: `
        <div class="input-row">
          <div class="field grow"><label>Scope</label><select class="select" id="fScope">
            <option value="category" ${p.scope === "category" ? "selected" : ""}>Whole category</option>
            <option value="item" ${p.scope === "item" ? "selected" : ""}>Single item</option></select></div>
          <div class="field grow"><label>Target</label><select class="select" id="fTarget">${targetOptions(p.scope)}</select></div>
        </div>
        <div class="input-row">
          <div class="field grow"><label>Type</label><select class="select" id="fType">
            <option value="b2g1" ${p.ptype === "b2g1" ? "selected" : ""}>Buy 2 Get 1 Free</option>
            <option value="percent" ${p.ptype === "percent" ? "selected" : ""}>Percent off</option>
            <option value="flat" ${p.ptype === "flat" ? "selected" : ""}>Flat ₹ off (per unit)</option></select></div>
          <div class="field grow" id="valWrap"><label>Value</label><input class="input" id="fValue" type="number" value="${p.value}" /></div>
        </div>
        <div class="field"><label>Label shown to customers</label><input class="input" id="fLabel" value="${esc(p.label)}" placeholder="Buy 2 Get 1 Free" /></div>
        <div class="field"><label>Active</label><select class="select" id="fActive"><option value="true" ${p.active ? "selected" : ""}>Active</option><option value="false" ${!p.active ? "selected" : ""}>Off</option></select></div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save promo</button>`,
    });
    const scopeSel = el("#fScope", m.backdrop);
    const typeSel = el("#fType", m.backdrop);
    const syncTarget = () => { el("#fTarget", m.backdrop).innerHTML = targetOptions(scopeSel.value); };
    const syncVal = () => { el("#valWrap", m.backdrop).style.display = typeSel.value === "b2g1" ? "none" : "block"; };
    scopeSel.addEventListener("change", syncTarget);
    typeSel.addEventListener("change", syncVal);
    syncVal();
    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const ptype = typeSel.value;
      const payload = {
        scope: scopeSel.value,
        target_id: +el("#fTarget", m.backdrop).value,
        ptype,
        value: ptype === "b2g1" ? 0 : (parseFloat(el("#fValue", m.backdrop).value) || 0),
        label: el("#fLabel", m.backdrop).value.trim() || (ptype === "b2g1" ? "Buy 2 Get 1 Free" : ""),
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
