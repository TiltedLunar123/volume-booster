/*
 * Minimal zip writer. Deflate only, no dependencies.
 *
 * The extension has no build step, so pulling in a packaging library just to
 * produce two store uploads would be the only node_modules in the repo. This is
 * about seventy lines instead.
 *
 * Timestamps are fixed so that the same input always produces a byte-identical
 * archive, which makes it obvious when a store upload actually changed.
 */
import zlib from 'node:zlib';
import { crc32 } from './crc32.mjs';

// 2026-01-01 00:00:00 in MS-DOS date/time format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/**
 * @param {Array<{name: string, data: Buffer}>} entries paths use forward slashes
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useStore = deflated.length >= raw.length;
    const body = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const sum = crc32(raw);

    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),          // version needed
      u16(0),           // flags
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(sum),
      u32(body.length),
      u32(raw.length),
      u16(name.length),
      u16(0),           // extra length
      name
    ]);

    locals.push(header, body);

    central.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),          // version made by
      u16(20),          // version needed
      u16(0),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(sum),
      u32(body.length),
      u32(raw.length),
      u16(name.length),
      u16(0),           // extra
      u16(0),           // comment
      u16(0),           // disk number
      u16(0),           // internal attrs
      u32(0),           // external attrs
      u32(offset),
      name
    ]));

    offset += header.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0)
  ]);

  return Buffer.concat([...locals, directory, end]);
}
