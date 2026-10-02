/* Thin fetch wrapper. Sends cookies (credentials: 'include') so the JWT
   session cookie flows to the backend for staff/owner endpoints. */
const API = (() => {
  const base = () => window.SPS_CONFIG.API_BASE || "";

  /* Query params added to every request — today just `branch`, set once by
     js/branch.js (customer pages) or js/staff/branch.js (staff pages) so no
     page has to remember to pass it. A param the path already names wins. */
  let defaults = {};
  function withDefaults(path) {
    const extra = Object.entries(defaults).filter(([k, v]) =>
      v !== "" && v != null && !new RegExp(`[?&]${k}=`).test(path));
    if (!extra.length) return path;
    const qs = extra.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return path + (path.includes("?") ? "&" : "?") + qs;
  }

  async function request(method, path, body, headers) {
    const opts = {
      method,
      credentials: "include",
      headers: { ...(headers || {}) },
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(base() + withDefaults(path), opts);
    } catch (e) {
      throw new ApiError("Cannot reach the server. Is the backend running?", 0);
    }
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = (data && data.detail) || (typeof data === "string" ? data : "Request failed");
      throw new ApiError(detail, res.status);
    }
    return data;
  }

  /* Multipart upload. Deliberately not routed through request(): that sets
     Content-Type: application/json, and a FormData body must be left alone so
     the browser can add the multipart boundary to the header itself. */
  async function upload(path, formData) {
    let res;
    try {
      res = await fetch(base() + withDefaults(path), { method: "POST", credentials: "include", body: formData });
    } catch (e) {
      throw new ApiError("Cannot reach the server. Is the backend running?", 0);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      throw new ApiError((data && data.detail) || "Upload failed", res.status);
    }
    return data;
  }

  /* Absolute URL for an image the API serves. Item image_url values are stored
     as API-relative paths, and in production the site and the API are different
     origins, so a bare path would resolve against the site and 404. */
  const assetUrl = (u) => (!u || /^(https?:|data:)/i.test(u) ? u : base() + u);

  return {
    get: (p, h) => request("GET", p, undefined, h),
    post: (p, b, h) => request("POST", p, b, h),
    put: (p, b, h) => request("PUT", p, b, h),
    patch: (p, b, h) => request("PATCH", p, b, h),
    del: (p, h) => request("DELETE", p, undefined, h),
    upload,
    assetUrl,
    setParams: (p) => { defaults = { ...defaults, ...p }; },
  };
})();

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
