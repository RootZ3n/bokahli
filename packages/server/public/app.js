// Bokahli chat UI.
// Talks to the native envelope endpoint so route mode, outcome, served
// identity and telemetry are all first-class in the transcript — not hidden
// behind an OpenAI-shaped response.

const $ = (id) => document.getElementById(id);
const log = $('log');
const promptEl = $('prompt');
const sendBtn = $('send');
const modeEl = $('mode');
const history = [];
let busy = false;

// ---------------------------------------------------------------------------
// header / readiness
// ---------------------------------------------------------------------------

let catalogEntry = null;

async function refreshStatus() {
  try {
    const [readyRes, catRes] = await Promise.all([
      fetch('/health/ready'),
      fetch('/v1/catalog'),
    ]);
    if (readyRes.status === 401 || catRes.status === 401) {
      $('ident').textContent = 'unauthenticated — append ?token=…';
      $('dot').className = 'dot bad';
      return;
    }
    const ready = await readyRes.json();
    const cat = await catRes.json();
    catalogEntry = cat.catalog?.[0] ?? null;

    const ok = ready.status === 'ready';
    $('dot').className = `dot ${ok ? 'ok' : 'warn'}`;
    const rt = ready.runtime ?? {};
    $('ident').innerHTML =
      `<b>${catalogEntry ? esc(catalogEntry.modelId) : 'no artifact'}</b> · ` +
      `${rt.build ?? '—'} · ctx ${fmt(rt.servedContextTokens)} · ` +
      `slots ${rt.busySlots ?? 0}/${rt.totalSlots ?? '—'} · ` +
      `${rt.attested ? 'attested' : 'UNATTESTED'}`;

    if (catalogEntry && catalogEntry.qualification.status !== 'QUALIFIED') {
      const b = $('banner');
      b.className = 'banner unqualified';
      b.innerHTML =
        `<b>${esc(catalogEntry.modelId)}</b> is <code>${esc(catalogEntry.qualification.status)}</code>. ` +
        `Luak has issued no qualification evidence for this artifact. ` +
        `Bokahli makes no claim that it is fit for any task class.`;
    }
    if (!ready.gpuLease?.available) {
      const h = ready.gpuLease.foreignHolders?.[0];
      const b = $('banner');
      b.className = 'banner unqualified';
      b.innerHTML = `GPU lease held by <code>${esc(h?.processName ?? 'another process')}</code> ` +
        `(${h?.usedMiB ?? '?'} MiB). Requests will return a typed capacity outcome.`;
    }
  } catch (err) {
    $('dot').className = 'dot bad';
    $('ident').textContent = `unreachable: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function addMessage(role, text) {
  $('empty')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
  wrap.querySelector('.body').textContent = text;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

function renderMeta(el, route, telemetry, served) {
  const meta = document.createElement('div');
  meta.className = 'meta';
  const tps = telemetry.completionTokensPerSecond;
  const ptps = telemetry.promptTokensPerSecond;
  const parts = [
    `<span class="pill routed">${esc(route.mode)} · ROUTED</span>`,
    served.qualification.status !== 'QUALIFIED'
      ? `<span class="pill unqualified">${esc(served.qualification.status)}</span>` : '',
    `<span>model <b>${esc(served.modelId)}</b></span>`,
    `<span>digest <b>${esc(served.digest.slice(7, 19))}…</b></span>`,
    `<span>attested <b>${served.attested}</b></span>`,
    `<span>build <b>${esc(served.runtime.build)}</b></span>`,
    `<span>ttft <b>${fmt(telemetry.timeToFirstTokenMs)} ms</b></span>`,
    `<span>total <b>${fmt(telemetry.totalMs)} ms</b></span>`,
    `<span>queue <b>${fmt(telemetry.queueWaitMs)} ms</b></span>`,
    `<span>route <b>${fmt(telemetry.routeMs)} ms</b></span>`,
    `<span>tok <b>${fmt(telemetry.promptTokens)}→${fmt(telemetry.completionTokens)}</b></span>`,
    ptps ? `<span>prefill <b>${ptps.toFixed(1)} t/s</b></span>` : '',
    tps ? `<span>decode <b>${tps.toFixed(1)} t/s</b></span>` : '',
    `<span>ctx <b>${pct(telemetry.contextUtilisation)} of ${fmt(telemetry.servedContextTokens)}</b></span>`,
    telemetry.gpu ? `<span>gpu <b>${telemetry.gpu.usedMiB} MiB · ${telemetry.gpu.temperatureC}°C</b></span>` : '',
    `<span>req <b>${esc(telemetry.requestId.slice(0, 8))}</b></span>`,
  ];
  meta.innerHTML = parts.filter(Boolean).join('');
  el.appendChild(meta);

  const det = document.createElement('details');
  det.innerHTML = `<summary>routing decision · ${route.considered?.length ?? 0} candidate(s) considered</summary>`;
  const pre = document.createElement('pre');
  pre.className = 'raw';
  pre.textContent = JSON.stringify({ route, servedIdentity: served, telemetry }, null, 2);
  det.appendChild(pre);
  el.appendChild(det);
}

function renderOutcome(kind, payload) {
  $('empty')?.remove();
  const route = payload.route;
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const cls = kind === 'REFUSED' ? 'refused' : kind === 'ESCALATE' ? 'escalate' : 'capacity';

  const unmet = route.unmet ?? [];
  const table = unmet.length
    ? `<table><tr><th>requirement</th><th>required</th><th>actual</th></tr>` +
      unmet.map((u) => `<tr><td>${esc(u.requirement)}</td><td>${esc(u.required)}</td><td>${esc(u.actual)}</td></tr>`).join('') +
      `</table>`
    : '';

  const avail = route.available?.length
    ? `<table><tr><th>available identity</th><th>digest</th></tr>` +
      route.available.map((a) => `<tr><td>${esc(a.modelId)}</td><td>${esc(a.digest.slice(7, 27))}…</td></tr>`).join('') +
      `</table>`
    : '';

  wrap.innerHTML =
    `<div class="role">bokahli</div>` +
    `<div class="outcome ${cls === 'refused' ? 'refused' : ''}">` +
      `<h3><span class="pill ${cls}">${esc(kind)}</span> ${esc(route.reason ?? '')}</h3>` +
      `<p>${esc(route.detail ?? '')}</p>` +
      table + avail +
      (route.authorityNote ? `<p style="color:var(--muted);font-size:.78rem">${esc(route.authorityNote)}</p>` : '') +
      (route.leaseHolder ? `<p style="font-family:var(--mono);font-size:.74rem">lease holder: ${esc(route.leaseHolder.processName)} pid ${route.leaseHolder.pid} · ${route.leaseHolder.usedMiB} MiB</p>` : '') +
      `<details><summary>raw outcome</summary><pre class="raw">${esc(JSON.stringify(payload, null, 2))}</pre></details>` +
    `</div>`;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

function buildRoute() {
  const mode = modeEl.value;
  const requireQualified = $('requireQualified').checked;
  if (mode === 'AUTO') {
    return { mode: 'AUTO', taskClass: 'chat', requireQualified };
  }
  if (mode === 'PROFILE') {
    return {
      mode: 'PROFILE',
      requirements: {
        requiredCapabilities: ['chat'],
        minContextTokens: 4096,
        ...(requireQualified ? { requireQualified: true, requiredTaskClass: 'chat' } : {}),
      },
    };
  }
  // EXACT uses the catalog identity + digest the UI already holds. If the
  // catalog has not loaded, this deliberately sends an unknown identity so the
  // refusal path is visible rather than silently skipped.
  return {
    mode: 'EXACT',
    modelId: catalogEntry?.modelId ?? 'unknown-artifact',
    artifactDigest: catalogEntry?.digest ?? 'sha256:' + '0'.repeat(64),
  };
}

async function send() {
  const text = promptEl.value.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  promptEl.value = '';
  addMessage('user', text);
  history.push({ role: 'user', content: text });

  const el = addMessage('assistant', '');
  const body = el.querySelector('.body');
  body.classList.add('cursor');

  try {
    const res = await fetch('/v1/bokahli/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        route: buildRoute(),
        messages: history,
        maxTokens: Number($('maxTokens').value) || 512,
        temperature: Number($('temp').value),
        stream: true,
      }),
    });

    // Non-routed outcomes arrive as a single JSON document, not a stream.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('event-stream')) {
      const payload = await res.json();
      el.remove();
      history.pop();
      if (payload.outcome) renderOutcome(payload.outcome, payload);
      else renderOutcome('REFUSED', { route: { reason: payload.error?.code ?? 'ERROR', detail: payload.error?.message ?? 'request failed' } });
      return;
    }

    let acc = '';
    let served = null;
    let route = null;
    await readSse(res, (event, data) => {
      if (event === 'bokahli.identity') { served = data.servedIdentity; route = data.route; }
      else if (event === 'bokahli.delta') { acc += data.text; body.textContent = acc; log.scrollTop = log.scrollHeight; }
      else if (event === 'bokahli.done') {
        body.classList.remove('cursor');
        body.textContent = data.result?.content ?? acc;
        history.push({ role: 'assistant', content: body.textContent });
        renderMeta(el, route ?? data.route, data.telemetry, served ?? data.result.servedIdentity);
      } else if (event === 'bokahli.error') {
        body.classList.remove('cursor');
        body.textContent = acc || `[${data.code}] ${data.message}`;
      }
    });
  } catch (err) {
    body.classList.remove('cursor');
    body.textContent = `transport error: ${err.message}`;
  } finally {
    body.classList.remove('cursor');
    busy = false;
    sendBtn.disabled = false;
    promptEl.focus();
    refreshStatus();
  }
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { onEvent(event, JSON.parse(data)); } catch { /* ignore malformed frame */ }
    }
  }
}

// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

sendBtn.addEventListener('click', send);
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('clear').addEventListener('click', () => {
  history.length = 0;
  log.innerHTML = '<div class="empty" id="empty"><h1>Cleared.</h1><p>Conversation history reset.</p></div>';
});

refreshStatus();
setInterval(refreshStatus, 20000);
promptEl.focus();
