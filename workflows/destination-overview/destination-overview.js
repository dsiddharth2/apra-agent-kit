import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'destination-overview' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WIKIPEDIA_PY = path.join(toolsDir, 'wikipedia-summary', 'wikipedia_summary.py');
const PLACES_PY = path.join(toolsDir, 'places-of-interest', 'places_of_interest.py');

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
  const destination = shellEscape(args.destination || 'London');
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('wikipedia');
  await reportPhase(`fetching wikipedia summary for ${destination}`);
  const wikiRaw = await command(`python3 "${WIKIPEDIA_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  const wikipedia = safeJson(wikiRaw);
  log(`wikipedia: ${JSON.stringify(wikipedia)}`);
  if (cancelled()) return { cancelled: true, wikipedia };

  phase('places');
  await reportPhase(`fetching places of interest for ${destination}`);
  const placesRaw = await command(`python3 "${PLACES_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  const places = safeJson(placesRaw);
  log(`places: ${JSON.stringify(places)}`);
  if (cancelled()) return { cancelled: true, wikipedia, places };

  phase('compose');
  await reportPhase(`composing destination overview for ${destination}`);
  const prompt = [
    `You are a concise travel guide. Given the data below, write a short destination overview for ${destination}.`,
    `Include background info and top places to visit. End with one practical tip.`,
    '', `Wikipedia: ${JSON.stringify(wikipedia)}`, `Places: ${JSON.stringify(places)}`,
    '', 'Reply with ONLY the overview text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { destination, wikipedia, places, answer };
}
