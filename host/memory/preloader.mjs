// host/memory/preloader.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

export async function preloadKnowledge(longTermMemory, { dir, logger = console } = {}) {
  if (!dir) return { loaded: 0, reinforced: 0, merged: 0, errors: 0 };
  let files;
  try {
    files = await collectJsonFiles(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info?.(`[memory/preloader] directory ${dir} not found — skipping`);
      return { loaded: 0, reinforced: 0, merged: 0, errors: 0 };
    }
    throw err;
  }

  let loaded = 0, reinforced = 0, merged = 0, errors = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const text = await fs.readFile(file, 'utf8');
      const entries = JSON.parse(text);
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        try {
          const result = await longTermMemory.store(entry);
          if (result.action === 'created') loaded++;
          else if (result.action === 'reinforced') reinforced++;
          else if (result.action === 'merged') merged++;
        } catch (err) {
          errors++;
          logger.warn?.(`[memory/preloader] failed to load entry from ${file}: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      errors++;
      logger.warn?.(`[memory/preloader] failed to read ${file}: ${err?.message ?? err}`);
    }
    if ((i + 1) % 50 === 0) {
      logger.info?.(`[memory/preloader] processed ${i + 1}/${files.length} files (${loaded} new, ${reinforced} reinforced, ${merged} merged, ${errors} errors)`);
    }
  }

  logger.info?.(`[memory/preloader] loaded ${loaded} new, ${reinforced} reinforced, ${merged} merged, ${errors} errors from ${files.length} files`);
  return { loaded, reinforced, merged, errors };
}

async function collectJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(full));
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      files.push(full);
    }
  }
  return files;
}
