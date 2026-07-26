/* Guided first-time-user tour. Self-contained (no dependency on ui.js/api.js).
 * - Welcome overview on the home page, then spotlight coachmarks per page.
 * - Flows across pages: home -> menu -> checkout -> track.
 * - Runs once per page (localStorage); replayable via the header "Guide" button.
 */
(function () {
  "use strict";
  const LS = window.localStorage, SS = window.sessionStorage;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- which page are we on ---------------- */
  function currentPage() {
    const p = location.pathname.toLowerCase();
    if (p.includes("menu.html")) return "menu";
    if (p.includes("checkout")) return "checkout";
    if (p.includes("track")) return "track";
    if (p.includes("staff")) return "staff";
    return "index"; // index.html or "/"
  }

  /* ---------------- step definitions ---------------- */
  // Each step: { target?, title, bodyHTML, placement?, pad?, wait?, last?, ctaLast? }
  // No `target` => a centered card (welcome / intro). `target` may be a CSS
  // selector or a function returning an element.
  const WELCOME_LIST = `
    <ul class="tour-steps-list">
      <li><span class="ico">🍽️</span> Pick <b>dine-in, takeaway or delivery</b></li>
      <li><span class="ico">🌯</span> Add items — <b>Buy 1 Get 1 Free!</b></li>
      <li><span class="ico">💳</span> Checkout &amp; pay by <b>UPI</b></li>
      <li><span class="ico">📍</span> <b>Track</b> your order live</li>
    </ul>`;

  const TOURS = {
    index: [
      { title: "Welcome to Shiv Paneer Shawarma! 👋",
        bodyHTML: "Ordering takes under a minute. Here's the whole journey:" + WELCOME_LIST,
        ctaFirst: "Show me around →" },
      { target: ".ordertypes", title: "1 · Choose your order type",
        bodyHTML: "Start with <b>Dine-in</b>, <b>Takeaway</b> or <b>Delivery</b>. Prices and any delivery fee adjust automatically." },
      { target: ".section .card", title: "Buy 1 Get 1 Free 🎉",
        bodyHTML: "This offer runs on shawarmas, cheese delights, kullads &amp; bowls. Add 2 of the same item and one is <b>free</b> — applied for you at checkout." },
      { target: '.header-actions a[href="track.html"]', title: "Track anytime", placement: "bottom",
        bodyHTML: "Once you order, check its status here — from <em>Placed</em> to <em>Delivered</em> — with your order ID. Tap <b>Refresh</b> for the latest." },
      { target: ".section .btn-primary", title: "Ready to order?",
        bodyHTML: "Tap here to open the menu and start adding items. Let's go!",
        last: true, ctaLast: "Go to the menu →" },
    ],
    menu: [
      { target: "#modeSeg", title: "Order type",
        bodyHTML: "Switch between <b>dine-in</b>, <b>takeaway</b> and <b>delivery</b> here anytime — totals update instantly." },
      { target: "#catChips", title: "Browse the menu", wait: 6000,
        bodyHTML: "Tap a category to jump to it. A <b>B1G1</b> tag means <b>Buy 1 Get 1 Free</b> on those items." },
      { target: () => document.querySelector(".add-btn"), title: "Add an item", wait: 6000,
        bodyHTML: "One tap on <b>Add</b> and it's in your cart. Want the millet base or the exotic size? Tap those pills on the card first — the price updates as you do. Added items turn into a <b>− 1 ＋</b> counter you can adjust right here." },
      { target: "#headerCart", title: "Your cart", placement: "bottom",
        bodyHTML: "Everything you add collects here. Add <b>2 of the same</b> item and one is free automatically." },
      { target: "#headerCart", title: "Checkout when ready", placement: "bottom",
        bodyHTML: "Open your cart and tap <b>Proceed to checkout →</b> to add your details and pay. You'll get an order ID to track. Enjoy! 🌯",
        last: true, ctaLast: "Got it" },
    ],
    checkout: [
      { title: "Almost done! 🎉",
        bodyHTML: "Just add your details, choose how to pay, and place your order.",
        ctaFirst: "Next →" },
      { target: "#payStep", title: "Pay your way", wait: 6000,
        bodyHTML: "Pay now by <b>UPI</b>, or at the counter for dine-in / takeaway. For UPI: tap <b>Show UPI QR</b>, scan it with any UPI app, pay, then paste your <b>UPI reference / UTR</b>." },
      { target: "#placeOrder", title: "Place your order", wait: 6000,
        bodyHTML: "Tap here to confirm. We'll show your <b>order ID</b> — save it to track your order.",
        last: true, ctaLast: "Got it" },
    ],
    track: [
      { target: "#orderIdInput", title: "Track your order", wait: 4000,
        bodyHTML: "Enter the order ID from your confirmation (e.g. <b>SPS-260718-0001</b>) and tap <b>Track</b>. Use the <b>↻ Refresh</b> button any time to see the latest status.",
        last: true, ctaLast: "Got it" },
    ],
  };

  // What to do after a tour completes (only when finished, not skipped).
  const ON_COMPLETE = {
    index: () => { SS.setItem("sps_tour", "menu"); location.href = "menu.html"; },
  };

  /* ---------------- engine ---------------- */
  const seenKey = (page) => "sps_tour_" + page;
  const seen = (page) => LS.getItem(seenKey(page)) === "1";
  const markSeen = (page) => { try { LS.setItem(seenKey(page), "1"); } catch (_) {} };

  let root, mask, spot, tip, steps, page, onComplete, idx, activeTarget, repositionRAF;

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      if (!sel) return resolve(null);
      const get = () => (typeof sel === "function" ? sel() : document.querySelector(sel));
      const first = get();
      if (first) return resolve(first);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const f = get();
        if (f) { clearInterval(iv); resolve(f); }
        else if (Date.now() - t0 > (timeout || 4000)) { clearInterval(iv); resolve(null); }
      }, 120);
    });
  }

  function buildDOM() {
    root = document.createElement("div");
    root.className = "tour-root";
    root.innerHTML = `
      <div class="tour-mask"></div>
      <div class="tour-spot" style="display:none;"></div>
      <div class="tour-tip" role="dialog" aria-modal="true" aria-live="polite">
        <div class="tour-tip-head">
          <span class="tour-badge"></span>
          <button class="tour-x" aria-label="Close tour" title="Close">×</button>
        </div>
        <h3 class="tour-title"></h3>
        <div class="tour-body"></div>
        <div class="tour-foot">
          <div class="tour-dots"></div>
          <div class="tour-btns">
            <button class="tour-btn tour-back" type="button">Back</button>
            <button class="tour-btn primary tour-next" type="button">Next</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    mask = root.querySelector(".tour-mask");
    spot = root.querySelector(".tour-spot");
    tip = root.querySelector(".tour-tip");

    root.querySelector(".tour-x").addEventListener("click", dismiss);
    root.querySelector(".tour-back").addEventListener("click", () => show(idx - 1, -1));
    root.querySelector(".tour-next").addEventListener("click", () => {
      if (idx >= steps.length - 1) finish(); else show(idx + 1, 1);
    });
    mask.addEventListener("click", (e) => { if (e.target === mask) { /* stay put; ignore stray clicks */ } });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === "Escape") { e.preventDefault(); dismiss(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); if (idx >= steps.length - 1) finish(); else show(idx + 1, 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(idx - 1, -1); }
  }

  function renderContent(step) {
    tip.querySelector(".tour-badge").textContent = `Step ${idx + 1} of ${steps.length}`;
    tip.querySelector(".tour-title").innerHTML = step.title;
    tip.querySelector(".tour-body").innerHTML = step.bodyHTML || "";
    const dots = steps.map((_, i) => `<span class="tour-dot ${i === idx ? "on" : ""}"></span>`).join("");
    tip.querySelector(".tour-dots").innerHTML = dots;
    const back = tip.querySelector(".tour-back");
    back.disabled = idx === 0;
    back.style.visibility = idx === 0 ? "hidden" : "visible";
    const next = tip.querySelector(".tour-next");
    next.textContent = step.last ? (step.ctaLast || "Done") : (idx === 0 && step.ctaFirst ? step.ctaFirst : "Next");
    tip.classList.toggle("centered", !step.target);
  }

  function positionSpot(target, pad) {
    if (!target) { spot.style.display = "none"; mask.classList.add("dim"); return; }
    mask.classList.remove("dim");
    const r = target.getBoundingClientRect();
    const p = pad == null ? 8 : pad;
    spot.style.display = "block";
    spot.style.top = (r.top - p) + "px";
    spot.style.left = (r.left - p) + "px";
    spot.style.width = (r.width + p * 2) + "px";
    spot.style.height = (r.height + p * 2) + "px";
  }

  function positionTip(target, placement) {
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 14, m = 12;
    if (!target) {
      tip.style.top = Math.max(m, (vh - th) / 2) + "px";
      tip.style.left = Math.max(m, (vw - tw) / 2) + "px";
      return;
    }
    const r = target.getBoundingClientRect();
    let place = placement || "auto";
    if (place === "auto") {
      if (r.bottom + gap + th < vh) place = "bottom";
      else if (r.top - gap - th > 0) place = "top";
      else if (r.right + gap + tw < vw) place = "right";
      else place = "bottom";
    }
    let top, left;
    if (place === "top") { top = r.top - gap - th; left = r.left + r.width / 2 - tw / 2; }
    else if (place === "right") { left = r.right + gap; top = r.top + r.height / 2 - th / 2; }
    else if (place === "left") { left = r.left - gap - tw; top = r.top + r.height / 2 - th / 2; }
    else { top = r.bottom + gap; left = r.left + r.width / 2 - tw / 2; }
    left = Math.max(m, Math.min(left, vw - tw - m));
    top = Math.max(m, Math.min(top, vh - th - m));
    tip.style.top = top + "px";
    tip.style.left = left + "px";
  }

  function scheduleReposition() {
    if (!root || repositionRAF) return;
    repositionRAF = requestAnimationFrame(() => {
      repositionRAF = null;
      const step = steps[idx];
      if (!step) return;
      positionSpot(activeTarget, step.pad);
      positionTip(activeTarget, step.placement);
    });
  }

  async function show(i, dir) {
    dir = dir || 1;
    if (i < 0) i = 0;
    if (i >= steps.length) return finish();
    const step = steps[i];
    let target = null;
    if (step.target) {
      target = await waitFor(step.target, step.wait);
      if (!target) { // element never appeared — skip in the current direction
        const nextI = i + dir;
        if (nextI < 0 || nextI >= steps.length) return finish();
        return show(nextI, dir);
      }
    }
    idx = i;
    activeTarget = target;
    tip.classList.remove("show");
    renderContent(step);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      await sleep(320);
      // target may have moved while scrolling; re-measure
      positionSpot(target, step.pad);
    } else {
      positionSpot(null);
    }
    positionTip(target, step.placement);
    requestAnimationFrame(() => tip.classList.add("show"));
  }

  function teardown() {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", scheduleReposition);
    window.removeEventListener("scroll", scheduleReposition, true);
    if (root) root.remove();
    root = mask = spot = tip = steps = activeTarget = null;
  }

  function finish() {
    const p = page, cb = onComplete;
    markSeen(p);
    teardown();
    if (cb) cb();
  }
  function dismiss() {
    markSeen(page);
    teardown();
  }

  function start(stepList, pageName, complete) {
    if (root) teardown();               // never stack two tours
    steps = stepList; page = pageName; onComplete = complete || null; idx = 0;
    buildDOM();
    show(0, 1);
  }

  function startForPage(pg, force) {
    const list = TOURS[pg];
    if (!list || !list.length) return;
    if (!force && seen(pg)) return;
    start(list, pg, ON_COMPLETE[pg]);
  }

  /* ---------------- header "Guide" button ---------------- */
  function injectHelp() {
    const bar = document.querySelector(".header-actions");
    if (!bar || document.getElementById("tourHelpBtn")) return;
    const pg = currentPage();
    if (!TOURS[pg]) return; // no tour for staff pages
    const btn = document.createElement("button");
    btn.id = "tourHelpBtn";
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm tour-help";
    btn.title = "How it works";
    btn.innerHTML = "❔ <span class='guide-label'>Guide</span>";
    btn.addEventListener("click", () => startForPage(currentPage(), true));
    bar.insertBefore(btn, bar.firstChild);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    injectHelp();
    const pg = currentPage();
    if (!TOURS[pg]) return;
    const continuing = SS.getItem("sps_tour");
    if (pg === "menu" && continuing === "menu") {
      SS.removeItem("sps_tour");
      setTimeout(() => startForPage("menu", true), 400);
      return;
    }
    if (pg !== "track" && !seen(pg)) {   // auto once for index / menu / checkout
      setTimeout(() => startForPage(pg, false), 500);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Public API (replay, reset).
  window.SPSTour = {
    start: (pg) => startForPage(pg || currentPage(), true),
    reset: () => ["index", "menu", "checkout", "track"].forEach((p) => LS.removeItem(seenKey(p))),
  };
})();
