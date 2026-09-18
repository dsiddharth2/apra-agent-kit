// Pass-through stubs. Replace by injection, not by editing this file.
// Express-middleware form (legacy mcp/http.mjs path):
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}
// Neutral-contract form (host/ path): request → user | null.
export function authenticateRequest() {
  return { id: 'anonymous' };
}
