/*
 * Uploaded artwork: category covers (config/covers/), performer photos and
 * studio logos (into Stash). One check for all three. The format is read
 * from the file's header, never the uploaded name.
 */

// 8MB cap: base64 makes it an 11MB Stash mutation.
export const MAX_ART = 8 * 1024 * 1024;

const starts = (buffer, bytes, at = 0) => bytes.every((byte, i) => buffer[at + i] === byte);

/* The image type from its header, or null. Browser-drawable formats only. */
export function kindOf(buffer) {
  if (!buffer || buffer.length < 16) return null;

  if (starts(buffer, [0xff, 0xd8, 0xff])) return { ext: '.jpg', type: 'image/jpeg' };
  if (starts(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: '.png', type: 'image/png' };
  if (starts(buffer, [0x47, 0x49, 0x46, 0x38])) return { ext: '.gif', type: 'image/gif' };

  // RIFF....WEBP — the four bytes between are the length, which is not ours.
  if (starts(buffer, [0x52, 0x49, 0x46, 0x46]) && starts(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: '.webp', type: 'image/webp' };
  }

  // An ISO box: the brand sits after 'ftyp', and avif and its sequence variant
  // are the two a browser will draw.
  if (starts(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buffer.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return { ext: '.avif', type: 'image/avif' };
  }

  return null;
}

export const ART_TYPES = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/* The one check. Throws what the route should send. */
export function checked(buffer) {
  if (!buffer?.length) throw Object.assign(new Error('The upload was empty.'), { status: 400 });

  if (buffer.length > MAX_ART) {
    throw Object.assign(new Error('That picture is over 8MB.'), { status: 413 });
  }

  const kind = kindOf(buffer);
  if (!kind) {
    throw Object.assign(
      new Error('That is not a picture this can use — JPEG, PNG, WebP, AVIF or GIF.'),
      { status: 415 }
    );
  }

  return kind;
}

/* Stash takes images as a data URI on the update mutation. */
export const dataUrl = (buffer, kind) => `data:${kind.type};base64,${buffer.toString('base64')}`;
