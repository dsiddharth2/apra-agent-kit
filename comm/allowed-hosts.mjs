// Host header allowlist for DNS-rebinding protection (#89).
//
// The MCP SDK picks its Host validation from the bind host: localhost binds
// accept only localhost names, while 0.0.0.0 / :: binds validate nothing and
// leave the bearer token as the guard. An explicit allowlist overrides both.

export function parseAllowedHosts(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const hosts = String(value).split(',').map((h) => h.trim()).filter(Boolean);
  return hosts.length ? hosts : undefined;
}

export function validateAllowedHosts(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((h) => typeof h === 'string' && h.trim())) {
    throw new Error('comm.allowedHosts must be a non-empty array of hostnames');
  }
  return Object.freeze(value.map((h) => h.trim()));
}
