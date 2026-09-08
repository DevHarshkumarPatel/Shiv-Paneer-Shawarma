/* Direct thermal printing, without the system print dialog.
 *
 * The dialog route in invoice.js still exists and still works; this file is the
 * one that talks to the printer itself. Thermal printers come in two Bluetooth
 * flavours and the label on the box rarely says which:
 *
 *   BLE (GATT)  — Web Bluetooth can drive it straight from the page. No app.
 *   Classic SPP — Web Bluetooth cannot see it at all, by design. The bytes go
 *                 through RawBT, a free Android app that holds the pairing.
 *
 * So `printCanvas` tries BLE, falls back to RawBT on Android, and reports
 * failure otherwise so the caller can offer the print dialog instead. Whichever
 * path runs, the bytes are identical: the same receipt canvas the PDF and the
 * WhatsApp copy are built from, rasterised to the printer's own dot grid.
 *
 * Requires HTTPS (or localhost) — Web Bluetooth is refused on plain http, and
 * on a LAN IP in dev. There is no iOS support in any browser; iPhones keep the
 * dialog.
 */
const BTPrint = (function () {
  const NAME_KEY = "sps_bt_printer";     // remembered for the button's label only

  /* Printers from the same handful of factories reuse these. The first is on
     almost every 58mm BLE unit; the rest cover the common relabels. */
  const SERVICES = [
    "000018f0-0000-1000-8000-00805f9b34fb",
    "0000ff00-0000-1000-8000-00805f9b34fb",
    "0000ffe0-0000-1000-8000-00805f9b34fb",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455",   // Microchip/BM77, used by some relabels
  ];

  let device = null;
  let chr = null;
  let chunk = 180;      // dropped to 20 if the negotiated MTU turns out small

  const supported = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  const isAndroid = () => /Android/i.test(navigator.userAgent);
  const savedName = () => localStorage.getItem(NAME_KEY) || "";
  const connected = () => !!(device && device.gatt && device.gatt.connected && chr);

  /* ---------------------------------------------------------------- *
   * ESC/POS raster
   * ---------------------------------------------------------------- */

  /* Turn the receipt canvas into GS v 0 raster data.
   *
   * The canvas must already be the printer's exact dot width — 384 for 58mm,
   * 576 for 80mm. A wider canvas is not scaled by the printer, it wraps, and
   * every line of the bill comes out in two pieces.
   *
   * A thermal head has one ink and no greys, so the image is dithered rather
   * than thresholded: Floyd–Steinberg keeps the logo photograph readable, where
   * a flat cutoff turns it into a blob and thins the small type. */
  function escposRaster(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const bytesPerRow = Math.ceil(w / 8);
    const src = canvas.getContext("2d").getImageData(0, 0, w, h).data;

    // Greyscale first, in a float buffer, because dithering pushes each pixel's
    // error into its neighbours and that error has to survive as a fraction.
    const grey = new Float32Array(w * h);
    for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
      const a = src[p + 3] / 255;
      // Anything transparent sits on receipt paper, which is white.
      grey[i] = 255 - a * (255 - (src[p] * 299 + src[p + 1] * 587 + src[p + 2] * 114) / 1000);
    }

    const bits = new Uint8Array(bytesPerRow * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = grey[i];
        const black = old < 128;
        if (black) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        const err = old - (black ? 0 : 255);
        if (x + 1 < w)                grey[i + 1]         += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0)                  grey[i + w - 1]     += (err * 3) / 16;
                                      grey[i + w]         += (err * 5) / 16;
          if (x + 1 < w)              grey[i + w + 1]     += (err * 1) / 16;
        }
      }
    }

    /* One GS v 0 per band. A whole bill in a single command overruns the
       buffer on small printers, which drop the remainder silently — the bill
       simply stops halfway down. */
    const BAND = 64;
    const out = [];
    const push = (...b) => out.push(...b);
    push(0x1b, 0x40);                                   // ESC @    reset
    for (let y0 = 0; y0 < h; y0 += BAND) {
      const rows = Math.min(BAND, h - y0);
      push(0x1d, 0x76, 0x30, 0x00,                      // GS v 0, mode 0
           bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
           rows & 0xff, (rows >> 8) & 0xff);
      const from = y0 * bytesPerRow;
      for (let i = 0; i < rows * bytesPerRow; i++) push(bits[from + i]);
    }
    push(0x1b, 0x64, 0x03);                             // ESC d 3  clear the tear bar
    return new Uint8Array(out);
  }

  /* ---------------------------------------------------------------- *
   * BLE transport
   * ---------------------------------------------------------------- */

  function onDrop() {
    chr = null;         // the handle is dead; the next send reconnects
  }

  async function bind(gatt) {
    for (const uuid of SERVICES) {
      let svc;
      try {
        svc = await gatt.getPrimaryService(uuid);
      } catch (e) {
        continue;       // this printer doesn't carry that service; try the next
      }
      const chars = await svc.getCharacteristics();
      const found = chars.find((c) => c.properties.writeWithoutResponse)
                 || chars.find((c) => c.properties.write);
      if (found) return found;
    }
    return null;
  }

  /* Open the browser's device picker and keep the printer. Must be called from
     a click — Chrome refuses a picker that no gesture asked for. */
  async function connect() {
    if (!supported()) throw new Error("This browser has no Bluetooth printing");
    device = await navigator.bluetooth.requestDevice({
      // A thermal printer rarely advertises its service UUID, so filtering by
      // service hides it from the picker. Show everything and bind afterwards.
      acceptAllDevices: true,
      optionalServices: SERVICES,
    });
    device.addEventListener("gattserverdisconnected", onDrop);
    const gatt = await device.gatt.connect();
    chr = await bind(gatt);
    if (!chr) {
      device.gatt.disconnect();
      device = null;
      throw new Error("That device isn't a Bluetooth LE printer");
    }
    chunk = 180;
    localStorage.setItem(NAME_KEY, device.name || "Bluetooth printer");
    return device.name || "Bluetooth printer";
  }

  /* Reconnect to a printer already granted, so a reprint doesn't reopen the
     picker. Only some Chrome builds expose this, hence the quiet failure. */
  async function reconnect() {
    if (!supported() || !navigator.bluetooth.getDevices) return false;
    let known = [];
    try {
      known = await navigator.bluetooth.getDevices();
    } catch (e) {
      return false;
    }
    const name = savedName();
    const pick = known.find((d) => (d.name || "") === name) || known[0];
    if (!pick) return false;
    try {
      pick.addEventListener("gattserverdisconnected", onDrop);
      const gatt = await pick.gatt.connect();
      const found = await bind(gatt);
      if (!found) return false;
      device = pick;
      chr = found;
      chunk = 180;
      return true;
    } catch (e) {
      return false;     // out of range or powered off; the picker will ask again
    }
  }

  async function write(slice) {
    if (chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(slice);
    else await chr.writeValue(slice);
  }

  /* Feed the printer in slices. Its buffer is a few hundred bytes and it has no
     flow control we can read, so the pause between writes is what keeps the
     receipt from arriving as noise. */
  async function send(bytes) {
    if (!connected()) {
      if (!(await reconnect())) await connect();
    }
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.slice(i, i + chunk);
      try {
        await write(slice);
      } catch (e) {
        // Almost always a slice wider than the negotiated MTU. Shrink once to
        // the 20 bytes every BLE link is guaranteed, and resend this slice.
        if (chunk === 20) throw e;
        chunk = 20;
        for (let j = 0; j < slice.length; j += 20) await write(slice.slice(j, j + 20));
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /* ---------------------------------------------------------------- *
   * RawBT — the Bluetooth Classic route
   * ---------------------------------------------------------------- */

  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  /* Hand the same bytes to RawBT, which owns the pairing with an SPP printer.
     A very long bill can outgrow what the browser will carry in a URL; the
     caller treats a failure here as "use the print dialog". */
  function viaRawBT(bytes) {
    const payload = b64(bytes);
    if (payload.length > 1500000) throw new Error("Bill too large for RawBT");
    location.href = "rawbt:base64," + payload;
  }

  /* ---------------------------------------------------------------- *
   * What the invoice modal calls
   * ---------------------------------------------------------------- */

  /* Print a canvas already drawn at the printer's dot width. Returns which
     route ran, or throws with a message worth showing the user. */
  async function printCanvas(canvas) {
    const bytes = escposRaster(canvas);
    if (supported()) {
      try {
        await send(bytes);
        return "ble";
      } catch (e) {
        if (e && e.name === "NotFoundError") throw e;   // picker dismissed; not our problem to retry
        if (!isAndroid()) throw e;
        // A BLE failure on Android is often just an SPP-only printer.
      }
    }
    if (isAndroid()) {
      viaRawBT(bytes);
      return "rawbt";
    }
    throw new Error("No direct Bluetooth route on this device");
  }

  function forget() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    device = null;
    chr = null;
    localStorage.removeItem(NAME_KEY);
  }

  return {
    supported, isAndroid, connected, savedName,
    connect, forget, send, escposRaster, viaRawBT, printCanvas,
  };
})();
