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

  /* The three marks across the top of the bill. All line art, not photographs:
     a thermal head has one ink, and flat black strokes survive the dot grid
     where a photo turns to mush. The photo stays the last resort for the name
     block in case the file is missing.

     The filenames are versioned rather than overwritten. A receipt printer is
     used from one phone all day and that phone caches `logo-print.png` for as
     long as it likes, so replacing artwork in place ships an update the counter
     never sees. A new name is a cache miss, which is the point. */
  const ART = {
    logo: ["../assets/img/logo-print-v2.png", "../assets/img/logo-print.png", "../assets/img/logo.jpeg"],
    left: ["../assets/img/badge-p3y-left.png"],
    right: ["../assets/img/badge-p3y-right.png"],
    tagline: ["../assets/img/tagline-p3y.png"],
  };

  /* The tagline, set as live text rather than placed as artwork.
   *
   * The supplied strip is 7:1, so at the size the owner wants it the bitmap had
   * to come down about 14x and Lanczos turned the matras into grey mush. Drawing
   * the string lets the font rasteriser work at the final size instead, which is
   * the whole difference between a smear and readable Devanagari.
   *
   * It still cannot travel as ESC/POS characters: a thermal printer's ROM font
   * has no Devanagari (see `ascii` in escpos-text.js, which drops every
   * non-ASCII codepoint), so the header stays one raster block — just a far
   * better one. The artwork remains on disk as the fallback for a browser with
   * no Devanagari face at all. */
  const TAGLINE = "P3Y शक्ति से काम बने।";
  /* Devanagari named first and explicitly. Left to a Latin-first stack the
     engine falls back glyph by glyph, which lands the vowel marks at the wrong
     height; Android and the desktop browsers this runs on ship a Noto
     Devanagari face, with Nirmala/Mangal covering Windows. */
  const TAGLINE_FAMILY = '"Noto Sans Devanagari", "Noto Serif Devanagari", '
    + '"Nirmala UI", Mangal, system-ui, "Segoe UI", Roboto, sans-serif';

  /* Header geometry, as fractions of the paper width. Two rows: the tagline
     across the top, then the badges in the corners with the name block between
     them.
   *
   * `tagline` is a font size now, not a width — the point of drawing the string
   * is that the type size becomes the thing being chosen. It is capped to the
   * paper in `taglineBox`, so a longer motto shrinks to fit rather than running
   * off the edge.
   *
   * The badges are sized separately, and not because one matters more: the left
   * crest is a wide mark and the right one is a circle, so an equal *width*
   * made the circle the taller of the two and it read as the bigger badge. */
  const HEADER = {
    tagline: 0.048,
    badgeLeft: 0.17, badgeRight: 0.1,
    logo: 0.6,
    pad: 0.02, gap: 0.02, rowGap: 0.02,
  };

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

  /* First of a list of sources that decodes. */
  async function loadFirst(sources) {
    for (const src of sources) {
      const img = await loadImage(src);
      if (img) return img;
    }
    return null;
  }

  /* The three marks, once per invoice. A missing badge is a missing badge —
     the header falls back to whatever loaded rather than failing the bill. */
  async function loadArt() {
    const [logo, left, right, tagline] = await Promise.all([
      loadFirst(ART.logo), loadFirst(ART.left), loadFirst(ART.right), loadFirst(ART.tagline),
    ]);
    return { logo, left, right, tagline };
  }

  /* Whether the browser can actually draw Devanagari, memoised.

     Only catches total failure — a face missing entirely, so the string
     rasterises to nothing. A font that draws .notdef boxes still puts ink down
     and passes here; there is no way to tell tofu from type through a canvas.
     That is the accepted risk: every device this runs on ships a Noto
     Devanagari face, and the artwork fallback covers what can be detected. */
  let devanagariOK = null;
  function canDrawDevanagari() {
    if (devanagariOK !== null) return devanagariOK;
    const cv = document.createElement("canvas");
    cv.width = 80;
    cv.height = 40;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, 80, 40);
    c.fillStyle = "#000";
    c.font = `700 28px ${TAGLINE_FAMILY}`;
    c.textBaseline = "middle";
    c.fillText("शक्ति", 2, 20);
    const px = c.getImageData(0, 0, 80, 40).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 200) ink++;
    devanagariOK = ink > 20;      // a handful of stray pixels is not a word
    return devanagariOK;
  }

  /* The tagline's type size and the box it needs, for a header `W` wide.
     Devanagari hangs matras above the cap line and vowel signs below the
     baseline, so the box is 1.5x the font size rather than the ~1.2x Latin
     would want — at 1.2 the danda and the top marks get clipped. */
  function taglineBox(W) {
    if (!TAGLINE || !canDrawDevanagari()) return null;
    const probe = document.createElement("canvas").getContext("2d");
    const maxW = Math.round(W * 0.92);
    let px = Math.max(6, Math.round(W * HEADER.tagline));
    probe.font = `700 ${px}px ${TAGLINE_FAMILY}`;
    let w = probe.measureText(TAGLINE).width;
    if (w > maxW) {
      // Scale the type down to the paper rather than letting it overflow.
      px = Math.max(6, Math.floor((px * maxW) / w));
      probe.font = `700 ${px}px ${TAGLINE_FAMILY}`;
      w = probe.measureText(TAGLINE).width;
    }
    return { px, w: Math.ceil(w), h: Math.ceil(px * 1.5) };
  }

  /* The whole header as one canvas `W` pixels wide: the P3Y crest in the top
     left corner, the P3Y 11 badge in the top right, and the shop's name block
     centred between them.
   *
   * One canvas rather than three draws, because text mode can only put an image
   * on the paper as a raster block and three blocks would be three bands with
   * printer line feeds between them — the badges would stack above the name
   * instead of flanking it. Building the arrangement here means the raster bill,
   * the text bill, the PDF and the preview all get the identical header.
   *
   * `W` should be a whole number of bytes wide (a multiple of 8): GS v 0 works
   * in 8-dot columns and anything else leaves a ragged right edge. Every caller
   * passes a printer dot width or a 2x multiple of one, so all of them are. */
  function headerCanvas(art, W) {
    if (!art || !(art.logo || art.left || art.right || art.tagline)) return null;

    const pad = Math.round(W * HEADER.pad);
    const gap = Math.round(W * HEADER.gap);
    const rowGap = Math.round(W * HEADER.rowGap);

    // Each mark keeps its own aspect ratio; width is given, height follows.
    const box = (img, w) => (img ? { img, w, h: Math.max(1, Math.round((img.height / img.width) * w)) } : null);

    /* Row 1 — the tagline, centred across the paper. Drawn as type when the
       browser has the script, and only then falling back to the artwork. */
    const tag = taglineBox(W);
    const tagArt = tag ? null : box(art.tagline, Math.round(W * 0.19));

    /* Row 2 — badges in the corners, the name block between them. */
    const lbw = Math.round(W * HEADER.badgeLeft);
    const rbw = Math.round(W * HEADER.badgeRight);
    // Without badges the name block has the whole paper, so it takes it.
    const side = (art.left ? lbw + gap : 0) + (art.right ? rbw + gap : 0);
    const lw = side
      ? Math.min(Math.round(W * HEADER.logo), W - pad * 2 - side)
      : W - pad * 2;
    const left = box(art.left, lbw);
    const right = box(art.right, rbw);
    const mid = box(art.logo, lw);
    const row = [left, right, mid].filter(Boolean);
    const rowH = row.length ? Math.max(...row.map((b) => b.h)) : 0;

    const top = tag || tagArt;
    const H = (top ? top.h + (rowH ? rowGap : 0) : 0) + rowH;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, W, H);

    let y = 0;
    if (tag) {
      c.fillStyle = "#000";
      c.font = `700 ${tag.px}px ${TAGLINE_FAMILY}`;
      c.textBaseline = "middle";
      c.fillText(TAGLINE, Math.round((W - tag.w) / 2), Math.round(tag.h / 2));
    } else if (tagArt) {
      c.drawImage(tagArt.img, Math.round((W - tagArt.w) / 2), y, tagArt.w, tagArt.h);
    }
    if (top) y += top.h + (rowH ? rowGap : 0);
    /* The badges hang from the top of their row — they are corner marks, and
       centring them against a much taller name block would float them in the
       middle of nothing. The name block is centred, because it is the thing the
       eye lands on. */
    if (left) c.drawImage(left.img, pad, y, left.w, left.h);
    if (right) c.drawImage(right.img, W - pad - right.w, y, right.w, right.h);
    if (mid) c.drawImage(mid.img, Math.round((W - mid.w) / 2), y + Math.round((rowH - mid.h) / 2), mid.w, mid.h);
    return cv;
  }

  /* Draw the receipt and return a canvas cropped to the height it actually
     used. The height isn't known until the last line is placed, so it is drawn
     on an over-tall scratch canvas first and copied into a snug one. */
  async function render(o, art, scale, qrImg) {
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
    /* The same composite the printer gets, so the preview, the PDF and the
       paper carry the badges in the same corners. The shop name is only set as
       text when nothing decoded — the name block spells it out already, and
       printing it twice is what the old header did. */
    const head = headerCanvas(art, W);
    if (head) {
      c.drawImage(head, 0, y);
      y += head.height + S(6);
    } else {
      line(SHOP, { size: 19, bold: true, center: true, gap: 1 });
    }
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

    /* ---- Scan to pay ---- *
     *
     * On every bill with something to pay, paid or not — the same rule the text
     * bill uses. The drawn bill had no QR block at all, which meant the Image
     * style printed a bill the Text style put a payment code on, and, worse,
     * the PDF sent to the customer on WhatsApp had no way to pay from it. */
    if (qrImg && o.total > 0) {
      const qr = qrFit(qrImg, Math.round(W * 0.56));
      if (qr) {
        line(`Scan to pay ${money(o.total)}`, { size: 13, bold: true, center: true, gap: 3 });
        // 1:1, never scaled — see qrFit.
        c.drawImage(qr, Math.round((W - qr.width) / 2), y);
        y += qr.height + S(8);
      }
    }

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

  /* The QR at the largest whole number of pixels per module that fits
     `targetW`, and never wider.

     Whole pixels, because that is the whole point of `qrCanvas`: scale a QR by
     a fraction and resampling eats module rows, leaving a code that still looks
     like a QR and scans never. The first pass is one pixel per module purely to
     count them, which is cheap — a 57x57 canvas — and saves threading the count
     back out of `qrCanvas` and past its other caller. */
  function qrFit(img, targetW) {
    const probe = qrCanvas(img, 1);
    if (!probe) return null;
    const px = Math.max(1, Math.floor(targetW / probe.width));
    return px === 1 ? probe : qrCanvas(img, px);
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

  function buildText(o, art, pay, qrImg) {
    const p = paper();
    const dots = (ESCPOSText.QR_MODULE && ESCPOSText.QR_MODULE[p.mm]) || 3;
    return ESCPOSText.build(o, {
      shop: SHOP,
      paperMm: p.mm,
      // Full paper width, so the badges reach the corners the owner asked for.
      logo: headerCanvas(art, p.dots),
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
    /* The same voice as the WhatsApp bill in orders.js, kept short: this one is
       a caption on a PDF, and the bill it is thanking them for is the file. */
    const note = `Namaste${o.customer && o.customer.name ? " " + o.customer.name : ""} 🙏\n`
      + `🌯❤️ Thank you for being a part of our Shawarma Family!❤️🌯\n\n`
      + `Here is your invoice for ${o.public_id} — total ${money(o.total)}.\n\n`
      + `Thank you for choosing us! See you again soon! ❤️`;
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
      /* Say plainly when the printer will have to be picked again, because the
         answer is not the owner's fault and there is something they can do
         about it. Once picked, the printer is reused for every bill; a page
         reload is the one thing that loses it, and only in a browser without
         the Web Bluetooth permissions backend. */
      const memoryNote = !saved
        ? ""
        : BTPrint.remembered()
          ? ` Already picked — the next bill goes straight to it, even if it has gone to sleep.`
          : BTPrint.canReattach()
            ? ` Picked once, it is reused for every bill after — no need to pick it again.`
            : ` Pick it once and every bill after goes straight to it. Reloading this page makes `
              + `Chrome ask again, unless you turn on “Use the new permissions backend for Web `
              + `Bluetooth” in chrome://flags.`;
      el("#invHint", m.backdrop).innerHTML = direct
        ? `Bluetooth prints straight to your thermal printer${saved ? ` — ${esc(saved)}` : ""}.${memoryNote} ${styleNote} `
          + `Dialog goes through the system print sheet instead. No printer? Save the PDF or send it on WhatsApp.`
        : `Dialog sends it to this device's print sheet — pick your printer there. `
          + `No printer connected? Save the PDF or send it on WhatsApp.`;
    }
    hint();
    // Fetched once and reused when the paper size or the style changes.
    const art = await loadArt();
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

      /* Before the render, not inside the text branch. The drawn bill carries
         the payment QR too now, so Image style, the PDF and the WhatsApp copy
         all need the link — fetching it only for Text style was what left the
         drawn bill without one. */
      await ensurePay();

      // The drawn bill is built either way — Dialog, PDF and Send PDF all need
      // it, and the buttons should not wait for a second render on a tap.
      const { canvas, paper: p } = await render(o, art, undefined, qrImg);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      built = {
        dataUrl,
        paper: p,
        pdf: buildPdf(dataUrlBytes(dataUrl), canvas.width, canvas.height, p.mm),
      };

      if (asText()) {
        preview.innerHTML = `<pre class="inv-text" aria-label="Invoice preview for ${esc(o.public_id)}">`
          + `${esc(buildText(o, art, pay, qrImg).text)}</pre>`;
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
            // built from.
            route = await BTPrint.printBytes(buildText(o, art, pay, qrImg).bytes);
          } else {
            // 1x, because the printer maps one canvas pixel to one dot.
            route = await BTPrint.printCanvas((await render(o, art, 1, qrImg)).canvas);
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
