/* Owner reviews: build the form, read what came back.
 *
 * Three tabs, in the order the owner uses them: what customers said, the
 * questions being asked, and the page's own copy + switch. Filtering the
 * responses is done here rather than on the server — the window fetch already
 * has every review in it, and a rating chip should feel instant.
 */
(function () {
  const { esc, el, els, toast, modal, fmtDateTime, fmtDate } = UI;

  const TYPES = [
    { id: "rating", label: "⭐ Star rating", hint: "1–5 stars. The headline score." },
    { id: "nps", label: "📊 Score 0–10", hint: "“Would you recommend us?” Drives the NPS number." },
    { id: "single", label: "🔘 One choice", hint: "Radio buttons — exactly one answer." },
    { id: "multi", label: "☑️ Many choices", hint: "Checkboxes — any number of answers." },
    { id: "yes_no", label: "👍 Yes / No", hint: "Two big buttons." },
    { id: "short_text", label: "✏️ Short answer", hint: "One-line text box." },
    { id: "long_text", label: "📝 Long answer", hint: "Paragraph box, with optional one-tap words." },
  ];
  const typeOf = (id) => TYPES.find((t) => t.id === id) || { label: id, hint: "" };
  const NEEDS_OPTIONS = ["single", "multi", "long_text"];

  let data = { questions: [], settings: {}, reviews: [], stats: {}, summary: { questions: [] } };
  let tab = "responses";
  const filters = { days: 90, rating: "all", q: "" };
  let searchTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });
    if (user.role !== "owner") {
      el("#reviewRoot").innerHTML = `<div class="empty"><div class="emoji">🔒</div><h3>Owner access only</h3>
        <p class="text-muted">Reviews are the owner's book.</p><a class="btn btn-primary" href="orders.html">Go to orders</a></div>`;
      return;
    }
    await load();
  }

  async function load() {
    try {
      const [qs, res] = await Promise.all([
        API.get("/api/admin/reviews/questions"),
        API.get(`/api/admin/reviews/responses?days=${filters.days}`),
      ]);
      data = { questions: qs.questions, settings: qs.settings, ...res };
      render();
    } catch (e) {
      if (e.status === 401) { location.href = "login.html"; return; }
      el("#reviewRoot").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    }
  }

  function render() {
    const tabBtn = (id, label) => `<button class="chip ${tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`;
    el("#reviewRoot").innerHTML = `
      <div class="section-tabs">
        ${tabBtn("responses", `💬 Responses${data.stats.reviews ? ` (${data.stats.reviews})` : ""}`)}
        ${tabBtn("questions", "❓ Questions")}
        ${tabBtn("setup", "⚙️ Page setup")}
      </div>
      <div id="tabBody"></div>`;
    els("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
    ({ responses: renderResponses, questions: renderQuestions, setup: renderSetup }[tab])();
  }

  const reviewUrl = () => new URL("../review.html", location.href).href;

  /* ============================== RESPONSES ============================== */

  function renderResponses() {
    const s = data.stats;
    const body = el("#tabBody");
    body.innerHTML = `
      <div class="stat-strip">
        <div class="stat-tile"><div class="st-val">${s.reviews || 0}</div><div class="st-label">Reviews</div><div class="st-hint">${s.window_days ? `last ${s.window_days} days` : "all time"}</div></div>
        <div class="stat-tile ${s.avg_rating >= 4 ? "good" : s.avg_rating && s.avg_rating < 3 ? "warn" : ""}">
          <div class="st-val">${s.avg_rating ? `${s.avg_rating} ★` : "—"}</div><div class="st-label">Average</div><div class="st-hint">${s.rated || 0} rated</div></div>
        <div class="stat-tile good"><div class="st-val">${s.happy_share === null || s.happy_share === undefined ? "—" : `${s.happy_share}%`}</div>
          <div class="st-label">Happy</div><div class="st-hint">4★ and up</div></div>
        <div class="stat-tile ${s.unhappy ? "warn" : ""}"><div class="st-val">${s.unhappy || 0}</div><div class="st-label">Unhappy</div><div class="st-hint">2★ or less</div></div>
        <div class="stat-tile"><div class="st-val">${s.nps === null || s.nps === undefined ? "—" : s.nps}</div><div class="st-label">NPS</div><div class="st-hint">${s.nps_responses || 0} answered</div></div>
      </div>

      <div class="cust-toolbar">
        <div class="search-field">
          <span class="search-ico" aria-hidden="true">🔎</span>
          <input class="input" id="searchBox" type="search" placeholder="Search words, name, phone or order id"
                 value="${esc(filters.q)}" autocomplete="off" />
        </div>
        <div class="chips" id="ratingChips">
          ${["all", "5", "4", "3", "low"].map((r) => `<button class="chip ${filters.rating === r ? "active" : ""}" data-rating="${r}">${
            { all: "All", 5: "5 ★", 4: "4 ★", 3: "3 ★", low: "1–2 ★ ⚠️" }[r]}</button>`).join("")}
        </div>
        <div class="cust-filters">
          <label class="pill-toggle"><span>Since</span>
            <select class="select" id="windowSel">
              ${[[30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "All time"]].map(([v, t]) =>
                `<option value="${v}" ${filters.days === v ? "selected" : ""}>${t}</option>`).join("")}
            </select>
          </label>
          <button class="btn btn-outline btn-sm" id="refreshBtn">↻ Refresh</button>
          <a class="btn btn-outline btn-sm" href="${esc(reviewUrl())}" target="_blank" rel="noopener">👁 Open review page</a>
        </div>
      </div>

      ${starBars(s.stars, s.rated)}
      <div id="qSummary">${summaryHTML()}</div>
      <h3 style="margin:var(--sp-5) 0 var(--sp-3);">What people said</h3>
      <div id="respList"></div>`;

    el("#windowSel").addEventListener("change", (e) => { filters.days = Number(e.target.value); load(); });
    el("#refreshBtn").addEventListener("click", load);
    els("#ratingChips .chip").forEach((c) => c.addEventListener("click", () => {
      filters.rating = c.dataset.rating;
      els("#ratingChips .chip").forEach((x) => x.classList.toggle("active", x === c));
      renderList();
    }));
    el("#searchBox").addEventListener("input", (e) => {
      filters.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderList, 250);
    });
    renderList();
  }

  function starBars(stars, rated) {
    if (!rated) return "";
    return `<div class="rv-dist">
      ${[5, 4, 3, 2, 1].map((n) => {
        const c = (stars || {})[String(n)] || 0;
        return `<div class="rv-dist-row">
          <span class="rv-dist-lab">${n} ★</span>
          <span class="rv-bar"><i style="width:${Math.round(c / rated * 100)}%" class="${n <= 2 ? "bad" : n === 3 ? "mid" : ""}"></i></span>
          <span class="rv-dist-n">${c}</span></div>`;
      }).join("")}
    </div>`;
  }

  function summaryHTML() {
    const qs = data.summary.questions || [];
    if (!qs.length) return "";
    return `<div class="rv-sum-grid">${qs.map(sumCard).join("")}</div>`;
  }

  function sumCard(b) {
    const total = b.answers || 0;
    let inner = "";
    if (b.qtype === "rating" || b.qtype === "nps") {
      const keys = Object.keys(b.counts).map(Number).sort((a, c) => c - a);
      inner = `<div class="rv-avg">${b.average ?? "—"}<small>${b.qtype === "nps" ? "/10" : " ★"} average</small></div>
        <div class="rv-dist">${keys.map((k) => `
          <div class="rv-dist-row"><span class="rv-dist-lab">${k}</span>
            <span class="rv-bar"><i style="width:${Math.round(b.counts[String(k)] / total * 100)}%"></i></span>
            <span class="rv-dist-n">${b.counts[String(k)]}</span></div>`).join("")}</div>`;
    } else if (b.qtype === "short_text" || b.qtype === "long_text") {
      inner = b.texts.length
        ? `<div class="rv-quotes">${b.texts.slice(0, 6).map((t) =>
            `<blockquote>“${esc(t.text)}”<cite>${esc(t.name || "Anonymous")} · ${esc(fmtDate(t.at))}</cite></blockquote>`).join("")}
            ${b.texts.length > 6 ? `<p class="text-sm text-muted">+ ${b.texts.length - 6} more in the list below.</p>` : ""}</div>`
        : `<p class="text-muted text-sm">No written answers yet.</p>`;
    } else {
      const rows = Object.entries(b.counts).sort((a, c) => c[1] - a[1]);
      inner = `<div class="rv-dist">${rows.map(([opt, n]) => `
        <div class="rv-dist-row"><span class="rv-dist-lab wide">${esc(opt)}</span>
          <span class="rv-bar"><i style="width:${Math.round(n / total * 100)}%"></i></span>
          <span class="rv-dist-n">${n}</span></div>`).join("")}</div>`;
    }
    return `<div class="rv-sum-card">
      <div class="rv-sum-head">
        <div class="rv-sum-q">${esc(b.question)}</div>
        <div class="text-sm text-muted">${total} answer${total === 1 ? "" : "s"}${b.removed ? " · question removed" : ""}</div>
      </div>
      ${inner}
    </div>`;
  }

  function visibleReviews() {
    const q = filters.q.trim().toLowerCase();
    return data.reviews.filter((r) => {
      if (filters.rating === "low" && !(r.rating && r.rating <= 2)) return false;
      if (["3", "4", "5"].includes(filters.rating) && r.rating !== Number(filters.rating)) return false;
      if (!q) return true;
      const hay = [r.name, r.phone, r.order_public_id,
        ...(r.answers || []).flatMap((a) => [a.question, a.text, ...(a.choices || [])])]
        .join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderList() {
    const rows = visibleReviews();
    el("#respList").innerHTML = rows.length
      ? rows.map(respCard).join("")
      : `<div class="empty"><div class="emoji">💬</div><p><strong>Nothing here.</strong></p>
         <p class="text-sm">Try a wider period, or clear the filters.</p></div>`;
    els("[data-del-resp]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this review? It cannot be brought back.")) return;
      try {
        await API.del(`/api/admin/reviews/responses/${b.dataset.delResp}`);
        toast("Review deleted", "ok");
        await load();
      } catch (e) { toast(e.message, "err"); }
    }));
  }

  const starsText = (n) => (n ? "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n)) : "");

  function answerLine(a) {
    if (a.qtype === "rating") return `<span class="rv-stars-sm">${starsText(a.score)}</span>`;
    if (a.qtype === "nps") return `<b>${a.score}/10</b>`;
    if (a.qtype === "yes_no") return a.score ? `<b class="yes">Yes</b>` : `<b class="no">No</b>`;
    if ((a.choices || []).length) return a.choices.map((c) => `<span class="fav-chip">${esc(c)}</span>`).join(" ");
    return `<span>${esc(a.text)}</span>`;
  }

  function respCard(r) {
    const tone = r.rating ? (r.rating >= 4 ? "good" : r.rating <= 2 ? "bad" : "mid") : "";
    return `<article class="rv-resp ${tone}">
      <div class="rv-resp-head">
        <div>
          <div class="rv-resp-who">${esc(r.name || "Anonymous")}
            ${r.rating ? `<span class="rv-stars-sm">${starsText(r.rating)}</span>` : ""}</div>
          <div class="text-sm text-muted">${esc(fmtDateTime(r.created_at))}</div>
        </div>
        <div class="rv-resp-side">
          ${r.order_public_id
            /* The tracking page, not the orders board: the board has no way to
               jump to one id, and tracking shows the whole bill for that order. */
            ? `<a class="badge badge-soft" target="_blank" rel="noopener"
                  href="../track.html?id=${encodeURIComponent(r.order_public_id)}">${esc(r.order_public_id)}</a>` : ""}
          ${r.phone ? `<a class="badge badge-status" href="tel:+91${esc(r.phone)}">📞 ${esc(r.phone)}</a>` : ""}
          <button class="icon-btn" data-del-resp="${r.id}" title="Delete review">🗑</button>
        </div>
      </div>
      <div class="rv-resp-body">
        ${(r.answers || []).map((a) => `
          <div class="rv-ans"><div class="rv-ans-q">${esc(a.question)}</div>
            <div class="rv-ans-v">${answerLine(a)}</div></div>`).join("")}
      </div>
    </article>`;
  }

  /* ============================== QUESTIONS ============================== */

  function renderQuestions() {
    const body = el("#tabBody");
    const qs = data.questions;
    body.innerHTML = `
      <div class="row-between wrap" style="margin:0 0 var(--sp-3);">
        <h2 style="margin:0;">Questions</h2>
        <div class="row wrap" style="gap:var(--sp-2);">
          <a class="btn btn-outline" href="${esc(reviewUrl())}" target="_blank" rel="noopener">👁 Preview</a>
          <button class="btn btn-primary" id="addQ">＋ Add question</button>
        </div>
      </div>
      <p class="text-muted text-sm" style="max-width:70ch;">
        Customers see one question per screen, in this order. Keep it short — every extra
        question loses a few people. Mark only the first one as required.
      </p>
      <div class="rv-qlist">${qs.length ? qs.map(qCard).join("") : `
        <div class="empty"><div class="emoji">❓</div><p><strong>No questions yet.</strong></p>
        <p class="text-sm">The review page stays closed until there is at least one active question.</p></div>`}
      </div>`;

    el("#addQ").addEventListener("click", () => openEditor(null));
    els("[data-edit]", body).forEach((b) => b.addEventListener("click", () =>
      openEditor(qs.find((q) => q.id === Number(b.dataset.edit)))));
    els("[data-del]", body).forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this question? Answers already given to it are kept.")) return;
      try { await API.del(`/api/admin/reviews/questions/${b.dataset.del}`); toast("Deleted", "ok"); await load(); }
      catch (e) { toast(e.message, "err"); }
    }));
    els("[data-move]", body).forEach((b) => b.addEventListener("click", () => move(Number(b.dataset.id), b.dataset.move)));
  }

  function qCard(q, i) {
    const t = typeOf(q.qtype);
    return `<div class="rv-qcard ${q.active ? "" : "off"}">
      <div class="rv-qnum">${i + 1}</div>
      <div class="rv-qmain">
        <div class="rv-qtext">${esc(q.text)}</div>
        ${q.help_text ? `<div class="text-sm text-muted">${esc(q.help_text)}</div>` : ""}
        <div class="rv-qtags">
          <span class="badge badge-soft">${esc(t.label)}</span>
          ${q.qtype === "rating" ? `<span class="badge badge-status">1–${q.scale_max}</span>` : ""}
          ${q.required ? `<span class="badge badge-status" style="color:var(--brand-700);">Required</span>` : ""}
          ${q.active ? "" : `<span class="badge badge-status" style="color:var(--err);">Hidden</span>`}
        </div>
        ${(q.options || []).length ? `<div class="fav-chips" style="margin-top:6px;">${
          q.options.map((o) => `<span class="fav-chip">${esc(o)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="rv-qacts">
        <button class="icon-btn" data-move="up" data-id="${q.id}" title="Move up">↑</button>
        <button class="icon-btn" data-move="down" data-id="${q.id}" title="Move down">↓</button>
        <button class="btn btn-outline btn-sm" data-edit="${q.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-del="${q.id}">Delete</button>
      </div>
    </div>`;
  }

  async function move(id, dir) {
    const order = data.questions.map((q) => q.id);
    const i = order.indexOf(id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try { await API.post("/api/admin/reviews/questions/reorder", { order }); await load(); }
    catch (e) { toast(e.message, "err"); }
  }

  /* ---- the question editor -------------------------------------------- */

  function openEditor(q) {
    const isNew = !q;
    q = q || { text: "", help_text: "", qtype: "rating", options: [], scale_max: 5, required: false, active: true, sort_order: 0 };

    const m = modal({
      title: isNew ? "New question" : "Edit question",
      bodyHTML: `
        <div class="field"><label>Question</label>
          <input class="input" id="qText" placeholder="How was your food?" value="${esc(q.text)}" /></div>
        <div class="field"><label>Helper line (optional)</label>
          <input class="input" id="qHelp" placeholder="Taste, portion, temperature." value="${esc(q.help_text)}" /></div>

        <div class="field"><label>Answer type</label>
          <select class="select" id="qType">${TYPES.map((t) =>
            `<option value="${t.id}" ${q.qtype === t.id ? "selected" : ""}>${t.label}</option>`).join("")}</select>
          <p class="text-sm text-muted" id="qHint" style="margin:6px 0 0;">${esc(typeOf(q.qtype).hint)}</p></div>

        <div id="scaleWrap" class="field"><label>Stars</label>
          <select class="select" id="qScale">${[3, 5, 10].map((n) =>
            `<option value="${n}" ${q.scale_max === n ? "selected" : ""}>1 – ${n}</option>`).join("")}</select></div>

        <div id="optWrap" class="field">
          <label id="optLabel">Options</label>
          <div id="optList"></div>
          <button class="btn btn-outline btn-sm" id="addOpt" type="button">＋ Add option</button>
        </div>

        <label class="pill-toggle" style="margin-right:8px;">
          <input type="checkbox" id="qReq" ${q.required ? "checked" : ""} /> <span>Must be answered</span></label>
        <label class="pill-toggle">
          <input type="checkbox" id="qActive" ${q.active ? "checked" : ""} /> <span>Show on the page</span></label>`,
      footHTML: `<button class="btn btn-primary btn-block btn-lg" id="saveQ">Save question</button>`,
    });

    const optList = el("#optList", m.backdrop);
    const addRow = (value = "") => {
      const row = document.createElement("div");
      row.className = "input-row";
      row.style.marginBottom = "6px";
      row.innerHTML = `<input class="input" value="${esc(value)}" placeholder="Option text" />
        <button class="btn btn-danger btn-sm" type="button" title="Remove">✕</button>`;
      row.querySelector("button").addEventListener("click", () => row.remove());
      optList.appendChild(row);
    };
    (q.options || []).forEach(addRow);
    el("#addOpt", m.backdrop).addEventListener("click", () => addRow());

    const typeSel = el("#qType", m.backdrop);
    const syncType = () => {
      const t = typeSel.value;
      el("#qHint", m.backdrop).textContent = typeOf(t).hint;
      el("#scaleWrap", m.backdrop).style.display = t === "rating" ? "" : "none";
      el("#optWrap", m.backdrop).style.display = NEEDS_OPTIONS.includes(t) ? "" : "none";
      // For a long answer the options are not answers — they are the one-tap
      // words that write themselves into the box, so they are labelled as that.
      el("#optLabel", m.backdrop).textContent = t === "long_text"
        ? "One-tap words (optional)" : "Options to pick from";
      if (NEEDS_OPTIONS.includes(t) && !optList.children.length && t !== "long_text") { addRow(); addRow(); }
    };
    typeSel.addEventListener("change", syncType);
    syncType();

    el("#saveQ", m.backdrop).addEventListener("click", async () => {
      const payload = {
        text: el("#qText", m.backdrop).value.trim(),
        help_text: el("#qHelp", m.backdrop).value.trim(),
        qtype: typeSel.value,
        options: els("input", optList).map((i) => i.value.trim()).filter(Boolean),
        scale_max: Number(el("#qScale", m.backdrop).value) || 5,
        required: el("#qReq", m.backdrop).checked,
        active: el("#qActive", m.backdrop).checked,
        sort_order: q.sort_order || 0,
      };
      if (!NEEDS_OPTIONS.includes(payload.qtype)) payload.options = [];
      try {
        if (isNew) await API.post("/api/admin/reviews/questions", payload);
        else await API.put(`/api/admin/reviews/questions/${q.id}`, payload);
        toast("Saved", "ok");
        m.close();
        await load();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  /* ================================ SETUP ================================ */

  function renderSetup() {
    const s = data.settings;
    const url = reviewUrl();
    const live = s.reviews_enabled && data.questions.some((q) => q.active);
    el("#tabBody").innerHTML = `
      <div class="card card-pad" style="margin-bottom:var(--sp-4);">
        <div class="row-between wrap">
          <div>
            <div style="font-weight:800;">Review page</div>
            <div class="text-sm text-muted">${live
              ? "Live — customers can leave a review."
              : s.reviews_enabled
                ? "Switched on, but no active question yet, so the page stays closed."
                : "Switched off. Anyone opening the link sees a polite “closed” note."}</div>
          </div>
          <label class="pill-toggle"><input type="checkbox" id="revToggle" ${s.reviews_enabled ? "checked" : ""} />
            <span>Collect reviews</span></label>
        </div>
      </div>

      <div class="card card-pad" style="margin-bottom:var(--sp-4);">
        <h3 style="margin-top:0;">Share the link</h3>
        <p class="text-sm text-muted">Put it on the bill, on a table QR, or send it after delivery.
          Adding <code>?id=SPS-…</code> ties the review to that order, and the page then allows one review per order.</p>
        <div class="input-row" style="margin-top:var(--sp-2);">
          <input class="input" id="revUrl" readonly value="${esc(url)}" />
          <button class="btn btn-outline" id="copyUrl">Copy</button>
        </div>
        <div class="row wrap" style="margin-top:var(--sp-2);gap:var(--sp-2);">
          <a class="btn btn-outline btn-sm" href="${esc(url)}" target="_blank" rel="noopener">👁 Open</a>
          <a class="btn btn-outline btn-sm" target="_blank" rel="noopener"
             href="https://wa.me/?text=${encodeURIComponent(`How was your order from Shiv Paneer Shawarma? Tell us in 30 seconds: ${url}`)}">💬 Send on WhatsApp</a>
        </div>
      </div>

      <div class="card card-pad">
        <h3 style="margin-top:0;">What the page says</h3>
        <div class="field"><label>Heading</label>
          <input class="input" id="setTitle" maxlength="120" value="${esc(s.review_title || "")}" /></div>
        <div class="field"><label>Opening line</label>
          <input class="input" id="setIntro" maxlength="200" value="${esc(s.review_intro || "")}"
                 placeholder="A few quick taps — under a minute." /></div>
        <div class="field"><label>Thank-you message</label>
          <input class="input" id="setThanks" maxlength="200" value="${esc(s.review_thanks || "")}" /></div>
        <div class="field"><label>Google review link (optional)</label>
          <input class="input" id="setGoogle" placeholder="https://g.page/r/…/review" value="${esc(s.review_google_url || "")}" />
          <p class="text-sm text-muted" style="margin:6px 0 0;">Offered only to customers who just rated you 4★ or 5★.</p></div>
        <button class="btn btn-primary btn-lg" id="saveSetup">Save</button>
      </div>`;

    el("#revToggle").addEventListener("change", (e) => saveSettings({ reviews_enabled: e.target.checked }, e.target));
    el("#saveSetup").addEventListener("click", () => saveSettings({
      review_title: el("#setTitle").value,
      review_intro: el("#setIntro").value,
      review_thanks: el("#setThanks").value,
      review_google_url: el("#setGoogle").value,
    }));
    el("#copyUrl").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast("Link copied", "ok"); }
      catch { el("#revUrl").select(); toast("Press Ctrl+C to copy", ""); }
    });
  }

  async function saveSettings(patch, checkbox) {
    const s = data.settings;
    const payload = {
      reviews_enabled: s.reviews_enabled,
      review_title: s.review_title || "",
      review_intro: s.review_intro || "",
      review_thanks: s.review_thanks || "",
      review_google_url: s.review_google_url || "",
      ...patch,
    };
    if (checkbox) checkbox.disabled = true;
    try {
      const saved = await API.put("/api/admin/reviews/settings", payload);
      data.settings = saved;
      toast("Saved", "ok");
      renderSetup();
    } catch (e) {
      toast(e.message, "err");
      if (checkbox) checkbox.checked = !checkbox.checked;
    } finally {
      if (checkbox) checkbox.disabled = false;
    }
  }
})();
