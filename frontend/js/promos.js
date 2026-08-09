/* Active offers, rendered from /api/promos on every public page.

   The offer copy used to be typed into index.html, menu.html and the sticky
   bar by hand, so switching a promo off in the admin left the site still
   advertising it. Pages now declare *where* an offer goes and this file fills
   it in from the live promos:

     <div data-promos="band"></div>     landing-page offer card(s)
     <div data-promos="strip"></div>    compact list (menu, checkout)
     <span data-promos="line"></span>   one sentence of running-offer text
     <div data-promos="faq"></div>      one <details> per offer

   Anything already inside such an element is the no-JS / pre-load fallback and
   stays visible until the API answers. If there are no active promos, the
   element is emptied and hidden, along with its closest [data-promo-section] —
   so an offer band disappears from the page entirely rather than sitting there
   empty. */
const Promos = (() => {
  // Promo text is owner-entered through the admin, so it is untrusted here.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let promise = null;

  /* One request per page load, shared by every mount point. Failures resolve to
     [] rather than reject: an offer banner is never worth breaking a page for,
     and the static fallback markup is left alone in that case. */
  function load() {
    if (!promise) {
      promise = API.get("/api/promos")
        .then((r) => (r && r.promos) || [])
        .catch(() => null);
    }
    return promise;
  }

  const appliesTo = (p) => (p.store_wide ? "the whole menu" : p.applies_to_text || "");

  function bandHTML(p) {
    return `
      <div class="card lp-offer">
        <div class="t">
          <span class="tag">Running now</span>
          <h3>${esc(p.label)}</h3>
          <p>${esc(p.description)}</p>
          <p class="promo-terms">${esc(p.conditions)}</p>
        </div>
        <a class="btn lp-btn-gold btn-lg" href="menu.html">Claim it →</a>
      </div>`;
  }

  function stripHTML(p) {
    const on = appliesTo(p);
    return `
      <div class="promo-item">
        <span class="badge badge-offer">${esc(p.label)}</span>
        <div class="promo-body">
          ${on ? `<div class="promo-on">On ${esc(on)}</div>` : ""}
          <p class="promo-desc">${esc(p.description)}</p>
          <p class="promo-terms">${esc(p.conditions)}</p>
        </div>
      </div>`;
  }

  function faqHTML(p) {
    return `
      <details>
        <summary>What is the ${esc(p.label)} offer?</summary>
        <p>${esc(p.description)}</p>
        <p class="promo-terms">${esc(p.conditions)}</p>
      </details>`;
  }

  /* One sentence, for places with room for a line and not a card. */
  function lineHTML(p) {
    const on = appliesTo(p);
    return `<b>${esc(p.label)}</b>${on ? ` on ${esc(on)}` : ""}`;
  }

  const RENDERERS = {
    band: (list) => list.map(bandHTML).join(""),
    strip: (list) => `<div class="promo-strip">${list.map(stripHTML).join("")}</div>`,
    faq: (list) => list.map(faqHTML).join(""),
    // Only the headline offer gets the one-liner; the rest would not fit.
    line: (list) => lineHTML(list[0]),
  };

  function fill(node, list) {
    const render = RENDERERS[node.dataset.promos];
    if (!render) return;
    const section = node.closest("[data-promo-section]");
    if (!list.length) {
      node.innerHTML = "";
      node.hidden = true;
      if (section) section.hidden = true;
      return;
    }
    node.innerHTML = render(list);
    node.hidden = false;
    if (section) section.hidden = false;
  }

  /* Fill every declared mount point on the page. Called automatically on load;
     exported too, for pages that inject their own markup after that (checkout
     re-renders its whole root). */
  async function mount(root) {
    const nodes = (root || document).querySelectorAll("[data-promos]");
    if (!nodes.length) return;
    const list = await load();
    if (!list) return;              // request failed — keep the static fallback
    nodes.forEach((n) => fill(n, list));
  }

  document.addEventListener("DOMContentLoaded", () => mount());

  return { load, mount, lineHTML, esc };
})();
