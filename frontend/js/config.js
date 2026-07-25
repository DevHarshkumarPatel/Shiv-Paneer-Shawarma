/* Frontend runtime config. API_BASE is derived from the host the page is
   opened on, so no domain is hardcoded and a new domain needs no code change. */

// Fallback used only on Cloud Run's default *.run.app hostnames, where no
// `api.` sibling exists. deploy.sh rewrites this line with the backend URL.
window.SPS_BACKEND_URL = "";

// In dev the session cookie defaults to SameSite=Lax, so it is only sent when
// the API host matches the host in the address bar — opening the site on
// localhost while calling 127.0.0.1 (or vice-versa) counts as cross-site and
// the cookie is silently dropped (=> 401 on /api/auth/me). In prod deploy.sh
// sets COOKIE_SAMESITE=none; Secure, so `api.<domain>` works either way.
function _spsApiBase() {
  const { protocol, hostname } = window.location;
  // Served over file:// or an unexpected scheme => fall back to a fixed host.
  if (protocol !== "http:" && protocol !== "https:") return "http://127.0.0.1:8000";
  // Local / LAN dev: backend runs on the same host, port 8000.
  if (hostname === "localhost" || hostname === "127.0.0.1" ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return `${protocol}//${hostname}:8000`;
  }
  // Cloud Run default URL => use the backend URL baked in at deploy time.
  if (hostname.endsWith(".run.app")) return window.SPS_BACKEND_URL;
  // Any custom domain (apex or www) => the `api.` subdomain of that domain.
  return `https://api.${hostname.replace(/^www\./, "")}`;
}

window.SPS_CONFIG = {
  // FastAPI backend base URL. Empty string => same origin.
  API_BASE: _spsApiBase(),
  CURRENCY: "₹",
  // Filled at runtime from GET /api/config (maps key, delivery fee, payee name).
  runtime: {},
};
