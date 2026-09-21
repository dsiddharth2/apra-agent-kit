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
  const themes = chatConfig.themes ?? ['apra'];
  const defaultTheme = themes[0];
  const themeButtons = themes.length > 1
    ? themes.map((t, i) => `<button data-theme="${escapeHtml(t)}"${i === 0 ? ' class="active"' : ''}>${escapeHtml(t.toUpperCase())}</button>`).join('')
    : '';
  const read = (name) => fs.readFile(path.join(dir, name), 'utf8');
  const readBin = (name) => fs.readFile(path.join(dir, name));
  const useApraMark = themes.includes('apra');
  const filesToRead = [read('index.html'), read('transcript.mjs'), read('app.mjs')];
  if (useApraMark) filesToRead.push(readBin('apra-mark.png'));
  const [html, transcript, app, mark] = await Promise.all(filesToRead);
  const BLUE_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#3B82F6"/><circle cx="16" cy="16" r="6" fill="#fff" opacity=".9"/><circle cx="16" cy="6" r="3" fill="#fff" opacity=".7"/><circle cx="24.5" cy="21" r="3" fill="#fff" opacity=".7"/><circle cx="7.5" cy="21" r="3" fill="#fff" opacity=".7"/><line x1="16" y1="10" x2="16" y2="16" stroke="#fff" stroke-width="1.5" opacity=".5"/><line x1="16" y1="16" x2="21.5" y2="19" stroke="#fff" stroke-width="1.5" opacity=".5"/><line x1="16" y1="16" x2="10.5" y2="19" stroke="#fff" stroke-width="1.5" opacity=".5"/></svg>`;
  const markDataUri = useApraMark
    ? `data:image/png;base64,${mark.toString('base64')}`
    : `data:image/svg+xml;base64,${Buffer.from(BLUE_MARK_SVG).toString('base64')}`;
  const page = html
    .replaceAll('{{title}}', title)
    .replaceAll('{{mark}}', markDataUri)
    .replaceAll('{{theme-buttons}}', themeButtons)
    .replace('<html>', `<html data-theme="${escapeHtml(defaultTheme)}">`);
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
