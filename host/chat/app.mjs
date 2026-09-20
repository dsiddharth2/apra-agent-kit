// host/chat/app.mjs
// DOM glue for the chat page. Served after transcript.mjs (exports stripped) as
// one module, so initialTurn / accepted / submitFailed / cancelling / reduce /
// isLive are already in scope. No import or export statements in this file.
/* global initialTurn, accepted, submitFailed, cancelling, reduce, isLive */
/* global marked, DOMPurify */
(() => {
  var apiBase = location.pathname.replace(/\/chat\/?$/, '');
  var $ = function(sel) { return document.querySelector(sel); };
  var transcriptEl = $('#transcript');
  var composerEl = $('#composer');
  var goalEl = $('#goal');
  var sendBtn = $('#send');
  var statusPill = $('#status-pill');
  var statusText = $('#status-text');
  var threadTitle = $('#thread-title');
  var hdrSub = $('#hdr-sub');
  var composerStatus = $('#composer-status');
  var markSrc = (function() { var img = $('.hdr-left img'); return img ? img.src : ''; })();

  var current = null; // { turn, card, source, grouped, planOpen, openStep }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pillText(turn) {
    switch (turn.status) {
      case 'submitting': return 'SENDING';
      case 'queued': return turn.position ? 'QUEUED #' + turn.position : 'QUEUED';
      case 'running': return turn.iteration ? 'WORKING · STEP ' + turn.iteration : 'WORKING';
      case 'cancelling': return 'CANCELLING';
      case 'completed': return 'DONE';
      case 'error': return 'ERROR';
      default: return turn.status.replace(/_/g, ' ').toUpperCase();
    }
  }

  function updatePill(turn) {
    statusText.textContent = pillText(turn);
    statusPill.className = 'hdr-pill' + (isLive(turn) ? ' status-running' : (turn.error ? ' status-error' : ''));
  }

  function updateComposer(busy) {
    sendBtn.disabled = busy;
    goalEl.disabled = busy;
    sendBtn.className = 'btn-send' + (!busy && goalEl.value.trim() ? ' ready' : '');
    composerStatus.textContent = busy ? 'WORKING… ENTER TO STOP' : 'ENTER TO SEND';
    if (busy) composerStatus.className = 'stop-hint'; else composerStatus.className = '';
  }

  goalEl.addEventListener('input', function() {
    sendBtn.className = 'btn-send' + (goalEl.value.trim() && !sendBtn.disabled ? ' ready' : '');
  });

  // --- Plan card rendering ---

  function planSummary(turn) {
    if (!turn.plan) return '';
    var done = 0, total = turn.plan.steps.length;
    for (var i = 0; i < total; i++) if (turn.plan.steps[i].status === 'completed') done++;
    if (done === total && total > 0) return 'DONE · ' + total + ' STEPS';
    return done + ' OF ' + total + ' DONE';
  }

  function planPct(turn) {
    if (!turn.plan || turn.plan.steps.length === 0) return '0%';
    var done = 0, run = 0;
    for (var i = 0; i < turn.plan.steps.length; i++) {
      if (turn.plan.steps[i].status === 'completed') done++;
      if (turn.plan.steps[i].status === 'running') run++;
    }
    return Math.round(((done + run * 0.5) / turn.plan.steps.length) * 100) + '%';
  }

  function stepGlyph(status) {
    if (status === 'completed') return '✓';
    if (status === 'running') return null; // use dot
    if (status === 'failed') return '✗';
    if (status === 'retrying') return '↻';
    return '○';
  }

  function stepColors(status) {
    var isDone = status === 'completed';
    var isRun = status === 'running';
    return {
      glyph: isDone || isRun ? '#6B9420' : 'rgba(0,0,0,.28)',
      tool: isDone || isRun ? '#14171A' : 'rgba(0,0,0,.42)',
      detail: isRun ? '#5a7a1e' : 'rgba(0,0,0,.45)',
      caret: 'rgba(0,0,0,.3)',
      bg: isRun ? '#F7FAF0' : 'transparent'
    };
  }

  function renderPlan(turn) {
    var plan = h('div', 'plan');
    // Header
    var hdr = h('div', 'plan-hdr');
    var left = h('div', 'plan-hdr-left');
    left.append(h('span', 'plan-label', 'PLAN'));
    left.append(h('span', 'plan-meta', planSummary(turn)));
    hdr.append(left);
    var toggle = h('span', 'plan-toggle', current.planOpen ? 'HIDE STEPS' : 'SHOW STEPS');
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      current.planOpen = !current.planOpen;
      renderCard(current.card, current.turn);
    });
    hdr.append(toggle);
    plan.append(hdr);
    // Progress bar
    var bar = h('div', 'plan-bar');
    var fill = h('div', 'plan-bar-fill');
    fill.style.width = planPct(turn);
    bar.append(fill);
    plan.append(bar);
    // Steps
    if (current.planOpen) {
      var steps = h('div', 'plan-steps');
      for (var i = 0; i < turn.plan.steps.length; i++) {
        (function(idx) {
          var s = turn.plan.steps[idx];
          var c = stepColors(s.status);
          var isOpen = current.openStep === idx;
          var hasContent = s.result != null || s.error;

          var row = h('div', 'plan-step');
          row.style.background = isOpen ? '#FAFBF7' : c.bg;
          row.addEventListener('click', function() {
            if (!hasContent) return;
            current.openStep = current.openStep === idx ? null : idx;
            renderCard(current.card, current.turn);
          });

          // Caret
          var caret = h('span', 'caret');
          caret.style.color = isOpen ? '#5a7a1e' : c.caret;
          caret.textContent = hasContent ? (isOpen ? '▼' : '▶') : '';
          row.append(caret);

          // Glyph
          var glyph = h('span', 'glyph');
          glyph.style.color = c.glyph;
          var g = stepGlyph(s.status);
          if (g) { glyph.textContent = g; } else { var dot = h('span', 'run-dot'); glyph.append(dot); }
          row.append(glyph);

          // Info column
          var info = h('div', 'step-info');
          var sr = h('div', 'step-row');
          var toolSpan = h('span', 'tool', s.tool || s.type);
          toolSpan.style.color = c.tool;
          sr.append(toolSpan);
          var detSpan = h('span', 'detail');
          detSpan.style.color = c.detail;
          detSpan.textContent = s.status === 'running' ? (s.description || '') + '…' : (s.description || '');
          sr.append(detSpan);
          info.append(sr);

          // Expanded content
          if (isOpen && hasContent) {
            var exp = h('div', 'step-expand');
            if (s.result) {
              var note = h('div', 'step-note', typeof s.result === 'string' ? s.result : JSON.stringify(s.result));
              exp.append(note);
            }
            if (s.error) {
              var errDiv = h('div', 'step-note');
              errDiv.style.color = '#b91c1c';
              errDiv.textContent = s.error;
              exp.append(errDiv);
            }
            info.append(exp);
          }
          row.append(info);

          // Timing
          var timing = h('span', 'timing');
          timing.textContent = s.status === 'running' ? '···' : '';
          row.append(timing);

          steps.append(row);
        })(i);
      }
      plan.append(steps);
    }
    // Footer — reviews + stop
    var footer = h('div', 'plan-footer');
    for (var r = 0; r < turn.reviews.length; r++) {
      var rev = turn.reviews[r];
      var badge = h('span', 'review-badge' + (rev.approved ? '' : ' no'));
      badge.textContent = rev.reviewType + ' review ' + (rev.approved ? '✓' : '✗');
      if (rev.feedback) badge.title = rev.feedback;
      footer.append(badge);
    }
    if (isLive(turn) && turn.status !== 'submitting') {
      var stopBtn = h('span', 'plan-stop', 'STOP');
      stopBtn.addEventListener('click', function(e) { e.stopPropagation(); doStop(); });
      footer.append(stopBtn);
    }
    plan.append(footer);
    return plan;
  }

  // --- Answer rendering ---

  function renderAnswer(text) {
    var div = h('div', 'answer-block');
    var inner = h('div', 'answer-text');
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      inner.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
      inner.textContent = text;
    }
    div.append(inner);
    return div;
  }

  // --- Card rendering ---

  function renderCard(card, turn) {
    card.replaceChildren();
    var img = h('img', 'bot-mark');
    img.src = markSrc;
    img.alt = '';
    img.style.opacity = isLive(turn) ? '.55' : '1';
    card.append(img);

    var body = h('div', 'bot-body');

    // Status when not yet running
    if (turn.status === 'submitting' || turn.status === 'queued') {
      body.append(h('div', 'bot-status active', pillText(turn)));
    }

    // Plan
    if (turn.plan) {
      body.append(renderPlan(turn));
    }

    // Answer
    if (turn.status === 'completed' && turn.answer != null) {
      if (typeof turn.answer === 'string') {
        body.append(renderAnswer(turn.answer));
      } else {
        body.append(h('pre', 'answer-raw', JSON.stringify(turn.answer, null, 2)));
      }
    } else if (turn.error) {
      body.append(h('div', 'error-card', turn.status.replace(/_/g, ' ') + ': ' + turn.error.message));
    }

    card.append(body);
    updatePill(turn);
  }

  // --- Lifecycle ---

  function finish() {
    if (current.source) { current.source.close(); current.source = null; }
    if (current.grouped) { console.groupEnd(); current.grouped = false; }
    updateComposer(false);
    if (current.turn.status === 'completed') goalEl.value = '';
    goalEl.focus();
    sendBtn.className = 'btn-send';
    // Collapse plan when done
    current.planOpen = false;
    renderCard(current.card, current.turn);
  }

  function apply(fn) {
    current.turn = fn(current.turn);
    renderCard(current.card, current.turn);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (isLive(current.turn)) updateComposer(true); else finish();
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
    source.onerror = function(err) { console.error('SSE error; browser will reconnect with Last-Event-ID', err); };
  }

  function doSend(goal) {
    // User bubble
    var userDiv = h('div', 'user-msg', goal);
    transcriptEl.append(userDiv);

    // Update thread title
    var short = goal.length > 50 ? goal.slice(0, 50) + '…' : goal;
    threadTitle.textContent = short;
    hdrSub.textContent = '';

    // Bot card
    var card = h('div', 'bot-msg');
    transcriptEl.append(card);
    current = { turn: initialTurn(goal), card: card, source: null, grouped: false, planOpen: true, openStep: null };
    renderCard(card, current.turn);
    updateComposer(true);

    fetch(apiBase + '/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal }) })
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
        hdrSub.textContent = 'JOB ' + body.jobId.toUpperCase();
        apply(function(turn) { return accepted(turn, { jobId: body.jobId, position: body.position }); });
        subscribe(apiBase + (body.links && body.links.events ? body.links.events : '/jobs/' + body.jobId + '/events'));
      })
      .catch(function(err) {
        console.error('submit failed', err);
        apply(function(turn) { return submitFailed(turn, { message: err.message }); });
      });
  }

  function doStop() {
    if (!current || !current.turn.jobId || !isLive(current.turn)) return;
    fetch(apiBase + '/jobs/' + current.turn.jobId, { method: 'DELETE' })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        console.log('cancel', r.res.status, r.body);
        if (r.res.status === 200 || r.res.status === 202) apply(function(turn) { return cancelling(turn); });
      })
      .catch(function(err) { console.error('cancel failed', err); });
  }

  composerEl.addEventListener('submit', function(e) {
    e.preventDefault();
    var goal = goalEl.value.trim();
    if (goal && !sendBtn.disabled) doSend(goal);
  });
  goalEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (current && isLive(current.turn)) { doStop(); return; }
      composerEl.requestSubmit();
    }
  });
  composerStatus.addEventListener('click', function() {
    if (current && isLive(current.turn)) doStop();
  });
})();
