/* Staff/owner live orders board: list, advance status, verify payment. */
(function () {
  const { money, esc, el, els, toast, modal, statusLabel, fmtDateTime, fmtTime, istDateISO, fmtDate, phoneIntl } = UI;

  const FLOW = {
    delivery: ["placed", "confirmed", "preparing", "packing", "ready", "on_the_way", "delivered"],
    takeaway: ["placed", "confirmed", "preparing", "packing", "ready", "picked_up"],
    dine_in: ["placed", "confirmed", "preparing", "ready", "served"],
  };
  const TYPE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
  const TYPE_EMOJI = { dine_in: "🍽️", takeaway: "🥡", delivery: "🛵" };
  const SHOP = "Shiv Paneer Shawarma";

  let filter = "all";
  let activeOnly = true;
  let dateFilter = istDateISO();   // IST "YYYY-MM-DD"; "" = all dates
  let user = null;
  // Last rendered board, keyed by public_id: the WhatsApp bill needs the whole
  // order object and a data- attribute can only carry the id.
  let ordersById = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    user = await Auth.requireAuth();
    el("#whoami").textContent = `${user.name || user.email} · ${user.role}`;
    if (user.role === "owner") {
      el("#navMenu").classList.remove("hidden");
      el("#navCustomers").classList.remove("hidden");
      el("#navReviews").classList.remove("hidden");
    }
    el("#logoutBtn").addEventListener("click", async () => { await Auth.logout(); location.href = "login.html"; });
    els("[data-filter]").forEach((c) => c.addEventListener("click", () => {
      els("[data-filter]").forEach((x) => x.classList.remove("active"));
      c.classList.add("active"); filter = c.dataset.filter; load();
    }));
    el("#activeOnly").addEventListener("change", (e) => { activeOnly = e.target.checked; load(); });

    // Date picker: defaults to today (IST). Max is today so future dates can't be chosen.
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
    syncDateButtons();

    el("#refreshBtn").addEventListener("click", load);
    Alerts.init();
    WA.init();
    await load();
  }

  /* No board auto-refresh. The 2-min timer and the reload-on-tab-visible that
     used to sit here were removed at the owner's request (2026-09-09): the
     board reloads when ↻ is tapped, when a filter or date changes, when a
     status is set — and when the alert poll spots a new order, if alerts are
     on. Every other reload was a request nobody asked for. */

  /* ------------------------------------------------------------------ *
   * New-order sound alerts (owner-only, opt-in, page-open only).
   * Polls the tiny /latest probe every POLL_MS while alerts are on and
   * the tab is visible; on a newer order id it chimes, shows a browser
   * notification, and refreshes the board. Kept off by default because
   * browsers block audio until the owner arms it with a tap.
   * ------------------------------------------------------------------ */
  /* Alert-sound picker: preset tones (synthesised) OR a user-uploaded file,
     at a chosen volume. All saved per-device in localStorage — a website can't
     read the phone's own ringtone, so each device picks its own tone here. */
  const Sound = (function () {
    const SEL_KEY = "sps_alert_sound";        // preset key or "custom"
    const VOL_KEY = "sps_alert_volume";       // "0".."1"
    const CUSTOM_KEY = "sps_alert_custom";    // data URL of uploaded audio
    const NAME_KEY = "sps_alert_custom_name"; // display name of uploaded file
    const MAX_BYTES = 1024 * 1024;            // ~1 MB cap (localStorage-friendly)
    // Preset keys that map to a shipped audio file (played via <audio>, not synth).
    const FILE_PRESETS = { notify: "../assets/audio/notify.mp3" };
    let ctx = null;

    const customUrl = () => localStorage.getItem(CUSTOM_KEY) || "";
    const customName = () => localStorage.getItem(NAME_KEY) || "";
    function sel() {
      const s = localStorage.getItem(SEL_KEY) || "notify";
      return s === "custom" && !customUrl() ? "notify" : s;
    }
    const setSel = (v) => localStorage.setItem(SEL_KEY, v);
    function vol() {
      const v = parseFloat(localStorage.getItem(VOL_KEY));
      return isNaN(v) ? 0.9 : Math.min(1, Math.max(0, v));
    }
    const setVol = (v) => localStorage.setItem(VOL_KEY, String(v));

    function ensure() {
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
      } catch { /* Web Audio unavailable; custom files still play via <audio> */ }
    }

    // Read a chosen file into a data URL, store it, and return a promise.
    function saveCustom(file) {
      return new Promise((resolve, reject) => {
        if (!file) return reject(new Error("No file"));
        if (file.size > MAX_BYTES) return reject(new Error("Please pick an audio file under 1 MB."));
        const reader = new FileReader();
        reader.onload = () => {
          localStorage.setItem(CUSTOM_KEY, reader.result);
          localStorage.setItem(NAME_KEY, file.name || "Custom sound");
          setSel("custom");
          resolve();
        };
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
    }

    function play(opts) {
      opts = opts || {};
      const v = vol();
      if (v <= 0) return;                       // volume slider at 0 = muted
      const s = sel();
      if (FILE_PRESETS[s]) {
        try { const a = new Audio(FILE_PRESETS[s]); a.volume = v; a.play().catch(() => {}); }
        catch { synth("alarm", v); }
      } else if (s === "custom") {
        try { const a = new Audio(customUrl()); a.volume = v; a.play().catch(() => {}); }
        catch { synth("alarm", v); }
      } else {
        synth(s, v);
      }
      if (opts.alert && navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    }

    // Synthesise a preset. Routed through a limiter so it's loud, not distorted.
    function synth(key, v) {
      if (!ctx) return;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      const master = ctx.createGain();
      master.gain.value = v;
      master.connect(limiter).connect(ctx.destination);
      const t0 = ctx.currentTime;
      const tone = (type, freq, start, dur, level) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(level, start + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(g).connect(master);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      };
      if (key === "ding") {
        tone("sine", 987.77, t0, 0.5, 0.9);
      } else if (key === "chime") {
        tone("sine", 880, t0, 0.5, 0.8);
        tone("sine", 1174.66, t0 + 0.18, 0.6, 0.8);
      } else if (key === "bell") {
        [[523.25, 0.9, 1.6], [1046.5, 0.5, 1.4], [1567.98, 0.25, 1.0], [2093, 0.15, 0.8]]
          .forEach(([f, l, d]) => tone("sine", f, t0, d, l));
      } else { // "alarm" — urgent three-beep sine + sawtooth stack
        for (let i = 0; i < 3; i++) {
          const t = t0 + i * 0.22;
          tone("sine", 880, t, 0.18, 0.7);
          tone("sawtooth", 587.33, t, 0.18, 0.35);
        }
      }
    }

    return { ensure, play, saveCustom, sel, setSel, vol, setVol, customName, customUrl };
  })();

  const Alerts = (function () {
    const POLL_MS = 15000;
    const KEY = "sps_order_alerts";
    let on = false;
    let timer = null;
    let lastSeenId = null;
    let seeded = false;

    function init() {
      const btn = el("#alertsBtn");
      if (!btn) return;
      btn.addEventListener("click", toggle);
      initSoundControls();
      if (localStorage.getItem(KEY) === "1") {
        // Persisted on, but audio needs a user gesture to unlock after a
        // reload — resume it on the owner's first interaction with the page.
        enable(false);
        const unlock = () => { Sound.ensure(); document.removeEventListener("click", unlock); document.removeEventListener("keydown", unlock); };
        document.addEventListener("click", unlock);
        document.addEventListener("keydown", unlock);
      }
      document.addEventListener("visibilitychange", () => {
        if (on && document.visibilityState === "visible") poll();
      });
      render();
    }

    // Wire the preset dropdown, volume slider, preview, and custom upload.
    function initSoundControls() {
      const select = el("#alertSound");
      const range = el("#alertVol");
      const preview = el("#alertPreview");
      const upload = el("#alertUpload");
      if (!select || !range) return;

      // Add the "custom" option if the owner uploaded a file previously.
      if (Sound.customUrl()) addCustomOption(Sound.customName());
      select.value = Sound.sel();
      range.value = Sound.vol();

      select.addEventListener("change", () => {
        Sound.setSel(select.value);
        Sound.ensure();
        Sound.play({ preview: true });   // let them hear the pick immediately
      });
      range.addEventListener("change", () => {
        Sound.setVol(parseFloat(range.value));
        Sound.ensure();
        Sound.play({ preview: true });
      });
      if (preview) preview.addEventListener("click", () => { Sound.ensure(); Sound.play({ preview: true }); });
      if (upload) upload.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          await Sound.saveCustom(file);
          addCustomOption(Sound.customName());
          select.value = "custom";
          Sound.ensure();
          Sound.play({ preview: true });
          toast("🎵 Custom alert sound saved on this device", "ok");
        } catch (err) {
          toast(err.message, "err");
        } finally {
          e.target.value = "";   // allow re-picking the same file later
        }
      });
    }

    function addCustomOption(name) {
      const select = el("#alertSound");
      if (!select) return;
      let opt = select.querySelector('option[value="custom"]');
      if (!opt) { opt = document.createElement("option"); opt.value = "custom"; select.appendChild(opt); }
      opt.textContent = `🎵 ${name || "Custom"}`;
    }

    function toggle() {
      if (on) { disable(); } else { enable(true); }
    }

    function enable(fromGesture) {
      on = true;
      localStorage.setItem(KEY, "1");
      if (fromGesture) {
        Sound.ensure();
        Sound.play({ preview: true });   // confirmation: play the chosen tone once
        if (window.Notification && Notification.permission === "default") {
          Notification.requestPermission();
        }
      }
      seeded = false;
      seed().then(() => { if (timer) clearInterval(timer); timer = setInterval(poll, POLL_MS); });
      render();
      if (fromGesture) toast("🔔 Order alerts on", "ok");
    }

    function disable() {
      on = false;
      localStorage.removeItem(KEY);
      if (timer) { clearInterval(timer); timer = null; }
      render();
      toast("🔕 Order alerts off", "");
    }

    function render() {
      const btn = el("#alertsBtn");
      if (!btn) return;
      btn.textContent = on ? "🔔 Alerts on" : "🔕 Alerts off";
      btn.classList.toggle("btn-primary", on);
      btn.classList.toggle("btn-ghost", !on);
    }

    // Record the current newest order id without alerting (avoids chiming for
    // the backlog that already exists when alerts are switched on).
    async function seed() {
      try {
        const { latest_id } = await API.get("/api/admin/orders/latest");
        lastSeenId = latest_id;
        seeded = true;
      } catch { /* leave unseeded; poll will retry */ }
    }

    async function poll() {
      if (!on || document.visibilityState !== "visible") return;
      let latest_id;
      try { ({ latest_id } = await API.get("/api/admin/orders/latest")); }
      catch (e) { if (e.status === 401) location.href = "login.html"; return; }
      if (!seeded) { lastSeenId = latest_id; seeded = true; return; }
      if (latest_id && latest_id !== lastSeenId) {
        lastSeenId = latest_id;
        Sound.play({ alert: true });
        notify(latest_id);
        toast(`🔔 New order ${latest_id}`, "ok");
        load();
      }
    }

    function notify(id) {
      if (!(window.Notification && Notification.permission === "granted")) return;
      try {
        const n = new Notification("🔔 New order — Shiv Paneer Shawarma", {
          body: `${id} just came in. Tap to open the board.`,
          tag: "sps-new-order",
          renotify: true,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* some mobile browsers require a service worker; skip quietly */ }
    }

    return { init, seed };
  })();

  /* ------------------------------------------------------------------ *
   * WhatsApp bill: a thank-you + the full invoice, sent to the customer.
   * wa.me can only carry plain text, so the bill is laid out in lines with
   * WhatsApp's own *bold* markers rather than a table. The draft opens in a
   * modal first — the owner can reword it, and nothing is sent until they
   * tap send inside WhatsApp itself.
   * ------------------------------------------------------------------ */
  const WA = (function () {
    let reviewsOn = false;

    async function init() {
      try { reviewsOn = !!(await API.get("/api/settings")).reviews_enabled; }
      catch { /* the review line is optional; drop it if settings can't be read */ }
    }

    const pageUrl = (file, id) => new URL(`../${file}?id=${encodeURIComponent(id)}`, location.href).href;

    /* What they actually ate, for the thank-you line. Deduped and listed the
       way a person would say it: "your Paneer Shawarma and Chicken Roll" is the
       line the owner wrote, and an item count is not a substitute for it. */
    function itemNames(o) {
      const names = [...new Set((o.items || []).map((i) => String(i.name || "").trim()).filter(Boolean))];
      if (!names.length) return "shawarma";
      if (names.length === 1) return names[0];
      return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }

    function itemLine(i) {
      const variant = i.variant_label ? ` (${i.variant_label})` : "";
      const free = i.free_quantity ? ` +${i.free_quantity} free` : "";
      const promo = i.promo_label ? ` [${i.promo_label}]` : "";
      return `• ${i.quantity}× ${i.name}${variant}${free}${promo} — ${money(i.line_total)}`;
    }

    function message(o) {
      const name = ((o.customer && o.customer.name) || "").trim();
      const cancelled = o.status === "cancelled";
      const L = [];

      L.push(name ? `Namaste ${name} 🙏` : "Namaste 🙏");
      /* The greeting no longer splits on repeat_no. The order block below
         already carries "your 3rd order with us", and the owner's wording
         welcomes a returning customer and a first-timer the same way — as
         family — which is the point of it. */
      L.push(cancelled
        ? `Your order with *${SHOP}* has been cancelled. Here are the details for your records.`
        : "🌯❤️ Thank you for being a part of our Shawarma Family!❤️🌯");
      L.push("");

      L.push(`*Order ${o.public_id}*`);
      if (o.created_at) L.push(`🗓 ${fmtDateTime(o.created_at)}`);
      if (o.repeat_no > 1) L.push(`🔁 Your ${ordinal(o.repeat_no)} order with us`);
      L.push(`${TYPE_EMOJI[o.order_type] || "🍽️"} ${TYPE_LABEL[o.order_type] || o.order_type}`);
      L.push("");

      L.push("*Your bill*");
      o.items.forEach((i) => L.push(itemLine(i)));

      /* Same rule as the card: show the subtotal only when something moves it,
         otherwise the subtotal and the total are the same number twice. */
      if (o.promo_discount > 0 || o.coupon_discount > 0 || o.delivery_fee > 0) {
        L.push(`Subtotal: ${money(o.subtotal)}`);
      }
      if (o.promo_discount > 0) {
        const labels = [...new Set(o.items.map((i) => i.promo_label).filter(Boolean))];
        L.push(`Offers${labels.length ? ` · ${labels.join(", ")}` : ""}: − ${money(o.promo_discount)}`);
      }
      if (o.coupon_discount > 0) {
        L.push(`Coupon${o.coupon_code ? ` ${o.coupon_code}` : ""}: − ${money(o.coupon_discount)}`);
      }
      if (o.delivery_fee > 0) {
        L.push(`Delivery${o.delivery_area ? ` · ${o.delivery_area}` : ""}: ${money(o.delivery_fee)}`);
      }
      L.push(`*Total: ${money(o.total)}*`);
      L.push("");

      if (o.payment) {
        L.push(`💳 ${payLabel(o.payment)}${o.payment.upi_reference ? ` · UTR ${o.payment.upi_reference}` : ""}`);
      }
      if (o.order_type === "delivery" && o.customer && o.customer.address) {
        L.push(`🛵 Deliver to: ${o.customer.address}`);
      }
      if (!cancelled) L.push(`📦 Status: ${statusLabel(o.status)}`);
      L.push("");

      if (cancelled) {
        L.push("Sorry for the trouble — do order again, we'd love to make it right.");
      } else {
        L.push(`Track your order: ${pageUrl("track.html", o.public_id)}`);
        L.push("");
        /* The owner's own words, kept as written. Blank lines between each part
           on purpose: WhatsApp renders one long paragraph as a wall of text on
           a phone, and this is the half of the message the customer is meant to
           read rather than check. */
        L.push(`We truly hope you loved your *${itemNames(o)}* and that every bite made you happy! 😋`);
        L.push("");
        L.push("We'd love to see you again and again. Your love and support mean a lot to us! 🥰");
        L.push("");
        L.push("And hey, if you have any suggestions or feedback, please don't hesitate to share them "
             + "with us. Tell us honestly — just like you would with a friend or family member. ❤️");
        // The review link belongs with the ask for feedback, not off on its own.
        if (reviewsOn) L.push(`Tell us here: ${pageUrl("review.html", o.public_id)}`);
        L.push("");
        L.push("Your feedback helps us make your next shawarma even better! 🌯✨");
        L.push("");
        L.push("Thank you for choosing us! See you again soon! ❤️");
      }
      L.push(`— ${SHOP}`);
      return L.join("\n");
    }

    function open(o) {
      const phone = phoneIntl(o.customer && o.customer.phone);
      const m = modal({
        title: `WhatsApp bill · ${o.public_id}`,
        bodyHTML: `
          <p class="text-sm text-muted" style="margin-top:0;">Edit anything you like, then open WhatsApp — the message goes in ready to send.</p>
          <textarea class="input wa-draft" id="waText" rows="18"></textarea>
          ${phone
            ? `<p class="text-sm text-muted" style="margin-bottom:0;">Sending to +${esc(phone)}</p>`
            : `<p class="text-sm" style="color:var(--err-ink);margin-bottom:0;">No usable phone number on this order — copy the bill and send it yourself.</p>`}`,
        footHTML: `<div class="row">
            <button class="btn btn-outline grow" id="waCopy">Copy</button>
            <button class="btn btn-primary grow" id="waSend" ${phone ? "" : "disabled"}>💬 Open WhatsApp</button>
          </div>`,
      });

      /* Set as .value, never as markup: the bill carries customer-typed names
         and addresses, and this keeps them text. */
      const ta = el("#waText", m.backdrop);
      ta.value = message(o);

      el("#waCopy", m.backdrop).addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(ta.value); toast("Bill copied", "ok"); }
        catch { ta.select(); toast("Press Ctrl+C to copy", ""); }
      });
      if (phone) {
        el("#waSend", m.backdrop).addEventListener("click", () => {
          window.open(`https://wa.me/${phone}?text=${encodeURIComponent(ta.value)}`, "_blank", "noopener");
          m.close();
        });
      }
    }

    return { init, open };
  })();

  /* "3rd order" reads faster than a bare count. Orders placed before the
     repeat count was recorded have none, and are left unlabelled rather than
     shown as a first visit. */
  function ordinal(n) {
    if (!n) return "";
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
    return `${n}${suffix}`;
  }

  // Highlight whichever date shortcut matches the current selection.
  function syncDateButtons() {
    const isToday = dateFilter === istDateISO();
    el("#todayBtn").classList.toggle("active", isToday && !!dateFilter);
    el("#allDatesBtn").classList.toggle("active", !dateFilter);
  }

  async function load() {
    const btn = el("#refreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    let path = `/api/admin/orders?active_only=${activeOnly}`;
    if (filter !== "all") path += `&order_type=${filter}`;
    if (dateFilter) path += `&date=${dateFilter}`;
    try {
      const { orders } = await API.get(path);
      render(orders);
      el("#lastUpdated").textContent = `· updated ${fmtTime(new Date())}`;
    } catch (e) {
      if (e.status === 401) { location.href = "login.html"; return; }
      el("#ordersBoard").innerHTML = `<div class="empty"><div class="emoji">⚠️</div><p>${esc(e.message)}</p></div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh"; }
    }
  }

  function render(orders) {
    if (!orders.length) {
      const when = dateFilter
        ? (dateFilter === istDateISO() ? "today" : `on ${fmtDate(dateFilter)}`)
        : "";
      el("#ordersBoard").innerHTML = `<div class="empty"><div class="emoji">🍽️</div><h3>No ${activeOnly ? "active " : ""}orders${when ? " " + esc(when) : ""}</h3>
        <p class="text-muted">Pick another date or tap “All dates” to see more.</p></div>`;
      return;
    }
    ordersById = Object.fromEntries(orders.map((o) => [o.public_id, o]));
    el("#ordersBoard").innerHTML = `<div class="orders-grid">${orders.map(card).join("")}</div>`;
    els("[data-advance]").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.id, b.dataset.advance)));
    els("[data-cancel]").forEach((b) => b.addEventListener("click", () => {
      if (confirm("Cancel this order?")) setStatus(b.dataset.cancel, "cancelled");
    }));
    els("[data-verify]").forEach((b) => b.addEventListener("click", () => verifyPay(b.dataset.verify, b.dataset.result)));
    els("[data-wa]").forEach((b) => b.addEventListener("click", () => {
      const o = ordersById[b.dataset.wa];
      if (o) WA.open(o);
    }));
    els("[data-invoice]").forEach((b) => b.addEventListener("click", () => {
      const o = ordersById[b.dataset.invoice];
      if (o) Invoice.open(o);
    }));
  }

  function card(o) {
    const steps = FLOW[o.order_type] || FLOW.takeaway;
    const idx = steps.indexOf(o.status);
    const next = idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null;
    const terminal = ["delivered", "picked_up", "served", "cancelled"].includes(o.status);
    const created = o.created_at ? fmtDateTime(o.created_at) : "";

    const items = o.items.map((i) =>
      `<div class="oc-item"><span><span class="q">${i.quantity}×</span> ${esc(i.name)} <span class="text-muted">${esc(i.variant_label || "")}</span>${i.free_quantity ? ` <span class="oc-free">+${i.free_quantity} free</span>` : ""}${i.promo_label ? ` <span class="oc-free">${esc(i.promo_label)}</span>` : ""}</span>
        <span>${money(i.line_total)}</span></div>`).join("");

    /* Discount lines. The card used to jump straight from the item prices to a
       smaller Total, so a counter handling a coupon order had no way to tell
       whether the gap was an offer, a coupon or a mistake. */
    const bill = [];
    if (o.promo_discount > 0 || o.coupon_discount > 0 || o.delivery_fee > 0) {
      bill.push(`<div class="oc-line"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>`);
    }
    if (o.promo_discount > 0) {
      const labels = [...new Set(o.items.map((i) => i.promo_label).filter(Boolean))];
      bill.push(`<div class="oc-line disc"><span>${labels.length ? `Offers · ${esc(labels.join(", "))}` : "Offers"}</span><span>− ${money(o.promo_discount)}</span></div>`);
    }
    if (o.coupon_discount > 0) {
      bill.push(`<div class="oc-line disc"><span>Coupon ${esc(o.coupon_code || "")}</span><span>− ${money(o.coupon_discount)}</span></div>`);
    }
    if (o.delivery_fee > 0) {
      bill.push(`<div class="oc-line"><span>${o.delivery_area ? `Delivery · ${esc(o.delivery_area)}` : "Delivery fee"}</span><span>${money(o.delivery_fee)}</span></div>`);
    }

    /* A returning customer is worth seeing before the order is even started —
       it changes how the counter greets them. */
    const repeat = o.repeat_no > 1 ? `<span class="oc-repeat">🔁 ${esc(ordinal(o.repeat_no))} order</span>` : "";
    const cust = o.customer ? `<div class="oc-cust">
      👤 ${esc(o.customer.name || "—")} · 📞 ${esc(o.customer.phone || "—")} ${repeat}
      ${o.order_type === "delivery" && o.customer.address ? `<br/>🛵 ${esc(o.customer.address)}` : ""}
      ${o.customer.lat ? `<br/><a href="https://maps.google.com/?q=${o.customer.lat},${o.customer.lng}" target="_blank" rel="noopener">📍 View on map</a>` : ""}
    </div>` : "";

    const payRow = `<div class="row-between" style="margin-bottom:8px;">
      <span class="pay-pill ${o.payment.status}">${esc(payLabel(o.payment))}</span>
      ${o.payment.upi_reference ? `<span class="text-xs text-muted" style="font-size:var(--fs-xs);">UTR: ${esc(o.payment.upi_reference)}</span>` : ""}
    </div>`;

    let verifyBtns = "";
    if (o.payment.status === "awaiting_verification") {
      verifyBtns = `<div class="row" style="margin-bottom:8px;">
           <button class="btn btn-sm btn-primary grow" data-verify="${esc(o.public_id)}" data-result="paid">✓ Confirm payment</button>
           <button class="btn btn-sm btn-danger" data-verify="${esc(o.public_id)}" data-result="failed">Reject</button>
         </div>`;
    } else if (o.payment.status === "pending" && o.status !== "cancelled") {
      // Cash (or UPI with no reference yet): let the owner confirm payment on hand-over.
      const label = o.payment.method === "cash" ? "✓ Mark cash received" : "✓ Mark as paid";
      verifyBtns = `<div class="row" style="margin-bottom:8px;">
           <button class="btn btn-sm btn-primary grow" data-verify="${esc(o.public_id)}" data-result="paid">${label}</button>
         </div>`;
    }

    const actions = terminal
      ? `<div class="text-sm text-muted">Order ${esc(statusLabel(o.status))}.</div>`
      : `<div class="row">
           ${next ? `<button class="btn btn-sm btn-primary grow" data-advance="${esc(next)}" data-id="${esc(o.public_id)}">Mark ${esc(statusLabel(next))} →</button>` : ""}
           <button class="btn btn-sm btn-danger" data-cancel="${esc(o.public_id)}">Cancel</button>
         </div>`;

    /* The bill goes out on WhatsApp, so it sits on its own row rather than
       competing for width with the status and cancel buttons. */
    const waBtn = `<div class="row" style="margin-bottom:8px;">
        <button class="btn btn-sm btn-outline grow" data-wa="${esc(o.public_id)}">💬 WhatsApp bill</button>
        <button class="btn btn-sm btn-outline grow" data-invoice="${esc(o.public_id)}">🖨 Invoice</button>
      </div>`;

    return `<article class="order-card type-${o.order_type}">
      <div class="oc-head">
        <div><div class="oc-id">${esc(o.public_id)}</div><div class="oc-meta">${esc(created)}${
          o.channel === "counter" ? ` · 🧑‍🍳 counter${o.placed_by ? ` · ${esc(o.placed_by)}` : ""}` : ""}</div></div>
        <div style="text-align:right;">
          <span class="type-tag ${o.order_type}">${esc(TYPE_LABEL[o.order_type])}</span>
          <div style="margin-top:6px;"><span class="status-pill ${o.status}">${esc(statusLabel(o.status))}</span></div>
        </div>
      </div>
      <div class="oc-body">
        ${items}
        ${bill.join("")}
        <div class="row-between" style="margin-top:8px;font-weight:800;"><span>Total</span><span>${money(o.total)}</span></div>
        ${cust}
      </div>
      <div class="oc-foot">
        ${payRow}
        ${verifyBtns}
        ${waBtn}
        ${actions}
      </div>
    </article>`;
  }

  function payLabel(p) {
    const map = { paid: "Paid", awaiting_verification: "Verify payment", pending: "Unpaid", failed: "Payment failed" };
    return `${p.method === "upi" ? "UPI" : "Cash"} · ${map[p.status] || p.status}`;
  }

  async function setStatus(id, status) {
    try { await API.post(`/api/admin/orders/${encodeURIComponent(id)}/status`, { status }); toast(`${id} → ${statusLabel(status)}`, "ok"); load(); }
    catch (e) { toast(e.message, "err"); }
  }
  async function verifyPay(id, result) {
    try { await API.post(`/api/admin/orders/${encodeURIComponent(id)}/verify-payment`, { status: result }); toast(`Payment ${result}`, result === "paid" ? "ok" : ""); load(); }
    catch (e) { toast(e.message, "err"); }
  }
})();
