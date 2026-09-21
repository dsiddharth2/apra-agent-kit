import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'route-check' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const ROUTE_DISTANCE_PY = path.join(toolsDir, 'route-distance', 'route_distance.py');

function safeJson(text) {
  try { return JSON.parse(typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? ''); }
  catch { return { ok: false, error: 'parse failed', raw: String(text) }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const from = args.from || 'Delhi';
  const to = args.to || 'Manali';
  const signal = args.signal;
  const cancelled = () => signal?.aborted === true;

  phase('route-distance');
  const routeRaw = await command(`python3 "${ROUTE_DISTANCE_PY}" "${from}" "${to}"`, { member_name: 'doer', failSoft: true });
  const route = safeJson(routeRaw);
  log(`route: ${JSON.stringify(route)}`);
  if (cancelled()) return { cancelled: true, route };

  phase('compose');
  const prompt = [
    `You are a concise travel route assistant. Given the data below, write a short summary of the route from ${from} to ${to}.`,
    `Include distance and estimated travel time. End with one practical driving tip.`,
    '', `Route: ${JSON.stringify(route)}`,
    '', 'Reply with ONLY the summary text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { from, to, route, answer };
}
