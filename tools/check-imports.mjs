/**
 * Static import check.
 *
 *   node tools/check-imports.mjs
 *
 * Walks every module under src/ and tools/ and verifies that each relative
 * import resolves to a file that exists, and that each named import is
 * actually exported by its target.
 *
 * With no bundler there is nothing to catch a renamed export at build time —
 * the browser only complains when it reaches the module, which may be three
 * menus deep. This is the cheap substitute, and it runs in well under a
 * second.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', 'tools', 'tests'];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const EXPORT_RE =
  /^\s*export\s+(?:(?:async\s+)?function\s*\*?\s*(\w+)|class\s+(\w+)|const\s+(\w+)|let\s+(\w+)|var\s+(\w+))/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/gm;

function parseNamed(clause) {
  // Strip a default import and a namespace import; keep the braced names.
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return [];
  return braces[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

async function collectExports(file) {
  const source = await readFile(file, 'utf8');
  const names = new Set();
  for (const m of source.matchAll(EXPORT_RE)) {
    names.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  }
  for (const m of source.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^\s*export\s+default/m.test(source)) names.add('default');
  return names;
}

const files = [];
for (const dir of ROOTS) await walk(join(ROOT, dir), files);

const exportCache = new Map();
let problems = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const clause = match[1];
    const specifier = match[2];
    if (!specifier.startsWith('.')) continue; // bare specifiers: three only

    const target = resolve(dirname(file), specifier);
    if (!existsSync(target)) {
      console.log(`  missing  ${relative(ROOT, file)} -> ${specifier}`);
      problems++;
      continue;
    }

    if (!exportCache.has(target)) exportCache.set(target, await collectExports(target));
    const exported = exportCache.get(target);

    for (const name of parseNamed(clause)) {
      if (!exported.has(name)) {
        console.log(
          `  no export  ${relative(ROOT, file)} imports {${name}} from ${specifier}`
        );
        problems++;
      }
    }
    if (/^\s*\w+\s*(,|$)/.test(clause.trim()) && !clause.trim().startsWith('{') && !clause.includes('*')) {
      if (!exported.has('default')) {
        console.log(`  no default  ${relative(ROOT, file)} -> ${specifier}`);
        problems++;
      }
    }
  }
}

console.log(
  problems === 0
    ? `import check passed (${files.length} modules)`
    : `import check failed: ${problems} problem(s) across ${files.length} modules`
);
process.exit(problems === 0 ? 0 : 1);
