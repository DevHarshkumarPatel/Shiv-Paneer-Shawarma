/* Owner menu admin: categories, items (+variants/prices), promos, coupons. */
(function () {
  const { money, esc, el, els, toast, modal } = UI;

  let data = {
    categories: [], items: [], promos: [], coupons: [], areas: [],
    settings: { ordering_enabled: true, scratch_enabled: false },
    scratch: { prizes: [], enabled: false, live: false },
    awards: { awards: [], stats: {} },
  };
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
      const [cats, items, promos, coupons, areas, settings, scratch, awards] = await Promise.all([
        API.get("/api/admin/menu/categories"),
        API.get("/api/admin/menu/items"),
        API.get("/api/admin/menu/promos"),
        API.get("/api/coupons"),
        API.get("/api/admin/delivery-areas"),
        API.get("/api/admin/settings"),
        API.get("/api/admin/scratch/prizes"),
        API.get("/api/admin/scratch/awards"),
      ]);
      data = {
        categories: cats.categories, items: items.items, promos: promos.promos,
        coupons: coupons.coupons, areas: areas.areas, settings, scratch, awards,
      };
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
        ${tabBtn("scratch", "🎁 Scratch Cards")}
        ${tabBtn("areas", "🛵 Delivery Areas")}
        ${tabBtn("export", "📄 Export")}
        ${tabBtn("settings", "⚙️ Settings")}
      </div>
      <div id="tabBody"></div>`;
    els("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
    ({ items: renderItems, categories: renderCategories, promos: renderPromos, coupons: renderCoupons, scratch: renderScratch, areas: renderAreas, export: renderExport, settings: renderSettings }[tab])();
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
        <!-- Legacy free-text badge. The customer menu no longer reads it: the
             badge on a category heading now comes from the live promo, so it
             cannot outlive the offer it advertises. -->
        <div class="field"><label>Offer badge (internal note — not shown on the site)</label><input class="input" id="fBadge" value="${esc(c.offer_badge)}" placeholder="e.g. Buy 2 Get 1" />
          <p class="text-muted text-sm">Offers shown to customers come from the <strong>Promos</strong> tab.</p></div>
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
    // How many variants are actually sellable — the number the kitchen cares
    // about mid-service, not just whether the item exists.
    const offCount = i.variants.filter((v) => v.available === false).length;
    const soldOut = i.available === false;
    const stock = soldOut
      ? `<span class="pill-out">Sold out</span>`
      : offCount
        ? `<span class="pill-part">${i.variants.length - offCount}/${i.variants.length} in stock</span>`
        : `<span class="pill-in">In stock</span>`;
    return `<tr draggable="true" data-id="${i.id}">
      <td class="drag-handle text-muted" title="Drag to reorder" style="cursor:grab;user-select:none;width:1%;">⠿</td>
      <td style="width:1%;">${i.image_url
        ? `<img class="row-thumb" src="${esc(API.assetUrl(i.image_url))}" alt="" loading="lazy" />`
        : `<span class="row-thumb row-thumb-empty" title="No photo">＋</span>`}</td>
      <td><strong>${esc(i.name)}</strong>${i.tags.length ? `<br/><span class="text-sm text-muted">${esc(i.tags.join(", "))}</span>` : ""}</td>
      <td>${i.variants.length} variant(s)</td>
      <td>${range}</td>
      <td>${i.active ? "✅" : "⛔"}</td>
      <td>${stock}</td>
      <td class="row"><button class="btn btn-sm ${soldOut ? "btn-primary" : "btn-outline"}" data-stock="${i.id}"
            title="Toggle sold out for the whole item">${soldOut ? "Back in stock" : "Sold out"}</button>
        <button class="btn btn-sm btn-outline" data-edit="${i.id}">Edit</button>
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
      body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><tbody>${emptyRow(8)}</tbody></table></div>`);
    }
    groups.forEach(({ cat, items }) => {
      if (!items.length) return;
      const rows = items.map(itemRow).join("");
      body.insertAdjacentHTML("beforeend", `
        <h3 style="margin:var(--sp-4) 0 var(--sp-2);">${esc(cat.name)}</h3>
        <div class="table-wrap"><table class="admin-table"><thead><tr><th></th><th></th><th>Item</th><th>Variants</th><th>Price</th><th>Active</th><th>Stock</th><th></th></tr></thead>
          <tbody data-cat="${cat.id}">${rows}</tbody></table></div>`);
    });

    el("#addBtn").addEventListener("click", () => itemForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => itemForm(data.items.find((i) => i.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/menu/items/${b.dataset.del}`, "Delete this item?")));
    // Quick sold-out switch. PATCHes only the flag, so it can never overwrite a
    // price with whatever this page last loaded.
    els("[data-stock]", body).forEach((b) => b.addEventListener("click", async () => {
      const it = data.items.find((x) => x.id == b.dataset.stock);
      if (!it) return;
      b.disabled = true;
      try {
        const updated = await API.patch(`/api/admin/menu/items/${it.id}/availability`,
                                        { available: it.available === false });
        Object.assign(it, updated);
        toast(`${it.name} is ${it.available === false ? "sold out" : "back in stock"}`, "ok");
        renderItems();
      } catch (e) { toast(e.message, "err"); b.disabled = false; }
    }));
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
    const it = item || { name: "", category_id: data.categories[0] && data.categories[0].id, subcategory_id: 0, description: "", tags: [], veg: true, active: true, available: true, sort_order: 0, variants: [{ base: "", size: "", price: 0 }] };
    const m = modal({
      title: item ? "Edit item" : "Add item",
      bodyHTML: `
        <div class="field"><label>Name</label><input class="input" id="fName" value="${esc(it.name)}" /></div>
        <div class="input-row">
          <div class="field grow"><label>Category</label><select class="select" id="fCat">${catOptionsHTML(it.category_id)}</select></div>
          <div class="field grow"><label>Active</label><select class="select" id="fActive"><option value="true" ${it.active ? "selected" : ""}>Active</option><option value="false" ${!it.active ? "selected" : ""}>Hidden</option></select></div>
          <div class="field grow"><label>Stock</label><select class="select" id="fAvail"><option value="true" ${it.available !== false ? "selected" : ""}>In stock</option><option value="false" ${it.available === false ? "selected" : ""}>Sold out</option></select></div>
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
        <div class="opt-label">Photo</div>
        <div class="img-field">
          <div class="img-preview" id="imgPreview">${it.image_url
            ? `<img src="${esc(API.assetUrl(it.image_url))}" alt="" />`
            : `<span class="img-empty">No photo</span>`}</div>
          <div class="img-actions">
            <!-- capture lets a phone open the camera straight away, which is how
                 a photo of today's plate actually gets taken. -->
            <input type="file" id="fImg" accept="image/jpeg,image/png,image/webp" capture="environment" hidden />
            <button class="btn btn-sm btn-outline" id="pickImg" type="button">${it.image_url ? "Replace photo" : "Upload photo"}</button>
            <button class="btn btn-sm btn-danger ${it.image_url ? "" : "hidden"}" id="rmImg" type="button">Remove</button>
            <p class="text-muted text-sm" style="margin:6px 0 0;">${item
              ? "Any JPEG or PNG. Resized and saved as soon as you pick it."
              : "Save the item first, then add its photo."}</p>
          </div>
        </div>
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
    const addRow = (v = { base: "", size: "", price: "", available: true }) => {
      const row = document.createElement("div");
      row.className = "input-row"; row.style.marginBottom = "8px";
      // The stock toggle is per variant, not just per item: millets can run out
      // while wheat is still on, and that is the common case mid-service.
      const off = v.available === false;
      row.innerHTML = `
        <input class="input v-base" placeholder="Base (e.g. Millets)" value="${esc(v.base)}" />
        <input class="input v-size" placeholder="Size (e.g. Regular)" value="${esc(v.size)}" />
        <input class="input v-price" type="number" step="1" placeholder="₹" value="${v.price === "" ? "" : v.price}" style="max-width:90px;" />
        <button class="btn btn-sm ${off ? "btn-danger" : "btn-outline"} v-stock" type="button"
          data-off="${off ? "1" : ""}" title="Click to toggle stock">${off ? "Sold out" : "In stock"}</button>
        <button class="icon-btn v-del" type="button" title="Remove">×</button>`;
      const stock = row.querySelector(".v-stock");
      stock.addEventListener("click", () => {
        const nowOff = !stock.dataset.off;
        stock.dataset.off = nowOff ? "1" : "";
        stock.textContent = nowOff ? "Sold out" : "In stock";
        stock.classList.toggle("btn-danger", nowOff);
        stock.classList.toggle("btn-outline", !nowOff);
      });
      row.querySelector(".v-del").addEventListener("click", () => row.remove());
      rowsWrap.appendChild(row);
    };
    (it.variants.length ? it.variants : [{ base: "", size: "", price: "" }]).forEach(addRow);
    el("#addVar", m.backdrop).addEventListener("click", () => addRow());

    /* Photo. Uploaded immediately against the saved item rather than held until
       Save: the bytes go to a different endpoint (multipart, not JSON), and an
       upload that only landed when the whole form validated would lose the file
       on any unrelated validation error. A brand-new item has no id yet, so the
       control asks for a save first. */
    const fileInput = el("#fImg", m.backdrop);
    const preview = el("#imgPreview", m.backdrop);
    const rmBtn = el("#rmImg", m.backdrop);
    const pickBtn = el("#pickImg", m.backdrop);

    pickBtn.addEventListener("click", () => {
      if (!item) return toast("Save the item first, then add its photo", "err");
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file || !item) return;
      const fd = new FormData();
      fd.append("file", file);
      pickBtn.disabled = true;
      const was = pickBtn.textContent;
      pickBtn.textContent = "Uploading…";
      try {
        const res = await API.upload(`/api/admin/menu/items/${item.id}/image`, fd);
        it.image_url = res.image_url;
        preview.innerHTML = `<img src="${API.assetUrl(res.image_url)}" alt="" />`;
        rmBtn.classList.remove("hidden");
        pickBtn.textContent = "Replace photo";
        const kb = Math.round(res.bytes / 1024);
        toast(`Photo saved — ${res.width}×${res.height}, ${kb} KB`, "ok");
        // Keep the row behind the modal honest about having a photo now.
        const row = data.items.find((x) => x.id === item.id);
        if (row) row.image_url = res.image_url;
      } catch (e) {
        toast(e.message, "err");
        pickBtn.textContent = was;
      } finally {
        pickBtn.disabled = false;
        fileInput.value = "";     // so re-picking the same file fires change again
      }
    });

    rmBtn.addEventListener("click", async () => {
      if (!item) return;
      try {
        await API.del(`/api/admin/menu/items/${item.id}/image`);
        it.image_url = "";
        preview.innerHTML = `<span class="img-empty">No photo</span>`;
        rmBtn.classList.add("hidden");
        pickBtn.textContent = "Upload photo";
        const row = data.items.find((x) => x.id === item.id);
        if (row) row.image_url = "";
        toast("Photo removed", "ok");
      } catch (e) { toast(e.message, "err"); }
    });

    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const variants = els(".input-row", rowsWrap).map((r) => ({
        base: r.querySelector(".v-base").value.trim(),
        size: r.querySelector(".v-size").value.trim(),
        price: parseFloat(r.querySelector(".v-price").value),
        available: !r.querySelector(".v-stock").dataset.off,
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
        available: el("#fAvail", m.backdrop).value === "true",
        image_url: it.image_url || "",
        // New items append to the end of their category; edits keep their place. Reorder via drag.
        sort_order: item ? it.sort_order : data.items.filter((i) => i.category_id === +el("#fCat", m.backdrop).value).length,
        variants,
      };
      if (!payload.name) return toast("Name is required", "err");
      await save(item ? "put" : "post", item ? `/api/admin/menu/items/${item.id}` : "/api/admin/menu/items", payload, m);
    });
  }

  /* ---------------- Promos ---------------- */
  /* Which codes gate this promo. Read off the coupons rather than stored on the
     promo, so the column cannot disagree with the coupon screen. */
  const promoCodes = (promoId) =>
    data.coupons.filter((c) => (c.promo_ids || []).includes(promoId)).map((c) => c.code);

  function renderPromos() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Promos", "Add promo", null));
    const rows = data.promos.map((p) => `
      <tr>
        <td>${esc(p.label || "—")}</td>
        <td>${esc(p.scope)}: ${esc(((p.target_ids && p.target_ids.length ? p.target_ids : [p.target_id]).map((id) => p.scope === "item" ? itemName(id) : catName(id)).join(", ")))}</td>
        <td>${esc(p.ptype)}${p.ptype === "percent" || p.ptype === "flat" ? ` (${p.value}${p.ptype === "percent" ? "%" : "₹"})` : ""}</td>
        <td>${p.coupon_only ? `🔒 ${esc(promoCodes(p.id).join(", ")) || "coupon only"}` : "Everyone"}</td>
        <td>${p.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${p.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Label</th><th>Applies to</th><th>Type</th><th>Who gets it</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(6)}</tbody></table></div>`);
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
        <!-- These two are what the site's offer banners say. Left blank, the API
             writes the copy itself from the promo type and the categories it
             covers, so a promo is never advertised with an empty description. -->
        <div class="field"><label>Description (optional)</label>
          <textarea class="input" id="fDescription" rows="2" placeholder="Left blank: written automatically from the promo type.">${esc(p.description || "")}</textarea></div>
        <div class="field"><label>Conditions / fine print (optional)</label>
          <textarea class="input" id="fConditions" rows="2" placeholder="Left blank: the standard 'applies automatically at checkout' terms.">${esc(p.conditions || "")}</textarea></div>
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
        description: el("#fDescription", m.backdrop).value.trim(),
        conditions: el("#fConditions", m.backdrop).value.trim(),
        active: el("#fActive", m.backdrop).value === "true",
      };
      await save(promo ? "put" : "post", promo ? `/api/admin/menu/promos/${promo.id}` : "/api/admin/menu/promos", payload, m);
    });
  }

  /* ---------------- Coupons ----------------
     A coupon does two things, separately: it can take money off (percent/flat),
     and it can switch on promos that the cart otherwise never applies. "Offer
     only" is the second without the first — the code's whole job is unlocking
     the offer. A promo listed on any coupon stops running on its own, which is
     what makes "only with this code" true. */
  const promoName = (id) => {
    const p = data.promos.find((x) => x.id == id);
    return p ? (p.display_label || p.label || p.ptype) : "";
  };
  const unlockedNames = (c) => (c.promo_ids || []).map(promoName).filter(Boolean);
  const couponAmount = (c) =>
    c.ctype === "promo" ? "Offer only" : c.ctype === "percent" ? `${c.value}%` : money(c.value);

  function renderCoupons() {
    const body = el("#tabBody");
    body.innerHTML = "";
    body.appendChild(toolbar("Coupons", "Add coupon", null));
    const rows = data.coupons.map((c) => `
      <tr>
        <td><strong>${esc(c.code)}</strong></td>
        <td>${esc(couponAmount(c))}${c.max_discount && c.ctype !== "promo" ? ` (max ${money(c.max_discount)})` : ""}</td>
        <td>${esc(unlockedNames(c).join(", ")) || "—"}</td>
        <td>${c.min_order ? `≥ ${money(c.min_order)}` : "—"}</td>
        <td>${c.used_count}${c.usage_limit ? ` / ${c.usage_limit}` : ""}</td>
        <td>${c.active ? "✅" : "⛔"}</td>
        <td class="row"><button class="btn btn-sm btn-outline" data-edit="${c.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${c.id}">Delete</button></td>
      </tr>`).join("");
    body.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Code</th><th>Discount</th><th>Unlocks</th><th>Min order</th><th>Used</th><th>Active</th><th></th></tr></thead><tbody>${rows || emptyRow(7)}</tbody></table></div>`);
    el("#addBtn").addEventListener("click", () => couponForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => couponForm(data.coupons.find((c) => c.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/coupons/${b.dataset.del}`, "Delete this coupon?")));
  }

  function couponForm(coupon) {
    const c = coupon || { code: "", ctype: "percent", value: 10, min_order: 0, max_discount: 0, usage_limit: 0, active: true, promo_ids: [] };
    const picked = new Set(c.promo_ids || []);
    /* Several promos of the same type read identically ("Buy 1 Get 1 Free" once
       per category), so each row names what it covers. */
    const promoTargets = (p) => {
      const names = (p.target_ids && p.target_ids.length ? p.target_ids : [p.target_id])
        .filter((x) => x != null).map((id) => (p.scope === "item" ? itemName(id) : catName(id)));
      // A promo can cover a dozen items; the row only needs enough to tell it apart.
      return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3} more` : names.join(", ");
    };
    const promoOpts = data.promos.map((p) =>
      `<label class="ms-opt"><input type="checkbox" value="${p.id}" ${picked.has(p.id) ? "checked" : ""}/> <span>${esc(p.display_label || p.label || p.ptype)} <span class="text-muted">· ${esc(promoTargets(p))}</span>${p.active ? "" : " (off)"}</span></label>`).join("")
      || `<div class="ms-opt text-muted">Create a promo first.</div>`;
    const m = modal({
      title: coupon ? "Edit coupon" : "Add coupon",
      bodyHTML: `
        <div class="field"><label>Code</label><input class="input" id="fCode" value="${esc(c.code)}" style="text-transform:uppercase;" placeholder="SHIV10" /></div>
        <div class="input-row">
          <div class="field grow"><label>Type</label><select class="select" id="fType">
            <option value="percent" ${c.ctype === "percent" ? "selected" : ""}>Percent</option>
            <option value="flat" ${c.ctype === "flat" ? "selected" : ""}>Flat ₹</option>
            <option value="promo" ${c.ctype === "promo" ? "selected" : ""}>Offer only (no ₹ off)</option></select></div>
          <div class="field grow" id="cValWrap"><label>Value</label><input class="input" id="fValue" type="number" value="${c.value}" /></div>
        </div>
        <!-- Attaching a promo here is what makes it code-only: it stops applying
             to everyone's cart and comes back only for a cart carrying this
             code. Detach it (or delete the coupon) and it goes public again. -->
        <div class="field"><label>Offers this code unlocks</label>
          <div class="ms" id="fPromoMs">
            <button type="button" class="select ms-toggle" id="fPromoToggle"><span class="ms-summary placeholder" id="fPromoSummary">None</span><span class="ms-caret">▾</span></button>
            <div class="ms-panel" id="fPromoPanel" hidden>
              <div class="ms-bar"><span id="fPromoCount">0 selected</span><span class="ms-actions"><button type="button" id="fPromoNone">Clear</button></span></div>
              <div id="fPromoOpts">${promoOpts}</div>
            </div>
          </div>
        </div>
        <p class="text-muted text-sm">Any offer picked here stops running on its own — only carts using this code get it.</p>
        <div class="input-row">
          <div class="field grow"><label>Min order (₹)</label><input class="input" id="fMin" type="number" value="${c.min_order}" /></div>
          <div class="field grow" id="cMaxWrap"><label>Max discount (₹, 0=none)</label><input class="input" id="fMax" type="number" value="${c.max_discount}" /></div>
        </div>
        <div class="input-row">
          <div class="field grow"><label>Usage limit (0=∞)</label><input class="input" id="fLimit" type="number" value="${c.usage_limit}" /></div>
          <div class="field grow"><label>Active</label><select class="select" id="fActive"><option value="true" ${c.active ? "selected" : ""}>Active</option><option value="false" ${!c.active ? "selected" : ""}>Off</option></select></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save coupon</button>`,
    });

    const updatePromoSummary = () => {
      const names = [...picked].map((id) => {
        const p = data.promos.find((x) => x.id == id);
        return p ? `${promoName(id)} · ${promoTargets(p)}` : "";
      }).filter(Boolean);
      const sum = el("#fPromoSummary", m.backdrop);
      sum.textContent = names.length ? (names.length <= 2 ? names.join(", ") : `${names.length} selected`) : "None";
      sum.classList.toggle("placeholder", !names.length);
      el("#fPromoCount", m.backdrop).textContent = `${names.length} selected`;
    };
    els("#fPromoOpts input[type=checkbox]", m.backdrop).forEach((cb) =>
      cb.addEventListener("change", () => { cb.checked ? picked.add(+cb.value) : picked.delete(+cb.value); updatePromoSummary(); }));
    el("#fPromoToggle", m.backdrop).addEventListener("click", () => {
      const ms = el("#fPromoMs", m.backdrop), panel = el("#fPromoPanel", m.backdrop);
      const open = panel.hidden;
      panel.hidden = !open; ms.classList.toggle("open", open);
    });
    el("#fPromoNone", m.backdrop).addEventListener("click", () => {
      picked.clear();
      els("#fPromoOpts input[type=checkbox]", m.backdrop).forEach((cb) => { cb.checked = false; });
      updatePromoSummary();
    });

    // An offer-only code has no amount to cap or charge, so those two inputs go.
    const typeSel = el("#fType", m.backdrop);
    const syncType = () => {
      const offerOnly = typeSel.value === "promo";
      el("#cValWrap", m.backdrop).style.display = offerOnly ? "none" : "";
      el("#cMaxWrap", m.backdrop).style.display = offerOnly ? "none" : "";
    };
    typeSel.addEventListener("change", syncType);
    syncType();
    updatePromoSummary();

    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const ctype = typeSel.value;
      const payload = {
        code: el("#fCode", m.backdrop).value.trim().toUpperCase(),
        ctype,
        value: ctype === "promo" ? 0 : (parseFloat(el("#fValue", m.backdrop).value) || 0),
        min_order: parseFloat(el("#fMin", m.backdrop).value) || 0,
        max_discount: ctype === "promo" ? 0 : (parseFloat(el("#fMax", m.backdrop).value) || 0),
        usage_limit: parseInt(el("#fLimit", m.backdrop).value) || 0,
        active: el("#fActive", m.backdrop).value === "true",
        promo_ids: [...picked],
      };
      if (!payload.code) return toast("Code is required", "err");
      if (ctype === "promo" && !payload.promo_ids.length) return toast("Pick the offer this code unlocks", "err");
      await save(coupon ? "put" : "post", coupon ? `/api/coupons/${coupon.id}` : "/api/coupons", payload, m);
    });
  }

  /* ---------------- Scratch cards ----------------
     A printed batch, not a set of odds: the owner says "100 cards — 40 of this,
     40 of that, 20 of the third" and those are the numbers that go out. Cards
     come off the batch at random, so the order is a surprise and the totals are
     not. Each row therefore needs one number, how many of that card exist, and
     everything else on this screen is worked out from it. */
  function renderScratch() {
    const body = el("#tabBody");
    const s = data.scratch || {};
    const prizes = s.prizes || [];
    const stats = data.awards.stats || {};
    const on = !!data.settings.scratch_enabled;
    const repeat = !!data.settings.scratch_repeat_batch;
    const live = !!s.live;
    const size = s.batch_size || 0;
    const left = s.left || 0;
    const given = size - left;
    const pct = size ? Math.round(given / size * 100) : 0;

    body.innerHTML = "";
    body.appendChild(toolbar("Scratch Cards", "Add card to batch", null));

    const status = !on
      ? `<span class="pill-out">Off</span> Customers do not see a card.`
      : live
        ? `<span class="pill-in">Running</span> Customers get one card per order at checkout.`
        : `<span class="pill-part">Batch finished</span> The card is on, but every card in the batch has gone out — customers see no card until you print a new batch.`;

    body.insertAdjacentHTML("beforeend", `
      <div class="card" style="margin-bottom:var(--sp-4);"><div class="card-pad">
        <div class="row-between" style="gap:var(--sp-4);flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">Show scratch cards at checkout</div>
            <p class="text-muted text-sm" style="margin:4px 0 0;max-width:52ch;">
              Each customer gets one card per order, just before they pay. A win mints a
              private code locked to their phone number, so it cannot be shared around.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="scratchToggle" ${on ? "checked" : ""} />
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div class="text-sm" style="margin-top:var(--sp-3);">${status}</div>

        <div class="batch-bar-wrap">
          <div class="row-between" style="gap:var(--sp-2);flex-wrap:wrap;">
            <div><strong>Batch #${s.batch_no || 1}</strong> · ${size} cards · <strong>${left}</strong> still to give</div>
            <div class="text-muted text-sm">${given} given (${pct}%)</div>
          </div>
          <div class="batch-bar">${prizes.filter((p) => p.active && p.quantity).map((p) => `
            <span class="bb-seg ${p.kind === "miss" ? "miss" : ""}" style="width:${size ? p.quantity / size * 100 : 0}%"
                  title="${esc(p.label)}: ${p.quantity} of ${size}">
              <i style="width:${p.quantity ? (p.awarded_count / p.quantity * 100) : 0}%"></i>
            </span>`).join("")}</div>
          <div class="text-muted text-sm">Solid part of each block is what has already gone out.</div>
        </div>

        <div class="row-between" style="gap:var(--sp-4);flex-wrap:wrap;margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--line);">
          <div>
            <div style="font-weight:600;">Print the same batch again when it runs out</div>
            <p class="text-muted text-sm" style="margin:4px 0 0;max-width:52ch;">
              On: the split starts over automatically, forever. Off: cards stop when the
              batch is finished, and you decide whether to run another.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="repeatToggle" ${repeat ? "checked" : ""} />
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div style="margin-top:var(--sp-3);">
          <button class="btn btn-outline btn-sm" id="reprintBtn">↻ Start a new batch now</button>
          <span class="text-muted text-sm"> Resets every count to zero. Codes already won stay valid.</span>
        </div>
      </div></div>

      <div class="stat-strip" style="margin-top:0;">
        <div class="stat-tile"><div class="st-val">${stats.draws || 0}</div><div class="st-label">Cards scratched</div><div class="st-hint">all batches</div></div>
        <div class="stat-tile good"><div class="st-val">${stats.wins || 0}</div><div class="st-label">Prizes won</div></div>
        <div class="stat-tile good"><div class="st-val">${stats.redeemed || 0}</div><div class="st-label">Redeemed</div><div class="st-hint">came back and spent it</div></div>
        <div class="stat-tile warn"><div class="st-val">${stats.outstanding || 0}</div><div class="st-label">Unspent</div><div class="st-hint">still owed</div></div>
        <div class="stat-tile"><div class="st-val">${stats.misses || 0}</div><div class="st-label">No-win cards</div></div>
      </div>`);

    const rows = prizes.map((p) => {
      const what = p.kind === "miss"
        ? `<em class="text-muted">Better luck next time</em>`
        : p.coupon_missing
          ? `<span class="pill-out">Coupon deleted</span>`
          : `<strong>${esc(p.coupon_code)}</strong> <span class="text-muted">· ${esc(p.coupon_terms)}</span>`;
      return `
        <tr>
          <td><strong>${esc(p.label)}</strong></td>
          <td>${what}</td>
          <td><strong>${p.quantity}</strong> <span class="text-muted">of ${size}</span>
            <div class="text-muted text-sm">${p.share}% of the batch</div></td>
          <td>${p.awarded_count} given<div class="text-muted text-sm">${p.remaining} left</div></td>
          <td>${p.drawable ? `${p.chance}%` : "—"}</td>
          <td>${p.kind === "miss" ? "—" : `${p.validity_days} days`}</td>
          <td>${p.drawable ? "✅" : p.active ? "⛔ all given" : "⛔ paused"}</td>
          <td class="row col-actions"><button class="btn btn-sm btn-outline" data-edit="${p.id}">Edit</button>
            <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button></td>
        </tr>`;
    }).join("");

    body.insertAdjacentHTML("beforeend", `
      <h3 style="margin:var(--sp-4) 0 var(--sp-2);">What is in the batch</h3>
      <div class="table-wrap"><table class="admin-table" style="min-width:960px;">
        <thead><tr><th>Shows as</th><th>Gives</th><th>How many</th><th>Given</th><th>Next card</th><th>Valid for</th><th>Live</th><th></th></tr></thead>
        <tbody>${rows || emptyRow(8)}</tbody></table></div>
      <p class="text-muted text-sm" style="margin-top:var(--sp-2);">
        “How many” is the promise: 40 of 100 means exactly 40 customers get that coupon, no
        more and no fewer. “Next card” is only the odds for the very next scratch — it drifts
        as the batch empties, which is what keeps the final split exact.
        Add a “Better luck next time” card to decide how many of the batch win nothing.</p>`);

    const winRows = (data.awards.awards || []).map((a) => `
      <tr>
        <td>${esc(a.phone)}</td>
        <td>${esc(a.label)}</td>
        <td><code>${esc(a.code || "—")}</code></td>
        <td>${a.status === "used" ? `✅ used${a.order_public_id ? ` · ${esc(a.order_public_id)}` : ""}` : "⏳ not used yet"}</td>
        <td>${esc(UI.fmtDate(a.created_at))}</td>
        <td>${a.expires_at ? esc(UI.fmtDate(a.expires_at)) : "—"}</td>
      </tr>`).join("");

    body.insertAdjacentHTML("beforeend", `
      <h3 style="margin:var(--sp-5) 0 var(--sp-2);">Winners</h3>
      <div class="table-wrap"><table class="admin-table" style="min-width:720px;">
        <thead><tr><th>Phone</th><th>Won</th><th>Code</th><th>Status</th><th>Won on</th><th>Valid till</th></tr></thead>
        <tbody>${winRows || emptyRow(6)}</tbody></table></div>`);

    el("#addBtn").addEventListener("click", () => prizeForm());
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () => prizeForm(prizes.find((p) => p.id == b.dataset.edit))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", () => del(`/api/admin/scratch/prizes/${b.dataset.del}`, "Remove this card from the batch?")));

    const putSettings = async (patch, okMsg, checkbox) => {
      checkbox.disabled = true;
      try {
        // The payload replaces the whole settings row, so every switch goes up
        // together — sending one alone would reset the others to their defaults.
        data.settings = await API.put("/api/admin/settings", {
          ordering_enabled: !!data.settings.ordering_enabled,
          scratch_enabled: !!data.settings.scratch_enabled,
          scratch_repeat_batch: !!data.settings.scratch_repeat_batch,
          ...patch,
        });
        toast(okMsg, "ok");
      } catch (err) {
        toast(err.message, "err");
        checkbox.checked = !checkbox.checked;
      } finally { checkbox.disabled = false; renderScratch(); }
    };

    el("#scratchToggle").addEventListener("change", (e) =>
      putSettings({ scratch_enabled: e.target.checked },
        e.target.checked ? "Scratch cards turned on" : "Scratch cards turned off", e.target));
    el("#repeatToggle").addEventListener("change", (e) =>
      putSettings({ scratch_repeat_batch: e.target.checked },
        e.target.checked ? "The batch will reprint itself" : "Cards will stop when the batch runs out", e.target));

    el("#reprintBtn").addEventListener("click", async () => {
      if (!confirm(`Start a new batch of ${size} cards? Every count goes back to zero.`)) return;
      try {
        data.scratch = await API.post("/api/admin/scratch/reprint");
        data.settings = await API.get("/api/admin/settings");
        toast("New batch started", "ok");
        renderScratch();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  function prizeForm(prize) {
    const p = prize || { kind: "coupon", coupon_id: 0, label: "", quantity: 10, validity_days: 7, active: true, sort_order: 0 };
    const couponOpts = data.coupons.map((c) =>
      `<option value="${c.id}" ${p.coupon_id == c.id ? "selected" : ""}>${esc(c.code)} — ${esc(couponAmount(c))}${c.ctype === "promo" ? "" : " off"}</option>`).join("");
    // The rest of the batch, so the owner can see what their number adds up to
    // without leaving the form — "40" only means something next to the other 60.
    const others = (data.scratch.prizes || [])
      .filter((x) => x.active && x.id !== p.id)
      .reduce((sum, x) => sum + (x.quantity || 0), 0);
    const m = modal({
      title: prize ? "Edit card" : "Add card to batch",
      bodyHTML: `
        <div class="field"><label>Prize type</label>
          <select class="select" id="fKind">
            <option value="coupon" ${p.kind === "coupon" ? "selected" : ""}>A coupon</option>
            <option value="miss" ${p.kind === "miss" ? "selected" : ""}>Better luck next time (no prize)</option>
          </select>
        </div>
        <div class="field" id="couponField"><label>Which coupon does this give?</label>
          <select class="select" id="fCoupon">${couponOpts || `<option value="0">Add a coupon first</option>`}</select>
          <div class="text-sm text-muted" style="margin-top:6px;">
            The winner gets a private one-time copy of this code, locked to their phone number.
            Your own code stays untouched.</div>
        </div>
        <div class="field"><label>Card text (blank = the discount)</label>
          <input class="input" id="fLabel" value="${esc(p.label)}" placeholder="e.g. ₹50 OFF" /></div>
        <div class="field"><label>How many of this card are in the batch?</label>
          <input class="input" id="fQty" type="number" min="1" value="${p.quantity}" />
          <div class="text-sm text-muted" style="margin-top:6px;" id="qtyHint"></div>
          ${prize ? `<div class="text-sm text-muted">${prize.awarded_count} already given this batch.</div>` : ""}
        </div>
        <div class="input-row">
          <div class="field grow"><label>Code valid for (days)</label>
            <input class="input" id="fDays" type="number" min="1" value="${p.validity_days}" /></div>
          <div class="field grow"><label>In the batch</label>
            <select class="select" id="fActive"><option value="true" ${p.active ? "selected" : ""}>Yes</option><option value="false" ${!p.active ? "selected" : ""}>Paused</option></select></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveBtn">Save card</button>`,
    });

    const kindEl = el("#fKind", m.backdrop);
    const syncKind = () => { el("#couponField", m.backdrop).style.display = kindEl.value === "miss" ? "none" : ""; };
    kindEl.addEventListener("change", syncKind);
    syncKind();

    // Live arithmetic under the field: this is the number the owner is really
    // choosing — "40 of 100, 40% of the batch" — and doing it in their head is
    // where a give-away budget goes wrong.
    const qtyEl = el("#fQty", m.backdrop);
    const syncQty = () => {
      const q = Math.max(0, parseInt(qtyEl.value) || 0);
      const total = others + q;
      el("#qtyHint", m.backdrop).textContent = total
        ? `Batch becomes ${total} cards — ${q} of them this one (${Math.round(q / total * 100)}%). Exactly ${q} customers get it, then it stops.`
        : "";
    };
    qtyEl.addEventListener("input", syncQty);
    syncQty();

    el("#saveBtn", m.backdrop).addEventListener("click", async () => {
      const kind = kindEl.value;
      const payload = {
        kind,
        coupon_id: kind === "miss" ? 0 : parseInt(el("#fCoupon", m.backdrop).value) || 0,
        label: el("#fLabel", m.backdrop).value.trim(),
        quantity: parseInt(qtyEl.value) || 0,
        validity_days: parseInt(el("#fDays", m.backdrop).value) || 7,
        active: el("#fActive", m.backdrop).value === "true",
        sort_order: p.sort_order || 0,
      };
      if (kind === "coupon" && !payload.coupon_id) return toast("Pick the coupon this card gives", "err");
      if (payload.quantity < 1) return toast("Enter how many of this card the batch holds", "err");
      await save(prize ? "put" : "post", prize ? `/api/admin/scratch/prizes/${prize.id}` : "/api/admin/scratch/prizes", payload, m);
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

  /* ---------------- Export ---------------- */
  /* Downloads through fetch rather than a plain <a href>: the export is behind
     the owner session cookie, and a link opened by the phone's downloader would
     arrive without it and 401. The CSV comes back as text, so it is wrapped in
     a Blob here and handed to a synthetic <a download>. */
  function renderExport() {
    const body = el("#tabBody");
    // Local date, not toISOString() — that converts to UTC and, after 5:30 am
    // IST is behind, would offer yesterday as "today" for half the day.
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    body.innerHTML = `
      <h2 style="margin:0 0 var(--sp-3);">Export orders</h2>
      <div class="card"><div class="card-pad">
        <p class="text-muted text-sm" style="margin:0 0 var(--sp-3);max-width:60ch;">
          Download the orders placed between two dates as a CSV you can open in Excel or
          Google Sheets. Every row carries the customer's name, phone and address.</p>
        <div class="input-row">
          <div class="field grow"><label>From</label><input class="input" id="expFrom" type="date" value="${ymd(monthStart)}" /></div>
          <div class="field grow"><label>To</label><input class="input" id="expTo" type="date" value="${ymd(today)}" /></div>
        </div>
        <label class="row" style="align-items:center;gap:10px;margin:var(--sp-2) 0 var(--sp-3);">
          <input type="checkbox" id="expItems" />
          <span>Also include the items, the offer/coupon applied and the amounts</span>
        </label>
        <button class="btn btn-primary" id="expBtn">⬇️ Download CSV</button>
        <p class="text-muted text-sm" id="expHint" style="margin:var(--sp-3) 0 0;max-width:60ch;">
          Dates are Indian Standard Time, and both days are included. With the box ticked
          each row also carries the subtotal before discounts, which offer and coupon were
          applied, what each took off, the delivery fee and the amount actually paid.</p>
      </div></div>`;

    el("#expBtn").addEventListener("click", async () => {
      const from = el("#expFrom").value;
      const to = el("#expTo").value;
      if (!from || !to) return toast("Pick both dates", "err");
      if (to < from) return toast("The end date is before the start date", "err");
      const btn = el("#expBtn");
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Preparing…";
      try {
        const withItems = el("#expItems").checked;
        const csv = await API.get(
          `/api/admin/orders/export.csv?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&include_items=${withItems}`);
        const rows = String(csv).trim().split("\n").length - 1;   // minus the header
        if (rows < 1) { toast("No orders in that date range", "err"); return; }
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `orders-${from}-to-${to}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`${rows} order${rows === 1 ? "" : "s"} downloaded`, "ok");
      } catch (e) {
        toast(e.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
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
        // Both switches go up together: the payload replaces the settings row,
        // so sending one alone would quietly reset the other to its default.
        data.settings = await API.put("/api/admin/settings", {
          ordering_enabled: enabled, scratch_enabled: !!data.settings.scratch_enabled,
        });
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
