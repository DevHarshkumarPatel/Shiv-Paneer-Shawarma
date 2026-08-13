/* Owner-only customer book: who orders again, what they order, when they last
   came. Reads the aggregate the backend derives from past orders — there is no
   customer account, so a phone number is the identity. */
(function () {
  const { money, esc, el, els, toast, statusLabel, fmtDateTime, fmtDate } = UI;

  const TYPE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
  const TYPE_ICON = { dine_in: "🍽️", takeaway: "🥡", delivery: "🛵" };

  // Spend that marks a customer as the shop's best. Deliberately a round number
  // the owner can reason about rather than a percentile nobody can explain.
  const VIP_SPEND = 3000;

  const state = { q: "", sort: "recent", repeatOnly: true, days: 365 };
  let searchTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    // Customer contact history is owner business, not shift-staff business.
    if (user.role !== "owner") { location.href = "orders.html"; return; }
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });

    els("#sortChips .chip").forEach((c) => c.addEventListener("click", () => {
      els("#sortChips .chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      state.sort = c.dataset.sort;
      load();
    }));
    el("#repeatOnly").addEventListener("change", (e) => { state.repeatOnly = e.target.checked; load(); });
    el("#windowSel").addEventListener("change", (e) => { state.days = Number(e.target.value); load(); });
    el("#refreshBtn").addEventListener("click", load);

    // Typing is debounced: every keystroke would otherwise re-scan the orders.
    el("#searchBox").addEventListener("input", (e) => {
      state.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 300);
    });

    await load();

    // customers.html#9876543210 opens that person straight away, so a specific
    // customer can be linked to (or bookmarked) instead of searched for again.
    const deep = (location.hash || "").replace(/\D/g, "");
    if (deep.length >= 10) openDetail(deep);
  }

  /* ------------------------------- data ------------------------------- */

  async function load() {
    const params = new URLSearchParams({
      days: String(state.days),
      repeat_only: String(state.repeatOnly),
      sort: state.sort,
    });
    if (state.q.trim()) params.set("q", state.q.trim());

    el("#custList").innerHTML = `<div class="center-load"><div class="spinner"></div><div>Loading customers…</div></div>`;
    try {
      const data = await API.get(`/api/admin/customers?${params}`);
      renderSummary(data.summary);
      renderList(data.customers, data.summary);
    } catch (e) {
      el("#custList").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    }
  }

  /* ------------------------------ rendering ---------------------------- */

  function renderSummary(s) {
    const tiles = [
      { label: "Customers", value: s.customers, hint: "in this period" },
      { label: "Repeat", value: s.repeat_customers, hint: `${s.repeat_rate}% come back`, tone: "good" },
      { label: "Repeat revenue", value: money(s.repeat_revenue), hint: `${s.repeat_revenue_share}% of sales`, tone: "good" },
      { label: "Orders / customer", value: s.avg_orders_per_customer, hint: "average" },
      { label: "Lapsed regulars", value: s.lapsed_regulars, hint: "overdue a visit", tone: s.lapsed_regulars ? "warn" : "" },
    ];
    el("#statStrip").innerHTML = tiles.map((t) => `
      <div class="stat-tile ${t.tone || ""}">
        <div class="st-val">${esc(String(t.value))}</div>
        <div class="st-label">${esc(t.label)}</div>
        <div class="st-hint">${esc(t.hint)}</div>
      </div>`).join("");
  }

  function renderList(rows, summary) {
    const note = el("#resultNote");
    const scope = summary.window_days ? `last ${summary.window_days} days` : "all time";
    note.textContent = `${rows.length} shown · ${scope}` +
      (summary.truncated ? ` · only the ${summary.orders_scanned} most recent orders were read` : "");

    if (!rows.length) {
      el("#custList").innerHTML = `
        <div class="empty">
          <div class="emoji">👤</div>
          <p><strong>No customers match.</strong></p>
          <p class="text-sm">Try a wider period, or turn off “Repeat only” to include first-time customers.</p>
        </div>`;
      return;
    }
    el("#custList").innerHTML = `<div class="cust-list">${rows.map(card).join("")}</div>`;
    els(".cust-card").forEach((c) => {
      c.addEventListener("click", (e) => {
        // Call / WhatsApp are real links inside the card; a tap on those should
        // dial, not open the sheet behind the dialler.
        if (e.target.closest("a")) return;
        openDetail(c.dataset.phone);
      });
    });
  }

  const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const telHref = (p) => `tel:+91${p}`;
  // wa.me needs the country code; this shop serves India only.
  const waHref = (p, name) => `https://wa.me/91${p}?text=${encodeURIComponent(`Hi ${name || ""}`.trim() + ", this is Shiv Paneer Shawarma. ")}`;
  const prettyPhone = (p) => (p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);

  function badges(c) {
    const out = [];
    if (c.orders >= 2) out.push(`<span class="cbadge regular">🔁 Regular ×${c.orders}</span>`);
    else out.push(`<span class="cbadge new">✨ First order</span>`);
    if (c.total_spent >= VIP_SPEND) out.push(`<span class="cbadge vip">⭐ Top spender</span>`);
    if (c.lapsed) out.push(`<span class="cbadge lapsed">⏳ Not seen ${c.days_since_last}d</span>`);
    if (c.cancelled) out.push(`<span class="cbadge cancel">✖ ${c.cancelled} cancelled</span>`);
    return out.join("");
  }

  function itemsLine(items) {
    if (!items.length) return `<span class="text-muted">No items recorded</span>`;
    return items.map((i) => `
      <span class="fav-chip">${esc(i.name)}${i.variant_label ? ` <em>${esc(i.variant_label)}</em>` : ""} <b>×${i.quantity}</b></span>
    `).join("");
  }

  function card(c) {
    const last = c.last_order;
    return `
      <article class="cust-card" data-phone="${esc(c.phone)}" tabindex="0">
        <div class="cc-head">
          <div class="cc-av">${esc(initials(c.name))}</div>
          <div class="cc-id">
            <div class="cc-name">${esc(c.name)}</div>
            <a class="cc-phone" href="${telHref(c.phone)}">${esc(prettyPhone(c.phone))}</a>
          </div>
          <div class="cc-money">
            <div class="cc-spent">${money(c.total_spent)}</div>
            <div class="cc-sub">${c.orders} order${c.orders === 1 ? "" : "s"}</div>
          </div>
        </div>

        <div class="cc-badges">${badges(c)}</div>

        <div class="cc-favs">
          <div class="cc-label">Usually orders</div>
          <div class="fav-chips">${itemsLine(c.top_items)}</div>
        </div>

        <div class="cc-foot">
          <div class="cc-last">
            ${last ? `${TYPE_ICON[last.order_type] || ""} ${esc(fmtDate(last.created_at))} · ${money(last.total)}` : "—"}
          </div>
          <div class="cc-actions">
            <a class="btn btn-outline btn-sm" href="${telHref(c.phone)}" aria-label="Call ${esc(c.name)}">📞 Call</a>
            <a class="btn btn-outline btn-sm" href="${waHref(c.phone, c.name)}" target="_blank" rel="noopener">💬 WhatsApp</a>
            <button class="btn btn-primary btn-sm">View</button>
          </div>
        </div>
      </article>`;
  }

  /* ------------------------------ detail sheet -------------------------- */

  async function openDetail(phone) {
    const m = UI.modal({ title: "Customer", bodyHTML: `<div class="center-load"><div class="spinner"></div></div>` });
    try {
      const c = await API.get(`/api/admin/customers/${encodeURIComponent(phone)}`);
      m.backdrop.querySelector(".modal-head h3").textContent = c.name;
      m.body.innerHTML = detailHTML(c);
      // Order history is long; each row expands to its item lines on tap.
      els(".hist-row", m.body).forEach((r) => r.addEventListener("click", () => r.classList.toggle("open")));
    } catch (e) {
      m.body.innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
      toast(e.message, "err");
    }
  }

  function detailHTML(c) {
    const maxQty = Math.max(...c.all_items.map((i) => i.quantity), 1);
    const typeRows = Object.entries(c.types).sort((a, b) => b[1] - a[1]);
    const totalTypes = typeRows.reduce((s, [, n]) => s + n, 0) || 1;

    return `
      <div class="cd-top">
        <div class="cc-av lg">${esc(initials(c.name))}</div>
        <div>
          <a class="cd-phone" href="${telHref(c.phone)}">${esc(prettyPhone(c.phone))}</a>
          <div class="cc-badges">${badges(c)}</div>
        </div>
      </div>

      <div class="cd-actions">
        <a class="btn btn-outline btn-sm" href="${telHref(c.phone)}">📞 Call</a>
        <a class="btn btn-outline btn-sm" href="${waHref(c.phone, c.name)}" target="_blank" rel="noopener">💬 WhatsApp</a>
      </div>

      <div class="cd-stats">
        ${stat("Orders", c.orders)}
        ${stat("Total spent", money(c.total_spent))}
        ${stat("Average order", money(c.avg_order))}
        ${stat("Orders every", c.avg_gap_days === null ? "—" : `${c.avg_gap_days} d`)}
        ${stat("Last order", c.days_since_last === null ? "—" : `${c.days_since_last} d ago`)}
        ${stat("Since", c.first_order_at ? fmtDate(c.first_order_at) : "—")}
      </div>

      <h4 class="cd-h">What they order</h4>
      <div class="fav-list">
        ${c.all_items.map((i) => `
          <div class="fav-row">
            <div class="fav-name">${esc(i.name)}${i.variant_label ? ` <em>${esc(i.variant_label)}</em>` : ""}</div>
            <div class="fav-qty">×${i.quantity}${i.free_quantity ? ` <span class="free">+${i.free_quantity} free</span>` : ""}</div>
            <div class="fav-bar"><span style="width:${Math.round(i.quantity / maxQty * 100)}%"></span></div>
          </div>`).join("") || `<p class="text-muted text-sm">No items recorded.</p>`}
      </div>

      <h4 class="cd-h">How they order</h4>
      <div class="split-bar">
        ${typeRows.map(([t, n]) => `
          <span class="sb-seg ${t}" style="width:${Math.round(n / totalTypes * 100)}%" title="${TYPE_LABEL[t]}: ${n}"></span>`).join("")}
      </div>
      <div class="split-key">
        ${typeRows.map(([t, n]) => `<span><i class="sk-dot ${t}"></i>${TYPE_ICON[t] || ""} ${TYPE_LABEL[t] || t} · ${n}</span>`).join("")}
        ${c.peak_hour !== null && c.peak_hour !== undefined ? `<span>🕒 Usually around ${hourLabel(c.peak_hour)}</span>` : ""}
      </div>

      ${c.addresses.length ? `
        <h4 class="cd-h">Delivery addresses</h4>
        <ul class="addr-list">${c.addresses.map((a) => `<li>📍 ${esc(a)}</li>`).join("")}</ul>` : ""}

      ${Object.keys(c.coupons).length ? `
        <h4 class="cd-h">Coupons used</h4>
        <div class="fav-chips">${Object.entries(c.coupons).map(([code, n]) =>
          `<span class="fav-chip">${esc(code)} <b>×${n}</b></span>`).join("")}</div>` : ""}

      <h4 class="cd-h">Order history <span class="text-muted text-sm">(tap a row for items)</span></h4>
      <div class="hist-list">
        ${c.orders_list.map(histRow).join("")}
      </div>`;
  }

  const stat = (label, value) => `<div class="cd-stat"><div class="cd-val">${esc(String(value))}</div><div class="cd-lab">${esc(label)}</div></div>`;

  function hourLabel(h) {
    const ampm = h < 12 ? "am" : "pm";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh} ${ampm}`;
  }

  function histRow(o) {
    return `
      <div class="hist-row">
        <div class="hr-head">
          <div class="hr-main">
            <div class="hr-id">${TYPE_ICON[o.order_type] || ""} ${esc(o.public_id)}</div>
            <div class="hr-when">${esc(fmtDateTime(o.created_at))}</div>
          </div>
          <div class="hr-right">
            <div class="hr-total">${money(o.total)}</div>
            <span class="status-pill ${esc(o.status)}">${esc(statusLabel(o.status))}</span>
          </div>
        </div>
        <div class="hr-items">
          ${o.items.map((i) => `
            <div class="oc-item">
              <span><span class="q">${i.quantity}×</span> ${esc(i.name)}${i.variant_label ? ` <span class="text-muted">${esc(i.variant_label)}</span>` : ""}
                ${i.free_quantity ? `<span class="oc-free"> +${i.free_quantity} free</span>` : ""}</span>
              <span>${money(i.line_total)}</span>
            </div>`).join("")}
          ${o.coupon_code ? `<div class="oc-line disc"><span>Coupon ${esc(o.coupon_code)}</span><span>−${money(o.coupon_discount)}</span></div>` : ""}
          ${o.delivery_fee ? `<div class="oc-line"><span>Delivery</span><span>${money(o.delivery_fee)}</span></div>` : ""}
          ${o.notes ? `<div class="oc-line"><span>Note</span><span>${esc(o.notes)}</span></div>` : ""}
        </div>
      </div>`;
  }
})();
