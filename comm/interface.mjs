// comm/interface.mjs
//
// Every comm adapter implements:
//
//   { async start({ routes, port, host, authenticate }), async stop(), port(), address() }
//
// routes is an object keyed by route name. Null entries are not mounted.
//
//   RouteDef = {
//     method:  'GET' | 'POST' | 'DELETE',
//     path:    '/jobs/:id',            // ':name' segments become request.params
//     handler: async (request) => response,
//     auth:    true,                   // false → authenticate is skipped
//     raw:     false,                  // true → handler(req, res, user) with Node objects
//     web:     undefined,              // raw routes may also supply web(Request, user) → Response
//   }
//
//   request  = { method, path, params, query, headers, body, signal, user }
//              headers has lower-case keys; body is parsed JSON or null.
//   response = { status, headers?, body? }                          // JSON body
//            | { status, headers?, stream: AsyncIterable<string> }  // chunked text (SSE)
//            | { status, headers?, text: string }                   // plain text / HTML / JS, served verbatim
//              text defaults content-type to text/plain; charset=utf-8 and always sets content-length.
//
//   authenticate(request) → user | null     null → adapter answers 401
//
// The adapter owns the HTTP framework. It never interprets routes beyond this.
// The MCP route is the only raw route: the MCP SDK needs Node req/res (or a
// web-standard Request), which is why RouteDef carries both `handler` and `web`.
export {};
