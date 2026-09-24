// host/memory/learner.mjs
const LEARNER_PROMPT = `You are a memory extraction agent. Given a completed task and its observation history, extract reusable facts that would help in future similar tasks.

Rules:
- Only extract facts useful across multiple future runs, not task-specific results.
- Each fact must have: kind (one of: domain, preference, pattern, procedure — NEVER "rule"), text, and tags (array of strings).
- Also identify which recalled facts (by id) were actually used in this run.
- Respond with a JSON block:

\`\`\`json
{
  "newFacts": [{ "kind": "domain", "text": "...", "tags": ["..."] }],
  "usedRecalledIds": ["mem-xxx", "mem-yyy"]
}
\`\`\`

Task: {{TASK}}

Recalled facts at start:
{{RECALLED}}

Observation history:
{{HISTORY}}`;

function buildPrompt(task, history, recalledFacts) {
  const taskText = typeof task === 'string' ? task : (task?.goal ?? JSON.stringify(task));
  const recalledText = (recalledFacts ?? []).map(f => `[${f.id}] (${f.kind}) ${f.text}`).join('\n') || '(none)';
  const historyText = (history ?? []).map((e, i) => `[${i + 1}] ${e.type ?? 'step'}: ${e.text ?? e.result ?? JSON.stringify(e).slice(0, 300)}`).join('\n');
  return LEARNER_PROMPT
    .replace('{{TASK}}', taskText)
    .replace('{{RECALLED}}', recalledText)
    .replace('{{HISTORY}}', historyText);
}

function parseExtraction(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return { newFacts: [], usedRecalledIds: [] };
  try {
    const parsed = JSON.parse(match[1]);
    const newFacts = (parsed.newFacts ?? []).filter(f => f.kind !== 'rule');
    return { newFacts, usedRecalledIds: parsed.usedRecalledIds ?? [] };
  } catch {
    return { newFacts: [], usedRecalledIds: [] };
  }
}

export function createLearner({ longTermMemory, fleetApi, events = null, logger = console } = {}) {
  return {
    async extract({ task, history, recalledFacts }) {
      try {
        const prompt = buildPrompt(task, history, recalledFacts);
        const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
        const text = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
        const { newFacts, usedRecalledIds } = parseExtraction(text);

        const stored = [];
        for (const fact of newFacts) {
          const result = await longTermMemory.store({
            kind: fact.kind,
            text: fact.text,
            tags: fact.tags ?? [],
            source: 'agent',
          });
          stored.push(result);
        }

        const promotedIds = [];
        for (const id of usedRecalledIds) {
          try {
            await longTermMemory.promote(id);
            promotedIds.push(id);
          } catch { /* skip missing */ }
        }

        logger.info?.(`[memory/learner] extracted ${newFacts.length} facts, promoted ${promotedIds.length} recalled facts`);
        events?.emit('memory:learn', { taskId: task?.id ?? null, newFacts: stored, promotedIds });
        return { newFacts: stored, promotedIds };
      } catch (err) {
        logger.warn?.(`[memory/learner] extraction failed: ${err?.message ?? err}`);
        events?.emit('memory:error', { tier: 'learner', error: err?.message ?? String(err), policy: 'log-and-skip' });
        return { newFacts: [], promotedIds: [] };
      }
    },
  };
}
