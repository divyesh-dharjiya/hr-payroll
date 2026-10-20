// Builds a small Material Symbols font that contains only the icons this app uses.
//
// The full variable font in the `material-symbols` package is about 4 MB, which is far too heavy for a first page
// load. This script collects every icon name used in src/app (literal <mat-icon> text and any quoted string that is
// a known icon name, which covers icons chosen in code), asks Google Fonts for a static subset with only those
// icons, and saves it as public/fonts/material-symbols-subset.woff2. The app self-hosts the result, so browsers
// never contact a third party at runtime.
//
// Run after adding or renaming an icon:   npm run icons
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const known = new Set(
  [...readFileSync(path.join(root, 'node_modules/material-symbols/index.d.ts'), 'utf8').matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]),
);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') || full.endsWith('.html') ? [full] : [];
  });
}

const used = new Set();
for (const file of walk(path.join(root, 'src/app'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/>\s*([a-z0-9_]+)\s*<\/mat-icon>/g)) used.add(m[1]);
  for (const m of text.matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)) if (known.has(m[1])) used.add(m[1]);
  for (const m of text.matchAll(/\bicon="([a-z0-9_]+)"/g)) used.add(m[1]);
  // Icons picked in a template expression: <mat-icon>{{ open ? 'expand_less' : 'expand_more' }}</mat-icon>
  for (const m of text.matchAll(/<mat-icon[^>]*>\{\{([^}]*)\}\}<\/mat-icon>/g)) {
    for (const q of m[1].matchAll(/'([a-z][a-z0-9_]+)'/g)) used.add(q[1]);
  }
  // Lookup tables such as `const TASK_ICONS: Record<string, string> = { leave: 'event_busy' }`.
  for (const m of text.matchAll(/ICONS[^=]*=\s*\{([^}]*)\}/g)) {
    for (const q of m[1].matchAll(/:\s*'([a-z][a-z0-9_]+)'/g)) used.add(q[1]);
  }
  // Objects with an `icon` property: { icon: 'payments', ... }
  for (const m of text.matchAll(/\bicon:\s*'([a-z][a-z0-9_]+)'/g)) used.add(m[1]);
}
// The package's name list misses a few aliases (expand_more, auto_awesome), so literal <mat-icon> names are kept as is.
const names = [...used].sort();

const cssUrl =
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0' +
  `&icon_names=${names.join(',')}&display=block`;
// A current browser user agent makes Google Fonts answer with woff2.
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const css = await (await fetch(cssUrl, { headers: { 'User-Agent': ua } })).text();
const fontUrl = css.match(/url\((https:[^)]+)\)/)?.[1];
if (!fontUrl) {
  console.error('Google Fonts did not return a font URL:\n' + css);
  process.exit(1);
}
const font = Buffer.from(await (await fetch(fontUrl)).arrayBuffer());
mkdirSync(path.join(root, 'public/fonts'), { recursive: true });
writeFileSync(path.join(root, 'public/fonts/material-symbols-subset.woff2'), font);
writeFileSync(path.join(root, 'scripts/icons.json'), JSON.stringify(names, null, 2) + '\n');
console.log(`Saved ${names.length} icons, ${(font.length / 1024).toFixed(1)} KB.`);
