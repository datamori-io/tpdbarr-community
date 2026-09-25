/*
 * Uploading your own pictures, singly or as a zip. The zip is read with
 * zlib (no dependencies): stored and deflate only; anything else is
 * reported, not skipped.
 */

import { inflateRawSync } from 'node:zlib';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Same limits the downloader uses, for the same reasons.
const MIN_BYTES = 15000;
const MAX_BYTES = 40 * 1024 * 1024;
export const MAX_UPLOAD = 512 * 1024 * 1024;

const EXTENSIONS = {
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.png': '.png',
  '.webp': '.webp',
  '.avif': '.avif',
  '.gif': '.gif',
};

const extensionOf = (name) => {
  const hit = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return hit ? EXTENSIONS[hit[0].toLowerCase()] || null : null;
};

export const isZip = (name) => /\.(zip|cbz)$/i.test(String(name || ''));

/* ------------------------------------------------------------------- zip */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/* Find the end-of-central-directory record by scanning back from the end. */
function endRecord(buffer) {
  const from = Math.max(0, buffer.length - 66_000);
  for (let at = buffer.length - 22; at >= from; at--) {
    if (buffer.readUInt32LE(at) === EOCD) {
      return { entries: buffer.readUInt16LE(at + 10), start: buffer.readUInt32LE(at + 16) };
    }
  }
  return null;
}

export function readZip(buffer) {
  const end = endRecord(buffer);
  if (!end) throw new Error('That does not look like a zip file.');

  const files = [];
  const skipped = [];
  let at = end.start;

  for (let i = 0; i < end.entries; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('The zip is damaged, or is a kind this cannot read.');

    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    at += 46 + nameLength + extraLength + commentLength;

    // Folders inside the archive, and the rubbish every Mac leaves behind.
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/i.test(name)) continue;

    const ext = extensionOf(name);
    if (!ext) {
      skipped.push({ name, why: 'not a picture' });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ name, why: `compression method ${method}` });
      continue;
    }
    if (buffer.readUInt32LE(localAt) !== LOCAL) {
      skipped.push({ name, why: 'bad entry' });
      continue;
    }

    // Take the data offset from the local header; its extra field length can differ.
    const localNameLength = buffer.readUInt16LE(localAt + 26);
    const localExtraLength = buffer.readUInt16LE(localAt + 28);
    const from = localAt + 30 + localNameLength + localExtraLength;

    const raw = buffer.subarray(from, from + size);
    let body;
    try {
      body = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    } catch (err) {
      skipped.push({ name, why: err.message });
      continue;
    }

    if (body.length > MAX_BYTES) {
      skipped.push({ name, why: 'over 40MB' });
      continue;
    }

    files.push({ name, ext, body });
  }

  // Filename order, because that is the order of a photo set — and the order
  // inside a zip is whatever the packer felt like.
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { files, skipped };
}

/* ---------------------------------------------------------------- writing */

/*
 * Write into the folder, numbering on from what's there. Tiny files
 * skipped; nothing overwritten.
 */
export async function writeInto(folder, files) {
  await mkdir(folder, { recursive: true });

  const already = await readdir(folder).catch(() => []);
  let position = already.length;

  const written = [];
  const skipped = [];

  for (const file of files) {
    if (file.body.length < MIN_BYTES) {
      skipped.push({ name: file.name, why: 'too small to be a picture' });
      continue;
    }

    const to = String(++position).padStart(3, '0') + file.ext;
    try {
      await writeFile(join(folder, to), file.body, { flag: 'wx' });
      written.push(to);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      skipped.push({ name: file.name, why: 'a file of that name is already there' });
    }
  }

  return { written, skipped };
}

/* One upload: a zip becomes its pictures; anything else is one picture. */
export function unpack(filename, body) {
  if (isZip(filename)) return readZip(body);

  const ext = extensionOf(filename);
  if (!ext) throw new Error(`${filename} is not a picture this can read.`);
  if (body.length > MAX_BYTES) throw new Error(`${filename} is over 40MB.`);

  return { files: [{ name: filename, ext, body }], skipped: [] };
}
