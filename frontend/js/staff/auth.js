/* Staff/owner auth helpers. The JWT lives in an httpOnly cookie set by the
   backend; we can't read it from JS, so we validate the session via /me. */
const Auth = (() => {
  let cachedUser = null;

  async function me() {
    if (cachedUser) return cachedUser;
    cachedUser = await API.get("/api/auth/me");
    return cachedUser;
  }

  async function login(email, password) {
    const res = await API.post("/api/auth/login", { email, password });
    cachedUser = res;
    return res;
  }

  async function logout() {
    try { await API.post("/api/auth/logout"); } catch { /* ignore */ }
    cachedUser = null;
  }

  // Guard a page: redirect to login if the session is invalid. Returns the user.
  async function requireAuth(loginPath = "login.html") {
    try { return (await me()).user; }
    catch { location.href = loginPath; throw new Error("redirecting"); }
  }

  // On the login page: if already signed in, jump straight to the app.
  async function redirectIfAuthed(dest) {
    try { await me(); location.href = dest; } catch { /* stay on login */ }
  }

  return { me, login, logout, requireAuth, redirectIfAuthed };
})();
