// host/strategies/open-ended.mjs
import { parseResponse } from '../response-parser.mjs';
import { buildSystemPrompt, buildActPrompt, formatTools } from '../prompts/index.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

export function createOpenEndedStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  jobs,
  workspace,
  maxNoActionTurns = 3,
  agentName = 'agent',
  agentDescription = '',
  traceId = null,
  memory,
  memories,
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription, memories });
  const toolCatalog = formatTools(tools);
  const observations = [];
  let noActionCount = 0;

  function remember(observation) {
    observations.push(observation);
    if (!memory?.workingContext) return;
    try {
      memory.workingContext.append(observation);
    } catch (err) {
      console.warn(`[host] working context append failed — continuing: ${err?.message ?? err}`);
    }
  }

  async function historyForPrompt() {
    if (!memory?.workingContext) return observations;
    try {
      return await memory.workingContext.forPrompt();
    } catch (err) {
      console.warn(`[host] working context failed — continuing with local history: ${err?.message ?? err}`);
      return observations;
    }
  }

  async function executeTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args, jobs, traceId, workspace });
    }
    const { executeTool: exec } = await import('../tools/executor.mjs');
    return exec(tool, { fleetApi, args, jobs, traceId, workspace });
  }

  async function* iterate() {
    while (true) {
      const history = await historyForPrompt();
      const prompt = buildActPrompt({ task, history, tools: toolCatalog, systemPrompt });
      const raw = await fleetApi.executePrompt({ member_name: 'doer', prompt });
      const text = extractText(raw);
      const parsed = parseResponse(text);

      yield { type: 'prompt_usage', text };

      if (parsed.type === 'done') {
        yield { type: 'done', result: parsed.payload.result, summary: parsed.payload.summary };
        return;
      }

      if (parsed.type === 'tool_call') {
        noActionCount = 0;
        const { tool, args } = parsed.payload;
        yield { type: 'action', tool, args, reasoning: parsed.reasoning };
        const result = await executeTool(tool, args);
        remember({ type: 'observation', tool, args, result });
        yield { type: 'observation', tool, args, ...result };
        continue;
      }

      if (parsed.type === 'thinking' || parsed.type === 'error') {
        noActionCount++;
        remember({ type: 'thinking', text: parsed.reasoning ?? parsed.message });
        if (noActionCount >= maxNoActionTurns) {
          yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
          return;
        }
        continue;
      }

      noActionCount++;
      remember({ type: 'thinking', text });
      if (noActionCount >= maxNoActionTurns) {
        yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
        return;
      }
    }
  }

  return {
    iterate,
    history: () => [...observations],
  };
}
