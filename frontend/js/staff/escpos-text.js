/* The bill as ESC/POS *text*, not as a picture of a bill.
 *
 * invoice.js draws a receipt onto a canvas and prints it as raster. That is the
 * right route when the layout matters more than anything (it prints exactly
 * what the preview and the PDF show), but it is the slow one: a 58mm bill is
 * ~40KB of dots over a BLE link that carries 180 bytes at a time.
 *
 * Text mode sends the characters instead and lets the printer's own font draw
 * them. The same bill is ~1KB, prints in a second or two, and comes out sharper
 * because there is no dithering between the glyph and the paper. The cost is
 * that layout is now a monospace grid — 32 columns on 58mm paper, 48 on 80mm —
 * and the printer's ROM font has no rupee sign and no emoji, so both are
 * transliterated on the way out (see `ascii`).
 *
 * Two things are still images or commands rather than characters:
 *   the logo — one small raster band at the top, via BTPrint.rasterBands
 *   the UPI QR — GS ( k, drawn by the printer from the upi:// URI itself, so it
 *                stays scannable at any module size the paper can hold
 *
 * `build()` returns the byte stream and the plain-text version of the same
 * lines, so the modal can show a preview that matches the paper column for
 * column.
 */
const ESCPOSText = (function () {
  const ESC = 0x1b;
  const GS = 0x1d;
  const LF = 0x0a;

  // Printable columns in the printer's Font A (12 dots per character).
  const COLS = { 58: 32, 80: 48 };
  /* Dots per QR module. A UPI intent URI is ~180 characters, which lands around
     QR version 11 (61 modules), so at 8 dots/mm these print roughly 23mm square
     on 58mm paper and 30mm on 80mm — big enough for a phone camera to lock on,
     small enough that the code isn't the biggest thing on the bill. At 3 dots a
     module is 0.375mm, where ink bleed on cheap paper can start costing scans:
     if phones struggle to read the code, raise this number. */
  const QR_MODULE = { 58: 3, 80: 4 };

  /* ---------------------------------------------------------------- *
   * Text for a ROM font
   * ---------------------------------------------------------------- */

  /* Fold a UTF-8 string down to the ASCII the printer can actually draw.
     Anything left unmapped is dropped rather than sent: an unmapped byte prints
     as a random glyph from whatever code page the printer booted in, and a bill
     with garbage in it looks broken in a way a missing symbol does not. */
  function ascii(s) {
    return String(s == null ? "" : s)
      .replace(/₹/g, "Rs.")
      .replace(/[×✕✖]/g, "x")
      .replace(/[\u2014\u2013\u2011\u2212]/g, "-")   // em/en dash, non-breaking hyphen, minus
      .replace(/[\u00b7\u2022]/g, "-")                // middle dot, bullet
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/[\u00a0\u202f\u2007]/g, " ")         // the non-breaking spaces
      // Accented Latin letters, flattened rather than dropped: CP437 carries
      // some of them, but not all, and "cafe" beats "caf".
      .replace(/[\u00e0-\u00e5\u00c0-\u00c5]/g, "a")
      .replace(/[\u00e8-\u00eb\u00c8-\u00cb]/g, "e")
      .replace(/[\u00ec-\u00ef\u00cc-\u00cf]/g, "i")
      .replace(/[\u00f2-\u00f6\u00d2-\u00d6]/g, "o")
      .replace(/[\u00f9-\u00fc\u00d9-\u00dc]/g, "u")
      .replace(/[\u00f1\u00d1]/g, "n")
      // Emoji, arrows, box drawing, Devanagari — every non-ASCII codepoint
      // that survived. A printer ROM font has none of them.
      .replace(/[^\x20-\x7e\n]/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  // ₹ is not in any printer code page, so amounts read "Rs.180" on paper.
  const amount = (n) => `Rs.${Number(n || 0).toFixed(Number.isInteger(+n) ? 0 : 2)}`;

  /* ---------------------------------------------------------------- *
   * Layout on a monospace grid
   * ---------------------------------------------------------------- */

  /* Collect ops rather than bytes, so the same bill can come out as a byte
     stream for the printer and as text for the on-screen preview. */
  function doc(cols) {
    const ops = [];

    // Double-width characters take two columns, so wrapping and right-padding
    // have to work in the width the *current* size gives us.
    const width = (o) => (o && o.dw ? Math.floor(cols / 2) : cols);

    function wrap(text, w) {
      const out = [];
      String(text).split("\n").forEach((para) => {
        let cur = "";
        para.split(" ").filter(Boolean).forEach((word) => {
          // A single word longer than the paper is cut, not left to wrap
          // wherever the printer happens to run out of head.
          while (word.length > w) {
            if (cur) { out.push(cur); cur = ""; }
            out.push(word.slice(0, w));
            word = word.slice(w);
          }
          const test = cur ? `${cur} ${word}` : word;
          if (test.length <= w || !cur) { cur = test; return; }
          out.push(cur);
          cur = word;
        });
        out.push(cur);
      });
      return out.length ? out : [""];
    }

    const api = {
      ops,

      /* One block of text. `opts`: bold, dw (double width), dh (double height),
         center, right, indent. */
      line(text, opts) {
        opts = opts || {};
        const w = width(opts) - (opts.indent || 0);
        const pad = " ".repeat(opts.indent || 0);
        wrap(ascii(text), w).forEach((row) => {
          ops.push({ t: "text", s: pad + row, ...opts });
        });
        return api;
      },

      /* A label on the left with an amount pinned to the right edge. The two
         are one string with spaces between, because the printer has no tab
         stops we can rely on — every model interprets HT differently. */
      row(left, right, opts) {
        opts = opts || {};
        const indent = opts.indent || 0;
        const w = width(opts) - indent;
        const pad = " ".repeat(indent);
        const r = ascii(right);
        const rows = wrap(ascii(left), Math.max(1, w - r.length - 1));
        rows.forEach((text, i) => {
          const last = i === rows.length - 1;
          const s = last ? text + " ".repeat(Math.max(1, w - text.length - r.length)) + r : text;
          ops.push({ t: "text", s: pad + s, ...opts });
        });
        return api;
      },

      rule(ch) {
        ops.push({ t: "text", s: (ch || "-").repeat(cols) });
        return api;
      },

      blank(n) {
        for (let i = 0; i < (n || 1); i++) ops.push({ t: "text", s: "" });
        return api;
      },

      /* Any bitmap block: the logo, or a QR we rasterised ourselves. The label
         is what the on-screen preview shows in the block's place. */
      image(canvas, label) {
        if (canvas) ops.push({ t: "raster", canvas, label });
        return api;
      },

      qr(data, module) {
        if (data) ops.push({ t: "qr", data: String(data), module });
        return api;
      },
    };
    return api;
  }

  /* ---------------------------------------------------------------- *
   * Ops to bytes
   * ---------------------------------------------------------------- */

  /* GS ( k, model 2. The printer builds the QR itself, so the payload travels
     as its own characters — a scannable code for the price of a text line. */
  function qrBytes(data, module) {
    const out = [];
    const payload = [];
    for (let i = 0; i < data.length; i++) payload.push(data.charCodeAt(i) & 0xff);
    const len = payload.length + 3;                       // the 3 is "1P0"
    out.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);  // model 2
    out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, module);      // module size
    out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);        // error correction M
    out.push(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...payload);
    out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);        // print what was stored
    return out;
  }

  function toBytes(ops, paperMm, opts) {
    const out = [];
    const push = (...b) => out.push(...b);
    const align = (n) => push(ESC, 0x61, n);              // ESC a  0 left 1 centre 2 right
    const bold = (on) => push(ESC, 0x45, on ? 1 : 0);     // ESC E
    const size = (dw, dh) => push(GS, 0x21, (dw ? 0x10 : 0) | (dh ? 0x01 : 0));  // GS !

    push(ESC, 0x40);                                      // ESC @  reset
    push(ESC, 0x74, 0x00);                                // ESC t 0  code page 437
    push(ESC, 0x33, 0x18);                                // ESC 3  line spacing, 24 dots

    let at = { align: 0, bold: false, dw: false, dh: false };
    const want = (o) => {
      const a = o.center ? 1 : o.right ? 2 : 0;
      if (a !== at.align) { align(a); at.align = a; }
      if (!!o.bold !== at.bold) { bold(!!o.bold); at.bold = !!o.bold; }
      if (!!o.dw !== at.dw || !!o.dh !== at.dh) {
        size(!!o.dw, !!o.dh);
        at.dw = !!o.dw;
        at.dh = !!o.dh;
      }
    };

    ops.forEach((op) => {
      if (op.t === "text") {
        want(op);
        for (let i = 0; i < op.s.length; i++) push(op.s.charCodeAt(i) & 0xff);
        push(LF);
        return;
      }
      if (op.t === "raster") {
        want({ center: true });
        // Reset size first: on some firmwares GS ! scales the raster too, and a
        // double-width logo wraps onto a second strip.
        size(false, false);
        at.dw = at.dh = false;
        push(...BTPrint.rasterBands(op.canvas));
        return;
      }
      if (op.t === "qr") {
        want({ center: true });
        push(...qrBytes(op.data, op.module || QR_MODULE[paperMm] || 6));
        push(LF);
      }
    });

    push(ESC, 0x64, opts && opts.feed != null ? opts.feed : 4);   // ESC d  clear the tear bar
    if (opts && opts.cut) push(GS, 0x56, 0x42, 0x00);             // GS V B  partial cut
    return new Uint8Array(out);
  }

  /* One op as the line the paper will carry, padded the way the printer will
     align it. Double-width text is stretched with a space between letters, so a
     line that will overflow the paper overflows here too instead of looking
     fine on screen and wrapping on paper. */
  function placed(op, cols) {
    const s = op.dw ? op.s.trimEnd().split("").join(" ") : op.s;
    const pad = Math.max(0, cols - s.length);
    if (op.center) return " ".repeat(Math.floor(pad / 2)) + s;
    if (op.right) return " ".repeat(pad) + s;
    return s;
  }

  /* The whole bill as one string, images named in square brackets. Still what a
     plain-text copy of the bill wants; `toBlocks` is what a preview wants. */
  function toText(ops, cols) {
    return ops.map((op) => {
      if (op.t === "raster") return placed({ s: `[ ${op.label || "image"} ]`, center: true }, cols);
      if (op.t === "qr") return placed({ s: "[ UPI QR code ]", center: true }, cols);
      return placed(op, cols);
    }).join("\n");
  }

  /* The same lines, but broken at every image, with the image itself carried
     through rather than named. A preview built from these shows the logo and
     the QR where the paper will actually have them — the placeholder version
     showed neither, so the owner could not tell a bill with the wrong artwork
     from a bill with the right artwork until it was printed.
     Runs of text stay in one block so the monospace grid is unbroken. */
  function toBlocks(ops, cols) {
    const out = [];
    ops.forEach((op) => {
      if (op.t !== "text") {
        out.push({ ...op });
        return;
      }
      const line = placed(op, cols);
      const last = out[out.length - 1];
      if (last && last.t === "text") last.text += `\n${line}`;
      else out.push({ t: "text", text: line });
    });
    return out;
  }

  /* ---------------------------------------------------------------- *
   * The bill
   * ---------------------------------------------------------------- */

  function ordinal(n) {
    if (!n) return "";
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
    return `${n}${suffix}`;
  }

  /* Lay out one order.
   *
   * `opts`: shop, paperMm, logo (a canvas at the paper's dot width or narrower),
   * qrCanvas (same, already at module size), upiUri, dateText, cut. Everything is optional — a bill missing the logo or
   * the QR prints without them rather than failing.
   */
  function build(o, opts) {
    opts = opts || {};
    const mm = COLS[opts.paperMm] ? opts.paperMm : 58;
    const cols = COLS[mm];
    const d = doc(cols);
    const cust = o.customer || {};

    /* ---- Header ---- */
    d.image(opts.logo, "logo");
    // The logo already spells the name out, so the name is not printed twice.
    // Without a logo it is the only thing identifying the bill, so it comes
    // back as text.
    if (!opts.logo) d.line(opts.shop || "Shiv Paneer Shawarma", { center: true, bold: true, dw: true, dh: true });
    d.rule("=");

    /* ---- Order details ---- */
    d.line("ORDER DETAILS", { bold: true });
    d.line(`Date : ${opts.dateText || "-"}`);
    // Bold, but the same height as the rest: it is the line staff and customer
    // read out to each other, and bold alone picks it out of the block.
    d.line(`Order No : ${o.public_id || "-"}`, { bold: true });
    d.line(`Client Name : ${cust.name || "-"}`);
    d.line(`Client Number : ${cust.phone || "-"}`);
    if (o.coupon_code) d.line(`Coupon : ${o.coupon_code}`);
    if (o.order_type === "delivery" && cust.address) d.line(`Address : ${cust.address}`);
    if (o.notes) d.line(`Note : ${o.notes}`);
    d.rule();

    /* ---- Items ---- */
    d.row("ITEM", "AMOUNT", { bold: true });
    d.rule();
    let units = 0;
    let free = 0;
    (o.items || []).forEach((i) => {
      units += i.quantity || 0;
      free += i.free_quantity || 0;
      // Name and amount on one row, so the amounts form a column the eye can
      // add up; what makes up that amount goes underneath, indented.
      d.row(ascii(i.name) || "Item", amount(i.line_total), { bold: true });
      const detail = [
        `${i.quantity} x ${amount(i.unit_price)}`,
        i.variant_label || "",
        i.free_quantity ? `+${i.free_quantity} free` : "",
        i.promo_label || "",
      ].filter(Boolean).join(" - ");
      d.line(detail, { indent: 2 });
    });
    d.rule();

    /* ---- Bill ---- */
    d.line(`Quantity : ${units} item${units === 1 ? "" : "s"}${free ? ` (+${free} free)` : ""}`);
    // Same rule as the dashboard and the raster bill: a subtotal is only worth
    // a line when something below it moves the number.
    if (o.promo_discount > 0 || o.coupon_discount > 0 || o.delivery_fee > 0) {
      d.row("Subtotal", amount(o.subtotal));
    }
    if (o.promo_discount > 0) {
      const labels = [...new Set((o.items || []).map((i) => i.promo_label).filter(Boolean))];
      d.row(`Offers${labels.length ? ` (${labels.join(", ")})` : ""}`, `- ${amount(o.promo_discount)}`);
    }
    if (o.coupon_discount > 0) {
      d.row(`Coupon${o.coupon_code ? ` ${o.coupon_code}` : ""}`, `- ${amount(o.coupon_discount)}`);
    }
    if (o.delivery_fee > 0) {
      d.row(`Delivery${o.delivery_area ? ` (${o.delivery_area})` : ""}`, amount(o.delivery_fee));
    }
    d.rule("=");
    d.row("TOTAL", amount(o.total), { bold: true, dw: true, dh: true });
    d.rule("=");

    /* ---- Thank you ---- *
     *
     * No payment line and no status line: the customer is standing at the
     * counter when this prints, so the paper telling them "Cash - Unpaid" or
     * "Status : Placed" says nothing they don't already know, and a status
     * printed at the till is stale by the time the order is handed over. The
     * "Scan to pay" block below is what an unpaid bill actually needs. */
    d.line(o.repeat_no > 1
      ? `Thank you for visiting for the ${ordinal(o.repeat_no)} time.`
      : "Thank you for visiting us today.",
      { center: true, bold: true });
    d.line("We are glad you are here :)", { center: true });
    d.blank();

    /* ---- Payment QR ---- */
    /* On every bill with something to pay, paid or not. It used to be skipped
       once payment was recorded, which quietly dropped the QR from every
       counter order the staff ticked "payment collected" on — the common case
       at the till, and the one the owner noticed. */
    if ((opts.qrCanvas || opts.upiUri) && o.total > 0) {
      d.line(`Scan to pay ${amount(o.total)}`, { center: true, bold: true });
      /* Prefer a QR we rasterised ourselves. GS ( k is the elegant route — the
         printer draws the code from the URI — but plenty of cheap 58mm
         firmwares ignore the command and print nothing at all, and a bill with
         "Scan to pay" over blank paper is worse than no QR. A raster block is
         dots, and every printer that can print a logo can print dots. */
      if (opts.qrCanvas) d.image(opts.qrCanvas, "UPI QR code");
      else d.qr(opts.upiUri, opts.qrModule);
      d.blank();
    }

    return {
      bytes: toBytes(d.ops, mm, opts),
      text: toText(d.ops, cols),
      blocks: toBlocks(d.ops, cols),
      cols,
    };
  }

  return { build, ascii, amount, toText, toBlocks, COLS, QR_MODULE };
})();
