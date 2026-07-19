/* Cart + order-type state, persisted in localStorage, with a simple pub/sub.
   A cart line is keyed by item_id + base + size so variants stack separately. */
const Store = (() => {
  const KEY = "sps_cart_v1";
  const MODE_KEY = "sps_mode_v1";
  const COUPON_KEY = "sps_coupon_v1";
  const subs = new Set();

  let state = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      const mode = localStorage.getItem(MODE_KEY) || "takeaway";
      const coupon = localStorage.getItem(COUPON_KEY) || "";
      return { lines: Array.isArray(raw) ? raw : [], mode, coupon };
    } catch { return { lines: [], mode: "takeaway", coupon: "" }; }
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(state.lines));
    localStorage.setItem(MODE_KEY, state.mode);
    localStorage.setItem(COUPON_KEY, state.coupon || "");
    subs.forEach((fn) => fn(state));
  }

  const lineKey = (l) => `${l.item_id}|${l.base}|${l.size}`;

  function add(line) {
    const key = lineKey(line);
    const existing = state.lines.find((l) => lineKey(l) === key);
    if (existing) existing.quantity += line.quantity;
    else state.lines.push({ ...line });
    persist();
  }

  function setQty(key, qty) {
    const l = state.lines.find((x) => lineKey(x) === key);
    if (!l) return;
    l.quantity = qty;
    if (l.quantity <= 0) state.lines = state.lines.filter((x) => lineKey(x) !== key);
    persist();
  }

  function remove(key) { state.lines = state.lines.filter((l) => lineKey(l) !== key); persist(); }
  function clear() { state.lines = []; state.coupon = ""; persist(); }
  function setMode(mode) { state.mode = mode; persist(); }
  // No-op when unchanged: requestQuote() calls this from inside a Store
  // subscriber, so re-persisting on every quote would notify subscribers again
  // and spin an endless quote loop.
  function setCoupon(code) {
    const next = code || "";
    if (next === state.coupon) return;
    state.coupon = next;
    persist();
  }

  const count = () => state.lines.reduce((s, l) => s + l.quantity, 0);
  // Cart lines reduced to what the backend /quote and /orders endpoints expect.
  const toCartPayload = () => state.lines.map((l) => ({ item_id: l.item_id, base: l.base, size: l.size, quantity: l.quantity }));

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  return { get: () => state, add, setQty, remove, clear, setMode, setCoupon, count, lineKey, toCartPayload, subscribe };
})();
