/*
 * The reel's dials, in one place because they are the things most often
 * reached for and none of them does anything on its own.
 */

/*
 * Line art, drawn rather than typed.
 *
 * These were emoji, which meant the row was half glyphs the browser drew in
 * its own colours and half text in ours — a yellow shuffle and a green alien
 * next to a white pause. Inline SVG on `currentColor` inherits whatever the
 * button is doing, so hover and the on-state carry the icon with them.
 */
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
  /*
   * The wide head, the aerial and its dot, two eyes and a smile. Drawn as
   * explicit arcs rather than one clever curve — the clever version came out
   * as an unreadable blob at eighteen pixels, which is the only size it is
   * ever seen at.
   */
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


/*
 * How far either side of the slide on screen keeps a loaded video. Two ahead is
 * enough that the next one starts the moment it lands; much more and the
 * browser holds half a dozen open streams for clips nobody reached.
 */
export const NEAR = 2;

// How long a marker runs for when it has no end of its own, in seconds.
export const WINDOW = 25;

/*
 * The two framings, in the order the button cycles them, and both of them fit
 * rather than crop.
 *
 * `auto` is each slide's own shape, scaled to fit. `four` puts everything in a
 * 4:3 box and scales to fit inside that — letterboxed, never cut.
 *
 * There used to be a 9:16 option and all three cropped with object-fit: cover.
 * The rule, and it is the right one: a clip you cannot see the edges of is a
 * clip you are not being shown. **This control governs the library only** —
 * RedGIFs and Reddit slides always fit, whatever it is set to, because their
 * shape is whatever the person who posted it chose and cropping to a house
 * style is how you cut the subject out of half of them.
 */
export const CROPS = ['auto', 'four'];

export const CROP_LABEL = { auto: 'Fit', four: '4:3' };

/*
 * The four feeds, in the order swiping moves through them.
 *
 * Mixed is the reel this page has always been — all three sources in whatever
 * proportions the ratio slider sets. The other three are one source each, and
 * they are not the mix with the slider shoved to an extreme: a RedGIFs feed has
 * no library page to thread through, so the server deals it straight from the
 * pool.
 *
 * Mixed sits first because it is the one you arrive on, and the dedicated
 * three run left to right in the same order the slider lists them.
 */
export const FEEDS = ['mixed', 'library', 'scenes', 'redgifs', 'reddit'];

export const FEED_LABEL = {
  mixed: 'All three',
  library: 'Markers',
  scenes: 'Scenes',
  redgifs: 'RedGIFs',
  reddit: 'Reddit',
};

/*
 * Markers or whole scenes used to be a dropdown in the bar, sitting beside the
 * tag pickers as though it were the same kind of choice. It never was: it
 * changes what every slide *is*, not how the slides are filtered. So it is two
 * feeds, alongside the other places slides come from, and the dropdown is gone.
 */
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

/*
 * How many markers may fail to find a clip before the reel stops asking for
 * them. On a library where Marker Previews has never been run that is every
 * marker, and asking 1400 times for a placeholder to fail on is pointless. It
 * is per visit, so a Generate job run since you last opened the page is picked
 * up on the next load rather than never.
 */
export const CLIP_STRIKES = 3;

// Load the next page while there are still this many slides below you.
export const RUNWAY = 4;

/*
 * The reel takes the whole screen while it is up.
 *
 * On a phone the site header and the status strip were eating the top third
 * before the clip even started, and a reel with page furniture around it is not
 * a reel. The class goes on the body rather than the view because what has to
 * be hidden lives outside the view — and it comes off again on the way out,
 * which is the only reason leave() has to know about it.
 */
export const FULL = 'reelfull';

/*
 * Sideways, by thumb, on the dial.
 *
 * The dial is a small target and it is the *only* thing that changes feed, so
 * a drag that starts on it is meant — 30px is enough to tell a swipe from a
 * tap that slid. The bias test stays: a thumb that lands on the dial on its
 * way down the page is scrolling, not switching.
 *
 * The clip keeps its own sideways gesture, which is scrubbing.
 */
export const SWIPE_MIN = 30;
export const SWIPE_BIAS = 1.6;
