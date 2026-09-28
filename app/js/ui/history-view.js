/*
 * Run history page: every run as an audit record — its definition, results
 * per contestant, how it was run, and whether reruns reproduced it.
 */
(function (EDA) {
  'use strict';

  const { clock, secs } = EDA.util;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const wallLabel = (s) => (s == null ? '—' : s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : clock(s));
  const wh = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} kWh` : `${x.toFixed(1)} Wh`);

  const STATUS = {
    running: ['Running', 'running'],
    done: ['Done', 'done'],
    stopped: ['Stopped', 'stopped'],
    interrupted: ['Interrupted', 'interrupted'],
  };
  const FILTERS = [
    ['all', 'All'],
    ['done', 'Finished'],
    ['running', 'Running'],
    ['incomplete', 'Incomplete'],
  ];

  function when(ts) {
    const d = new Date(ts);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? `Today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  function eventsShort(ev) {
    const on = [ev.heavy && 'heavy', ev.fault && 'fault', ev.spike && 'spike'].filter(Boolean);
    return on.length ? on.join(' · ') : 'no events';
  }

  function modeLabel(rec) {
    if (rec.modes.length > 1) return ['Mixed', 'mixed'];
    return rec.modes[0] === 'fast' ? ['Max speed', 'fast'] : ['Timeline', 'timeline'];
  }

  const ROWS = [
    ['Cleared at', (r) => (r.finishedAt == null ? '—' : clock(r.finishedAt))],
    ['Delivered', (r) => `${r.delivered} / ${r.total}`],
    ['Avg wait', (r) => secs(r.avgWait)],
    ['P95 wait', (r) => secs(r.p95Wait)],
    ['Longest wait', (r) => secs(r.longest)],
    ['Elevator energy', (r) => wh(r.energyWh)],
    ['Per passenger', (r) => (r.delivered ? wh(r.energyWh / r.delivered) : '—')],
    ['Recovered (regen)', (r) => wh(r.regenWh)],
    ['Empty travel', (r) => `${r.emptyFloors.toFixed(0)} fl`],
    ['Decisions', (r) => String(r.decisions)],
    ['Avg decision time', (r) => (r.avgLatency == null ? '—' : r.avgLatency < 1e-4 ? '< 0.1 ms' : `${Math.round(r.avgLatency * 1000)} ms`)],
    ['Decision energy', (r) => (r.remoteDecisions ? 'remote · n/a' : r.decisionWh < 0.01 ? '< 0.01 Wh' : r.decisionWh < 1 ? `${r.decisionWh.toFixed(2)} Wh est.` : `${r.decisionWh.toFixed(1)} Wh est.`)],
    ['Safety vetoes', (r) => String(r.vetoes)],
    ['Fallback decisions', (r) => (r.fallbacks ? `${r.fallbacks} · ${Math.round((r.fallbacks / Math.max(1, r.decisions)) * 100)}%` : '0')],
    ['API cost', (r) => (r.apiCostUsd ? `$${r.apiCostUsd.toFixed(4)} · ${r.apiTokens.toLocaleString('en-US')} tokens` : r.apiTokens ? 'local · no charge' : '—')],
    ['Model drift', (r) => (r.drifted ? `${r.drifted} decision${r.drifted === 1 ? '' : 's'} answered by another model` : '—')],
  ];
  const timingText = (def) => EDA.scenario.timingTag(def.timing) ?? 'measured · own timeouts';

  // Metrics for comparison: label, value getter, format, and which way is better.
  const CMP = [
    ['Cleared at', (r) => r.finishedAt, 'clock', 'low'],
    ['Delivered', (r) => r.delivered, 'count', 'high'],
    ['Avg wait', (r) => r.avgWait, 'secs', 'low'],
    ['P95 wait', (r) => r.p95Wait, 'secs', 'low'],
    ['Longest wait', (r) => r.longest, 'secs', 'low'],
    ['Elevator energy', (r) => r.energyWh, 'wh', 'low'],
    ['Per passenger', (r) => (r.delivered ? r.energyWh / r.delivered : null), 'wh', 'low'],
    ['Recovered (regen)', (r) => r.regenWh, 'wh', 'high'],
    ['Empty travel', (r) => r.emptyFloors, 'fl', 'low'],
    ['Decisions', (r) => r.decisions, 'count', null],
    ['Avg decision time', (r) => r.avgLatency, 'ms', 'low'],
    ['Decision energy', (r) => (r.remoteDecisions ? null : r.decisionWh), 'wh', 'low'],
    ['Safety vetoes', (r) => r.vetoes, 'count', 'low'],
    ['Fallback decisions', (r) => r.fallbacks ?? 0, 'count', 'low'],
  ];

  function fmtValue(v, fmt) {
    if (v == null || !isFinite(v)) return '<span class="hx-muted">—</span>';
    switch (fmt) {
      case 'clock':
        return clock(v);
      case 'secs':
        return secs(v);
      case 'wh':
        return wh(v);
      case 'fl':
        return `${v.toFixed(0)} fl`;
      case 'ms':
        return v < 1e-4 ? '< 0.1 ms' : `${Math.round(v * 1000)} ms`;
      case 'wall':
        return wallLabel(v);
      default:
        return String(Math.round(v * 100) / 100);
    }
  }

  function fmtDelta(d, fmt) {
    const sign = d > 0 ? '+' : '−';
    const a = Math.abs(d);
    switch (fmt) {
      case 'clock':
      case 'secs':
        return `${sign}${a.toFixed(1)} s`;
      case 'wh':
        return a >= 1000 ? `${sign}${(a / 1000).toFixed(2)} kWh` : `${sign}${a.toFixed(1)} Wh`;
      case 'fl':
        return `${sign}${a.toFixed(0)} fl`;
      case 'ms':
        return `${sign}${Math.round(a * 1000)} ms`;
      case 'wall':
        return `${sign}${wallLabel(a)}`;
      default:
        return `${sign}${Math.round(a * 100) / 100}`;
    }
  }

  function delta(a, b, fmt, better) {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return { text: '—', cls: 'na' };
    const d = b - a;
    // Below what the unit can display, a change reads as "same".
    const EPS = { ms: 5e-4, wh: 0.05, secs: 0.05, clock: 0.05, fl: 0.5, wall: 5e-4 };
    const tiny = Math.abs(d) < (EPS[fmt] ?? 1e-6);
    if (tiny) return { text: 'same', cls: 'same' };
    const pct = Math.abs(a) > 1e-9 ? ` <small>${d > 0 ? '+' : '−'}${Math.abs((d / a) * 100).toFixed(Math.abs(d / a) < 0.1 ? 1 : 0)}%</small>` : '';
    const good = better === 'low' ? d < 0 : better === 'high' ? d > 0 : null;
    return { text: `${fmtDelta(d, fmt)}${pct}`, cls: good === null ? 'neutral' : good ? 'better' : 'worse' };
  }

  const cidOf = (c) => c.cid ?? `${c.id}@${c.version}`;
  const laneOf = (r, c) => r.contestants.find((x) => cidOf(x) === cidOf(c))?.key ?? null;
  const resultOf = (r, c) => (laneOf(r, c) ? r.results[laneOf(r, c)] : null);
  // Everyone who appears in either run, baseline order first.
  function bothSides(x, y) {
    const out = [...x.contestants];
    for (const c of y.contestants) if (!out.some((o) => cidOf(o) === cidOf(c))) out.push(c);
    return out;
  }

  class HistoryView {
    constructor(host, store, api) {
      this.host = host;
      this.store = store;
      this.api = api; // { live(id) -> run|null, open(id), rerun(def), stop(id) }
      this.filter = 'all';
      this.open = new Set();
      this.picked = []; // up to two record ids, in the order they were ticked
      this.comparing = null; // [baselineId, otherId] while the comparison is shown
      this.renderedKey = null;
      this.confirmClear = 0;
      host.innerHTML = `
        <header class="hx-head">
          <div>
            <h2>Run history</h2>
            <p class="hx-sub" data-r="sub"></p>
          </div>
          <div class="hx-tools">
            <div class="chips" role="group" aria-label="Filter runs">
              ${FILTERS.map(([k, l]) => `<button data-f="${k}" class="${k === 'all' ? 'on' : ''}">${l}</button>`).join('')}
            </div>
            <button class="btn-ghost" data-r="clear">Clear history</button>
          </div>
        </header>
        <div class="hx-selbar" data-r="selbar" hidden></div>
        <div class="hx-compare" data-r="compare" hidden></div>
        <div class="hx-list" data-r="list" role="list"></div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      host.querySelectorAll('[data-f]').forEach((b) =>
        b.addEventListener('click', () => {
          this.filter = b.dataset.f;
          host.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b));
          this.render(true);
        })
      );
      this.r.clear.addEventListener('click', () => this.clear());
      this.r.list.addEventListener('click', (e) => this.onClick(e));
      this.r.list.addEventListener('change', (e) => {
        const box = e.target.closest('[data-pick]');
        if (box) this.pick(Number(box.dataset.pick), box.checked);
      });
      this.r.selbar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sel]');
        if (!b) return;
        if (b.dataset.sel === 'compare' && this.picked.length === 2) this.comparing = [...this.picked];
        else if (b.dataset.sel === 'clear') this.picked = [];
        this.render(true);
      });
      this.r.compare.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cmp]');
        if (!b) return;
        const act = b.dataset.cmp;
        if (act === 'back') this.comparing = null;
        else if (act === 'swap') this.comparing.reverse();
        else if (act === 'open') this.api.open(Number(b.dataset.id));
        else if (act === 'audit') this.api.audit(Number(b.dataset.id));
        this.render(true);
        if (act === 'back' || act === 'swap') this.host.scrollIntoView({ block: 'start' });
      });
    }

    pick(id, on) {
      this.picked = this.picked.filter((x) => x !== id);
      if (on) this.picked.push(id);
      this.picked = this.picked.slice(-2);
      this.render(true);
    }

    // Two picked runs; the first one ticked is the baseline.
    enterCompare(ids) {
      this.picked = ids.slice(0, 2);
      this.comparing = ids.length === 2 ? [...ids] : null;
      this.render(true);
    }

    clear() {
      const now = Date.now();
      if (now - this.confirmClear > 3000) {
        this.confirmClear = now;
        this.r.clear.textContent = 'Click again to clear';
        this.r.clear.classList.add('danger');
        setTimeout(() => {
          this.r.clear.textContent = 'Clear history';
          this.r.clear.classList.remove('danger');
        }, 3000);
        return;
      }
      this.confirmClear = 0;
      this.api.clear();
      this.render(true);
    }

    onClick(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = Number(b.dataset.id);
      const act = b.dataset.act;
      if (act === 'toggle') {
        if (this.open.has(id)) this.open.delete(id);
        else this.open.add(id);
        this.render(true);
      } else if (act === 'open') this.api.open(id);
      else if (act === 'rerun') this.api.rerun(this.store.get(id));
      else if (act === 'audit') this.api.audit(id);
      else if (act === 'remove') {
        this.api.remove(id);
        this.open.delete(id);
        this.render(true);
      }
    }

    visible() {
      return this.store.records
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((r) => {
          if (this.filter === 'all') return true;
          if (this.filter === 'incomplete') return r.status === 'stopped' || r.status === 'interrupted';
          return r.status === this.filter;
        });
    }

    render(force = false) {
      const recs = this.visible();
      const key = `${this.store.version}|${this.filter}|${[...this.open].join(',')}|${this.picked.join(',')}|${this.comparing ?? ''}`;
      if (!force && key === this.renderedKey) return;
      this.renderedKey = key;

      // Drop picks whose records were removed.
      this.picked = this.picked.filter((id) => this.store.get(id));
      if (this.comparing && !this.comparing.every((id) => this.store.get(id))) this.comparing = null;
      const cmp = !!this.comparing;
      this.r.compare.hidden = !cmp;
      this.r.list.hidden = cmp;
      this.host.querySelector('.hx-tools').hidden = cmp;
      this.renderSelbar(cmp);
      if (cmp) {
        this.r.compare.innerHTML = this.compareView(this.store.get(this.comparing[0]), this.store.get(this.comparing[1]));
        return;
      }

      const all = this.store.records;
      const done = all.filter((r) => r.status === 'done').length;
      this.r.sub.innerHTML = `${all.length} run${all.length === 1 ? '' : 's'} · ${done} finished${
        this.store.persistent ? ' · saved in this browser' : ' · <b>browser storage unavailable — history lasts for this page only</b>'
      }`;

      if (!recs.length) {
        this.r.list.innerHTML = `<div class="hx-empty">${icon('history')}<p>${all.length ? 'No runs match this filter.' : 'No runs yet. Launch one from the Arena.'}</p></div>`;
        return;
      }
      this.r.list.innerHTML = recs.map((r) => this.row(r)).join('');
    }

    row(r) {
      const [statusText, statusCls] = STATUS[r.status] ?? STATUS.interrupted;
      const [modeText, modeCls] = modeLabel(r);
      const live = this.api.live(r.id);
      const A = r.results.A;
      const B = r.results.B;
      const progress = r.status === 'running' ? ` ${Math.floor(((A.delivered + B.delivered) / (A.total + B.total)) * 100)}%` : '';
      const rep = this.store.replication(r);
      const repHtml =
        r.status !== 'done'
          ? '<span class="hx-rep none">—</span>'
          : !rep.peers.length
            ? '<span class="hx-rep none" title="No other finished run with this definition yet">Not rerun</span>'
            : rep.disagree
              ? `<span class="hx-rep bad" title="Same definition, different results">${icon('alert')}Mismatch</span>`
              : `<span class="hx-rep ok" title="Reproduced by ${rep.agree} other run${rep.agree > 1 ? 's' : ''}">${icon('check')}Replicated ×${rep.agree}</span>`;

      let result = '<span class="hx-muted">—</span>';
      if (r.winner) {
        const gap = Math.abs((A.finishedAt ?? 0) - (B.finishedAt ?? 0));
        const w = r.contestants.find((c) => c.key === r.winner);
        result =
          r.winner === 'tie'
            ? '<b>Dead heat</b>'
            : `<span class="lane lane-${r.winner}">${r.winner}</span><b>${esc(w.name)}</b> <span class="hx-muted">by ${secs(gap)}</span>`;
      }
      const times = `A ${A.finishedAt == null ? '…' : clock(A.finishedAt)} · B ${B.finishedAt == null ? '…' : clock(B.finishedAt)}`;
      const walls = r.modes.length > 1 ? 'mixed modes' : r.modes[0] === 'fast' && r.status === 'done' ? `A ${wallLabel(A.wall)} · B ${wallLabel(B.wall)}` : '—';
      const expanded = this.open.has(r.id);
      const picked = this.picked.includes(r.id);
      const pickTitle = picked ? 'Selected for comparison' : this.picked.length === 2 ? 'Replaces the older selection' : 'Select to compare';

      return `
        <article class="hx-row${expanded ? ' open' : ''}${picked ? ' picked' : ''}" role="listitem">
          <div class="hx-top">
          <label class="hx-pick" title="${pickTitle}">
            <input type="checkbox" data-pick="${r.id}" ${picked ? 'checked' : ''}>
            <span class="sr-only">Select Run ${r.id} to compare</span>
            ${picked ? `<b class="hx-pick-n">${this.picked.indexOf(r.id) === 0 ? 'Base' : 'vs'}</b>` : ''}
          </label>
          <button class="hx-main" data-act="toggle" data-id="${r.id}" aria-expanded="${expanded}">
            <span class="hx-id"><b>Run ${r.id}</b><small>${when(r.createdAt)}</small></span>
            <span class="hx-def"><b>${r.def.floors} × ${r.def.cars} ${EDA.setupView.chip(EDA.setup.ofRecord(r))}</b><small>${esc(r.def.scenario)} · seed ${r.def.seed} · ${eventsShort(r.def.events)}</small></span>
            <span class="hx-chip m-${modeCls}">${modeText}</span>
            <span class="hx-chip s-${statusCls}">${statusText}${progress}</span>
            <span class="hx-result">${result}<small>${times}</small></span>
            <span class="hx-wall"><small>Wall-clock</small>${walls}</span>
            ${repHtml}
            <svg class="ico hx-chev" aria-hidden="true"><use href="#i-arrow"/></svg>
          </button>
          </div>
          ${expanded ? this.detail(r, live, rep) : ''}
        </article>`;
    }

    // ── Comparison ──────────────────────────────────────────────────────

    renderSelbar(comparing) {
      const bar = this.r.selbar;
      const n = this.picked.length;
      bar.hidden = comparing || n === 0;
      if (bar.hidden) return;
      const names = this.picked.map((id, i) => `<b>Run ${id}</b>${i === 0 ? ' <small>baseline</small>' : ''}`).join(' vs ');
      bar.innerHTML = `
        <span>${names}${n === 1 ? ' <small>· pick one more run to compare</small>' : ''}</span>
        <span class="hx-selbar-actions">
          <button class="btn-ghost" data-sel="clear">Clear</button>
          <button class="btn-new" data-sel="compare" ${n === 2 ? '' : 'disabled'}>${icon('shuffle')}Compare</button>
        </span>`;
    }

    compareView(x, y) {
      const same = x.defHash === y.defHash;
      const bothDone = x.status === 'done' && y.status === 'done';
      let verdict;
      if (same && bothDone) {
        verdict =
          x.fingerprint === y.fingerprint
            ? `<p class="cx-note ok">${icon('check')}<span><b>Same experiment, same results.</b> Both runs share definition <code>${x.defHash}</code> and result fingerprint <code>${x.fingerprint}</code>: Run ${y.id} replicates Run ${x.id}.</span></p>`
            : `<p class="cx-note bad">${icon('alert')}<span><b>Same experiment, different results.</b> Definition <code>${x.defHash}</code> is shared but the fingerprints differ (<code>${x.fingerprint}</code> vs <code>${y.fingerprint}</code>). Audit both run files to find where they diverge.</span></p>`;
      } else if (same) {
        verdict = `<p class="cx-note">${icon('clock')}<span><b>Same experiment.</b> Results can be compared as a replication once both runs finish.</span></p>`;
      } else {
        verdict = `<p class="cx-note">${icon('info')}<span><b>Different experiments.</b> Differences below reflect both the change in definition and the policies' behaviour.</span></p>`;
      }
      return `
        <div class="cx-head">
          <button class="btn-ghost" data-cmp="back">${icon('arrow')}Back to runs</button>
          <h3>Run ${x.id} <small>baseline</small> vs Run ${y.id}</h3>
          <button class="btn-ghost" data-cmp="swap">${icon('shuffle')}Swap</button>
        </div>
        <div class="cx-cards">${this.runCard(x, 'Baseline')}${this.runCard(y, 'Compared')}</div>
        ${verdict}
        <section class="cx-sec">
          <h4>Definition</h4>
          ${this.defDiff(x, y)}
        </section>
        <section class="cx-sec">
          <h4>Results <small>change vs Run ${x.id}; green is better, red is worse</small></h4>
          <div class="cx-results">${bothSides(x, y).map((c) => this.resultsTable(c, x, y)).join('')}</div>
        </section>
        <section class="cx-sec">
          <h4>Waiting over sim time <small>solid Run ${x.id} · dashed Run ${y.id}</small></h4>
          <div class="cx-trends">${bothSides(x, y).map((c) => this.trendPair(c, x, y)).join('')}</div>
        </section>`;
    }

    runCard(r, role) {
      const [statusText, statusCls] = STATUS[r.status] ?? STATUS.interrupted;
      const [modeText, modeCls] = modeLabel(r);
      const A = r.results.A;
      const B = r.results.B;
      let result = '<span class="hx-muted">No winner yet</span>';
      if (r.winner === 'tie') result = '<b>Dead heat</b>';
      else if (r.winner) {
        const w = r.contestants.find((c) => c.key === r.winner);
        result = `<span class="lane lane-${r.winner}">${r.winner}</span><b>${esc(w.name)}</b> clears first by ${secs(Math.abs((A.finishedAt ?? 0) - (B.finishedAt ?? 0)))}`;
      }
      const live = this.api.live(r.id);
      return `
        <article class="cx-card">
          <div class="cx-card-h"><small>${role}</small><b>Run ${r.id}</b><span class="hx-chip s-${statusCls}">${statusText}</span><span class="hx-chip m-${modeCls}">${modeText}</span></div>
          <p>${esc(r.def.scenario)} · ${r.def.floors} floors × ${r.def.cars} cars · seed ${r.def.seed} · ${eventsShort(r.def.events)}</p>
          <p class="cx-winner">${result}</p>
          <div class="cx-card-a">
            ${live ? `<button class="btn-ghost" data-cmp="open" data-id="${r.id}">${icon('building')}Arena</button>` : ''}
            ${this.api.hasAudit(r.id) ? `<button class="btn-ghost" data-cmp="audit" data-id="${r.id}">${icon('shield')}Audit</button>` : ''}
          </div>
        </article>`;
    }

    defDiff(x, y) {
      const versions = (r) => r.contestants.map((c) => `${c.key} ${c.name} ${c.version}`).join(' · ');
      const rows = [
        ['Scenario', (r) => `${esc(r.def.scenario)}${r.def.scenarioVersion ? ` v${r.def.scenarioVersion}` : ''}`],
        ['Building', (r) => `${r.def.floors} × ${r.def.cars}`],
        ['Passengers', (r) => String(r.def.passengers)],
        ['Seed', (r) => String(r.def.seed)],
        ['Scripted events', (r) => eventsShort(r.def.events)],
        ['Contestants', versions],
        ['Decision timing', (r) => timingText(r.def)],
        ['Setup check', (r) => EDA.setup.ofRecord(r)?.short ?? '—'],
        ['Simulator', (r) => EDA.history.simName(r.sim)],
        ['Run modes', (r) => r.modes.map((m) => (m === 'fast' ? 'max speed' : 'timeline')).join(' → '), 'wall-clock only'],
        ['Definition hash', (r) => `<code>${r.defHash}</code>`],
      ];
      const diffs = rows.filter(([, f]) => f(x) !== f(y)).length;
      return `
        <table class="cx-table cx-def">
          <thead><tr><th></th><th>Run ${x.id}</th><th>Run ${y.id}</th></tr></thead>
          <tbody>
            ${rows
              .map(([label, f, note]) => {
                const a = f(x);
                const b = f(y);
                const d = a !== b;
                return `<tr class="${d ? 'diff' : 'same'}"><th>${label}${note ? ` <small>${note}</small>` : ''}</th><td>${a}</td><td>${b}${d ? ' <span class="cx-changed">changed</span>' : ''}</td></tr>`;
              })
              .join('')}
          </tbody>
        </table>
        <p class="nx-note">${diffs ? `${diffs} field${diffs > 1 ? 's' : ''} differ. Only the ones without a note can change simulated results.` : 'Identical definitions.'}</p>`;
    }

    // Contestants are matched by identity, not lane: lane A may be a
    // different policy in each run, or missing from one of them.
    resultsTable(c, x, y) {
      const rx = resultOf(x, c) ?? {};
      const ry = resultOf(y, c) ?? {};
      const pureFast = (r) => r.modes.length === 1 && r.modes[0] === 'fast' && r.status === 'done';
      const rows = CMP.map(([label, get, fmt, better]) => [label, get(rx, x), get(ry, y), fmt, better]);
      rows.push(['Wall-clock', pureFast(x) ? rx.wall : null, pureFast(y) ? ry.wall : null, 'wall', 'low']);
      return `
        <table class="cx-table cx-res">
          <caption>${EDA.registry.badge(c)}${esc(c.name)} <small>${c.kind} · ${esc(c.version)}${!laneOf(x, c) ? ` · not in Run ${x.id}` : !laneOf(y, c) ? ` · not in Run ${y.id}` : ''}</small></caption>
          <thead><tr><th></th><th>Run ${x.id}</th><th>Run ${y.id}</th><th>Change</th></tr></thead>
          <tbody>
            ${rows
              .map(([label, a, b, fmt, better]) => {
                const d = delta(a, b, fmt, better);
                return `<tr><th>${label}</th><td>${fmtValue(a, fmt)}</td><td>${fmtValue(b, fmt)}</td><td class="cx-d ${d.cls}">${d.text}</td></tr>`;
              })
              .join('')}
          </tbody>
        </table>`;
    }

    trendPair(c, x, y) {
      const a = laneOf(x, c) ? x.series[laneOf(x, c)] ?? [] : [];
      const b = laneOf(y, c) ? y.series[laneOf(y, c)] ?? [] : [];
      if (a.length < 2 && b.length < 2) return `<div class="cx-trend"><p class="hx-muted">No trend data yet.</p></div>`;
      const span = Math.max(60, ...[a, b].filter((p) => p.length).map((p) => p[p.length - 1][0]));
      const peak = Math.max(1, ...a.map((p) => p[1]), ...b.map((p) => p[1]));
      const path = (pts) => pts.map(([t, w], i) => `${i ? 'L' : 'M'}${((t / span) * 400).toFixed(1)} ${(78 - (w / peak) * 72).toFixed(1)}`).join('');
      return `
        <div class="cx-trend" style="${EDA.registry.mark(c).style}">
          <div class="cx-trend-h">${EDA.registry.badge(c)}${esc(c.name)}<small>peak ${peak} · ${clock(span).slice(0, 5)}</small></div>
          <svg viewBox="0 0 400 80" preserveAspectRatio="none" role="img" aria-label="${esc(c.name)}: waiting over time, Run ${x.id} solid and Run ${y.id} dashed">
            ${a.length > 1 ? `<path class="cx-line base" d="${path(a)}"/>` : ''}
            ${b.length > 1 ? `<path class="cx-line other" d="${path(b)}"/>` : ''}
          </svg>
        </div>`;
    }

    // Full facet comparison for the record's two lanes, read-only.
    setupPanel(r) {
      const [a, b] = ['A', 'B'].map((k) => r.contestants.find((c) => c.key === k));
      if (!a || !b) return '';
      const check = EDA.setup.check(a, b, r.def);
      return `<h3>Setup check</h3>${EDA.setupView.panel(check, a, b, { actions: false })}`;
    }

    detail(r, live, rep) {
      const defRows = [
        ['Scenario', r.def.scenario],
        ['Building', `${r.def.floors} floors × ${r.def.cars} cars`],
        ['Passengers', String(r.def.passengers)],
        ['Seed', String(r.def.seed)],
        ['Scripted events', eventsShort(r.def.events)],
        ['Decision timing', timingText(r.def)],
        ['Run modes', r.modes.map((m) => (m === 'fast' ? 'max speed' : 'timeline')).join(' → ')],
        ['Simulator', EDA.history.simName(r.sim)],
        ['Definition hash', `<code>${r.defHash}</code>`],
        ['Result fingerprint', r.fingerprint ? `<code>${r.fingerprint}</code>` : '—'],
      ];
      const who = r.contestants
        .map((c) => {
          // Models and algorithms carry different provenance.
          const prov = c.model
            ? `${esc(c.model.runtime)} · prompt <code>${c.model.promptHash}</code> · config <code>${c.model.configHash}</code>`
            : c.algorithm
              ? `${esc(c.algorithm.source)} · code <code>${c.algorithm.codeHash}</code>`
              : esc(c.identity ?? '');
          return `<div class="hx-who"><span class="lane lane-${c.key}">${c.key}</span><b>${esc(c.name)}</b><small>${c.kind} · ${esc(c.version)}</small><small class="hx-prov">${prov}</small></div>`;
        })
        .join('');
      const table = `
        <table class="hx-table">
          <thead><tr><th></th>${r.contestants.map((c) => `<th><span class="lane lane-${c.key}">${c.key}</span></th>`).join('')}</tr></thead>
          <tbody>
            ${ROWS.map(([label, f]) => `<tr><th>${label}</th>${r.contestants.map((c) => `<td>${f(r.results[c.key])}</td>`).join('')}</tr>`).join('')}
            <tr><th>Wall-clock</th>${r.contestants
              .map((c) => `<td>${r.modes.length > 1 ? 'mixed' : r.modes[0] === 'fast' ? wallLabel(r.results[c.key].wall) : 'timeline run'}</td>`)
              .join('')}</tr>
          </tbody>
        </table>`;
      const peers = rep.peers.length
        ? `<p class="hx-peers">${icon(rep.disagree ? 'alert' : 'check')}Same definition as ${rep.peers
            .map((p) => `Run ${p.id} (${p.fingerprint === r.fingerprint ? 'identical' : 'different'})`)
            .join(', ')}.</p>`
        : '';
      return `
        <div class="hx-detail">
          <div class="hx-col">
            <h3>Definition</h3>
            <dl class="exp-def">${defRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
            <h3>Contestants</h3>
            ${who}
            ${this.setupPanel(r)}
          </div>
          <div class="hx-col">
            <h3>Results</h3>
            ${table}
            <h3>Waiting over sim time</h3>
            ${this.trend(r)}
            ${peers}
          </div>
          <div class="hx-actions">
            ${live ? `<button class="btn-new" data-act="open" data-id="${r.id}">${icon('building')}Open in Arena</button>` : ''}
            ${this.api.hasAudit(r.id) ? `<button class="btn-ghost" data-act="audit" data-id="${r.id}">${icon('shield')}Audit &amp; replay</button>` : ''}
            <button class="${live ? 'btn-ghost' : 'btn-new'}" data-act="rerun" data-id="${r.id}">${icon('restart')}Rerun same definition</button>
            <button class="btn-ghost" data-act="remove" data-id="${r.id}">${live ? 'Remove record' : 'Remove'}</button>
          </div>
        </div>`;
    }

    trend(r) {
      const lanes = r.contestants.map((c) => ({ key: c.key, pts: r.series[c.key] ?? [] })).filter((l) => l.pts.length > 1);
      if (!lanes.length) return '<p class="hx-muted">Not enough data yet.</p>';
      const span = Math.max(60, ...lanes.map((l) => l.pts[l.pts.length - 1][0]));
      const peak = Math.max(1, ...lanes.flatMap((l) => l.pts.map((p) => p[1])));
      const path = (pts) => pts.map(([t, w], i) => `${i ? 'L' : 'M'}${((t / span) * 400).toFixed(1)} ${(78 - (w / peak) * 72).toFixed(1)}`).join('');
      return `
        <svg class="hx-trend" viewBox="0 0 400 80" preserveAspectRatio="none" role="img" aria-label="Waiting passengers over sim time, peak ${peak}">
          ${lanes.map((l) => `<path class="hx-line lane-${l.key}" d="${path(l.pts)}"/>`).join('')}
        </svg>
        <div class="hx-legend">${lanes.map((l) => `<span><i class="lane-${l.key}"></i>${l.key}</span>`).join('')}<span class="hx-muted">peak ${peak} · ${clock(span).slice(0, 5)}</span></div>`;
    }
  }

  EDA.HistoryView = HistoryView;
})(window.EDA);
