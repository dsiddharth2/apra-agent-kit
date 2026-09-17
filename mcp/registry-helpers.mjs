// Shared by the kit's registry and by the starter registry a generated
// project receives. Kept separate so the starter can be a short file that
// registers its own workflows without reimplementing these.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools',
);

export function shellEscape(value) {
  return value.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function parseToolOutput(raw) {
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw?.structuredContent?.stdout) {
    text = raw.structuredContent.stdout;
  } else if (raw?.content?.[0]?.text) {
    text = raw.content[0].text;
  } else {
    text = raw?.output ?? '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'failed to parse tool output', raw: text };
  }
}
