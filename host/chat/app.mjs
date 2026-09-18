// host/chat/app.mjs
// DOM glue for the chat page. Served after transcript.mjs (exports stripped) as
// one module, so initialTurn / accepted / submitFailed / cancelling / reduce /
// isLive are already in scope. No import or export statements in this file.
/* global initialTurn, accepted, submitFailed, cancelling, reduce, isLive */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const transcriptEl = $('#transcript');
  const composerEl = $('#composer');
  const goalEl = $('#goal');
  const sendEl = $('#send');
  const stopEl = $('#stop');
  const pillEl = $('#status');

  const ICONS = { pending: '○', running: '◔', completed: '✓', failed: '✗', retrying: '↻' };
  let current = null;   // { turn, card, source, grouped }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusText(turn) {
    switch (turn.status) {
      case 'submitting': return 'sending…';
      case 'queued': return turn.position ? `queued #${turn.position}` : 'queued';
      case 'running': return turn.iteration ? `running · iteration ${turn.iteration}` : 'running';
      case 'cancelling': return 'cancelling…';
      case 'completed': return 'done';
      case 'error': return 'error';
      default: return turn.status.replace('_', ' ');
    }
  }

  function stepLabel(step) {
    const name = step.tool ?? step.type;
    const extra = step.description && step.description !== name ? ` — ${step.description}` : '';
    return `${ICONS[step.status] ?? '○'} ${name}${extra}`;
  }

  function renderCard(card, turn) {
    card.replaceChildren();
    card.append(el('div', `status ${turn.status}`, statusText(turn)));
    if (turn.replans) card.append(el('div', 'notice', `Plan revised (${turn.replans})`));
    if (turn.plan) {
      const list = el('ol', 'plan');
      for (const step of turn.plan.steps) {
        const li = el('li', `step ${step.status}`);
        if (step.result != null || step.error) {
          const details = el('details');
          details.append(el('summary', null, stepLabel(step)));
          details.append(el('pre', step.error ? 'error' : null, step.error ?? step.result));
          li.append(details);
        } else {
          li.append(el('span', null, stepLabel(step)));
        }
        list.append(li);
      }
      card.append(list);
    }
    if (turn.reviews.length) {
      const row = el('div', 'reviews');
      for (const review of turn.reviews) {
        const badge = el('span', `badge ${review.approved ? 'ok' : 'no'}`, `${review.reviewType} review ${review.approved ? '✓' : '✗'}`);
        if (review.feedback) badge.title = review.feedback;
        row.append(badge);
      }
      card.append(row);
    }
    if (turn.status === 'completed') {
      card.append(typeof turn.answer === 'string'
        ? el('div', 'answer', turn.answer)
        : el('pre', 'answer', JSON.stringify(turn.answer, null, 2)));
    } else if (turn.error) {
      card.append(el('div', 'error-card', `${turn.status}: ${turn.error.message}`));
    }
    pillEl.textContent = statusText(turn);
    pillEl.className = `pill ${turn.status}`;
  }

  function setBusy(busy) {
    sendEl.disabled = busy;
    goalEl.disabled = busy;
    const canStop = busy && current?.turn.jobId && isLive(current.turn) && current.turn.status !== 'cancelling';
    stopEl.disabled = !canStop;
  }

  function finish() {
    if (current.source) { current.source.close(); current.source = null; }
    if (current.grouped) { console.groupEnd(); current.grouped = false; }
    setBusy(false);
    if (current.turn.status === 'completed') goalEl.value = '';
    goalEl.focus();
  }

  function apply(fn) {
    current.turn = fn(current.turn);
    renderCard(current.card, current.turn);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (isLive(current.turn)) setBusy(true); else finish();
  }

  function subscribe(url) {
    const source = new EventSource(url);
    current.source = source;
    for (const type of ['queued', 'started', 'progress', 'settled']) {
      source.addEventListener(type, (msg) => {
        let event;
        try { event = JSON.parse(msg.data); } catch (err) { console.error('unparseable event', msg.data, err); return; }
        console.log(event.type, event.kind ?? '', event);
        apply((turn) => reduce(turn, event));
      });
    }
    source.onerror = (err) => console.error('event stream error; the browser will reconnect with Last-Event-ID', err);
  }

  async function send(goal) {
    transcriptEl.append(el('div', 'user', goal));
    const card = el('div', 'assistant');
    transcriptEl.append(card);
    current = { turn: initialTurn(goal), card, source: null, grouped: false };
    renderCard(card, current.turn);
    setBusy(true);

    let res, body;
    try {
      res = await fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
      body = await res.json().catch(() => null);
    } catch (err) {
      console.error('submit failed', err);
      apply((turn) => submitFailed(turn, { message: err.message }));
      return;
    }
    if (res.status !== 202) {
      const retry = res.headers.get('retry-after');
      const message = `${body?.message ?? body?.error ?? `HTTP ${res.status}`}${retry ? ` (retry in ${retry}s)` : ''}`;
      console.error('submit rejected', res.status, body);
      apply((turn) => submitFailed(turn, { message }));
      return;
    }
    console.group(`job ${body.jobId}`);
    current.grouped = true;
    console.log('accepted', body);
    apply((turn) => accepted(turn, { jobId: body.jobId, position: body.position }));
    subscribe(body.links?.events ?? `/jobs/${body.jobId}/events`);
  }

  async function stop() {
    if (!current?.turn.jobId || !isLive(current.turn)) return;
    stopEl.disabled = true;
    let res, body;
    try {
      res = await fetch(`/jobs/${current.turn.jobId}`, { method: 'DELETE' });
      body = await res.json().catch(() => null);
    } catch (err) {
      console.error('cancel failed', err);
      stopEl.disabled = false;
      return;
    }
    console.log('cancel', res.status, body);
    if (res.status === 200 || res.status === 202) apply((turn) => cancelling(turn));
    else stopEl.disabled = false;   // 409 already terminal: the settled event will land, or has
  }

  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const goal = goalEl.value.trim();
    if (goal && !sendEl.disabled) send(goal);
  });
  goalEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composerEl.requestSubmit(); }
  });
  stopEl.addEventListener('click', stop);
})();
