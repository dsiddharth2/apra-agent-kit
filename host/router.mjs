import { executeTool } from './tools/executor.mjs';

const VALID_PATHS = new Set(['workflow', 'open-ended', 'plan-execute']);
const CLASSIFY_TIMEOUT_MS = 30_000;

export function buildClassifierPrompt(goal, registry) {
  const routable = registry.filter(t => t.routing);
  const workflowLines = routable.map(t => {
    const argDesc = Object.entries(t.routing.args ?? {})
      .map(([k, v]) => `${k}: ${v.extract}`)
      .join(', ');
    return `- ${t.name}: ${t.routing.description}${argDesc ? ` (extract: ${argDesc})` : ''}`;
  }).join('\n');

  const workflowSection = routable.length > 0
    ? `Available workflows (predefined, fastest — pick one if the goal is a direct match):\n${workflowLines}\n\n`
    : '';

  return `You are a task router for a travel assistant. Given the user's goal, decide the best execution path.

${workflowSection}Available strategies (flexible, for goals that don't match a workflow):
- open-ended: Good for simple questions needing 1-2 tool calls or conversational replies.
- plan-execute: For complex multi-step tasks that need planning, multiple tools in a dynamic order, and review. Use only when the task genuinely requires it.

User's goal: "${goal}"

Respond with ONLY a JSON object, no other text:
{"path":"workflow|open-ended|plan-execute","workflow":"name-if-workflow","args":{extracted args if workflow}}`;
}

export function parseClassifierResponse(text, { routableNames, fallbackStrategy }) {
  const fallback = { path: fallbackStrategy };
  if (!text || typeof text !== 'string') return fallback;

  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return fallback;
  }

  if (!parsed || typeof parsed !== 'object') return fallback;
  if (!VALID_PATHS.has(parsed.path)) return fallback;

  if (parsed.path === 'workflow') {
    if (!parsed.workflow || !routableNames.has(parsed.workflow)) return fallback;
    return { path: 'workflow', workflow: parsed.workflow, args: parsed.args ?? {} };
  }

  return { path: parsed.path };
}

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export async function classify(goal, { fleetApi, registry, fallbackStrategy, signal }) {
  const routableNames = new Set(registry.filter(t => t.routing).map(t => t.name));
  const fallback = { path: fallbackStrategy };
  if (signal?.aborted) return fallback;

  const prompt = buildClassifierPrompt(goal, registry);

  try {
    const timeoutSignal = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    if (combined.aborted) return fallback;

    const raw = await Promise.race([
      fleetApi.executePrompt({ member_name: 'doer', prompt, signal: combined }),
      new Promise((_, reject) => {
        const onAbort = () => reject(abortError('classify aborted'));
        if (combined.aborted) {
          onAbort();
          return;
        }
        combined.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    const text = extractText(raw);
    return parseClassifierResponse(text, { routableNames, fallbackStrategy });
  } catch {
    return fallback;
  }
}

function unwrapWorkflowResult(result) {
  if (result && typeof result === 'object' && typeof result.answer === 'string') {
    return result.answer;
  }
  if (typeof result === 'string') {
    const marker = 'completed:';
    const idx = result.lastIndexOf(marker);
    if (idx !== -1) {
      const jsonPart = result.slice(idx + marker.length).trim();
      try {
        const parsed = JSON.parse(jsonPart);
        if (parsed && typeof parsed.answer === 'string') return parsed.answer;
      } catch {
        // keep original string
      }
    }
    return result;
  }
  return JSON.stringify(result);
}

function adaptReportPhase(onProgress) {
  if (!onProgress) return () => {};
  let iteration = 0;
  return (messageOrObj) => {
    if (typeof messageOrObj === 'string') {
      iteration += 1;
      return onProgress({ iteration, message: messageOrObj });
    }
    return onProgress(messageOrObj);
  };
}

export async function executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress, workspace }) {
  const entry = toolRegistry.find(t => t.name === name && t.routing);
  if (!entry) {
    return { status: 'failed', result: { error: 'workflow_not_found', message: `Workflow "${name}" not found` }, history: [], budget: null };
  }

  const executed = await executeTool(entry, {
    fleetApi,
    args: args ?? {},
    signal,
    reportPhase: adaptReportPhase(onProgress),
    workspace,
  });

  if (!executed.ok) {
    if (executed.error === 'timeout' && signal?.aborted) {
      return { status: 'cancelled', result: null, history: [], budget: null };
    }
    const error = executed.error === 'validation_failed' ? 'validation_failed'
      : executed.error === 'timeout' ? 'timeout'
      : executed.error === 'tool_error' ? 'workflow_failed'
      : executed.error ?? 'workflow_failed';
    return {
      status: 'failed',
      result: {
        error,
        message: executed.message ?? (error === 'validation_failed' ? 'invalid workflow args' : String(error)),
        ...(executed.details ? { details: executed.details } : {}),
      },
      history: [],
      budget: null,
    };
  }

  return {
    status: 'completed',
    result: unwrapWorkflowResult(executed.result),
    history: [],
    budget: null,
  };
}
