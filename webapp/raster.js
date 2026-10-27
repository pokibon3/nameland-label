// Label layout and conversion to the KL-SP100 column raster.

import { HEAD_DOTS, DOTS_PER_MM } from './printer.js';
import { encodeBarcode } from './barcode.js';

/* global qrcode */

const BLOCK_GAP_DOTS = 2 * DOTS_PER_MM;
const BAR_MODULE_DOTS = 2;      // 0.25 mm narrow bar
const BAR_QUIET_MODULES = 10;

export function makeQr(text, ecLevel = 'M') {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, ecLevel);
  qr.addData(text, 'Byte');
  qr.make();
  return qr;
}

function fontSpec(o, px) {
  return `${o.fontWeight || 'normal'} ${px}px ${o.font}`;
}

// Ink extents above/below the em-box middle, per px of font size.
function inkExtents(lines, o, scratch) {
  const ref = 100;
  scratch.font = fontSpec(o, ref);
  scratch.textBaseline = 'middle';
  let up = 0, down = 0;
  for (const l of lines) {
    const m = scratch.measureText(l);
    up = Math.max(up, m.actualBoundingBoxAscent);
    down = Math.max(down, m.actualBoundingBoxDescent);
  }
  return { up: up / ref, down: down / ref };
}

// Largest font size whose lines fit in `height` dots, descenders included.
function fitFontPx(lines, o, height, ink) {
  const lineGap = 1.15;
  let px = Math.floor(height / (lines.length * lineGap - (lineGap - 1)));
  const inkH = ink.up + ink.down + (lines.length - 1) * lineGap;
  if (ink.up + ink.down > 0) px = Math.min(px, Math.floor((height - 1) / inkH));
  if (o.fontScale) px = Math.floor(px * o.fontScale);
  return Math.max(6, px);
}

// Frame geometry: stroke thickness and the inset content must keep.
function frameMetrics(frame, H) {
  if (!frame || frame === 'none') return { t: 0, padY: 0, padX: 0 };
  const t = Math.max(2, Math.round(H / 36));
  const lines = frame === 'double' ? 3 : 1;          // two strokes and a gap
  const padY = t * lines + Math.max(2, Math.round(H * 0.08));
  const innerH = H - 2 * padY;
  let padX = padY + Math.round(innerH * 0.12);
  if (frame === 'capsule') padX = Math.round(H / 2);
  return { t, padY, padX };
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFrame(ctx, frame, W, H, t) {
  if (!t) return;
  ctx.save();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = t;
  const h = t / 2;
  const box = (inset, radius) => {
    roundRectPath(ctx, inset + h, inset + h, W - 2 * inset - t, H - 2 * inset - t, radius);
    ctx.stroke();
  };
  if (frame === 'rect') box(0, 0);
  else if (frame === 'round') box(0, H * 0.22);
  else if (frame === 'capsule') box(0, H / 2);
  else if (frame === 'double') { box(0, 0); box(2 * t, 0); }
  ctx.restore();
}

// ---- content blocks: each has a width and draws itself in (x, y, h) ----

function textBlock(o, h) {
  const lines = o.text.split('\n');
  const scratch = document.createElement('canvas').getContext('2d');
  const ink = inkExtents(lines, o, scratch);
  const px = fitFontPx(lines, o, h, ink);
  const lineH = Math.round(px * 1.15);
  scratch.font = fontSpec(o, px);
  const widths = lines.map((l) => scratch.measureText(l).width);
  const w = Math.ceil(Math.max(...widths));
  return {
    kind: 'text', w, fontPx: px,
    draw(ctx, x, y) {
      ctx.font = fontSpec(o, px);
      ctx.textBaseline = 'middle';
      // centre the em boxes, then nudge so the ink stays inside the tape
      const span = lineH * (lines.length - 1);
      let y0 = y + h / 2 - span / 2;
      y0 = Math.min(y0, y + h - 1 - ink.down * px - span);
      y0 = Math.max(y0, y + ink.up * px);
      lines.forEach((line, i) => {
        let lx = x;
        if (o.align === 'center') lx = x + (w - widths[i]) / 2;
        else if (o.align === 'right') lx = x + w - widths[i];
        ctx.fillText(line, Math.round(lx), Math.round(y0 + i * lineH));
      });
    },
  };
}

function qrBlock(o, h) {
  const qr = makeQr(o.qrText, o.qrEc || 'M');
  const n = qr.getModuleCount();
  const m = Math.max(1, Math.floor(h / (n + 2)));
  const size = n * m;
  return {
    kind: 'qr', w: size, qrModule: m,
    draw(ctx, x, y) {
      const y0 = y + Math.floor((h - size) / 2);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(x + c * m, y0 + r * m, m, m);
      }
    },
  };
}

function barcodeBlock(o, h) {
  const { modules, text } = encodeBarcode(o.barType, o.barText);
  const m = BAR_MODULE_DOTS;
  const quiet = BAR_QUIET_MODULES * m;
  const textPx = o.barShowText && h >= 40 ? Math.max(10, Math.round(h * 0.2)) : 0;
  const barH = textPx ? h - textPx - Math.round(textPx * 0.25) : h;
  return {
    kind: 'barcode', w: quiet * 2 + modules.length * m, barModule: m,
    draw(ctx, x, y) {
      for (let i = 0; i < modules.length; i++) {
        if (modules[i]) ctx.fillRect(x + quiet + i * m, y, m, barH);
      }
      if (textPx) {
        ctx.font = `${textPx}px Menlo, "SF Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(text, x + quiet + (modules.length * m) / 2, y + h);
        ctx.textAlign = 'start';
      }
    },
  };
}

/**
 * Render the label as a canvas whose height is the head dots of the tape
 * and whose width is the printed length (excluding the printer's side feed).
 * o: { tape, text, code: 'none'|'qr'|'barcode', codePos: 'left'|'right',
 *      qrText, barType, barText, barShowText, frame, font (CSS family),
 *      fontWeight, align, fontScale, lengthMm (0 = auto), sideMarginMm, invert }
 * scale > 1 renders the same layout at a higher resolution (for preview).
 * Throws when the QR/barcode content is invalid.
 */
export function renderLabel(o, scale = 1) {
  const H = HEAD_DOTS[o.tape];
  const { t, padY, padX } = frameMetrics(o.frame, H);
  const innerH = H - 2 * padY;

  let code = null;
  if (o.code === 'qr' && o.qrText) code = qrBlock(o, innerH);
  else if (o.code === 'barcode') code = barcodeBlock(o, innerH);
  const text = o.text.trim() !== '' ? textBlock(o, innerH) : null;

  const blocks = [code, text].filter(Boolean);
  if (code && text && o.codePos === 'right') blocks.reverse();
  const contentW = blocks.reduce((sum, b) => sum + b.w, 0) + BLOCK_GAP_DOTS * Math.max(0, blocks.length - 1);

  let W = o.lengthMm > 0
    ? Math.round((o.lengthMm - 2 * o.sideMarginMm) * DOTS_PER_MM)
    : contentW + 2 * padX;
  W = (Math.max(8, W) + 7) & ~7;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // place the content block inside the frame padding
  const room = W - 2 * padX;
  let x = padX;
  if (o.lengthMm > 0 && contentW < room) {
    if (o.align === 'center') x = padX + Math.floor((room - contentW) / 2);
    else if (o.align === 'right') x = padX + room - contentW;
  }

  ctx.fillStyle = '#000';
  for (const b of blocks) {
    b.draw(ctx, x, padY);
    x += b.w + BLOCK_GAP_DOTS;
  }
  drawFrame(ctx, o.frame, W, H, t);

  if (o.invert) {
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    canvas,
    widthDots: W,
    heightDots: H,
    fontPx: text ? text.fontPx : 0,
    qrModuleDots: code && code.qrModule ? code.qrModule : 0,
    barModuleDots: code && code.barModule ? code.barModule : 0,
    overflow: o.lengthMm > 0 && contentW > room,
  };
}

// Ink where luminance < 128 (black text matches the official app's red < 128;
// luminance also gives sensible results for colour emoji).
export function inkMask(canvas) {
  const { width: W, height: H } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    ink[i] = lum < 128 ? 1 : 0;
  }
  return ink;
}

/**
 * Column-major raster sent to the printer: for each column x (left to right,
 * width padded to a multiple of 32), H/8 bytes; byte k bit j = row 8k+j
 * counted from the top edge of the image.
 */
export function toRaster(canvas) {
  const { width: W, height: H } = canvas;
  const ink = inkMask(canvas);
  const W32 = Math.ceil(W / 32) * 32;
  const bpc = H / 8;
  const out = new Uint8Array(W32 * bpc);
  for (let x = 0; x < W; x++) {
    for (let k = 0; k < bpc; k++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        if (ink[(k * 8 + j) * W + x]) b |= 1 << j;
      }
      out[x * bpc + k] = b;
    }
  }
  return out;
}

// Draw the thresholded result (what will actually print) at 1 px per dot,
// ink in `inkRgb` on a transparent background; CSS scales it for display.
export function drawPreview(target, canvas, inkRgb = [20, 20, 20]) {
  const { width: W, height: H } = canvas;
  const ink = inkMask(canvas);
  target.width = W;
  target.height = H;
  const ctx = target.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    if (!ink[i]) continue;
    img.data.set(inkRgb, i * 4);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
