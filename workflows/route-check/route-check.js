import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'route-check' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const ROUTE_DISTANCE_PY = path.join(toolsDir, 'route-distance', 'route_distance.py');

function shellEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function safeJson(text) {
  let raw = typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? '';
  raw = String(raw).trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const m = raw.match(fenceRe);
  if (m) raw = m[1].trim();
  try { return JSON.parse(raw); }
  catch { return { ok: false, error: 'parse failed', raw }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const from = shellEscape(args.from || 'Delhi');
  const to = shellEscape(args.to || 'Manali');
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('route-distance');
  await reportPhase(`checking route from ${from} to ${to}`);
  const routeRaw = await command(`python3 "${ROUTE_DISTANCE_PY}" "${from}" "${to}"`, { member_name: 'doer', failSoft: true });
  const route = safeJson(routeRaw);
  log(`route: ${JSON.stringify(route)}`);
  if (cancelled()) return { cancelled: true, route };

  phase('compose');
  await reportPhase(`composing route summary from ${from} to ${to}`);
  const prompt = [
    `You are a concise travel route assistant. Given the data below, write a short summary of the route from ${from} to ${to}.`,
    `Include distance and estimated travel time. End with one practical driving tip.`,
    '', `Route: ${JSON.stringify(route)}`,
    '', 'Reply with ONLY the summary text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { from, to, route, answer };
}
