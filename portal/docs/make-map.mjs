/*
 * Writes docs/map.md — where everything lives, in one page you can read for the
 * price of a grep.
 *
 * This exists because the two front-end files are ten thousand lines between
 * them, and every question that starts "where is the video page" used to be
 * answered by searching all of it. A generated index is cheaper to read than
 * the code and cannot drift the way a hand-written one does: re-run it after
 * moving anything.
 *
 *   docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
 *
 * Everything below is read off the source rather than described, so a route
 * that is not in here is a route that does not exist.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split('\n');

/* ------------------------------------------------------------------ helpers */

// A line number is only useful next to the thing it points at, so every finder
// returns { line, ... } and the writer formats them the same way.
function scan(lines, re, shape) {
  const out = [];
  lines.forEach((text, i) => {
    const m = re.exec(text);
    if (m) out.push({ line: i + 1, ...shape(m) });
    re.lastIndex = 0;
  });
  return out;
}

/*
 * The banner comments the two big files are divided by. They are the only
 * structure those files have, and they are what a table of contents is for.
 */
const banner = (lines) => {
  const found = new Map(); // by line, so a banner both patterns match is one entry
  for (const hit of scan(lines, /^\/\*\s*[-=]{3,}\s*(.+?)\s*$/, (m) => ({ title: m[1] }))) {
    found.set(hit.line, { ...hit, title: hit.title.replace(/\s*\*\/\s*$/, '') });
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
};

/* ------------------------------------------------------------------ sources */

const named = [
  'public/app.js',
  'public/shelf.js',
  'public/catalogue.js',
  'public/player.js',
  'public/reel.js',
  // The marker bench and the two files it shares with the players: the prompt
  // a marker is named through, and the management list. They sit at the top
  // level rather than in a folder, so they have to be named.
  'public/markerbuilder.js',
  'public/markertag.js',
  'public/markermanage.js',
  'public/markerfetch.js',
  'src/server.mjs',
];

// The library is a folder now, so it is listed rather than named: a page added
// in there shows up here without anyone remembering to add it.
const folder = (name, ext = '.js') =>
  readdirSync(new URL(`../public/${name}`, import.meta.url))
    .filter((f) => f.endsWith(ext))
    .map((f) => `public/${name}/${f}`);

const inFolders = [...folder('library'), ...folder('import'), ...folder('reel'), ...folder('css', '.css')];

const files = Object.fromEntries([...named, ...inFolders].map((f) => [f, read(f)]));

/* ---------------------------------------------------------------- addresses */

// `if (hash === '#/x') return showX();` and `hash.match(/^#\/x\/(\d+)$/)`
const HASH_EQ = /hash === '(#[^']+)'\)\s*(?:\{\s*)?return\s+([\w.]+)\(/;
const HASH_BLOCK = /hash === '(#[^']+)'\)\s*\{\s*([\w.]+)\(/;
const HASH_RE = /const (\w+) = hash\.match\(([^;]+)\);/;

const addresses = [];

for (const [file, lines] of Object.entries(files)) {
  if (!file.endsWith('.js')) continue;

  for (const re of [HASH_EQ, HASH_BLOCK]) {
    for (const hit of scan(lines, re, (m) => ({ address: m[1], handler: m[2] }))) {
      if (addresses.some((a) => a.address === hit.address && a.file === file)) continue;
      addresses.push({ ...hit, file });
    }
  }

  // The matched ones name their handler on the next line or two.
  lines.forEach((text, i) => {
    const m = HASH_RE.exec(text);
    if (!m) return;
    const pattern = m[2].replace(/new RegExp\(|\)$/g, '').trim();
    const next = (lines[i + 1] || '') + (lines[i + 2] || '');
    const call = /(\w+)\(/.exec(next.replace(/^\s*if\s*\([^)]*\)\s*\{?\s*/, ''));
    addresses.push({
      line: i + 1,
      address: pattern.replace(/^\/|\/$/g, ''),
      handler: call ? call[1] : '—',
      file,
    });
  });
}

/* --------------------------------------------------------------------- api */

const api = scan(
  files['src/server.mjs'],
  /^\s*\['(GET|POST|PUT|DELETE|PATCH)',\s*\/\^?([^,]+?)\$?\/,/,
  (m) => ({ method: m[1], path: m[2] })
);

/* ------------------------------------------------------------ the big files */

const contents = {};

/* ------------------------------------------------------------------- output */

const rows = (list, cells) => list.map((r) => '| ' + cells(r).join(' | ') + ' |').join('\n');

const table = (head, list, cells) =>
  list.length ? `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows(list, cells)}` : '_none_';

const out = `# Where things live

**Generated — do not hand-edit.** Re-run after moving anything:

\`\`\`
docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
\`\`\`

Written ${new Date().toISOString().slice(0, 10)} from ${Object.keys(files).length} files.

## Addresses

Every \`#/\` the front end answers, and what draws it. The library half is
served by \`shelf.js\` and claimed before \`app.js\` sees the address.

${table(['Address', 'Draws it', 'Where'], addresses, (r) => [
  '`' + r.address + '`',
  '`' + r.handler + '`',
  `${r.file}:${r.line}`,
])}

## API

${table(['', 'Path', 'Where'], api, (r) => ['`' + r.method + '`', '`' + r.path + '`', `src/server.mjs:${r.line}`])}

## Inside what is still large

\`shelf.js\` was 5,813 lines and is now a router over \`public/library/\`. These
two are what is left of that shape; the only structure they have is their banner
comments, so jump to a line rather than searching the file.

${Object.entries(contents)
  .map(
    ([file, marks]) =>
      `### ${file} — ${files[file].length} lines\n\n` +
      (marks.length
        ? marks.map((m) => `- **${m.title}** — ${file}:${m.line}`).join('\n')
        : '_no section banners_')
  )
  .join('\n\n')}

## Line counts

${table(['File', 'Lines'], Object.entries(files).map(([f, l]) => ({ f, n: l.length })).sort((a, b) => b.n - a.n), (r) => [
  r.f,
  String(r.n),
])}
`;

writeFileSync(new URL('../docs/map.md', import.meta.url), out);
console.log(`docs/map.md — ${addresses.length} addresses, ${api.length} endpoints`);
