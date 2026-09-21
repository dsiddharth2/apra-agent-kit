import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'destination-overview' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WIKIPEDIA_PY = path.join(toolsDir, 'wikipedia-summary', 'wikipedia_summary.py');
const PLACES_PY = path.join(toolsDir, 'places-of-interest', 'places_of_interest.py');

function safeJson(text) {
  try { return JSON.parse(typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? ''); }
  catch { return { ok: false, error: 'parse failed', raw: String(text) }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const destination = args.destination || 'London';
  const signal = args.signal;
  const cancelled = () => signal?.aborted === true;

  phase('wikipedia');
  const wikiRaw = await command(`python3 "${WIKIPEDIA_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  const wikipedia = safeJson(wikiRaw);
  log(`wikipedia: ${JSON.stringify(wikipedia)}`);
  if (cancelled()) return { cancelled: true, wikipedia };

  phase('places');
  const placesRaw = await command(`python3 "${PLACES_PY}" "${destination}"`, { member_name: 'doer', failSoft: true });
  const places = safeJson(placesRaw);
  log(`places: ${JSON.stringify(places)}`);
  if (cancelled()) return { cancelled: true, wikipedia, places };

  phase('compose');
  const prompt = [
    `You are a concise travel guide. Given the data below, write a short destination overview for ${destination}.`,
    `Include background info and top places to visit. End with one practical tip.`,
    '', `Wikipedia: ${JSON.stringify(wikipedia)}`, `Places: ${JSON.stringify(places)}`,
    '', 'Reply with ONLY the overview text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { destination, wikipedia, places, answer };
}
