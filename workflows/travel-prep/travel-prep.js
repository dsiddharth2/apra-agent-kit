import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'travel-prep' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const COUNTRY_INFO_PY = path.join(toolsDir, 'country-info', 'country_info.py');
const TRAVEL_ADVISORY_PY = path.join(toolsDir, 'travel-advisory', 'travel_advisory.py');
const CURRENCY_PY = path.join(toolsDir, 'currency', 'currency.py');
const PUBLIC_HOLIDAYS_PY = path.join(toolsDir, 'public-holidays', 'public_holidays.py');

function safeJson(text) {
  try { return JSON.parse(typeof text === 'string' ? text : text?.content?.[0]?.text ?? text?.output ?? ''); }
  catch { return { ok: false, error: 'parse failed', raw: String(text) }; }
}

export async function main(context) {
  const { phase, command, agent, log, args } = context;
  const country = args.country || 'Japan';
  const signal = args.signal;
  const cancelled = () => signal?.aborted === true;

  phase('country-info');
  const countryRaw = await command(`python3 "${COUNTRY_INFO_PY}" "${country}"`, { member_name: 'doer', failSoft: true });
  const countryInfo = safeJson(countryRaw);
  log(`country-info: ${JSON.stringify(countryInfo)}`);
  if (cancelled()) return { cancelled: true, countryInfo };

  phase('travel-advisory');
  const advisoryRaw = await command(`python3 "${TRAVEL_ADVISORY_PY}" "${country}"`, { member_name: 'doer', failSoft: true });
  const advisory = safeJson(advisoryRaw);
  log(`travel-advisory: ${JSON.stringify(advisory)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory };

  phase('currency');
  const currencyRaw = await command(`python3 "${CURRENCY_PY}" "INR" "${country}"`, { member_name: 'doer', failSoft: true });
  const currency = safeJson(currencyRaw);
  log(`currency: ${JSON.stringify(currency)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory, currency };

  phase('public-holidays');
  const holidaysRaw = await command(`python3 "${PUBLIC_HOLIDAYS_PY}" "${country}"`, { member_name: 'doer', failSoft: true });
  const holidays = safeJson(holidaysRaw);
  log(`public-holidays: ${JSON.stringify(holidays)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory, currency, holidays };

  phase('compose');
  const prompt = [
    `You are a concise travel preparation assistant. Given the data below, write a short pre-trip guide for ${country}.`,
    `Include country info, travel advisory, currency exchange, and public holidays. End with one practical tip.`,
    '', `Country info: ${JSON.stringify(countryInfo)}`, `Advisory: ${JSON.stringify(advisory)}`,
    `Currency: ${JSON.stringify(currency)}`, `Holidays: ${JSON.stringify(holidays)}`,
    '', 'Reply with ONLY the guide text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { country, countryInfo, advisory, currency, holidays, answer };
}
