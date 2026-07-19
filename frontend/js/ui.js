/* Small UI helpers shared across pages: money formatting, DOM, toast, modal. */
const UI = (() => {
  const money = (n) => `${window.SPS_CONFIG.CURRENCY}${Number(n || 0).toFixed(Number.isInteger(+n) ? 0 : 2)}`;

  // Escape untrusted strings before injecting into innerHTML.
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function toast(message, kind = "") {
    let wrap = el(".toast-wrap");
    if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = message;
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 2600);
  }

  // Generic modal controller. Pass innerHTML for body; returns helpers.
  function modal({ title, bodyHTML, footHTML = "" }) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">×</button></div>
        <div class="modal-body">${bodyHTML}</div>
        ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ""}
      </div>`;
    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => backdrop.classList.add("open"));
    const close = () => {
      backdrop.classList.remove("open");
      document.body.style.overflow = "";
      setTimeout(() => backdrop.remove(), 200);
    };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop || e.target.hasAttribute("data-close")) close(); });
    document.addEventListener("keydown", function onEsc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } });
    return { backdrop, close, body: el(".modal-body", backdrop), foot: el(".modal-foot", backdrop) };
  }

  function statusLabel(s) {
    return String(s || "").replace(/_/g, " ");
  }

  /* ---------------- date/time (always shown in IST) ----------------
     The backend stores timestamps as naive UTC and serialises them with no
     timezone offset (e.g. "2026-07-18T12:44:00"). A browser parses such a
     string as *local* time, so it ends up echoing the raw UTC clock. We force
     UTC, then format in Asia/Kolkata so every visitor sees IST regardless of
     their device timezone. */
  const IST_TZ = "Asia/Kolkata";
  function _toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value) ? null : value;
    let s = String(value);
    // Append 'Z' when the string carries no timezone (naive UTC from the API).
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  // "18 Jul 2026, 6:14 pm IST"
  function fmtDateTime(value) {
    const d = _toDate(value);
    if (!d) return "";
    return d.toLocaleString("en-IN", {
      timeZone: IST_TZ, day: "2-digit", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }) + " IST";
  }
  // "6:14 pm IST"
  function fmtTime(value) {
    const d = _toDate(value);
    if (!d) return "";
    return d.toLocaleTimeString("en-IN", {
      timeZone: IST_TZ, hour: "numeric", minute: "2-digit", hour12: true,
    }) + " IST";
  }

  return { money, esc, el, els, toast, modal, statusLabel, fmtDateTime, fmtTime };
})();
