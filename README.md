<p align="center">
  <img src="docs/apra-agent-kit-banner.png" alt="apra-agent-kit" />
</p>

## Quick start

```bash
git clone https://github.com/dsiddharth2/apra-agent-kit.git
cd apra-agent-kit
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

## Without Docker

```bash
npm install -g @apralabs/apra-fleet && apra-fleet install
npm install
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
npm run mcp
```

## Testing

```bash
npm test    # mock tests — no Fleet binary, no tokens needed
```

## Docs

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layers, module map, data flow, design decisions |
| [docs/development.md](docs/development.md) | Setup, testing, adding workflows, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract, timeouts, auth |
| [docs/run-loop.md](docs/run-loop.md) | Autonomous agent: strategies, budgets, guardrails, `/task` API |
