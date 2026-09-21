const VALID_PATHS = new Set(['workflow', 'open-ended', 'plan-execute']);

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

export async function classify(goal, { fleetApi, registry, fallbackStrategy }) {
  const routableNames = new Set(registry.filter(t => t.routing).map(t => t.name));
  const prompt = buildClassifierPrompt(goal, registry);

  try {
    const raw = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const text = extractText(raw);
    return parseClassifierResponse(text, { routableNames, fallbackStrategy });
  } catch {
    return { path: fallbackStrategy };
  }
}

export async function executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress }) {
  const entry = toolRegistry.find(t => t.name === name && t.routing);
  if (!entry) {
    return { status: 'failed', result: { error: 'workflow_not_found', message: `Workflow "${name}" not found` }, history: [], budget: null };
  }
  try {
    const result = await entry.run({ fleetApi, args: args ?? {}, signal, reportPhase: onProgress });
    return {
      status: 'completed',
      result: typeof result === 'string' ? result : JSON.stringify(result),
      history: [],
      budget: null,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'cancelled', result: null, history: [], budget: null };
    }
    return { status: 'failed', result: { error: 'workflow_failed', message: String(err?.message ?? err) }, history: [], budget: null };
  }
}
