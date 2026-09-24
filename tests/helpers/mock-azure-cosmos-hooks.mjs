// ESM resolve hook so `import('@azure/cosmos')` stays offline in tests.
// node:test mock.module is unavailable on Node 22.14 unless
// --experimental-test-module-mocks is set; module.register works with `node --test`.

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@azure/cosmos') {
    return {
      url: new URL('./mock-azure-cosmos.mjs', import.meta.url).href,
      shortCircuit: true,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
