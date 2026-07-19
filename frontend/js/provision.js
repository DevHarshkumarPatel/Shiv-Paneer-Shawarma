/* Standalone user provisioning (setup-key gated). No owner/staff login involved. */
(function () {
  const { esc, el, els, toast, modal } = UI;
  const KEY_STORE = "sps_setup_key";
  let setupKey = sessionStorage.getItem(KEY_STORE) || "";

  const authHeader = () => ({ "X-Setup-Key": setupKey });

  document.addEventListener("DOMContentLoaded", async () => {
    el("#gateForm").addEventListener("submit", onUnlock);
    el("#lockBtn").addEventListener("click", lock);
    el("#createBtn").addEventListener("click", createUser);
    el("#refreshBtn").addEventListener("click", loadUsers);
    el("#cGen").addEventListener("click", () => { el("#cPass").value = genPassword(); });
    // If a key is already stored this tab, try to resume.
    if (setupKey) { try { await API.get("/api/setup/verify", authHeader()); enterApp(); } catch { lock(); } }
  });

  async function onUnlock(e) {
    e.preventDefault();
    const btn = el("#gateBtn"), errEl = el("#gateErr");
    errEl.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
    setupKey = el("#setupKey").value;
    try {
      await API.get("/api/setup/verify", authHeader());
      sessionStorage.setItem(KEY_STORE, setupKey);
      enterApp();
    } catch (ex) {
      errEl.textContent = ex.status === 403 ? ex.message : "Invalid setup key.";
      setupKey = "";
    } finally { btn.disabled = false; btn.textContent = "Unlock"; }
  }

  function lock() {
    sessionStorage.removeItem(KEY_STORE); setupKey = "";
    el("#app").classList.add("hidden"); el("#gate").classList.remove("hidden");
    el("#setupKey").value = "";
  }

  function enterApp() {
    el("#gate").classList.add("hidden"); el("#app").classList.remove("hidden");
    loadUsers();
  }

  async function loadUsers() {
    const target = el("#usersTable");
    target.innerHTML = `<div class="center-load"><div class="spinner"></div></div>`;
    try {
      const { users } = await API.get("/api/setup/users", authHeader());
      renderUsers(users);
    } catch (e) {
      if (e.status === 401) return lock();
      target.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    }
  }

  function renderUsers(users) {
    if (!users.length) { el("#usersTable").innerHTML = `<div class="empty"><p class="text-muted">No users yet.</p></div>`; return; }
    const rows = users.map((u) => `
      <tr>
        <td><strong>${esc(u.email)}</strong>${u.name ? `<br/><span class="text-sm text-muted">${esc(u.name)}</span>` : ""}</td>
        <td><span class="badge ${u.role === "owner" ? "badge-offer" : "badge-soft"}">${esc(u.role)}</span></td>
        <td>${u.active ? "✅ Active" : "⛔ Disabled"}</td>
        <td class="row wrap">
          <button class="btn btn-sm btn-outline" data-pass="${u.id}">Reset password</button>
          <button class="btn btn-sm btn-outline" data-edit="${u.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${u.id}" data-email="${esc(u.email)}">Delete</button>
        </td>
      </tr>`).join("");
    el("#usersTable").innerHTML = `<table class="admin-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    els("[data-pass]").forEach((b) => b.addEventListener("click", () => passwordModal(b.dataset.pass, users.find((u) => u.id == b.dataset.pass))));
    els("[data-edit]").forEach((b) => b.addEventListener("click", () => editModal(users.find((u) => u.id == b.dataset.edit))));
    els("[data-del]").forEach((b) => b.addEventListener("click", () => delUser(b.dataset.del, b.dataset.email)));
  }

  async function createUser() {
    const payload = {
      name: el("#cName").value.trim(),
      email: el("#cEmail").value.trim(),
      password: el("#cPass").value,
      role: el("#cRole").value,
      active: true,
    };
    if (!payload.email) return toast("Email is required", "err");
    if (!payload.password || payload.password.length < 6) return toast("Password must be at least 6 characters", "err");
    const btn = el("#createBtn"); btn.disabled = true; btn.textContent = "Creating…";
    try {
      const u = await API.post("/api/setup/users", payload, authHeader());
      toast(`Created ${u.email} (${u.role})`, "ok");
      el("#cName").value = ""; el("#cEmail").value = ""; el("#cPass").value = ""; el("#cRole").value = "staff";
      loadUsers();
    } catch (e) { if (e.status === 401) return lock(); toast(e.message, "err"); }
    finally { btn.disabled = false; btn.textContent = "＋ Create user"; }
  }

  function passwordModal(id, u) {
    const m = modal({
      title: `Reset password · ${u.email}`,
      bodyHTML: `
        <div class="field"><label>New password</label>
          <div class="input-row">
            <input class="input" id="npass" type="text" placeholder="min 6 characters" />
            <button class="btn btn-outline" id="ngen" type="button">🎲</button>
          </div></div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="savePass">Set password</button>`,
    });
    el("#ngen", m.backdrop).addEventListener("click", () => { el("#npass", m.backdrop).value = genPassword(); });
    el("#savePass", m.backdrop).addEventListener("click", async () => {
      const pw = el("#npass", m.backdrop).value;
      if (!pw || pw.length < 6) return toast("Password must be at least 6 characters", "err");
      try { await API.post(`/api/setup/users/${id}/password`, { password: pw }, authHeader()); toast("Password updated", "ok"); m.close(); }
      catch (e) { if (e.status === 401) return lock(); toast(e.message, "err"); }
    });
  }

  function editModal(u) {
    const m = modal({
      title: `Edit · ${u.email}`,
      bodyHTML: `
        <div class="field"><label>Name</label><input class="input" id="eName" value="${esc(u.name)}" /></div>
        <div class="input-row">
          <div class="field grow"><label>Role</label><select class="select" id="eRole">
            <option value="staff" ${u.role === "staff" ? "selected" : ""}>Staff</option>
            <option value="owner" ${u.role === "owner" ? "selected" : ""}>Owner</option></select></div>
          <div class="field grow"><label>Status</label><select class="select" id="eActive">
            <option value="true" ${u.active ? "selected" : ""}>Active</option>
            <option value="false" ${!u.active ? "selected" : ""}>Disabled</option></select></div>
        </div>`,
      footHTML: `<button class="btn btn-primary btn-block" id="saveEdit">Save changes</button>`,
    });
    el("#saveEdit", m.backdrop).addEventListener("click", async () => {
      const payload = { name: el("#eName", m.backdrop).value.trim(), role: el("#eRole", m.backdrop).value, active: el("#eActive", m.backdrop).value === "true" };
      try { await API.put(`/api/setup/users/${u.id}`, payload, authHeader()); toast("Saved", "ok"); m.close(); loadUsers(); }
      catch (e) { if (e.status === 401) return lock(); toast(e.message, "err"); }
    });
  }

  async function delUser(id, email) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    try { await API.del(`/api/setup/users/${id}`, authHeader()); toast("User deleted", "ok"); loadUsers(); }
    catch (e) { if (e.status === 401) return lock(); toast(e.message, "err"); }
  }

  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%";
    let out = "";
    const rnd = new Uint32Array(12); crypto.getRandomValues(rnd);
    for (let i = 0; i < 12; i++) out += chars[rnd[i] % chars.length];
    return out;
  }
})();
