/*
 * Renders the toolbar icons. No image editor, no binary blobs in git.
 *
 * A tiny PNG encoder plus a 4x supersampled software rasteriser. The glyph
 * simplifies itself at small sizes: two arcs at 48px and above, one thicker arc
 * below that, because two hairlines turn to mush at 16px.
 *
 * Run: node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from './crc32.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4;

/* ---------------------------- png encoder ---------------------------- */

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, sum]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ----------------------------- geometry ------------------------------ */

// Everything below works in a 0..1 unit square, so one description covers all
// four output sizes.

function inRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inArc(x, y, cx, cy, radius, width, halfSpread) {
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(dist - radius) > width / 2) return false;
  if (dx <= 0) return false;
  return Math.abs(Math.atan2(dy, dx)) <= halfSpread;
}

const SPEAKER_BODY = { x0: 0.20, x1: 0.335, y0: 0.395, y1: 0.605 };
const SPEAKER_CONE = [
  [0.335, 0.395],
  [0.505, 0.225],
  [0.505, 0.775],
  [0.335, 0.605]
];

function glyphAt(x, y, arcs) {
  if (x >= SPEAKER_BODY.x0 && x <= SPEAKER_BODY.x1 &&
      y >= SPEAKER_BODY.y0 && y <= SPEAKER_BODY.y1) return true;
  if (inPolygon(x, y, SPEAKER_CONE)) return true;
  for (const arc of arcs) {
    if (inArc(x, y, 0.47, 0.5, arc.r, arc.w, 0.86)) return true;
  }
  return false;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// Green, because the level-meter ramp that runs along the slider and the badge
// starts there. The tile stays inside one hue: blending green into the amber
// end of that ramp lands on olive, which looks like a mistake at 16px.
const FROM = [0x0f, 0x9d, 0x4c]; // deep green
const TO = [0x3a, 0xdb, 0x74];   // bright green

/* ------------------------------ render ------------------------------- */

/**
 * @param size    output canvas in pixels
 * @param tile    fraction of the canvas the tile fills. 1 is full bleed, which
 *                is what the toolbar wants. The Chrome Web Store listing icon
 *                wants a 96x96 tile inside a 128x128 canvas, so 0.75 there.
 */
function render(size, tile = 1) {
  const glyphSize = size * tile;
  const arcs = glyphSize >= 48
    ? [{ r: 0.20, w: 0.062 }, { r: 0.315, w: 0.062 }]
    : [{ r: 0.245, w: 0.105 }];
  const radius = 0.225;
  const inset = (1 - tile) / 2;
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      let gradSum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size - inset) / tile;
          const y = ((py + (sy + 0.5) / SS) / size - inset) / tile;
          if (x < 0 || x > 1 || y < 0 || y > 1) continue;
          if (!inRoundedSquare(x, y, radius)) continue;
          bgHits++;
          gradSum += (x + y) / 2;
          if (glyphAt(x, y, arcs)) fgHits++;
        }
      }

      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (bgHits === 0) continue;

      const [r, g, b] = mix(FROM, TO, gradSum / bgHits);
      const bgAlpha = bgHits / total;
      const fgAlpha = fgHits / total;

      // Composite white glyph over the gradient, then the whole tile over
      // transparency using the rounded-square coverage.
      const t = bgAlpha > 0 ? fgAlpha / bgAlpha : 0;
      out[i] = Math.round(r + (255 - r) * t);
      out[i + 1] = Math.round(g + (255 - g) * t);
      out[i + 2] = Math.round(b + (255 - b) * t);
      out[i + 3] = Math.round(bgAlpha * 255);
    }
  }

  return encodePng(size, size, out);
}

const ROOT = path.join(HERE, '..');
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${rel(file)} (${size}x${size})`);
}

// Listing art, not shipped in the extension package. Chrome asks for a 96x96
// tile centred in a 128x128 canvas with the remaining 16px per side left
// transparent, which is not what the toolbar icon wants.
const STORE = path.join(ROOT, 'store');
fs.mkdirSync(STORE, { recursive: true });
const storeIcon = path.join(STORE, 'store-icon-128.png');
fs.writeFileSync(storeIcon, render(128, 0.75));
console.log(`wrote ${rel(storeIcon)} (128x128, 96x96 tile plus 16px padding)`);
