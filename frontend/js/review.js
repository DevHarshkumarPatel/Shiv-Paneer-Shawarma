/* Customer review page.
 *
 * The owner writes the questions (staff/reviews.html); this file only knows how
 * to *ask* each type well on a phone. Everything here follows from one goal:
 * a customer standing outside the shop, holding the phone in one hand, should
 * be able to finish without thinking about the form.
 *
 * - One question per screen, so the page never looks like paperwork.
 * - Single-answer questions (stars, radio, yes/no, 0–10) advance themselves
 *   after a beat — long enough to see the tap register, short enough that the
 *   Next button is never needed. Multi-answer and text keep Next.
 * - A half-finished form survives a reload or a phone call: the draft is kept
 *   in sessionStorage against this order id and cleared on submit.
 * - Swiping sideways moves between questions, because on a phone that is what
 *   a card-shaped thing invites.
 */
(function () {
  const { esc, el, els, toast } = UI;

  const AUTO_ADVANCE_MS = 340;
  const TEXT_LIMIT = 1500;   // matches the backend cap
  // Named feelings beat bare numbers: "4" is data, "Really good" is a feeling
  // someone can agree or disagree with, so the tap is more considered.
  const STAR_WORDS = ["", "Not good", "Could be better", "It was fine", "Really good", "Loved it!"];

  const params = new URLSearchParams(location.search);
  const orderId = (params.get("id") || params.get("order") || "").toUpperCase().trim();
  const DRAFT_KEY = `sps_review_draft_${orderId || "walkin"}`;

  let form = null;             // GET /api/review/form
  let questions = [];
  let idx = 0;                 // 0..questions.length (last index = the "you" step)
  let dir = "fwd";
  let answers = {};            // question_id -> { score, text, choices[] }
  let who = { name: "", phone: "" };
  let submitting = false;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      form = await API.get(`/api/review/form?order_id=${encodeURIComponent(orderId)}`);
    } catch (e) {
      return showState("⚠️", "Could not load the form", e.message, [homeCta()]);
    }
    if (!form.enabled) {
      return showState("🙏", "Reviews are closed right now",
        "We are not collecting feedback at the moment. Thanks for wanting to tell us!", [menuCta(), homeCta()]);
    }
    if (form.already_reviewed) {
      return showState("✅", "You have already reviewed this order",
        "Thank you — it is already with the kitchen.", [menuCta(), homeCta()]);
    }

    questions = form.questions || [];
    if (form.order) {
      who.name = form.order.name || "";
      who.phone = form.order.phone || "";
    }
    restoreDraft();
    render();
  }

  /* ------------------------------------------------------------ draft ---- */

  function saveDraft() {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ answers, who, idx }));
    } catch { /* private mode: the draft is a convenience, not a requirement */ }
  }
  function restoreDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
      if (!d) return;
      answers = d.answers || {};
      who = { ...who, ...(d.who || {}) };
      idx = Math.min(Number(d.idx) || 0, questions.length);
    } catch { /* ignore a corrupt draft */ }
  }
  const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} };

  /* ------------------------------------------------------------ answers -- */

  const cur = () => questions[idx];
  const ansOf = (q) => (answers[q.id] = answers[q.id] || { score: null, text: "", choices: [] });

  function hasAnswer(q) {
    const a = answers[q.id];
    if (!a) return false;
    if (q.qtype === "multi" || q.qtype === "single") return (a.choices || []).length > 0;
    if (q.qtype === "short_text" || q.qtype === "long_text") return !!(a.text || "").trim();
    return a.score !== null && a.score !== undefined;
  }

  /* ------------------------------------------------------------- render -- */

  function render() {
    const root = el("#rvRoot");
    root.className = "container";
    root.innerHTML = idx < questions.length ? questionCard(cur()) : whoCard();
    const card = el(".rv-card", root);
    card.classList.add(dir === "back" ? "back" : "fwd", "in");
    card.addEventListener("animationend", () => card.classList.remove("in"), { once: true });

    renderBar();
    renderProgress();
    idx < questions.length ? wireQuestion(cur()) : wireWho();
    wireSwipe(root);
    saveDraft();
  }

  function renderProgress() {
    const total = questions.length + 1;
    // Never a completely empty bar: a sliver on question one reads as "this is
    // short", where a bar at zero reads as "you have not started".
    el("#progressBar").style.width = `${Math.max(6, Math.round((idx / total) * 100))}%`;
    el("#stepCount").textContent = `${idx + 1} of ${total}`;
  }

  function head(q) {
    const flag = q.required
      ? `<span class="rv-req">Required</span>`
      : `<span class="rv-optional">Skip if you like</span>`;
    return `
      <div>
        ${idx === 0 && form.order ? orderStrip() : ""}
        ${idx === 0 && form.intro ? `<p class="rv-help" style="margin-bottom:var(--sp-3);">${esc(form.intro)}</p>` : ""}
        <h1 class="rv-q">${esc(q.text)}</h1>
        ${q.help_text ? `<p class="rv-help">${esc(q.help_text)}</p>` : ""}
        <div style="margin-top:6px;">${flag}</div>
      </div>`;
  }

  function orderStrip() {
    const o = form.order;
    const items = (o.items || []).join(", ");
    return `<div class="rv-order">
      <span>Order <b>${esc(o.public_id)}</b></span>
      ${items ? `<span>· ${esc(items)}</span>` : ""}
    </div>`;
  }

  function questionCard(q) {
    return `<div class="rv-card">
      ${head(q)}
      <div class="rv-answer" data-answer>${answerHTML(q)}</div>
    </div>`;
  }

  function answerHTML(q) {
    const a = ansOf(q);
    switch (q.qtype) {
      case "rating": {
        const max = q.scale_max || 5;
        const stars = Array.from({ length: max }, (_, i) => i + 1).map((n) =>
          `<button type="button" data-star="${n}" class="${a.score >= n ? "on" : ""}" aria-label="${n} out of ${max}">★</button>`).join("");
        return `<div class="rv-stars">${stars}</div>
          <div class="rv-star-label" data-star-label>${a.score ? esc(starWord(a.score, max)) : ""}</div>`;
      }
      case "nps": {
        const cells = Array.from({ length: 11 }, (_, n) =>
          `<button type="button" data-nps="${n}" class="${a.score === n ? `on ${npsTone(n)}` : ""}">${n}</button>`).join("");
        return `<div class="rv-nps">${cells}</div>
          <div class="rv-scale-ends"><span>0 · Never</span><span>10 · Definitely</span></div>`;
      }
      case "yes_no":
        return `<div class="rv-yesno">
          <button type="button" data-yn="1" class="${a.score === 1 ? "on yes" : ""}"><span>👍</span>Yes</button>
          <button type="button" data-yn="0" class="${a.score === 0 ? "on no" : ""}"><span>👎</span>No</button>
        </div>`;
      case "single":
      case "multi": {
        const multi = q.qtype === "multi";
        const rows = (q.options || []).map((o) => `
          <button type="button" class="rv-opt ${multi ? "check" : "radio"} ${a.choices.includes(o) ? "on" : ""}"
                  data-opt="${esc(o)}" role="${multi ? "checkbox" : "radio"}" aria-checked="${a.choices.includes(o)}">
            <span class="mark">✓</span><span>${esc(o)}</span>
          </button>`).join("");
        return rows + (multi ? `<p class="rv-help" style="margin:4px 0 0;">Pick as many as you like.</p>` : "");
      }
      case "short_text":
        return `<input class="input rv-text" data-text maxlength="${TEXT_LIMIT}" enterkeyhint="next"
                       placeholder="Type your answer" value="${esc(a.text)}" />`;
      default: {
        // long_text — the chips are the point: most people will tap a word and
        // never type a sentence, and a tapped word is still a real answer.
        const chips = (q.options || []).map((o) =>
          `<button type="button" class="rv-chip ${a.text.includes(o) ? "on" : ""}" data-chip="${esc(o)}">${esc(o)}</button>`).join("");
        return `${chips ? `<div class="rv-chips">${chips}</div>` : ""}
          <textarea class="input rv-text" data-text rows="4" maxlength="${TEXT_LIMIT}"
                    placeholder="Tell us in your own words (optional)">${esc(a.text)}</textarea>
          <div class="rv-count" data-count>${a.text.length}/${TEXT_LIMIT}</div>`;
      }
    }
  }

  const starWord = (n, max) => (max === 5 ? STAR_WORDS[n] : `${n} out of ${max}`);
  const npsTone = (n) => (n <= 6 ? "low" : n <= 8 ? "mid" : "high");

  function whoCard() {
    const rated = ratingGiven();
    return `<div class="rv-card">
      <div>
        <h1 class="rv-q">${rated >= 4 ? "Glad you enjoyed it! 🎉" : "Thanks for telling us"}</h1>
        <p class="rv-help">Last bit — your name, so we know who to thank. Both fields are optional.</p>
      </div>
      <div class="rv-who">
        <input class="input" id="rvName" placeholder="Your name" autocomplete="name" value="${esc(who.name)}" />
        <input class="input" id="rvPhone" placeholder="Phone number" inputmode="numeric" maxlength="14"
               autocomplete="tel" enterkeyhint="send" value="${esc(who.phone)}" />
        <p class="rv-help">We only use this to reach you if something went wrong.</p>
      </div>
    </div>`;
  }

  function ratingGiven() {
    const q = questions.find((x) => x.qtype === "rating");
    return q && answers[q.id] ? answers[q.id].score || 0 : 0;
  }

  /* ---------------------------------------------------------------- bar -- */

  function renderBar() {
    const last = idx >= questions.length;
    const q = last ? null : cur();
    const skippable = q && !q.required && !hasAnswer(q);
    el("#rvBar").className = "rv-bar";
    el("#rvBar").innerHTML = `
      <div class="container">
        <button class="rv-back" id="rvBack" ${idx === 0 ? "disabled" : ""} aria-label="Previous question">←</button>
        ${skippable ? `<button class="rv-skip" id="rvSkip">Skip</button>` : ""}
        <button class="rv-next" id="rvNext">${last ? "Send review ✓" : "Next →"}</button>
      </div>`;
    el("#rvBack").addEventListener("click", prev);
    el("#rvNext").addEventListener("click", () => (last ? submit() : next()));
    const skip = el("#rvSkip");
    if (skip) skip.addEventListener("click", next);
  }

  /* ------------------------------------------------------------- wiring -- */

  function wireQuestion(q) {
    const a = ansOf(q);
    const root = el("#rvRoot");

    els("[data-star]", root).forEach((b) => b.addEventListener("click", () => {
      a.score = Number(b.dataset.star);
      els("[data-star]", root).forEach((x) => x.classList.toggle("on", Number(x.dataset.star) <= a.score));
      el("[data-star-label]", root).textContent = starWord(a.score, q.scale_max || 5);
      advance();
    }));

    els("[data-nps]", root).forEach((b) => b.addEventListener("click", () => {
      a.score = Number(b.dataset.nps);
      els("[data-nps]", root).forEach((x) => {
        x.className = Number(x.dataset.nps) === a.score ? `on ${npsTone(a.score)}` : "";
      });
      advance();
    }));

    els("[data-yn]", root).forEach((b) => b.addEventListener("click", () => {
      a.score = Number(b.dataset.yn);
      els("[data-yn]", root).forEach((x) => {
        x.className = Number(x.dataset.yn) === a.score ? (a.score ? "on yes" : "on no") : "";
      });
      advance();
    }));

    els("[data-opt]", root).forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.opt;
      if (q.qtype === "single") {
        a.choices = [v];
        els("[data-opt]", root).forEach((x) => {
          const on = x.dataset.opt === v;
          x.classList.toggle("on", on);
          x.setAttribute("aria-checked", String(on));
        });
        advance();
      } else {
        const on = !a.choices.includes(v);
        a.choices = on ? [...a.choices, v] : a.choices.filter((c) => c !== v);
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
        renderBar();      // the Skip button disappears once something is picked
        saveDraft();
      }
    }));

    const box = el("[data-text]", root);
    if (box) {
      box.addEventListener("input", () => {
        a.text = box.value.slice(0, TEXT_LIMIT);
        const count = el("[data-count]", root);
        if (count) count.textContent = `${a.text.length}/${TEXT_LIMIT}`;
        syncChips(root, a);
        saveDraft();
      });
      if (q.qtype === "short_text") {
        box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); box.blur(); next(); } });
      }
    }

    // Tapping a chip writes the phrase into the box; tapping it again takes it
    // back out. The box stays the single source of truth for the answer.
    els("[data-chip]", root).forEach((c) => c.addEventListener("click", () => {
      const phrase = c.dataset.chip;
      const has = a.text.includes(phrase);
      if (has) {
        a.text = a.text.replace(phrase, "").replace(/\s*,\s*,/g, ",").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
      } else {
        a.text = a.text.trim() ? `${a.text.trim()}, ${phrase}` : phrase;
      }
      if (box) box.value = a.text;
      const count = el("[data-count]", root);
      if (count) count.textContent = `${a.text.length}/${TEXT_LIMIT}`;
      syncChips(root, a);
      renderBar();
      saveDraft();
    }));
  }

  function syncChips(root, a) {
    els("[data-chip]", root).forEach((c) => c.classList.toggle("on", a.text.includes(c.dataset.chip)));
  }

  function wireWho() {
    const name = el("#rvName"), phone = el("#rvPhone");
    name.addEventListener("input", () => { who.name = name.value; saveDraft(); });
    phone.addEventListener("input", () => { who.phone = phone.value; saveDraft(); });
    phone.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  }

  /* A horizontal drag moves between questions. Ignored on the text controls —
     dragging inside a textarea is selecting text, not turning a page. */
  function wireSwipe(root) {
    let x0 = null, y0 = null;
    root.addEventListener("touchstart", (e) => {
      if (e.target.closest("input, textarea")) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    root.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
      dx < 0 ? next() : prev();
    }, { passive: true });
  }

  /* ---------------------------------------------------------- navigation -- */

  function advance() {
    saveDraft();
    renderBar();
    setTimeout(() => { if (idx < questions.length) next(); }, AUTO_ADVANCE_MS);
  }

  function next() {
    if (idx < questions.length) {
      const q = cur();
      if (q.required && !hasAnswer(q)) {
        toast("This one is needed — a single tap is enough.", "err");
        const card = el(".rv-card");
        card.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" },
           { transform: "translateX(7px)" }, { transform: "translateX(0)" }],
          { duration: 220 },
        );
        return;
      }
    }
    if (idx >= questions.length) return;
    idx += 1; dir = "fwd"; render();
    window.scrollTo({ top: 0 });
  }

  function prev() {
    if (idx === 0) return;
    idx -= 1; dir = "back"; render();
    window.scrollTo({ top: 0 });
  }

  /* -------------------------------------------------------------- submit -- */

  async function submit() {
    if (submitting) return;
    const missing = questions.find((q) => q.required && !hasAnswer(q));
    if (missing) {
      idx = questions.indexOf(missing); dir = "back"; render();
      toast("Just this one left to answer.", "err");
      return;
    }
    const payload = {
      order_public_id: orderId,
      name: (who.name || "").trim(),
      phone: (who.phone || "").trim(),
      answers: questions.filter(hasAnswer).map((q) => ({
        question_id: q.id,
        score: answers[q.id].score,
        text: answers[q.id].text || "",
        choices: answers[q.id].choices || [],
      })),
    };
    if (!payload.answers.length) { toast("Answer at least one question first.", "err"); return; }

    submitting = true;
    const btn = el("#rvNext");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await API.post("/api/review", payload);
      clearDraft();
      thanks(res);
    } catch (e) {
      submitting = false;
      btn.disabled = false; btn.textContent = "Send review ✓";
      toast(e.message, "err");
    }
  }

  function thanks(res) {
    const rating = res.rating || ratingGiven();
    const happy = !rating || rating >= 4;
    el("#progressBar").style.width = "100%";
    el("#stepCount").textContent = "Done";

    const ctas = [];
    // The Google ask only goes to people who just said they were happy. Asking
    // an unhappy customer to repeat it in public is how a bad meal becomes a
    // permanent one-star.
    if (happy && res.google_url) {
      ctas.push(`<a class="btn btn-primary" href="${esc(res.google_url)}" target="_blank" rel="noopener">★ Post it on Google</a>`);
    }
    ctas.push(menuCta(), homeCta());

    showState(
      happy ? "🎉" : "🙏",
      happy ? "Thank you!" : "Thank you — we hear you",
      happy ? (res.thanks || form.thanks || "Your feedback goes straight to the kitchen.")
            : "Sorry it was not right this time. The owner reads every word of this, and we will fix it.",
      ctas,
    );
  }

  /* --------------------------------------------------------------- states -- */

  const menuCta = () => `<a class="btn btn-outline" href="menu.html">🌯 Order again</a>`;
  const homeCta = () => `<a class="btn btn-outline" href="index.html">Back to home</a>`;

  function showState(emoji, title, body, ctas = []) {
    el("#rvBar").innerHTML = "";
    el("#rvBar").className = "";
    const root = el("#rvRoot");
    root.className = "container rv-state";
    root.innerHTML = `
      <div>
        <div class="emoji rv-pop">${emoji}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(body)}</p>
        ${ctas.length ? `<div class="rv-cta">${ctas.join("")}</div>` : ""}
      </div>`;
  }
})();
