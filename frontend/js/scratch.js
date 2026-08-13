/* Checkout scratch card.
 *
 * The card is drawn server-side — this file only decides when to ask, and how
 * the answer arrives on screen. Two ways in, because a scratch card on a phone
 * means "rub it" and on a laptop means "click it":
 *   - drag across the foil and it erases under the pointer, revealing at ~45%;
 *   - a single tap or click plays the reveal by itself.
 *
 * Anything already won is re-shown face-up. The result is fixed the moment it
 * is drawn, so a reload never rerolls it and there is nothing to be gained by
 * scratching twice.
 */
window.SPSScratch = (function () {
  const { esc, toast } = UI;

  const REVEAL_AT = 0.45;          // fraction erased before it opens itself
  const BRUSH = 22;                // radius of the finger/cursor rub, in px
  const CONFETTI = ["#e9b949", "#f7941d", "#e23a2e", "#1a8f3c", "#fff2cf"];
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- API --- */

  async function fetchCard(phone) {
    try {
      return await API.get(`/api/scratch/card?phone=${encodeURIComponent(phone || "")}`);
    } catch {
      // A card is a bonus, never a blocker: if this call fails the checkout
      // carries on exactly as it did before the feature existed.
      return { enabled: false, state: "off", award: null };
    }
  }

  /* --------------------------------------------------------------- view --- */

  function prizeHTML(award, applied) {
    if (!award) return "";
    if (!award.won) {
      return `
        <div class="sc-prize sc-miss">
          <div class="sc-eyebrow">Scratched</div>
          <div class="sc-label">${esc(award.label || "Better luck next time!")}</div>
          <div class="sc-terms">No coupon this time — your next order gets a fresh card. 🙂</div>
        </div>`;
    }
    const expiry = award.expires_at ? UI.fmtDate(award.expires_at) : "";
    return `
      <div class="sc-prize">
        <div class="sc-eyebrow">🎉 Congratulations, you won</div>
        <div class="sc-label">${esc(award.label)}</div>
        ${award.terms ? `<div class="sc-terms">${esc(award.terms)}</div>` : ""}
        <div class="sc-code">🎟️ ${esc(award.code)}</div>
        <div class="sc-note ${applied ? "applied" : ""}">${
          applied
            ? "✓ Applied to this order"
            : `Yours alone — locked to this phone number${expiry ? ` · valid till ${esc(expiry)}` : ""}`
        }</div>
      </div>`;
  }

  function lockedHTML() {
    return `
      <div class="sc-locked">
        <div class="sc-lock">🎁</div>
        <div><strong>You have a scratch card waiting</strong></div>
        <div class="text-sm">Enter your 10-digit phone number above to unlock it.</div>
      </div>`;
  }

  function foilHTML() {
    return `
      <div class="sc-prize" id="scPrizeSlot"></div>
      <canvas class="sc-foil" id="scFoil"></canvas>
      <div class="sc-shine"></div>
      <div class="sc-hint">Scratch or tap to reveal</div>`;
  }

  /* -------------------------------------------------------------- foil ---- */

  function paintFoil(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const g = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    g.addColorStop(0, "#c9922b");
    g.addColorStop(0.35, "#f0cf78");
    g.addColorStop(0.55, "#b9822a");
    g.addColorStop(1, "#e6b64e");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, rect.width, rect.height);

    // Faint diagonal ribbing, so the foil reads as a physical surface rather
    // than a flat gold rectangle someone forgot to style.
    ctx.strokeStyle = "rgba(255,255,255,.16)";
    ctx.lineWidth = 1;
    for (let x = -rect.height; x < rect.width; x += 9) {
      ctx.beginPath(); ctx.moveTo(x, rect.height); ctx.lineTo(x + rect.height, 0); ctx.stroke();
    }
    ctx.fillStyle = "rgba(20,16,12,.55)";
    ctx.font = "800 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SHIV PANEER SHAWARMA", rect.width / 2, rect.height / 2 - 4);
    ctx.font = "800 11px system-ui, sans-serif";
    ctx.fillText("★ SCRATCH & WIN ★", rect.width / 2, rect.height / 2 + 14);

    ctx.globalCompositeOperation = "destination-out";
    return ctx;
  }

  function erasedFraction(canvas) {
    // Sampled on a grid, not per pixel: this runs on every pointer move on a
    // mid-range phone, and reading ~1200 points is enough to know when roughly
    // half the foil is gone.
    const ctx = canvas.getContext("2d");
    const step = Math.max(6, Math.floor(canvas.width / 40));
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0, total = 0;
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        total++;
        if (data[(y * canvas.width + x) * 4 + 3] < 40) clear++;
      }
    }
    return total ? clear / total : 0;
  }

  function confetti(card) {
    if (reduceMotion()) return;
    const box = document.createElement("div");
    box.className = "sc-confetti";
    for (let i = 0; i < 26; i++) {
      const bit = document.createElement("i");
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = CONFETTI[i % CONFETTI.length];
      bit.style.animationDuration = `${900 + Math.random() * 700}ms`;
      bit.style.animationDelay = `${Math.random() * 260}ms`;
      box.appendChild(bit);
    }
    card.appendChild(box);
    setTimeout(() => box.remove(), 2200);
  }

  /* -------------------------------------------------------------- mount --- */

  /**
   * Render the card into `root`.
   * opts: { card, phone, applied, onAward(award) }
   *   card    - the /api/scratch/card response
   *   applied - whether the won code is already on the current quote
   */
  function mount(root, opts) {
    const { card, phone, applied, onAward } = opts;
    if (!root || !card || !card.enabled) { if (root) root.innerHTML = ""; return; }

    if (card.state === "locked") {
      root.innerHTML = `<div class="sc-wrap"><div class="sc-card">${lockedHTML()}</div></div>`;
      return;
    }
    if (card.state === "revealed") {
      root.innerHTML = `<div class="sc-wrap"><div class="sc-card">${prizeHTML(card.award, applied)}</div></div>`;
      return;
    }

    root.innerHTML = `<div class="sc-wrap"><div class="sc-card" id="scCard">${foilHTML()}</div></div>`;
    const cardEl = root.querySelector("#scCard");
    const canvas = root.querySelector("#scFoil");
    const slot = root.querySelector("#scPrizeSlot");
    let ctx = paintFoil(canvas);
    let drawing = false, moved = false, revealed = false, pending = null, award = null;

    // The draw is fired at first touch, not on mount: until someone actually
    // reaches for the card there is nothing to decide, and a card drawn for a
    // visitor who never scratches would sit open and block their next one.
    function ensureDraw() {
      if (pending) return pending;
      pending = API.post("/api/scratch/draw", { phone })
        .then((res) => { award = res.award; return award; })
        .catch((e) => { toast(e.message, "err"); pending = null; throw e; });
      return pending;
    }

    async function reveal() {
      if (revealed) return;
      revealed = true;
      let won;
      try { won = await ensureDraw(); }
      catch { revealed = false; return; }

      slot.outerHTML = prizeHTML(won, false);
      canvas.classList.add("gone");
      const shine = cardEl.querySelector(".sc-shine");
      const hint = cardEl.querySelector(".sc-hint");
      if (shine) shine.remove();
      if (hint) hint.remove();
      cardEl.classList.add("revealing");
      if (won.won) {
        confetti(cardEl);
        if (navigator.vibrate) navigator.vibrate([18, 40, 18]);
      }
      setTimeout(() => canvas.remove(), 500);
      if (onAward) onAward(won);
    }

    function rub(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      ctx.beginPath();
      ctx.arc(x, y, BRUSH, 0, Math.PI * 2);
      ctx.fill();
      if (erasedFraction(canvas) >= REVEAL_AT) reveal();
    }

    canvas.addEventListener("pointerdown", (e) => {
      drawing = true; moved = false;
      // Capture keeps the rub going when the finger slides off the foil. It is
      // not essential, and it throws for a pointer the browser is not tracking,
      // so a failure here must not take the scratch down with it.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* keep scratching */ }
      ensureDraw().catch(() => {});
      rub(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      moved = true;
      rub(e);
    });
    const stop = () => {
      if (!drawing) return;
      drawing = false;
      // A tap with no drag is the "just show me" gesture — and it is the only
      // one available to anyone driving this by keyboard or assistive tech.
      if (!moved || reduceMotion()) reveal();
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("pointerleave", () => { drawing = false; });

    // Repaint on resize: the canvas bitmap is sized from the laid-out box, so a
    // rotated phone would otherwise stretch the foil (and the erased holes).
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (revealed || !canvas.isConnected) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { ctx = paintFoil(canvas); }, 180);
    });
  }

  return { fetchCard, mount };
})();
