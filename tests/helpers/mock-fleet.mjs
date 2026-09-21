// tests/helpers/mock-fleet.mjs
// One mock for every offline test. Returns realistic MCP envelopes so the
// text-extraction paths run for real, and records every mutating call so
// tests can assert on registration, teardown, and auth.
export function createMockFleetApi({
  members = [],
  tools = ['remove_member', 'provision_llm_auth'],
  registerFails = [],
  commandPayload = 'hello-from-python',
  promptResponses,          // NEW: string[] | (options) => string
} = {}) {
  const present = new Set(members);
  const registerCalls = [];
  const removeCalls = [];
  const authCalls = [];
  const commandCalls = [];
  const promptCalls = [];

  const api = {
    present,
    registerCalls,
    removeCalls,
    authCalls,
    commandCalls,
    promptCalls,
    async listMembers() {
      return { content: [{ type: 'text', text: [...present].join('\n') }] };
    },
    async fleetStatus() {
      return { content: [{ type: 'text', text: 'fleet server: running' }] };
    },
    async registerMember(options) {
      registerCalls.push(options);
      if (registerFails.includes(options.friendly_name)) {
        return { content: [{ type: 'text', text: `❌ cannot register ${options.friendly_name}` }] };
      }
      present.add(options.friendly_name);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload =
        typeof commandPayload === 'function' ? commandPayload(options) : commandPayload;
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      let text = 'pong';
      if (typeof promptResponses === 'function') {
        text = await promptResponses(options);
      } else if (Array.isArray(promptResponses) && promptResponses.length > 0) {
        const idx = Math.min(promptCalls.length - 1, promptResponses.length - 1);
        text = promptResponses[idx];
      }
      return {
        content: [{ type: 'text', text }],
        structuredContent: { response: text },
      };
    },
  };

  if (tools.includes('remove_member')) {
    api.removeMember = async (options) => {
      removeCalls.push(options);
      present.delete(options.member_name);
      return { content: [{ type: 'text', text: `removed ${options.member_name}` }] };
    };
  }
  if (tools.includes('provision_llm_auth')) {
    api.provisionLlmAuth = async (options) => {
      authCalls.push(options);
      return { content: [{ type: 'text', text: `auth ok ${options.member_name}` }] };
    };
  }
  return api;
}

export function rosterNames(size) {
  return Array.from({ length: size }, (_, index) => index + 1).flatMap((id) => [
    `WORKER-${id}-DOER`,
    `WORKER-${id}-REVIEWER`,
  ]);
}

/** Keep scripted run-loop replies when host.config.mjs has router.enabled. */
export function withRouterBypass(responses) {
  if (typeof responses === 'function') {
    return (opts) => {
      if (opts.prompt?.includes('task router')) return '{"path":"open-ended"}';
      return responses(opts);
    };
  }
  let idx = 0;
  return (opts) => {
    if (opts.prompt?.includes('task router')) return '{"path":"open-ended"}';
    const text = responses[Math.min(idx, responses.length - 1)];
    idx++;
    return text;
  };
}
