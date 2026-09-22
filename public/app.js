const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const money = (n) => '$' + fmt(n);
const cents = (p) => (Number(p) * 100).toFixed(0) + 'c';
const pct = (p) => (Number(p) * 100).toFixed(1) + '%';
const cls = (n) => (Number(n) > 0 ? 'pos' : Number(n) < 0 ? 'neg' : '');
const sign = (n) => (Number(n) > 0 ? '+' : '');

let nextScanAt = null;
let lastLogTs = 0;

async function poll() {
  try {
    const res = await fetch('/api/state');
    const s = await res.json();
    render(s);
    $('footStatus').innerHTML = `<span class="dot ${s.status === 'error' ? 'err' : ''}"></span>${s.running ? 'agent running' : 'agent paused'} · scan #${s.scanCount} · ${s.universeSize} markets tracked`;
  } catch (e) {
    $('footStatus').innerHTML = `<span class="dot err"></span>disconnected — ${e.message}`;
  }
}

function render(s) {
  // pills
  const mp = $('modePill'); mp.textContent = s.tradeMode; mp.className = 'pill ' + s.tradeMode;
  $('sourcePill').textContent = s.dataSource;

  // header stats
  const p = s.portfolio;
  $('headerStats').innerHTML = `
    <div class="hs"><b>${money(p.equity)}</b><small>equity</small></div>
    <div class="hs"><b class="${cls(p.totalPnl)}">${sign(p.totalPnl)}${money(p.totalPnl)}</b><small>total p&l</small></div>
    <div class="hs"><b class="${cls(p.returnPct)}">${sign(p.returnPct)}${p.returnPct}%</b><small>return</small></div>`;

  // KPIs
  $('kpis').innerHTML = [
    kpi('Equity', money(p.equity), `start ${money(p.startBankroll)}`),
    kpi('Cash', money(p.cash), `${p.openPositions} positions`),
    kpi('Unrealized', money(p.unrealizedPnl), 'mark-to-market', cls(p.unrealizedPnl)),
    kpi('Exposure', money(p.exposure), 'at risk'),
    kpi('Opportunities', s.opportunities.length, `edge ≥ ${(s.config.edgeThreshold * 100).toFixed(0)}%`),
    kpi('Risk rail', `${(s.config.kellyFraction * 100).toFixed(0)}% Kelly`, `≤ ${(s.config.maxPositionPct * 100).toFixed(0)}% equity/bet`),
  ].join('');

  // pipeline
  const order = ['BROWSER', 'RESEARCH', 'ANALYZE', 'DECIDE', 'EXECUTE'];
  const curPhase = s.log[0]?.phase;
  const curIdx = order.indexOf(curPhase);
  document.querySelectorAll('.stage').forEach((el) => {
    const i = order.indexOf(el.dataset.stage);
    el.classList.toggle('active', s.status === 'scanning' && i === curIdx);
    el.classList.toggle('done', s.status !== 'scanning' || i < curIdx);
  });
  $('loopPhase').textContent = s.status;
  nextScanAt = s.nextScanAt;

  // log
  const logEl = $('log');
  logEl.innerHTML = s.log.map((l) => {
    const t = new Date(l.ts).toLocaleTimeString('en-US', { hour12: false });
    return `<div class="line ${l.level}"><span class="t">${t}</span><span class="ph ${l.phase}">${l.phase}</span><span class="msg">${esc(l.message)}</span></div>`;
  }).join('');

  // opportunities
  $('oppHint').textContent = `${s.opportunities.length} live`;
  const ob = $('oppBody');
  if (!s.opportunities.length) {
    ob.innerHTML = `<tr><td colspan="7" class="empty">no markets above ${(s.config.edgeThreshold * 100).toFixed(0)}% edge right now — scanning…</td></tr>`;
  } else {
    ob.innerHTML = s.opportunities.slice(0, 30).map((o) => `
      <tr>
        <td class="q">${esc(o.question)}<small>${esc(o.category)}</small></td>
        <td><span class="side ${o.side}">${o.side === 'BUY_YES' ? 'YES' : 'NO'}</span></td>
        <td class="num">${cents(o.mid)}</td>
        <td class="num">${cents(o.fairEstimate)}</td>
        <td class="num edge-badge">${pct(o.edge)}</td>
        <td class="num">${sentBar(o.sentiment)}</td>
        <td class="num" title="${o.riskCapped ? 'Kelly ' + pct(o.kellyUsed) + ' capped by risk rail' : 'fractional Kelly ' + pct(o.kellyUsed)}">${money(o.sizeUsd)} ${o.riskCapped ? '<span class="cap">🛡</span>' : ''}<small>${pct(o.sizePctOfEquity)}</small></td>
      </tr>`).join('');
  }

  // positions
  $('posHint').textContent = `${s.positions.length} open`;
  const pb = $('posBody');
  if (!s.positions.length) {
    pb.innerHTML = `<tr><td colspan="6" class="empty">no open positions yet</td></tr>`;
  } else {
    pb.innerHTML = s.positions.map((x) => `
      <tr>
        <td class="q">${esc(x.question)}<small>${esc(x.category)}</small></td>
        <td><span class="side ${x.side}">${x.side === 'BUY_YES' ? 'YES' : 'NO'}</span></td>
        <td class="num">${x.shares}</td>
        <td class="num">${cents(x.avgPrice)}</td>
        <td class="num">${x.markPrice != null ? cents(x.markPrice) : '—'}</td>
        <td class="num ${cls(x.unrealizedPnl)}">${sign(x.unrealizedPnl)}${money(x.unrealizedPnl)}</td>
      </tr>`).join('');
  }

  // blotter
  $('tradeHint').textContent = `${p.totalTrades} total`;
  const tb = $('tradeBody');
  if (!s.trades.length) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">no fills yet</td></tr>`;
  } else {
    tb.innerHTML = s.trades.map((t) => `
      <tr>
        <td class="t">${new Date(t.ts).toLocaleTimeString('en-US', { hour12: false })}</td>
        <td><span class="side ${t.side}">${t.type} ${t.side === 'BUY_YES' ? 'YES' : 'NO'}</span></td>
        <td class="q">${esc(t.question)}</td>
        <td class="num">${cents(t.price)}</td>
        <td class="num">${money(t.cost)}</td>
        <td class="num edge-badge">${pct(t.edge)}</td>
      </tr>`).join('');
  }
}

function kpi(label, val, sub, klass = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="val ${klass}">${val}</div><div class="sub">${sub}</div></div>`;
}

function sentBar(s) {
  if (!s) return '—';
  const score = Number(s.score) || 0;
  const w = Math.abs(score) * 17;
  const color = score >= 0 ? 'var(--green)' : 'var(--red)';
  const style = score >= 0
    ? `left:50%;width:${w}px;background:${color}`
    : `right:50%;left:auto;width:${w}px;background:${color}`;
  return `<span class="sent" title="${s.posts} posts · ${s.bullish}↑ / ${s.bearish}↓"><span class="sbar"><i style="${style}"></i></span></span>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// countdown ticker
setInterval(() => {
  if (!nextScanAt) return;
  const ms = nextScanAt - Date.now();
  if (ms <= 0) { $('countdown').textContent = 'scanning soon…'; return; }
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  $('countdown').textContent = `next scan in ${m}:${String(s).padStart(2, '0')}`;
}, 1000);

// controls
$('scanBtn').onclick = async () => {
  $('scanBtn').textContent = 'scanning…';
  await fetch('/api/scan', { method: 'POST' });
  setTimeout(() => ($('scanBtn').textContent = 'Force scan'), 1500);
  poll();
};

let running = true;
$('toggleBtn').onclick = async () => {
  running = !running;
  await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: running ? 'start' : 'stop' }) });
  $('toggleBtn').textContent = running ? 'Pause' : 'Resume';
  poll();
};

poll();
setInterval(poll, 2000);
