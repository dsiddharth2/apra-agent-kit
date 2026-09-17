// The launcher owns spawning Fleet, leasing a worker pair, and cleanup. The
// body in hello.js owns the work. That split is what keeps the body testable
// with no binary and no token.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'hello.js');

export const selfExecuting = true;

export async function runHello({ fleetApi, workspace, signal, reportPhase, name } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    // CLI run: spawn Fleet, take one lease, run, release.
    return withStandaloneLease((ctx) => runHello({ ...ctx, reportPhase, name }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, { fleetApi, workspace, signal, reportPhase, name });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runHello({ name: process.argv[2] }), null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
