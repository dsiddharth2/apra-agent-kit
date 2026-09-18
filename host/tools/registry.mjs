// host/tools/registry.mjs
import { defaultRegistry } from '../../mcp/registry.mjs';
import { jobTools } from './jobs-tools.mjs';

export { jobTools };

const DEFAULTS = {
  reversible: true,
  timeout: 300_000,
  retryable: false,
  tags: [],
};

export function extendRegistry(registry = defaultRegistry) {
  return registry.map(entry => ({
    ...DEFAULTS,
    ...entry,
    tags: [...(entry.tags ?? [])],
  }));
}

export const hostRegistry = extendRegistry();

export function withJobTools(registry, jobs) {
  if (!jobs) return registry;
  return [...registry, ...extendRegistry(jobTools)];
}
