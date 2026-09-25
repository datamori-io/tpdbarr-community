/*
 * Watch state for films (scenes use Stash's own). A JSON file beside the
 * config, keyed on a hash of the folder name — renaming a folder loses its state.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'watch.json');

// The player reports every 15s per viewer, and this file is tiny. Batching a
// couple of seconds of those into one write keeps it off the disk on every tick.
const FLUSH_MS = 2000;

// Past this fraction it is finished rather than in progress, and offering to
// resume 40 seconds from the end is worse than offering nothing.
const FINISHED = 0.97;

let state = null;
let timer = null;
let writing = null;

async function load() {
  if (state) return state;
  try {
    const raw = await readFile(PATH, 'utf8');
    const parsed = JSON.parse(raw);
    state = { movies: parsed.movies && typeof parsed.movies === 'object' ? parsed.movies : {} };
  } catch {
    // Missing or corrupt: an empty history is the right recovery either way.
    state = { movies: {} };
  }
  return state;
}

/* Written to a temp file and renamed, so a crash can't empty it. */
async function flush() {
  timer = null;
  const snapshot = JSON.stringify(state, null, 2);

  writing = (async () => {
    try {
      await mkdir(CONFIG_DIR, { recursive: true });
      const temp = PATH + '.tmp';
      await writeFile(temp, snapshot, 'utf8');
      await rename(temp, PATH);
    } catch (err) {
      console.warn('[tpdbarr] could not write watch state -', err.message);
    }
  })();

  await writing;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  // Never hold the process open for a two-second debounce.
  timer.unref?.();
}

export const forgetWatch = () => { state = null; };

// -------------------------------------------------------------------- reads

export async function watchFor(id) {
  const { movies } = await load();
  return movies[id] || null;
}

/* -> Map<id, {resume, plays, progress, finished, lastPlayed}>, for a whole page. */
export async function watchIndex() {
  const { movies } = await load();
  const out = new Map();

  for (const [id, entry] of Object.entries(movies)) {
    out.set(id, shape(entry));
  }
  return out;
}

function shape(entry) {
  const resume = Math.max(0, Math.round(entry.resume || 0));
  const duration = entry.duration || 0;
  const ratio = duration ? Math.min(1, resume / duration) : 0;

  return {
    resume,
    plays: entry.plays || 0,
    lastPlayed: entry.lastPlayed || null,
    finished: ratio >= FINISHED,
    // A finished film shows no half-drawn bar; it shows nothing.
    progress: ratio >= FINISHED ? 0 : ratio,
  };
}

// Fold watch state onto a list of movies from moviefiles.scan().
export async function decorate(list) {
  const index = await watchIndex();

  return list.map((movie) => {
    const seen = index.get(movie.id);
    return seen
      ? { ...movie, resume: seen.resume, plays: seen.plays, progress: seen.progress, finished: seen.finished, lastPlayed: seen.lastPlayed }
      : { ...movie, resume: 0, plays: 0, progress: 0, finished: false, lastPlayed: null };
  });
}

// ------------------------------------------------------------------- writes

async function entry(id) {
  const { movies } = await load();
  if (!movies[id]) movies[id] = { resume: 0, plays: 0, lastPlayed: null };
  return movies[id];
}

export async function saveActivity(id, { resume = null, duration = null }) {
  const record = await entry(id);

  if (Number.isFinite(resume)) record.resume = Math.max(0, resume);
  // Duration is carried so the progress bar can be drawn without re-reading the
  // .nfo, and because a film with no .nfo has no duration anywhere else.
  if (Number.isFinite(duration) && duration > 0) record.duration = duration;

  record.updated = new Date().toISOString();
  schedule();
  return shape(record);
}

export async function addPlay(id) {
  const record = await entry(id);
  record.plays = (record.plays || 0) + 1;
  record.lastPlayed = new Date().toISOString();
  schedule();
  return shape(record);
}

export async function clearWatch(id) {
  const { movies } = await load();
  delete movies[id];
  schedule();
  return { ok: true };
}

// Anything still pending when the process is asked to stop.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    if (timer) { clearTimeout(timer); flush(); }
    process.exit(0);
  });
}
