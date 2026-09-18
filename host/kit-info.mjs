// host/kit-info.mjs
//
// Kit identity for a clone.
//
// The adoption flow is: clone the kit, delete the demo agents and tools, drop
// the git link, first commit. That is deliberate, but it means a clone has no
// way to say which kit revision it started from — so "which clones carry this
// bug?" is unanswerable once there is more than one.
//
// This module reads the kit version out of package.json at startup and exposes
// it. `scaffoldedFrom` is written once, by whatever creates the clone, and is
// never updated afterwards: it records the origin, not the current state.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let cached = null;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Kit identity for this process.
 *
 * @returns {Promise<{name: string, version: string, scaffoldedFrom: string|null, scaffoldedAt: string|null}>}
 */
export async function kitInfo() {
  if (cached) return cached;

  const pkg = await readJson(path.join(ROOT, 'package.json'));
  const stamp = await readJson(path.join(ROOT, 'kit.version.json'));

  cached = Object.freeze({
    name: pkg?.name ?? 'unknown',
    version: pkg?.version ?? '0.0.0',
    // Present only in a clone. Absent in the kit repo itself, which is correct
    // — the kit was not scaffolded from anything.
    scaffoldedFrom: stamp?.scaffoldedFrom ?? null,
    scaffoldedAt: stamp?.scaffoldedAt ?? null,
  });

  return cached;
}

/**
 * Write the origin stamp into a freshly created clone. Called by whatever
 * performs the scaffold; safe to call once and never again.
 *
 * @param {string} targetDir  root of the new clone
 * @param {{version: string, source?: string}} origin
 */
export async function writeScaffoldStamp(targetDir, origin) {
  const file = path.join(targetDir, 'kit.version.json');
  const existing = await readJson(file);
  if (existing) return existing; // never overwrite an origin record

  const stamp = {
    scaffoldedFrom: origin.version,
    scaffoldedAt: new Date().toISOString(),
    source: origin.source ?? null,
  };
  await fs.writeFile(file, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return stamp;
}
