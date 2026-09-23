import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const meta = { name: 'quick-weather' };

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const WEATHER_PY = path.join(toolsDir, 'weather', 'weather.py');
const FORECAST_PY = path.join(toolsDir, 'forecast', 'forecast.py');

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
  const city = shellEscape(args.city || 'London');
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const cancelled = () => signal?.aborted === true;

  phase('weather');
  await reportPhase(`fetching weather for ${city}`);
  const weatherRaw = await command(`python3 "${WEATHER_PY}" "${city}"`, { member_name: 'doer', failSoft: true });
  const weather = safeJson(weatherRaw);
  log(`weather: ${JSON.stringify(weather)}`);
  if (cancelled()) return { cancelled: true, weather };

  phase('forecast');
  await reportPhase(`fetching forecast for ${city}`);
  const forecastRaw = await command(`python3 "${FORECAST_PY}" "${city}" 3`, { member_name: 'doer', failSoft: true });
  const forecast = safeJson(forecastRaw);
  log(`forecast: ${JSON.stringify(forecast)}`);
  if (cancelled()) return { cancelled: true, weather, forecast };

  phase('compose');
  await reportPhase(`composing weather summary for ${city}`);
  const prompt = [
    `You are a concise travel weather assistant. Given the data below, write a short 3-4 sentence weather summary for ${city}.`,
    `Include current conditions, temperature, and the 3-day outlook. End with one practical tip.`,
    '', `Weather: ${JSON.stringify(weather)}`, `Forecast: ${JSON.stringify(forecast)}`,
    '', 'Reply with ONLY the summary text, no preamble.',
  ].join('\n');
  const answer = await agent(prompt, { member_name: 'doer' });

  return { city, weather, forecast, answer };
}
