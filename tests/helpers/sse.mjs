// tests/helpers/sse.mjs
// Consume a fetch() Response carrying text/event-stream. Yields { id, event, data }.
export async function* readSse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      if (!block.trim() || block.startsWith(':')) continue;               // heartbeat
      const field = (k) => block.split('\n').find(l => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
      const data = field('data');
      yield { id: Number(field('id')), event: field('event'), data: data ? JSON.parse(data) : null };
    }
  }
}
