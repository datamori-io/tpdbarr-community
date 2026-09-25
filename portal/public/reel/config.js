/* The reel's settings. */

/* Inline SVG line art on currentColor, so icons follow the button's state. */
const ICONS = {
  shuffle: 'M16 3h5v5M21 3l-7 7M4 20l16-16M16 21h5v-5M21 21l-6-6M4 4l4 4',
  sound: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6',
  info: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  noinfo: 'M3 3l18 18M10.6 6.2A9.4 9.4 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.4 7.5A17 17 0 0 0 2 12s3.6 6 10 6a9.6 9.6 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2',
  // A luggage tag: the body, the corner cut off, and the hole punched in it.
  tag: 'M20.6 13.4 12.4 21.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h9a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  // A strip of film: the shape RedGIFs is, without borrowing their mark.
  redgifs: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9.7h4M3 14.3h4M17 9.7h4M17 14.3h4',
  /* Reddit's alien: head, aerial, eyes, smile, as explicit arcs (legible at 18px). */
  reddit: 'M19 13.4a7 5.4 0 1 1-14 0 7 5.4 0 1 1 14 0M12 8V4.4l3.4-1M17 3.2a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 1 1 2.2 0M9.5 13h.01M14.5 13h.01M9.6 15.6a4 4 0 0 0 4.8 0',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'reelglyph');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}


/* Slides either side of the current one that keep a loaded video. */
export const NEAR = 2;

// How long a marker runs for when it has no end of its own, in seconds.
export const WINDOW = 25;

/*
 * Framings the button cycles: `auto` (each slide's own shape) and `four`
 * (a 4:3 box). Library only; RedGIFs and Reddit always fit.
 */
export const CROPS = ['auto', 'four'];

export const CROP_LABEL = { auto: 'Fit', four: '4:3' };

/* The feeds, in swipe order. Mixed uses the ratio; the others are one source each. */
export const FEEDS = ['mixed', 'library', 'scenes', 'redgifs', 'reddit'];

export const FEED_LABEL = {
  mixed: 'All three',
  library: 'Markers',
  scenes: 'Scenes',
  redgifs: 'RedGIFs',
  reddit: 'Reddit',
};

/* Markers and Scenes are feeds, since they change what a slide is. */
export const SOURCE_OF = { scenes: 'scenes', library: 'markers' };

// Library, RedGIFs, Reddit. Three quarters your own, the rest woven through.
export const RATIO_DEFAULT = [75, 15, 10];

// The most of a page that may come from elsewhere. Past this it stops being a
// library reel with things in it and becomes a feed with some of yours in.
export const RATIO_MAX_AWAY = 60;

export function readRatio(text) {
  const parts = String(text || '').split(',').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value) || value < 0)) return [...RATIO_DEFAULT];

  const gif = Math.round(parts[1]);
  const red = Math.round(parts[2]);
  if (gif + red > RATIO_MAX_AWAY) return [...RATIO_DEFAULT];

  return [100 - gif - red, gif, red];
}

// How long a still sits before a rolling reel moves on.
export const STILL_MS = 4000;

/* Markers that may fail to find a clip before the reel stops asking. Per visit. */
export const CLIP_STRIKES = 3;

// Load the next page while there are still this many slides below you.
export const RUNWAY = 4;

/* Body class for full-screen reel; leave() removes it. */
export const FULL = 'reelfull';

/*
 * Minimum swipe on the feed dial, with a sideways bias. The clip's own
 * sideways drag scrubs.
 */
export const SWIPE_MIN = 30;
export const SWIPE_BIAS = 1.6;
