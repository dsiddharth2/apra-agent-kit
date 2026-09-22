// tests/host-chat-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatRoutes, escapeHtml, stripExports } = await import('../host/chat/routes.mjs');

test('escapeHtml escapes the five HTML metacharacters', () => {
  assert.equal(escapeHtml(`<b class="x">it's & done</b>`), '&lt;b class=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/b&gt;');
});

test('stripExports removes export keywords only at declaration starts', () => {
  const src = 'export function a() {}\nexport const B = 1;\nconst txt = "export const";\n  export function inner() {}\n';
  assert.equal(stripExports(src), 'function a() {}\nconst B = 1;\nconst txt = "export const";\n  export function inner() {}\n');
});

test('chat disabled yields null routes', async () => {
  assert.deepEqual(await buildChatRoutes({ chatConfig: { enabled: false, title: 'x' }, hostName: 'h' }), { chatPage: null, chatScript: null });
  assert.deepEqual(await buildChatRoutes({}), { chatPage: null, chatScript: null });
});

test('chat page route serves HTML with the escaped title and the script tag', async () => {
  const { chatPage } = await buildChatRoutes({ chatConfig: { enabled: true, title: '<Travel> & "Co"' }, hostName: 'h' });
  assert.equal(chatPage.method, 'GET'); assert.equal(chatPage.path, '/chat'); assert.equal(chatPage.auth, false);
  const res = await chatPage.handler({ method: 'GET', path: '/chat', params: {}, query: {}, headers: {}, body: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.match(res.text, /<title>&lt;Travel&gt; &amp; &quot;Co&quot;<\/title>/);
  assert.doesNotMatch(res.text, /\{\{title\}\}/);
  assert.doesNotMatch(res.text, /<Travel>/);
  assert.match(res.text, /<script type="module" src="chat\/app\.mjs"><\/script>/);
  for (const id of ['status-pill', 'transcript', 'composer', 'goal', 'send', 'thread-title']) assert.match(res.text, new RegExp(`id="${id}"`), `missing #${id}`);
});

test('chat script route serves reducer plus app as one import-free module', async () => {
  const { chatScript } = await buildChatRoutes({ chatConfig: { enabled: true, title: 't' }, hostName: 'h' });
  assert.equal(chatScript.method, 'GET'); assert.equal(chatScript.path, '/chat/app.mjs'); assert.equal(chatScript.auth, false);
  const res = await chatScript.handler({ method: 'GET', path: '/chat/app.mjs', params: {}, query: {}, headers: {}, body: null });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.doesNotMatch(res.text, /^\s*(import|export)\b/m);
  for (const fn of ['function initialTurn', 'function accepted', 'function submitFailed', 'function cancelling', 'function reduce', 'function isLive']) assert.ok(res.text.includes(fn), `missing ${fn}`);
  assert.ok(res.text.indexOf('function reduce') < res.text.indexOf('new EventSource'), 'reducer must precede app code');
  assert.ok(res.text.includes("apiBase + '/task'"));
  assert.ok(res.text.includes('console.group'));
  // innerHTML is allowed only when wrapped in DOMPurify.sanitize — verify no raw innerHTML usage
  var innerHtmlUses = res.text.match(/\.innerHTML\s*=/g) || [];
  var sanitizedUses = res.text.match(/\.innerHTML\s*=\s*DOMPurify\.sanitize\(/g) || [];
  assert.equal(innerHtmlUses.length, sanitizedUses.length, 'all innerHTML assignments must use DOMPurify.sanitize');
});

test('served script parses as JavaScript', async () => {
  const { chatScript } = await buildChatRoutes({ chatConfig: { enabled: true, title: 't' }, hostName: 'h' });
  const { text } = await chatScript.handler({ method: 'GET', path: '/chat/app.mjs', params: {}, query: {}, headers: {}, body: null });
  assert.doesNotThrow(() => new Function(text));   // syntax check only; never executed
});
