/* Dark / light theme preference for the customer pages.
 *
 * Loaded in <head>, deliberately not deferred: the stored preference has to be
 * on <html data-theme> before the first paint, or the visitor sees one theme
 * flash into the other. That is also why the palettes are plain CSS in
 * theme.css and this file only ever writes one attribute.
 *
 * Three preferences, not two. "System" is the honest default for anyone who has
 * set their phone to a scheme and expects sites to follow it, but the shipped
 * default is **dark**, because dark is this brand's own look and the pages are
 * designed in it — a first visit should not depend on a phone setting. The
 * markup carries data-theme="dark" so that is also what renders when JS is off.
 *
 * The staff pages load none of this on purpose: a back-office tool read on a
 * counter tablet all day stays light.
 */
window.SPSTheme = (function () {
  const KEY = "sps_theme";                       // "system" | "light" | "dark"
  const DEFAULT = "dark";
  const BAR_COLOR = { dark: "#14100c", light: "#fff7ef" };
  const OPTIONS = [
    { pref: "system", icon: "🖥️", label: "System" },
    { pref: "light", icon: "☀️", label: "Light" },
    { pref: "dark", icon: "🌙", label: "Dark" },
  ];

  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function get() {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { /* private mode */ }
    return ["system", "light", "dark"].includes(stored) ? stored : DEFAULT;
  }

  const resolve = (pref) => (pref !== "system" ? pref : (media && media.matches ? "dark" : "light"));

  function paint(pref) {
    const theme = resolve(pref);
    document.documentElement.dataset.theme = theme;
    // The browser's own chrome (address bar, task switcher card) is painted from
    // this tag, so leaving it behind makes the switch look half-applied.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", BAR_COLOR[theme]);
    return theme;
  }

  function set(pref) {
    try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
    paint(pref);
    render();
  }

  // Applied immediately, at parse time — see the note at the top of the file.
  paint(get());

  // Following the system means following it while the page is open, too: phones
  // flip at sunset, and a page left open should flip with them.
  if (media && media.addEventListener) {
    media.addEventListener("change", () => { if (get() === "system") { paint("system"); render(); } });
  }

  /* ------------------------------------------------------------------ UI --- */

  function render() {
    const pref = get();
    const theme = resolve(pref);
    document.querySelectorAll("[data-theme-toggle]").forEach((slot) => {
      const btn = slot.querySelector(".theme-btn");
      if (!btn) return;
      btn.textContent = theme === "dark" ? "🌙" : "☀️";
      btn.setAttribute("aria-label", `Theme: ${OPTIONS.find((o) => o.pref === pref).label}`);
      slot.querySelectorAll("[data-pref]").forEach((b) => {
        b.setAttribute("aria-checked", String(b.dataset.pref === pref));
      });
    });
  }

  function mount(slot) {
    if (slot.dataset.mounted) return;
    slot.dataset.mounted = "1";
    slot.classList.add("theme-switch");
    slot.innerHTML = `
      <button class="theme-btn" type="button" aria-haspopup="true" aria-expanded="false">🌙</button>
      <div class="theme-menu" role="radiogroup" aria-label="Colour theme" hidden>
        ${OPTIONS.map((o) => `
          <button type="button" role="radio" data-pref="${o.pref}" aria-checked="false">
            <span aria-hidden="true">${o.icon}</span><span>${o.label}</span><span class="tick" aria-hidden="true">✓</span>
          </button>`).join("")}
      </div>`;

    const btn = slot.querySelector(".theme-btn");
    const menu = slot.querySelector(".theme-menu");
    const open = (on) => { menu.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };

    btn.addEventListener("click", (e) => { e.stopPropagation(); open(menu.hidden); });
    menu.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pref]");
      if (!pick) return;
      set(pick.dataset.pref);
      open(false);
    });
    // Any tap outside, or Escape, closes it — a popover that needs a second tap
    // on the same small button to dismiss feels stuck.
    document.addEventListener("click", (e) => { if (!slot.contains(e.target)) open(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });
  }

  function mountAll() {
    document.querySelectorAll("[data-theme-toggle]").forEach(mount);
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();

  return { get, set, resolve, current: () => resolve(get()), mountAll };
})();
