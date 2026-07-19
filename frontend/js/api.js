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

  return {
    get: (p, h) => request("GET", p, undefined, h),
    post: (p, b, h) => request("POST", p, b, h),
    put: (p, b, h) => request("PUT", p, b, h),
    del: (p, h) => request("DELETE", p, undefined, h),
  };
})();

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
