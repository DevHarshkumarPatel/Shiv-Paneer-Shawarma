/* Printed invoice: a thermal receipt the owner can print, save as PDF, or send.
 *
 * One renderer feeds all three actions. The receipt is drawn onto a canvas at
 * the printer's own dot width (384 dots for 58mm paper, 576 for 80mm), so what
 * prints, what downloads and what the customer receives are the same bill —
 * and a page-sized image is what a Bluetooth thermal printer handles best.
 *
 * There are two ways out to a printer. "Bluetooth" goes straight to a thermal
 * printer (see bt-print.js) and is the one to reach for at the counter; it sends
 * either the printer's own text mode (escpos-text.js — fast, sharp, and what
 * the Text style below selects) or this canvas as raster, whichever style the
 * device is set to. "Dialog" hands the image to the system print dialog, which is where
 * an OS-level printer — including one paired outside the browser — shows up.
 * The browser cannot tell whether any printer is connected, so the PDF download
 * and the share button sit next to both rather than behind a "no printer" check.
 */
const Invoice = (function () {
  const { money, esc, el, toast, modal, statusLabel, fmtDateTime, phoneIntl } = UI;

  const SHOP = "Shiv Paneer Shawarma";
  const LOGO_SRC = "../assets/img/logo.jpeg";
  const PAPER_KEY = "sps_invoice_paper";   // "58" | "80", per device
  const STYLE_KEY = "sps_invoice_style";   // "text" | "image", per device

  // Printable dot width per paper size; the canvas is drawn at 2× that so the
  // PDF stays readable on a phone screen and the print still lands on whole dots.
  const PAPERS = {
    "58": { mm: 58, dots: 384 },
    "80": { mm: 80, dots: 576 },
  };
  const SCALE = 2;
  const TYPE_LABEL = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

  /* "3rd order" reads faster on a bill than "repeat_no: 3". Orders placed
     before the count was recorded have none, and say so rather than claiming
     a first visit. */
  function ordinal(n) {
    if (!n) return "—";
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
    return `${n}${suffix}`;
  }

  const paper = () => PAPERS[localStorage.getItem(PAPER_KEY)] || PAPERS["58"];
  const setPaper = (k) => localStorage.setItem(PAPER_KEY, k);

  /* Text is the default: it prints in a second or two against the raster's
     twenty-odd, and the printer's own font is sharper than any dithered
     bitmap. Image is kept for a bill whose layout has to match the PDF exactly
     — and for a printer whose firmware mangles GS ( k QR codes. */
  const style = () => (localStorage.getItem(STYLE_KEY) === "image" ? "image" : "text");
  const setStyle = (k) => localStorage.setItem(STYLE_KEY, k);
  const textMode = () => style() === "text" && typeof ESCPOSText !== "undefined";

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);   // the logo is decoration; print without it
      img.src = src;
    });
  }

  /* Draw the receipt and return a canvas cropped to the height it actually
     used. The height isn't known until the last line is placed, so it is drawn
     on an over-tall scratch canvas first and copied into a snug one. */
  async function render(o, logo, scale) {
    const p = paper();
    // The preview and the PDF want 2x for a readable phone screen; the thermal
    // raster wants 1x, because the printer maps one canvas pixel to one dot and
    // wraps anything wider than its head.
    const W = p.dots * (scale || SCALE);
    const PAD = Math.round(W * 0.045);
    const RIGHT = W - PAD;
    const INNER = W - PAD * 2;

    // Every size is expressed in 58mm dots and scaled, so 80mm paper gets a
    // proportionally larger bill instead of the same one adrift in white space.
    const S = (n) => Math.round((n * W) / 384);
    const FAMILY = `"Segoe UI", system-ui, Roboto, "Noto Sans", Arial, sans-serif, "Noto Color Emoji", "Segoe UI Emoji"`;
    const font = (size, bold) => `${bold ? "700 " : ""}${S(size)}px ${FAMILY}`;

    const scratch = document.createElement("canvas");
    scratch.width = W;
    scratch.height = 12000;
    const c = scratch.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, W, scratch.height);
    c.textBaseline = "top";
    c.fillStyle = "#000";

    let y = PAD;

    function wrap(text, maxW) {
      const out = [];
      String(text).split("\n").forEach((para) => {
        let cur = "";
        para.split(/\s+/).filter(Boolean).forEach((word) => {
          const test = cur ? `${cur} ${word}` : word;
          if (c.measureText(test).width <= maxW || !cur) { cur = test; return; }
          out.push(cur);
          cur = word;
        });
        out.push(cur);
      });
      return out.length ? out : [""];
    }

    // One block of text, wrapped to the paper, optionally centred.
    function line(text, opts) {
      opts = opts || {};
      const size = opts.size || 13;
      c.font = font(size, opts.bold);
      const x = PAD + (opts.indent || 0);
      const maxW = INNER - (opts.indent || 0);
      wrap(text, maxW).forEach((row) => {
        if (opts.center) c.fillText(row, (W - c.measureText(row).width) / 2, y);
        else c.fillText(row, x, y);
        y += S(size) * 1.35;
      });
      y += S(opts.gap == null ? 3 : opts.gap);
    }

    // A label on the left and an amount pinned to the right edge — the shape
    // every bill line has, so the numbers form a column the eye can add up.
    function row(left, right, opts) {
      opts = opts || {};
      const size = opts.size || 13;
      c.font = font(size, opts.bold);
      const rightW = c.measureText(right).width;
      const rows = wrap(left, INNER - rightW - S(8));
      rows.forEach((text, i) => {
        c.font = font(size, opts.bold);
        c.fillText(text, PAD, y);
        if (i === rows.length - 1) c.fillText(right, RIGHT - rightW, y);
        y += S(size) * 1.35;
      });
      y += S(opts.gap == null ? 2 : opts.gap);
    }

    function rule(solid) {
      c.save();
      c.strokeStyle = "#000";
      c.lineWidth = Math.max(1, S(solid ? 2 : 1));
      if (!solid) c.setLineDash([S(4), S(4)]);
      c.beginPath();
      c.moveTo(PAD, y + S(3));
      c.lineTo(RIGHT, y + S(3));
      c.stroke();
      c.restore();
      y += S(10);
    }

    /* ---- Header ---- */
    if (logo) {
      const h = S(52);
      const w = Math.min(INNER, (logo.width / logo.height) * h);
      c.drawImage(logo, (W - w) / 2, y, w, h);
      y += h + S(8);
    }
    line(SHOP, { size: 19, bold: true, center: true, gap: 1 });
    line("Order receipt", { size: 11, center: true, gap: 4 });
    rule(true);

    /* ---- Order details ---- */
    line("📋 ORDER DETAILS", { size: 14, bold: true, gap: 4 });
    const cust = o.customer || {};
    line(`📅 Date: ${o.created_at ? fmtDateTime(o.created_at) : "—"}`, { gap: 1 });
    line(`🧾 Order No: ${o.public_id}`, { gap: 1 });
    line(`🔁 Repeat Number: ${o.repeat_no ? `${ordinal(o.repeat_no)} order` : "—"}`, { gap: 1 });
    line(`${o.order_type === "delivery" ? "🛵" : o.order_type === "dine_in" ? "🍽️" : "🥡"} Order Type: ${TYPE_LABEL[o.order_type] || o.order_type}`, { gap: 1 });
    line(`👤 Client Name: ${cust.name || "—"}`, { gap: 1 });
    line(`📞 Phone Number: ${cust.phone || "—"}`, { gap: 1 });
    line(`🎟️ Coupon Code: ${o.coupon_code || "—"}`, { gap: 1 });
    if (o.order_type === "delivery" && cust.address) line(`🏠 Address: ${cust.address}`, { gap: 1 });
    if (o.notes) line(`📝 Note: ${o.notes}`, { gap: 1 });
    y += S(4);
    rule();

    /* ---- Items ---- */
    row("🛍️ ITEM", "AMOUNT", { size: 12, bold: true, gap: 4 });
    let units = 0;
    let free = 0;
    (o.items || []).forEach((i) => {
      units += i.quantity || 0;
      free += i.free_quantity || 0;
      row(i.name, money(i.line_total), { size: 13, bold: true, gap: 0 });
      const detail = [
        `${i.quantity} × ${money(i.unit_price)}`,
        i.variant_label || "",
        i.free_quantity ? `+${i.free_quantity} free` : "",
        i.promo_label || "",
      ].filter(Boolean).join(" · ");
      line(detail, { size: 11, indent: S(8), gap: 3 });
    });
    rule();

    /* ---- Bill ---- */
    line(`📦 Quantity: ${units} item${units === 1 ? "" : "s"}${free ? ` (+${free} free)` : ""}`, { size: 12, gap: 4 });
    // Same rule as the dashboard card: the subtotal is only worth a line when
    // something below moves it, otherwise it is the total printed twice.
    if (o.promo_discount > 0 || o.coupon_discount > 0 || o.delivery_fee > 0) {
      row("Subtotal", money(o.subtotal));
    }
    if (o.promo_discount > 0) {
      const labels = [...new Set((o.items || []).map((i) => i.promo_label).filter(Boolean))];
      row(`Offers${labels.length ? ` · ${labels.join(", ")}` : ""}`, `− ${money(o.promo_discount)}`);
    }
    if (o.coupon_discount > 0) {
      row(`Coupon${o.coupon_code ? ` ${o.coupon_code}` : ""}`, `− ${money(o.coupon_discount)}`);
    }
    if (o.delivery_fee > 0) {
      row(`Delivery${o.delivery_area ? ` · ${o.delivery_area}` : ""}`, money(o.delivery_fee));
    }
    rule(true);
    row("💰 TOTAL BILL", money(o.total), { size: 17, bold: true, gap: 4 });
    rule(true);

    /* ---- Payment + status ---- */
    if (o.payment) {
      line(`💳 Payment: ${payLabel(o.payment)}`, { size: 12, gap: 1 });
      if (o.payment.upi_reference) line(`🔐 UTR: ${o.payment.upi_reference}`, { size: 12, gap: 1 });
    }
    line(`📍 Status: ${statusLabel(o.status)}`, { size: 12, gap: 4 });
    rule();

    /* ---- Thank you ---- */
    line("🙏 THANK YOU!", { size: 16, bold: true, center: true, gap: 2 });
    line(o.repeat_no > 1
      ? `Thank you for coming back — this is your ${ordinal(o.repeat_no)} order with us.`
      : `Welcome to the ${SHOP} family — we're glad you're here.`,
      { size: 12, center: true, gap: 2 });
    line("See you again soon! 🌯", { size: 12, center: true, gap: 5 });
    line("Track your order", { size: 11, center: true, gap: 0 });
    line(trackUrl(o.public_id), { size: 10, center: true, gap: 2 });

    /* ---- Crop to what was drawn ---- */
    const H = Math.min(Math.ceil(y + PAD), scratch.height);
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const oc = out.getContext("2d");
    oc.fillStyle = "#fff";
    oc.fillRect(0, 0, W, H);
    oc.drawImage(scratch, 0, 0, W, H, 0, 0, W, H);
    return { canvas: out, paper: p };
  }

  function payLabel(p) {
    const map = { paid: "Paid", awaiting_verification: "Awaiting verification", pending: "Unpaid", failed: "Failed" };
    return `${p.method === "upi" ? "UPI" : "Cash"} · ${map[p.status] || p.status}`;
  }

  /* ---------------------------------------------------------------- *
   * Text mode
   * ---------------------------------------------------------------- */

  /* The logo alone, on its own canvas at the printer's dot width. Text mode
     sends characters, but a logo is not a character, so this one block goes as
     raster inside the stream. Kept to ~55% of the paper and to a whole number
     of bytes wide: GS v 0 works in 8-dot columns, and a width that isn't a
     multiple of 8 leaves a ragged edge. */
  function logoCanvas(logo, dots) {
    if (!logo) return null;
    const w = Math.floor((dots * 0.55) / 8) * 8;
    const h = Math.max(8, Math.round((logo.height / logo.width) * w));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, w, h);
    c.drawImage(logo, 0, 0, w, h);
    return cv;
  }

  /* Redraw the server's QR PNG on the printer's dot grid, one module to a solid
     square of `dots` pixels.
     Plain scaling is no good here: scale a QR by a fraction and resampling eats
     whole module rows, leaving a code that looks fine and scans never. So the
     PNG's own grid is measured instead — the quiet zone is walked down the
     diagonal, and the top-left finder pattern's outer ring is exactly 7 modules
     wide, which gives the module size in source pixels — and every module is
     then sampled at its centre and painted at the size we want. */
  function qrCanvas(img, dots) {
    if (!img) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    const sc = src.getContext("2d");
    sc.fillStyle = "#fff";
    sc.fillRect(0, 0, w, h);
    sc.drawImage(img, 0, 0);
    const px = sc.getImageData(0, 0, w, h).data;
    const dark = (x, y) => {
      const p = (y * w + x) * 4;
      const a = px[p + 3] / 255;
      return 255 - a * (255 - (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000) < 128;
    };

    const edge = Math.min(w, h);
    let quiet = 0;
    while (quiet < edge && !dark(quiet, quiet)) quiet++;
    if (quiet >= edge) return null;                 // no dark pixel: not a QR
    let run = 0;
    while (quiet + run < w && dark(quiet + run, quiet)) run++;
    const box = run / 7;
    const modules = Math.round((w - 2 * quiet) / box);
    // 21 modules is QR version 1; anything smaller means the grid was misread.
    if (!(box >= 1) || modules < 21 || Math.abs(modules * box - (w - 2 * quiet)) > box) return null;

    // Two modules of white all round. The paper is white anyway, but the quiet
    // zone has to survive the bill's own rules and the "Scan to pay" line.
    const PAD = 2;
    const side = (modules + PAD * 2) * dots;
    const out = document.createElement("canvas");
    out.width = side;
    out.height = side;
    const oc = out.getContext("2d");
    oc.fillStyle = "#fff";
    oc.fillRect(0, 0, side, side);
    oc.fillStyle = "#000";
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        const x = Math.floor(quiet + c * box + box / 2);
        const y = Math.floor(quiet + r * box + box / 2);
        if (dark(Math.min(x, w - 1), Math.min(y, h - 1))) {
          oc.fillRect((c + PAD) * dots, (r + PAD) * dots, dots, dots);
        }
      }
    }
    return out;
  }

  /* The UPI intent link and a QR image for what this bill still owes. The bill
     prints without them if the call fails — a receipt is worth more than a
     payment shortcut. */
  async function upiFor(o) {
    try {
      return await API.get(`/api/orders/${encodeURIComponent(o.public_id)}/payment`);
    } catch (e) {
      return null;
    }
  }

  function buildText(o, logo, pay, qrImg) {
    const p = paper();
    const dots = (ESCPOSText.QR_MODULE && ESCPOSText.QR_MODULE[p.mm]) || 3;
    return ESCPOSText.build(o, {
      shop: SHOP,
      paperMm: p.mm,
      logo: logoCanvas(logo, p.dots),
      qrCanvas: qrCanvas(qrImg, dots),
      dateText: o.created_at ? fmtDateTime(o.created_at) : "",
      upiUri: pay && pay.upi_uri,
    });
  }

  const trackUrl = (id) => new URL(`../track.html?id=${encodeURIComponent(id)}`, location.href).href;

  /* ---------------------------------------------------------------- *
   * PDF
   * ---------------------------------------------------------------- */

  const latin1 = (s) => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  };

  function dataUrlBytes(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  /* A one-page PDF holding the receipt as a JPEG.
     Written by hand rather than pulled from a library: JPEG is the one image
     format a PDF can carry as-is (/DCTDecode), which makes the whole file a
     header, five objects and an xref — far less than a PDF library would cost
     to ship on a page that already runs on a phone over mobile data. */
  function buildPdf(jpeg, pxW, pxH, mmW) {
    const ptW = +((mmW / 25.4) * 72).toFixed(2);
    const ptH = +((ptW * pxH) / pxW).toFixed(2);

    const parts = [];
    let len = 0;
    const push = (chunk) => {
      const bytes = typeof chunk === "string" ? latin1(chunk) : chunk;
      parts.push(bytes);
      len += bytes.length;
    };

    const offsets = [];
    const obj = (n, dict, stream) => {
      offsets[n] = len;
      push(`${n} 0 obj\n${dict}\n`);
      if (stream) {
        push("stream\n");
        push(stream);
        push("\nendstream\n");
      }
      push("endobj\n");
    };

    const content = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`;
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] `
         + `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
    obj(4, `<< /Length ${content.length} >>`, latin1(content));
    obj(5, `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} `
         + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);

    const xrefAt = len;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let n = 1; n <= 5; n++) xref += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
    push(xref);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const all = new Uint8Array(len);
    let at = 0;
    parts.forEach((b) => { all.set(b, at); at += b.length; });
    return new Blob([all], { type: "application/pdf" });
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  /* Hand the image to the system print dialog — on a phone that is where a
     paired Bluetooth printer shows up. The page is sized to the paper so the
     printer doesn't scale the receipt down to fit an A4 sheet. */
  function print(dataUrl, p, title) {
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups for this site to print", "err"); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8" />
      <title>${esc(title)}</title>
      <style>
        @page { size: ${p.mm}mm auto; margin: 0; }
        html, body { margin: 0; padding: 0; background: #fff; }
        img { display: block; width: 100%; }
        @media print { html, body { width: ${p.mm}mm; } }
      </style></head><body>
      <img src="${dataUrl}" onload="window.focus();window.print();" /></body></html>`);
    w.document.close();
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* WhatsApp's own link can only carry text, so a real file has to go through
     the system share sheet (Android Chrome lists WhatsApp there). Where that
     isn't available — most desktops — the PDF is downloaded and the chat is
     opened, leaving the owner one drag away from the same result. */
  async function sendOnWhatsApp(o, blob) {
    const filename = `${o.public_id}.pdf`;
    const note = `Namaste${o.customer && o.customer.name ? " " + o.customer.name : ""} 🙏 `
      + `Thank you for ordering from ${SHOP}. Here is your invoice for ${o.public_id} — total ${money(o.total)}.`;
    const file = new File([blob], filename, { type: "application/pdf" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `Invoice ${o.public_id}`, text: note });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;   // owner backed out of the sheet
      }
    }
    download(blob, filename);
    const phone = phoneIntl(o.customer && o.customer.phone);
    window.open(
      phone ? `https://wa.me/${phone}?text=${encodeURIComponent(note)}` : "https://web.whatsapp.com/",
      "_blank", "noopener",
    );
    toast(`${filename} downloaded — attach it in the WhatsApp window`, "");
  }

  /* ---------------------------------------------------------------- *
   * Modal
   * ---------------------------------------------------------------- */

  async function open(o) {
    /* Only offer the direct route where one can exist. On an iPhone, or in
       desktop Safari and Firefox, there is no Web Bluetooth and no RawBT, so a
       Bluetooth button there would be a button that always fails. */
    const direct = typeof BTPrint !== "undefined" && (BTPrint.supported() || BTPrint.isAndroid());

    const m = modal({
      title: `Invoice · ${o.public_id}`,
      bodyHTML: `
        <div class="row-between wrap" style="gap:var(--sp-2);margin-bottom:var(--sp-2);">
          <span class="text-sm text-muted">Paper width</span>
          <div class="chips" style="padding:0;overflow:visible;">
            <button class="chip" data-paper="58">58 mm</button>
            <button class="chip" data-paper="80">80 mm</button>
          </div>
        </div>
        ${direct ? `<div class="row-between wrap" style="gap:var(--sp-2);margin-bottom:var(--sp-3);">
          <span class="text-sm text-muted">Print style</span>
          <div class="chips" style="padding:0;overflow:visible;">
            <button class="chip" data-style="text">Text</button>
            <button class="chip" data-style="image">Image</button>
          </div>
        </div>` : ""}
        <div class="inv-preview" id="invPreview">
          <div class="center-load"><div class="spinner"></div><div>Building the bill…</div></div>
        </div>
        <p class="text-sm text-muted" style="margin-bottom:0;" id="invHint"></p>`,
      footHTML: `<div class="row wrap">
          ${direct ? `<button class="btn btn-primary grow" id="invBt" disabled>🖨 Bluetooth</button>` : ""}
          <button class="btn btn-${direct ? "outline" : "primary"} grow" id="invPrint" disabled>🖨 Dialog</button>
          <button class="btn btn-outline grow" id="invPdf" disabled>⬇ PDF</button>
          <button class="btn btn-outline grow" id="invShare" disabled>💬 Send PDF</button>
        </div>`,
    });

    /* Text mode is an ESC/POS stream, so it only means anything over
       Bluetooth. Where there is no Bluetooth route the bill is the drawn one,
       whatever the device last chose. */
    const asText = () => direct && textMode();

    const preview = el("#invPreview", m.backdrop);
    const buttons = ["#invBt", "#invPrint", "#invPdf", "#invShare"]
      .map((s) => el(s, m.backdrop))
      .filter(Boolean);

    function hint() {
      const saved = direct && BTPrint.savedName();
      /* The style only changes what goes over Bluetooth. Dialog, PDF and the
         WhatsApp copy are always the drawn bill, because a print sheet and a
         PDF have no use for printer commands. */
      const styleNote = asText()
        ? `Text style sends the printer characters — fast, sharp, and it prints the UPI QR itself.`
        : `Image style sends the bill exactly as previewed — slower, and it needs no printer font.`;
      el("#invHint", m.backdrop).innerHTML = direct
        ? `Bluetooth prints straight to your thermal printer${saved ? ` — ${esc(saved)}` : ""}. ${styleNote} `
          + `Dialog goes through the system print sheet instead. No printer? Save the PDF or send it on WhatsApp.`
        : `Dialog sends it to this device's print sheet — pick your printer there. `
          + `No printer connected? Save the PDF or send it on WhatsApp.`;
    }
    hint();
    // The logo is fetched once and reused when the paper size changes.
    const logo = await loadImage(LOGO_SRC);
    let built = null;
    // Fetched once per invoice, whatever the style or paper size: the amount
    // owed doesn't change when the paper does.
    let pay = null;
    let payTried = false;
    let qrImg = null;

    /* The link and its QR image, once. The image is decoded here rather than in
       the builder so that switching paper size or restyling the bill doesn't
       re-decode it. */
    async function ensurePay() {
      if (payTried) return;
      payTried = true;
      pay = await upiFor(o);
      qrImg = pay && pay.qr_data_url ? await loadImage(pay.qr_data_url) : null;
    }

    async function build() {
      buttons.forEach((b) => { b.disabled = true; });
      el("[data-paper=\"58\"]", m.backdrop).classList.toggle("active", paper().mm === 58);
      el("[data-paper=\"80\"]", m.backdrop).classList.toggle("active", paper().mm === 80);
      if (direct) {
        el("[data-style=\"text\"]", m.backdrop).classList.toggle("active", asText());
        el("[data-style=\"image\"]", m.backdrop).classList.toggle("active", !asText());
      }
      hint();

      // The drawn bill is built either way — Dialog, PDF and Send PDF all need
      // it, and the buttons should not wait for a second render on a tap.
      const { canvas, paper: p } = await render(o, logo);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      built = {
        dataUrl,
        paper: p,
        pdf: buildPdf(dataUrlBytes(dataUrl), canvas.width, canvas.height, p.mm),
      };

      if (asText()) {
        await ensurePay();
        preview.innerHTML = `<pre class="inv-text" aria-label="Invoice preview for ${esc(o.public_id)}">`
          + `${esc(buildText(o, logo, pay, qrImg).text)}</pre>`;
      } else {
        preview.innerHTML = `<img src="${dataUrl}" alt="Invoice preview for ${esc(o.public_id)}" />`;
      }
      buttons.forEach((b) => { b.disabled = false; });
    }

    m.backdrop.querySelectorAll("[data-paper]").forEach((b) => b.addEventListener("click", () => {
      setPaper(b.dataset.paper);
      build();
    }));
    m.backdrop.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => {
      setStyle(b.dataset.style);
      build();
    }));
    /* In image style the thermal raster is drawn on demand rather than with the
       preview: it is a second full render, and most bills are opened to look at,
       not to print. */
    if (direct) {
      const btn = el("#invBt", m.backdrop);
      btn.addEventListener("click", async () => {
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = "… printing";
        try {
          let route;
          if (asText()) {
            // Nothing to re-render: text mode is the same bytes the preview was
            // built from, and the QR is drawn by the printer.
            await ensurePay();
            route = await BTPrint.printBytes(buildText(o, logo, pay, qrImg).bytes);
          } else {
            // 1x, because the printer maps one canvas pixel to one dot.
            route = await BTPrint.printCanvas((await render(o, logo, 1)).canvas);
          }
          if (route === "ble") toast("Sent to the printer", "ok");
          hint();
        } catch (e) {
          if (e && e.name === "NotFoundError") {
            toast("No printer picked", "");
          } else if (!BTPrint.supported() && !BTPrint.isAndroid()) {
            toast("This browser can't print over Bluetooth — use Dialog", "err");
          } else {
            /* Nothing here distinguishes "printer is off" from "printer speaks
               SPP and RawBT isn't installed", so name the two things the owner
               can actually check. */
            toast(`Bluetooth print failed: ${e && e.message ? e.message : e}. `
                + `Check the printer is on, or use Dialog.`, "err");
          }
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
    }

    el("#invPrint", m.backdrop).addEventListener("click", () => print(built.dataUrl, built.paper, o.public_id));
    el("#invPdf", m.backdrop).addEventListener("click", () => download(built.pdf, `${o.public_id}.pdf`));
    el("#invShare", m.backdrop).addEventListener("click", () => sendOnWhatsApp(o, built.pdf));

    await build();
  }

  return { open };
})();
