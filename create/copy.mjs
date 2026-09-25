// The generator's file-moving half. Framework folders are copied from the
// published package as they are; template/ is then copied over the result
// with overwrite set, so it wins on conflict.
import fs from 'node:fs';
import path from 'node:path';

// npm rewrites a packed .gitignore to .npmignore, so the generated project's
// copy ships under a name npm leaves alone and is renamed on write.
export const RENAME_ON_WRITE = { gitignore: '.gitignore' };

// Framework paths copied into every generated project, before the overlay.
// Mirrors the package.json "files" field; tools and docs are narrowed to the
// subset a starter project keeps.
export const PUBLISHED_DIRS = [
  'mcp',
  'pool',
  'host',
  'transport',
  'comm',
  '.claude/skills/agent-builder',
  'workflows/standalone.mjs',
  'tools/weather',
  'tools/textstats',
  'docs/architecture.md',
  'docs/development.md',
  '.dockerignore',
  'evals',
];

export function copyTree(src, dest, { overwrite = false, rename = {} } = {}) {
  const written = [];
  if (!fs.existsSync(src)) return written;

  const walk = (fromDir, toDir, relBase) => {
    fs.mkdirSync(toDir, { recursive: true });
    const entries = fs.readdirSync(fromDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const from = path.join(fromDir, entry.name);
      const name = rename[entry.name] ?? entry.name;
      const to = path.join(toDir, name);
      const rel = relBase ? path.join(relBase, name) : name;

      if (entry.isDirectory()) {
        walk(from, to, rel);
      } else {
        if (fs.existsSync(to) && !overwrite) continue;
        fs.copyFileSync(from, to);
        fs.chmodSync(to, fs.statSync(from).mode & 0o777);
        written.push(rel);
      }
    }
  };

  const stat = fs.statSync(src);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest) || overwrite) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, stat.mode & 0o777);
      written.push(path.basename(dest));
    }
    return written;
  }

  walk(src, dest, '');
  return written.sort((a, b) => a.localeCompare(b));
}
