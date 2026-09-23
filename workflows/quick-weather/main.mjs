import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'quick-weather.js');

export const selfExecuting = true;

export async function runQuickWeather({ fleetApi, workspace, city, signal, reportPhase } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runQuickWeather({ ...ctx, city, reportPhase }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, {
    fleetApi,
    workspace,
    city: city || 'London',
    signal,
    reportPhase,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const city = process.argv[2] || 'London';
    const result = await runQuickWeather({ city });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
