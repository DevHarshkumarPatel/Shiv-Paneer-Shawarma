/* Frontend runtime config. Adjust API_BASE if the backend runs elsewhere. */

// Derive the backend host from the host the page was opened on, so the API and
// the page are always same-site. This matters for auth: the session cookie is
// SameSite=Lax, so it is only sent when the API host matches the page host —
// opening the site on localhost while calling 127.0.0.1 (or vice-versa) counts
// as cross-site and the cookie is silently dropped (=> 401 on /api/auth/me).
function _spsApiBase() {
  const { protocol, hostname } = window.location;
  // Served over file:// or an unexpected scheme => fall back to a fixed host.
  if (protocol !== "http:" && protocol !== "https:") return "http://127.0.0.1:8000";
  return `${protocol}//${hostname}:8000`;
}

window.SPS_CONFIG = {
  // FastAPI backend base URL. Empty string => same origin.
  API_BASE: _spsApiBase(),
  CURRENCY: "₹",
  // Filled at runtime from GET /api/config (maps key, delivery fee, payee name).
  runtime: {},
};
