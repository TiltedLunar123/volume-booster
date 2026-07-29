/*
 * Just enough PNG to read what Chromium hands back and write what the Chrome
 * Web Store accepts. 8 bit only, no interlacing, no palettes.
 *
 * The store rejects alpha on screenshots and promo tiles, and a screenshot
 * captured over an opaque page is fully opaque anyway, so the useful operation
 * is decode RGBA, drop the alpha, re-encode as 24 bit RGB.
 */
import zlib from 'node:zlib';
import { crc32 } from './crc32.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, sum]);
}

/** @param channels 4 for RGBA, 3 for RGB */
export function encodePng(width, height, pixels, channels = 4) {
  if (channels !== 3 && channels !== 4) throw new Error(`unsupported channels: ${channels}`);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function unfilter(type, line, prior, bpp) {
  const n = line.length;
  switch (type) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prior[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prior[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + predicted) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown png filter: ${type}`);
  }
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a png');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  let pos = 8;
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png is not supported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported png colour type: ${colorType}`);
  if (bitDepth !== 8) throw new Error(`unsupported png bit depth: ${bitDepth}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prior = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start], line, prior, channels);
    line.copy(out, y * stride);
    prior = line;
  }

  return { width, height, channels, data: out };
}

/** Drops the alpha channel. Anything already opaque is unchanged visually. */
export function stripAlpha(image) {
  if (image.channels === 3) return image;
  if (image.channels !== 4) throw new Error(`cannot strip alpha from ${image.channels} channels`);

  const out = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4, j += 3) {
    out[j] = image.data[i];
    out[j + 1] = image.data[i + 1];
    out[j + 2] = image.data[i + 2];
  }
  return { width: image.width, height: image.height, channels: 3, data: out };
}

export function toOpaquePng(buffer) {
  const image = stripAlpha(decodePng(buffer));
  return encodePng(image.width, image.height, image.data, 3);
}
