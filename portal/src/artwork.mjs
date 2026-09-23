/*
 * Pictures somebody uploaded, and what this app will accept as one.
 *
 * Three places take artwork now — a category's cover, a performer's photograph
 * and a studio's logo — and they disagree about where it ends up. A category's
 * is the portal's own file in config/covers/; the other two are written into
 * Stash, because a performer's picture is Stash's record and not this app's
 * opinion of it.
 *
 * What they cannot be allowed to disagree about is what counts as a picture.
 * Two copies of a magic-byte table are two copies that drift, and the one that
 * drifts is the one that lets something through.
 *
 * **Sniffed, not trusted.** The format is read out of the file's own header
 * rather than from the name the browser sent. That name is the one part of an
 * upload entirely under the client's control, and here it would decide both
 * the filename written to disk and the content type served back out.
 */

// 8MB. Artwork is displayed a few hundred pixels wide and this is already
// generous; the cap is there because none of the places this lands is a media
// folder. A performer's photograph goes into the Stash database itself.
export const MAX_ART = 8 * 1024 * 1024;

const starts = (buffer, bytes, at = 0) => bytes.every((byte, i) => buffer[at + i] === byte);

/*
 * What this actually is, or null. Only the formats a browser will draw, and
 * each read from its own header rather than from a list of extensions.
 */
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

/*
 * The one check, made the same way everywhere, so the three callers cannot
 * develop three opinions about an 8MB WebP. Throws what the route should send.
 */
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

/*
 * How Stash takes an image: a data URI on the update mutation, which it
 * decodes and stores itself. There is no upload endpoint to post bytes at.
 *
 * Base64 is a third bigger than the bytes it carries, so an 8MB picture is an
 * 11MB mutation body. That is the real reason for the cap above rather than
 * anything about how big a photograph ought to be.
 */
export const dataUrl = (buffer, kind) => `data:${kind.type};base64,${buffer.toString('base64')}`;
