/* The index sheet: every picture in play, at a size you can judge by. */

import { api, el } from '../util.js';

/* ============================================================== comparing
 *
 * Both pages under this tab end at the same question — *is this the same
 * scene* — and both were answering it with two thumbnails a row apart. The
 * scene's frame at 176 and a candidate's cover at 176, and if the answer is
 * not obvious at that size you were opening the file to check.
 *
 * So this lays everything out at once and at a size that settles it: the
 * scene's own frames along the top, every candidate underneath, all the same
 * width. Cut more frames if the ones you have show nothing useful.
 *
 * **Inline, never a dialog.** You are working down a list, and a list you keep
 * being thrown out of is slower than the thing it replaced — the same reason
 * the match rows grow their candidates in place. This opens under the row and
 * closes again.
 *
 * **And it puts a number on it.** The picture pass on the match page already
 * measures a candidate's artwork against the scene's cover; here it measures
 * against every frame and reports the closest, which is strictly better
 * information — a cover cut at 25% is one sample of a scene, and the promo
 * still that a box holds was not necessarily taken anywhere near it.
 */

const HASH_W = 9;
const HASH_H = 8;

/*
 * 64 bits, or null if the picture cannot be read.
 *
 * Null covers every way this fails and they are all the same answer: no image,
 * a load that never finished, a canvas the browser will not let us read back.
 * A source whose artwork taints the canvas lands here rather than throwing,
 * and simply gets no number.
 */
function pictureHash(src) {
  return new Promise((done) => {
    if (!src) return done(null);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => done(null);

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = HASH_W;
        canvas.height = HASH_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, HASH_W, HASH_H);

        const { data } = ctx.getImageData(0, 0, HASH_W, HASH_H);
        const grey = [];
        for (let i = 0; i < data.length; i += 4) {
          grey.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }

        const bits = [];
        for (let y = 0; y < HASH_H; y++) {
          for (let x = 0; x < HASH_W - 1; x++) {
            bits.push(grey[y * HASH_W + x] > grey[y * HASH_W + x + 1] ? 1 : 0);
          }
        }
        done(bits);
      } catch {
        done(null);
      }
    };

    img.src = src;
  });
}

const bitsApart = (a, b) => a.reduce((n, bit, i) => n + (bit === b[i] ? 0 : 1), 0);

/*
 * What a distance means, in words rather than in bits.
 *
 * The thresholds are the ones measured on this library when the picture pass
 * was built: correct candidates scored 0 to 18 against the scene's own cover,
 * every wrong one scored 25 or more, and a 64-bit hash of two unrelated
 * pictures averages 32. The gap between 18 and 25 is the whole signal and it
 * is worth saying out loud rather than leaving as a number to interpret.
 */
const verdict = (apart) => {
  if (apart == null) return { word: '', why: '' };
  if (apart <= 8) return { word: 'the same picture', why: `${apart} of 64 apart` };
  if (apart <= 20) return { word: 'looks like it', why: `${apart} of 64 apart — a correct answer has never measured worse than 18 here` };
  if (apart <= 27) return { word: 'not sure', why: `${apart} of 64 apart, which is the gap where this stops meaning anything` };
  return { word: 'different picture', why: `${apart} of 64 apart — two unrelated pictures average 32` };
};

/*
 * The index sheet.
 *
 * `images` is what there is to compare against: `{ key, label, src, onPick }`.
 * `onPick` is optional and is what makes this useful on the match page rather
 * than merely interesting — having decided by looking, the tick is right here
 * instead of back up the row.
 */
export function compareSheet(sceneId, images, { onClose = null } = {}) {
  const mine = el('div', { className: 'cmpstrip' });
  const theirs = el('div', { className: 'cmpstrip' });
  const said = el('span', { className: 'muted small' }, 'Reading the frames…');

  const more = el('button', { className: 'chip', type: 'button', hidden: true }, 'Cut more frames');
  const shut = el('button', { className: 'chip', type: 'button' }, 'Close');
  if (onClose) shut.onclick = onClose;

  const sheet = el('div', { className: 'searchpanel cmpsheet' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Compare'),
      el('span', { className: 'muted small' }, 'the scene above, the answers below — same size, so the difference is the picture'),
      el('span', { className: 'spacer' }),
      more,
      shut),
    el('div', { className: 'cmplabel' }, 'This scene'),
    mine,
    el('div', { className: 'cmplabel' }, `What the sources offered (${images.length})`),
    theirs,
    el('div', { className: 'controls' }, said)
  );

  // Every frame's hash, so a candidate can be measured against the closest one
  // rather than against whichever single frame happened to be the thumbnail.
  let frameHashes = [];

  const tile = (src, label, extra = null, onPick = null) => {
    const img = el('img', { className: 'cmpart', src, alt: label });
    const node = el('div', { className: 'cmptile' + (onPick ? ' pickable' : '') },
      img,
      el('div', { className: 'cmpname' }, label),
      extra || el('div', { className: 'muted small' }, '')
    );

    if (onPick) {
      node.onclick = () => {
        const on = onPick();
        node.classList.toggle('on', Boolean(on));
      };
    }

    return node;
  };

  const drawFrames = (frames) => {
    mine.replaceChildren(
      // The row's own thumbnail first: it is what the picture pass has always
      // measured against, and seeing it beside the frames says whether it was
      // a fair sample of the scene.
      tile(`/media/scene/${sceneId}/thumb`, 'the row thumbnail'),
      ...frames.map((f) => tile(f.url, `${f.pct}% in`))
    );
  };

  /*
   * Measured after the sheet is on screen, not before. Decoding a dozen
   * pictures is tens of milliseconds of nothing to look at, and the sheet is
   * useful the instant it is drawn — the numbers arrive a moment later.
   */
  const measure = async () => {
    const sources = [`/media/scene/${sceneId}/thumb`, ...(await frames()).map((f) => f.url)];
    frameHashes = (await Promise.all(sources.map(pictureHash))).filter(Boolean);

    if (!frameHashes.length) {
      said.textContent = 'None of this scene’s pictures could be read, so there is nothing to measure against.';
      return;
    }

    let measured = 0;
    for (const [at, image] of images.entries()) {
      const theirHash = await pictureHash(image.src);
      const note = theirs.children[at]?.querySelector('.cmpnote');
      if (!note) continue;

      if (!theirHash) {
        note.textContent = 'picture could not be read';
        continue;
      }

      const apart = Math.min(...frameHashes.map((h) => bitsApart(h, theirHash)));
      const { word, why } = verdict(apart);
      note.textContent = word;
      note.title = why;
      note.className = 'cmpnote ' + (apart <= 8 ? 'same' : apart <= 20 ? 'close' : apart <= 27 ? 'unsure' : 'far');
      measured += 1;
    }

    said.textContent = measured
      ? `Measured ${measured} against ${frameHashes.length} of this scene’s pictures — each shows its closest.`
      : 'Nothing could be measured.';
  };

  let held = null;
  const frames = async () => {
    if (held) return held;
    const out = await api('/api/catalogue/frames/' + sceneId).catch(() => ({ frames: [], more: 0 }));
    held = out.frames || [];
    more.hidden = !out.more;
    return held;
  };

  const cut = async () => {
    more.disabled = true;
    const was = more.textContent;
    more.textContent = 'Cutting…';
    said.textContent = 'ffmpeg is seeking into the file — a few seconds each.';
    try {
      const out = await api('/api/catalogue/frames/' + sceneId, {
        method: 'POST',
        body: JSON.stringify({ count: 4 }),
      });
      held = out.frames || [];
      more.hidden = !out.more;
      drawFrames(held);
      await measure();
    } catch (err) {
      said.textContent = err.message;
    } finally {
      more.disabled = false;
      more.textContent = was;
    }
  };

  more.onclick = cut;

  theirs.replaceChildren(...images.map((image) => {
    const note = el('div', { className: 'cmpnote' }, '…');
    return tile(image.src, image.label, note, image.onPick || null);
  }));

  frames().then(async (list) => {
    drawFrames(list);
    said.textContent = list.length
      ? 'Measuring…'
      : 'No frames cut yet — the row thumbnail is the only picture of this scene so far.';
    await measure();
  }).catch((err) => { said.textContent = err.message; });

  return sheet;
}
