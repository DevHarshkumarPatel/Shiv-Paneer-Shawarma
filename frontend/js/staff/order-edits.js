/* Owner-only audit screen: every change made to an order after it was placed.

   The order card on the board already carries its own history, which is what
   the counter needs — this page is the other question, the one only the owner
   asks: what was changed today, across all orders, and by whom. So it is a
   single stream in time order rather than a list of orders, and it is
   read-only by construction: there is no endpoint that edits or deletes an
   entry, here or anywhere. */
(function () {
  const { money, esc, el, fmtDateTime, fmtDate, istDateISO } = UI;

  const TYPE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

  // Defaults to today (IST), like the orders board — the usual reason to open
  // this page is "what happened on the shift that just ended".
  let dateFilter = istDateISO();
  let moneyOnly = false;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    // Who changed whose bill is owner business. Staff see their own order's
    // history on the card and nothing wider.
    if (user.role !== "owner") { location.href = "orders.html"; return; }
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });

    const dateInput = el("#dateFilter");
    dateInput.value = dateFilter;
    dateInput.max = istDateISO();
    dateInput.addEventListener("change", (e) => { dateFilter = e.target.value; syncDateButtons(); load(); });
    el("#todayBtn").addEventListener("click", () => {
      dateFilter = istDateISO(); dateInput.value = dateFilter; syncDateButtons(); load();
    });
    el("#allDatesBtn").addEventListener("click", () => {
      dateFilter = ""; dateInput.value = ""; syncDateButtons(); load();
    });
    el("#moneyOnly").addEventListener("change", (e) => { moneyOnly = e.target.checked; load(); });
    el("#refreshBtn").addEventListener("click", load);
    syncDateButtons();

    await load();
  }

  function syncDateButtons() {
    el("#todayBtn").classList.toggle("active", !!dateFilter && dateFilter === istDateISO());
    el("#allDatesBtn").classList.toggle("active", !dateFilter);
  }

  // An edit that moved the total is the one worth finding again. The filter is
  // applied here rather than server-side so the same response serves both
  // views — the list is already bounded by the day.
  const movedMoney = (e) => Math.abs((e.total_after || 0) - (e.total_before || 0)) >= 0.01;

  async function load() {
    const btn = el("#refreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    let path = "/api/admin/orders/edits/recent";
    if (dateFilter) path += `?date=${encodeURIComponent(dateFilter)}`;
    try {
      const { edits } = await API.get(path);
      render(moneyOnly ? edits.filter(movedMoney) : edits);
      el("#lastUpdated").textContent = `· updated ${fmtDateTime(new Date()).split(", ").pop()}`;
    } catch (e) {
      if (e.status === 401) { location.href = "login.html"; return; }
      el("#editLog").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh"; }
    }
  }

  function render(edits) {
    if (!edits.length) {
      const when = dateFilter
        ? (dateFilter === istDateISO() ? "today" : `on ${fmtDate(dateFilter)}`)
        : "yet";
      el("#editLog").innerHTML = `<div class="empty"><div class="emoji">🗒️</div>
        <h3>No order was changed ${esc(when)}</h3>
        <p class="text-muted">Orders that get corrected show up here, with who changed them.</p></div>`;
      return;
    }
    el("#editLog").innerHTML = `<div class="edit-log">${edits.map(entry).join("")}</div>`;
  }

  function entry(e) {
    const delta = (e.total_after || 0) - (e.total_before || 0);
    const moved = Math.abs(delta) >= 0.01
      ? `<span class="el-delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "−"} ${money(Math.abs(delta))}</span>`
      : "";
    const val = (v, kind) => (v === "" || v == null) ? "—" : (kind === "money" ? money(v) : esc(v));
    const rows = (e.changes || []).map((ch) => `
      <div class="oe-change"><span>${esc(ch.label)}</span>
        <span><s>${val(ch.old, ch.kind)}</s> → <strong>${val(ch.new, ch.kind)}</strong></span></div>`).join("");

    return `<article class="card el-card"><div class="card-pad">
      <div class="el-head">
        <div>
          <a class="el-id" href="orders.html">${esc(e.order_public_id)}</a>
          <div class="el-sub">${esc(TYPE_LABEL[e.order_type] || e.order_type || "")}
            ${e.customer_name ? `· ${esc(e.customer_name)}` : ""}
            ${e.customer_phone ? `· ${esc(e.customer_phone)}` : ""}</div>
        </div>
        <div class="el-who">
          <div>${esc(fmtDateTime(e.at))}</div>
          <div class="text-muted">${esc(e.by || "unknown")}${e.by_role ? ` · ${esc(e.by_role)}` : ""}</div>
        </div>
      </div>
      <div class="el-totals">${money(e.total_before)} → <strong>${money(e.total_after)}</strong> ${moved}</div>
      ${rows}
    </div></article>`;
  }
})();
