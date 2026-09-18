// tests/helpers/scripted-fleet.mjs
// A fleetApi driven by a JSON script. Used by E2E_MODE=scripted (through the
// FLEET_MOCK_SCRIPT switch in host/index.mjs) and by unit tests.
import { readFile } from 'node:fs/promises';
import { createMockFleetApi, rosterNames } from './mock-fleet.mjs';

export function createScriptedFleetApi(script, { members = rosterNames(4) } = {}) {
  const cursors = new Map(); // goal key → next response index
  const toolFor = (command) => Object.keys(script.tools ?? {}).find(name => command.includes(`${name}.py`) || command.includes(`/${name}/`));
  const keyFor = (prompt) => Object.keys(script.goals ?? {}).find(k => prompt.includes(k)) ?? '__default__';
  const fallback = ['```done\n{"result":"no script","summary":"none"}\n```'];

  const api = createMockFleetApi({
    members,
    commandPayload: (options) => {
      const name = toolFor(options.command ?? '');
      const payload = name ? script.tools[name] : { ok: false, error: `no scripted payload for command: ${options.command}` };
      return JSON.stringify(payload);
    },
    promptResponses: (options) => {
      const key = keyFor(String(options.prompt ?? ''));
      const list = key !== '__default__' ? script.goals[key] : (script.default ?? fallback);
      const i = cursors.get(key) ?? 0;
      cursors.set(key, i + 1);
      return list[Math.min(i, list.length - 1)];
    },
  });

  // Optional per-goal latency so e2e cancel/backpressure cases find a running job.
  const origPrompt = api.executePrompt.bind(api);
  api.executePrompt = async (options) => {
    const delay = script.delays?.[keyFor(String(options.prompt ?? ''))];
    if (delay) await new Promise(r => setTimeout(r, delay));
    return origPrompt(options);
  };
  return api;
}

export async function loadScript(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
