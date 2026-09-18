// host/chat/routes.mjs
// Two unauthenticated GET routes: the chat page and its single client script.
// Both files are read once when the routes are built and held in memory. There
// is no path parameter and no directory walk, so nothing else can be served.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// transcript.mjs is a real ES module for node:test. The browser gets it inlined
// ahead of app.mjs as one script, so drop `export` from top-level declarations.
export function stripExports(source) {
  return source.replace(/^export (?=(?:async )?(?:function|const|let|class)\b)/gm, '');
}

export async function buildChatRoutes({ chatConfig, hostName, dir = HERE } = {}) {
  if (!chatConfig?.enabled) return { chatPage: null, chatScript: null };
  const title = escapeHtml(chatConfig.title ?? hostName ?? 'apra-agent-kit');
  const read = (name) => fs.readFile(path.join(dir, name), 'utf8');
  const [html, transcript, app] = await Promise.all([read('index.html'), read('transcript.mjs'), read('app.mjs')]);
  const page = html.replaceAll('{{title}}', title);
  const script = `${stripExports(transcript)}\n${app}`;
  const serve = (text, contentType) => async () => ({
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
    text,
  });
  return {
    chatPage:   { method: 'GET', path: '/chat',         auth: false, handler: serve(page, 'text/html; charset=utf-8') },
    chatScript: { method: 'GET', path: '/chat/app.mjs', auth: false, handler: serve(script, 'text/javascript; charset=utf-8') },
  };
}
