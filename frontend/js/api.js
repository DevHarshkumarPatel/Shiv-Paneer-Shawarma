/* Thin fetch wrapper. Sends cookies (credentials: 'include') so the JWT
   session cookie flows to the backend for staff/owner endpoints. */
const API = (() => {
  const base = () => window.SPS_CONFIG.API_BASE || "";

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
      res = await fetch(base() + path, opts);
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
      res = await fetch(base() + path, { method: "POST", credentials: "include", body: formData });
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
  };
})();

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
