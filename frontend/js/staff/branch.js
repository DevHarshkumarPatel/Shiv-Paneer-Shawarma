/* Which branch a staff screen is looking at.

   A staff login works at one branch. Its screens say which in the header and
   offer no way to change it — the server reads the branch from the login and
   ignores anything this page sends, so a switcher would only be a lie.

   The owner gets a picker instead: one branch, or "All branches" on the screens
   that only read (the board, customers, the edit log). A page that writes an
   order for one till marks itself <body data-branch-required> and the picker
   there has no "All"; one that is not per branch at all marks itself
   data-branch-none and gets no picker. The choice is kept on this device and sent as ?branch=
   with every request through API.setParams, so no page passes it by hand.

   With a single branch there is nothing to choose and nothing is shown. */
const StaffBranch = (() => {
  const KEY = "sps_staff_branch_v1";
  let current = null;      // the branch object in view, or null for all
  let list = [];

  const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

  async function init(user) {
    const who = document.querySelector(".staff-header .who");
    if (user.role !== "owner") {
      current = user.branch || null;
      if (current) API.setParams({ branch: current.id });
      if (who && current && !current.is_main) chip(who, current.name);
      return current;
    }
    try { list = (await API.get("/api/admin/branches")).branches.filter((b) => b.active); }
    catch { list = []; }
    const required = document.body.hasAttribute("data-branch-required");
    const saved = read();
    current = list.find((b) => String(b.id) === saved) || null;
    if (!current && (required || list.length === 1)) current = list[0] || null;
    API.setParams({ branch: current ? current.id : "" });
    // Reviews are not per branch yet, so that screen gets no picker that
    // would look like it filters something.
    if (who && list.length > 1 && !document.body.hasAttribute("data-branch-none")) picker(who, required);
    return current;
  }

  function chip(who, name) {
    const span = document.createElement("span");
    span.className = "branch-chip";
    span.title = "The branch this login works at";
    span.textContent = `📍 ${name}`;
    who.prepend(span);
  }

  function picker(who, required) {
    const sel = document.createElement("select");
    sel.className = "select branch-picker";
    sel.setAttribute("aria-label", "Branch");
    sel.innerHTML = (required ? "" : `<option value="">🏬 All branches</option>`) +
      list.map((b) => `<option value="${b.id}">📍 ${UI.esc(b.name)}</option>`).join("");
    sel.value = current ? String(current.id) : "";
    // A reload rather than a re-render: every screen loads its data once at
    // start-up, and reloading is the one way all of them pick the change up.
    sel.addEventListener("change", () => { write(sel.value); location.reload(); });
    who.prepend(sel);
  }

  return {
    init,
    current: () => current,
    all: () => list,
    isAll: () => !current,
  };
})();
