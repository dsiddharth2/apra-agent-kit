import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function pathsInScript(cmd) {
  const paths = [];
  for (const m of String(cmd).matchAll(/(?:^|\s)(tests\/[^\s]+)/g)) paths.push(m[1]);
  for (const m of String(cmd).matchAll(/(docker-compose\.[^\s]+)/g)) paths.push(m[1]);
  return paths;
}

test('package.json test scripts do not list missing files', () => {
  const names = Object.keys(pkg.scripts).filter(
    (n) => n === 'test' || n.startsWith('test:') || n.startsWith('e2e:'),
  );
  const missing = [];
  for (const name of names) {
    for (const rel of pathsInScript(pkg.scripts[name])) {
      if (!fs.existsSync(path.join(root, rel))) missing.push(`${name}: ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `scripts reference missing paths:\n${missing.join('\n')}`);
});
