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
  const titleEl = $('#topbar-title');

  const GLYPHS = { pending: '○', running: '●', completed: '✓', failed: '✗', retrying: '↻' };
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
      case 'queued': return turn.position ? 'queued #' + turn.position : 'queued';
      case 'running': return turn.iteration ? 'RUNNING · STEP ' + turn.iteration : 'RUNNING';
      case 'cancelling': return 'CANCELLING…';
      case 'completed': return 'DONE';
      case 'error': return 'ERROR';
      default: return turn.status.replace(/_/g, ' ').toUpperCase();
    }
  }

  function planSummary(turn) {
    if (!turn.plan) return '';
    var done = turn.plan.steps.filter(function(s) { return s.status === 'completed'; }).length;
    var total = turn.plan.steps.length;
    if (done === total && total > 0) return 'DONE · ' + total + ' STEPS';
    return done + ' OF ' + total + ' DONE';
  }

  function renderPlanCard(turn) {
    var card = el('div', 'plan-card');
    // Header
    var header = el('div', 'plan-header');
    header.append(el('span', 'plan-label', 'PLAN'));
    header.append(el('span', 'plan-meta', planSummary(turn)));
    card.append(header);
    // Progress bar
    var total = turn.plan.steps.length;
    var done = turn.plan.steps.filter(function(s) { return s.status === 'completed'; }).length;
    var running = turn.plan.steps.filter(function(s) { return s.status === 'running'; }).length;
    var pct = total > 0 ? Math.round(((done + running * 0.5) / total) * 100) : 0;
    var progWrap = el('div', 'plan-progress');
    var progBar = el('div', 'plan-progress-bar');
    progBar.style.width = pct + '%';
    progWrap.append(progBar);
    card.append(progWrap);
    // Steps
    var stepsWrap = el('div', 'plan-steps');
    for (var i = 0; i < turn.plan.steps.length; i++) {
      var step = turn.plan.steps[i];
      var hasDetail = step.result != null || step.error;
      var isExpanded = false;  // collapsed by default
      var row = el('div', 'plan-step' + (step.status === 'running' ? ' running' : ''));
      // Caret
      var caret = el('span', 'caret', hasDetail ? '▶' : '');
      row.append(caret);
      // Glyph
      var glyph = el('span', 'glyph ' + step.status);
      if (step.status === 'running') {
        var dot = el('span', 'running-dot blink');
        glyph.textContent = '';
        glyph.append(dot);
      } else {
        glyph.textContent = GLYPHS[step.status] || '○';
      }
      row.append(glyph);
      // Tool name
      var nameEl = el('span', 'tool-name' + (step.status === 'running' ? ' running' : ''), step.tool || step.type);
      row.append(nameEl);
      // Timing placeholder
      row.append(el('span', 'timing', ''));
      // Detail (collapsed)
      if (hasDetail) {
        var detail = el('div', step.error ? 'step-error' : 'step-detail', step.error || step.result);
        detail.style.display = 'none';
        row.append(detail);
        (function(caretEl, detailEl, rowEl) {
          caretEl.addEventListener('click', function() {
            var showing = detailEl.style.display !== 'none';
            detailEl.style.display = showing ? 'none' : 'block';
            caretEl.textContent = showing ? '▶' : '▼';
            rowEl.className = showing ? rowEl.className.replace(' expanded', '') : rowEl.className + ' expanded';
          });
        })(caret, detail, row);
      }
      stepsWrap.append(row);
    }
    card.append(stepsWrap);
    // Reviews in footer
    if (turn.reviews.length) {
      var footer = el('div', 'plan-footer');
      for (var r = 0; r < turn.reviews.length; r++) {
        var rev = turn.reviews[r];
        var badge = el('span', 'badge' + (rev.approved ? '' : ' no'), rev.reviewType + ' review ' + (rev.approved ? '✓' : '✗'));
        if (rev.feedback) badge.title = rev.feedback;
        footer.append(badge);
      }
      card.append(footer);
    }
    return card;
  }

  function renderCard(card, turn) {
    card.replaceChildren();
    // Apra mark avatar
    var markImg = document.querySelector('.topbar-brand img');
    var markSrc = markImg ? markImg.src : '';
    var img = el('img', 'assistant-mark');
    img.src = markSrc;
    img.alt = '';
    card.append(img);
    var body = el('div', 'assistant-body');
    // Status line
    body.append(el('div', 'assistant-status ' + turn.status, statusText(turn)));
    // Replan notice
    if (turn.replans) body.append(el('div', 'assistant-status', 'Plan revised (' + turn.replans + ')'));
    // Plan — 3c dense ledger
    if (turn.plan) {
      body.append(renderPlanCard(turn));
    }
    // Reviews (when no plan card renders them)
    if (turn.reviews.length && !turn.plan) {
      var revs = el('div', 'reviews');
      for (var r = 0; r < turn.reviews.length; r++) {
        var rev = turn.reviews[r];
        var badge = el('span', 'badge' + (rev.approved ? '' : ' no'), rev.reviewType + ' review ' + (rev.approved ? '✓' : '✗'));
        if (rev.feedback) badge.title = rev.feedback;
        revs.append(badge);
      }
      body.append(revs);
    }
    // Answer
    if (turn.status === 'completed') {
      if (typeof turn.answer === 'string') {
        body.append(el('div', 'answer', turn.answer));
      } else {
        body.append(el('pre', 'answer', JSON.stringify(turn.answer, null, 2)));
      }
    } else if (turn.error) {
      body.append(el('div', 'error-card', turn.status.replace(/_/g, ' ') + ': ' + turn.error.message));
    }
    card.append(body);
    // Status pill
    pillEl.textContent = statusText(turn);
    pillEl.className = 'topbar-status ' + turn.status;
  }

  function setBusy(busy) {
    sendEl.disabled = busy;
    goalEl.disabled = busy;
    var canStop = busy && current && current.turn.jobId && isLive(current.turn) && current.turn.status !== 'cancelling';
    stopEl.disabled = !canStop;
    stopEl.className = 'btn-stop' + (busy ? ' visible' : '');
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
    var source = new EventSource(url);
    current.source = source;
    var types = ['queued', 'started', 'progress', 'settled'];
    for (var t = 0; t < types.length; t++) {
      (function(type) {
        source.addEventListener(type, function(msg) {
          var event;
          try { event = JSON.parse(msg.data); } catch (err) { console.error('unparseable event', msg.data, err); return; }
          console.log(event.type, event.kind || '', event);
          apply(function(turn) { return reduce(turn, event); });
        });
      })(types[t]);
    }
    source.onerror = function(err) { console.error('event stream error; the browser will reconnect with Last-Event-ID', err); };
  }

  function send(goal) {
    // User bubble
    var userWrap = el('div', 'user');
    var bubble = el('div', 'user-bubble', goal);
    userWrap.append(bubble);
    transcriptEl.append(userWrap);
    // Update topbar title with the message
    var short = goal.length > 32 ? goal.slice(0, 32) + '…' : goal;
    titleEl.textContent = short;
    // Assistant card
    var card = el('div', 'assistant');
    transcriptEl.append(card);
    current = { turn: initialTurn(goal), card: card, source: null, grouped: false };
    renderCard(card, current.turn);
    setBusy(true);

    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal }) })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        var res = r.res, body = r.body;
        if (res.status !== 202) {
          var retry = res.headers.get('retry-after');
          var message = (body && body.message ? body.message : body && body.error ? body.error : 'HTTP ' + res.status) + (retry ? ' (retry in ' + retry + 's)' : '');
          console.error('submit rejected', res.status, body);
          apply(function(turn) { return submitFailed(turn, { message: message }); });
          return;
        }
        console.group('job ' + body.jobId);
        current.grouped = true;
        console.log('accepted', body);
        apply(function(turn) { return accepted(turn, { jobId: body.jobId, position: body.position }); });
        subscribe(body.links && body.links.events ? body.links.events : '/jobs/' + body.jobId + '/events');
      })
      .catch(function(err) {
        console.error('submit failed', err);
        apply(function(turn) { return submitFailed(turn, { message: err.message }); });
      });
  }

  function stop() {
    if (!current || !current.turn.jobId || !isLive(current.turn)) return;
    stopEl.disabled = true;
    fetch('/jobs/' + current.turn.jobId, { method: 'DELETE' })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        console.log('cancel', r.res.status, r.body);
        if (r.res.status === 200 || r.res.status === 202) apply(function(turn) { return cancelling(turn); });
        else stopEl.disabled = false;
      })
      .catch(function(err) {
        console.error('cancel failed', err);
        stopEl.disabled = false;
      });
  }

  composerEl.addEventListener('submit', function(e) {
    e.preventDefault();
    var goal = goalEl.value.trim();
    if (goal && !sendEl.disabled) send(goal);
  });
  goalEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composerEl.requestSubmit(); }
  });
  stopEl.addEventListener('click', stop);
})();
