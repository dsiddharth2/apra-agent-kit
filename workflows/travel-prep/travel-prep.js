import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'travel-prep' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const COUNTRY_INFO_PY = path.join(toolsDir, 'country-info', 'country_info.py');
const TRAVEL_ADVISORY_PY = path.join(toolsDir, 'travel-advisory', 'travel_advisory.py');
const CURRENCY_PY = path.join(toolsDir, 'currency', 'currency.py');
const PUBLIC_HOLIDAYS_PY = path.join(toolsDir, 'public-holidays', 'public_holidays.py');

const COUNTRY_LOOKUP = {
  japan: { iso2: 'JP', currency: 'JPY' },
  india: { iso2: 'IN', currency: 'INR' },
  'united states': { iso2: 'US', currency: 'USD' },
  usa: { iso2: 'US', currency: 'USD' },
  france: { iso2: 'FR', currency: 'EUR' },
  germany: { iso2: 'DE', currency: 'EUR' },
  'united kingdom': { iso2: 'GB', currency: 'GBP' },
  uk: { iso2: 'GB', currency: 'GBP' },
  canada: { iso2: 'CA', currency: 'CAD' },
  australia: { iso2: 'AU', currency: 'AUD' },
  china: { iso2: 'CN', currency: 'CNY' },
  italy: { iso2: 'IT', currency: 'EUR' },
  spain: { iso2: 'ES', currency: 'EUR' },
  brazil: { iso2: 'BR', currency: 'BRL' },
  mexico: { iso2: 'MX', currency: 'MXN' },
  'south korea': { iso2: 'KR', currency: 'KRW' },
  korea: { iso2: 'KR', currency: 'KRW' },
  thailand: { iso2: 'TH', currency: 'THB' },
  singapore: { iso2: 'SG', currency: 'SGD' },
};

function shellEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function resolveCountryMeta(country) {
  const trimmed = String(country ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const iso2 = trimmed.toUpperCase();
    const byIso = Object.values(COUNTRY_LOOKUP).find((c) => c.iso2 === iso2);
    return { iso2, currency: byIso?.currency ?? 'USD' };
  }
  return COUNTRY_LOOKUP[trimmed.toLowerCase()] ?? { iso2: trimmed, currency: trimmed };
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
  const country = args.country || 'Japan';
  const { iso2, currency } = resolveCountryMeta(country);
  const countryArg = shellEscape(country);
  const iso2Arg = shellEscape(iso2);
  const currencyArg = shellEscape(currency);
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('country-info');
  await reportPhase(`fetching country info for ${countryArg}`);
  const countryRaw = await command(`python3 "${COUNTRY_INFO_PY}" "${countryArg}"`, { member_name: 'doer', failSoft: true });
  const countryInfo = safeJson(countryRaw);
  log(`country-info: ${JSON.stringify(countryInfo)}`);
  if (cancelled()) return { cancelled: true, countryInfo };

  phase('travel-advisory');
  await reportPhase(`fetching travel advisory for ${iso2Arg}`);
  const advisoryRaw = await command(`python3 "${TRAVEL_ADVISORY_PY}" "${iso2Arg}"`, { member_name: 'doer', failSoft: true });
  const advisory = safeJson(advisoryRaw);
  log(`travel-advisory: ${JSON.stringify(advisory)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory };

  phase('currency');
  await reportPhase(`fetching currency rate INR to ${currencyArg}`);
  const currencyRaw = await command(`python3 "${CURRENCY_PY}" "INR" "${currencyArg}"`, { member_name: 'doer', failSoft: true });
  const currencyRate = safeJson(currencyRaw);
  log(`currency: ${JSON.stringify(currencyRate)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory, currency: currencyRate };

  phase('public-holidays');
  await reportPhase(`fetching public holidays for ${iso2Arg}`);
  const holidaysRaw = await command(`python3 "${PUBLIC_HOLIDAYS_PY}" "${iso2Arg}"`, { member_name: 'doer', failSoft: true });
  const holidays = safeJson(holidaysRaw);
  log(`public-holidays: ${JSON.stringify(holidays)}`);
  if (cancelled()) return { cancelled: true, countryInfo, advisory, currency: currencyRate, holidays };

  phase('compose');
  await reportPhase(`composing travel prep guide for ${countryArg}`);
  const prompt = [
    `You are a concise travel preparation assistant. Given the data below, write a short pre-trip guide for ${countryArg}.`,
    `Include country info, travel advisory, currency exchange, and public holidays. End with one practical tip.`,
    '', `Country info: ${JSON.stringify(countryInfo)}`, `Advisory: ${JSON.stringify(advisory)}`,
    `Currency: ${JSON.stringify(currencyRate)}`, `Holidays: ${JSON.stringify(holidays)}`,
    '', 'Reply with ONLY the guide text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { country, iso2, currency, countryInfo, advisory, currencyRate, holidays, answer };
}
