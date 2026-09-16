// host/response-parser.mjs

const BLOCK_TYPES = new Set(['tool_call', 'plan', 'done', 'review', 'step_review']);

const FENCE_RE = /```\s*(\w+)\s*\n([\s\S]*?)```/;

export function parseResponse(text) {
  const match = FENCE_RE.exec(text);
  if (!match) {
    return { type: 'thinking', reasoning: text.trim(), payload: null };
  }

  const blockType = match[1].trim();
  const jsonStr = match[2].trim();
  const reasoning = text.slice(0, match.index).trim();

  if (!BLOCK_TYPES.has(blockType)) {
    return { type: 'thinking', reasoning: text.trim(), payload: null };
  }

  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (err) {
    return { type: 'error', message: `Invalid JSON in ${blockType} block: ${err.message}`, reasoning };
  }

  return { type: blockType, payload, reasoning };
}
