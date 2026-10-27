/* Which branch a customer is ordering from.

   Picked from the QR on the table or a shared link (?b=<link name>), or from
   the picker when someone lands on the bare site. The choice stays on this
   device, and every request then carries ?branch= through API.setParams, so the
   menu, prices, delivery areas, ordering switch and payment QR are all that
   branch's without any page passing it by hand.

   With only one branch open there is nothing to choose and nothing is shown —
   the site looks exactly as it did before branches. A saved branch that has
   since closed for good falls back to the picker rather than an error page. */
const SiteBranch = (() => {
  const KEY = "sps_branch_v1";
  const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

  // From the link first: a QR scanned today beats what was saved last week.
  const fromLink = new URLSearchParams(location.search).get("b");
  if (fromLink) write(fromLink.toLowerCase());
  if (read()) API.setParams({ branch: read() });

  let list = [];
  let current = null;
  let readyPromise = null;

  function ready() {
    if (!readyPromise) readyPromise = settle();
    return readyPromise;
  }

  async function settle() {
    try { list = (await API.get("/api/branches")).branches || []; }
    catch { return null; }   // offline: carry on with whatever is saved
    current = list.find((b) => b.slug === read()) || null;
    if (!current && list.length === 1) current = list[0];
    if (!current && list.length > 1) current = await pick(false);
    if (!current) current = list.find((b) => b.is_main) || list[0] || null;
    if (current) { write(current.slug); API.setParams({ branch: current.slug }); }
    if (list.length > 1) bar();
    return current;
  }

  /* The picker: one tap per branch. Closable only when a branch is already
     chosen — otherwise closing it just picks Main, so nobody is left on a page
     with no menu. */
  function pick(closable) {
    return new Promise((resolve) => {
      const m = UI.modal({
        title: "Which branch are you ordering from?",
        bodyHTML: list.map((b) => `
          <button class="branch-option" data-slug="${UI.esc(b.slug)}">
            <strong>📍 ${UI.esc(b.name)}</strong>
            ${b.address ? `<span>${UI.esc(b.address)}</span>` : ""}
            ${b.timings ? `<span>🕒 ${UI.esc(b.timings)}</span>` : ""}
            ${b.ordering_enabled ? "" : `<span class="branch-closed">Not taking online orders right now</span>`}
          </button>`).join(""),
      });
      let done = false;
      const finish = (b) => { if (done) return; done = true; resolve(b); };
      UI.els("[data-slug]", m.backdrop).forEach((x) => x.addEventListener("click", () => {
        finish(list.find((b) => b.slug === x.dataset.slug));
        m.close();
      }));
      // Any other way out of the dialog (×, backdrop, Esc).
      new MutationObserver((_, obs) => {
        if (!document.body.contains(m.backdrop)) { obs.disconnect(); finish(closable ? current : null); }
      }).observe(document.body, { childList: true });
    });
  }

  /* A slim bar under the header naming the branch, tappable to change it.
     Changing reloads the page: the cart stays (it is on this device), and the
     reload re-prices it at the new branch, flagging anything not sold there. */
  function bar() {
    const header = document.querySelector(".site-header");
    if (!header || !current || document.getElementById("branchBar")) return;
    header.insertAdjacentHTML("afterend", `
      <div class="branch-bar" id="branchBar"><div class="container">
        <span>📍 Ordering from <strong>${UI.esc(current.name)}</strong></span>
        <button class="btn btn-ghost btn-sm" id="branchChange">Change</button>
      </div></div>`);
    document.getElementById("branchChange").addEventListener("click", async () => {
      const b = await pick(true);
      if (b && b.slug !== current.slug) switchTo(b.slug);
    });
  }

  function switchTo(slug) {
    write(slug);
    // Drop ?b= so the reload does not put the old branch straight back.
    const url = new URL(location.href);
    url.searchParams.delete("b");
    location.href = url.toString();
  }

  /* "Closed here, open there": the other branches taking orders right now,
     offered on the closed banner so a customer is one tap from ordering. */
  const openElsewhere = () => list.filter((b) => b.ordering_enabled && (!current || b.slug !== current.slug));

  /* Buttons for the closed banner. Empty when nowhere else is open. */
  function elsewhereHTML() {
    const open = openElsewhere();
    if (!open.length) return "";
    return `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">${open.map((b) =>
      `<button class="btn btn-sm btn-primary" data-branch-switch="${UI.esc(b.slug)}">Order from ${UI.esc(b.name)} instead</button>`).join("")}</div>`;
  }

  // One delegated listener, so banners drawn at any time get working buttons.
  document.addEventListener("click", (e) => {
    const x = e.target.closest && e.target.closest("[data-branch-switch]");
    if (x) switchTo(x.dataset.branchSwitch);
  });

  return { ready, current: () => current, all: () => list, switchTo, elsewhereHTML };
})();
