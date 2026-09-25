// evals/graders/custom.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadCustom(graderPath, suiteDir) {
  const resolved = path.resolve(suiteDir ?? '.', graderPath);
  // resolveGrader must throw immediately when the file is missing.
  // Dynamic import stays lazy for files that exist.
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Cannot find module '${resolved}'`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  let loaded = null;
  const wrapper = async (expected, actual) => {
    if (!loaded) {
      const m = await import(pathToFileURL(resolved).href);
      loaded = m.default ?? m;
    }
    return loaded(expected, actual);
  };
  return wrapper;
}
