/*
 * Shared HUD: timeline, race, scoreboard, active incidents and event feed.
 */
(function (EDA) {
  'use strict';

  const { clock, secs } = EDA.util;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const wallLabel = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : clock(s));
  const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const ICON = {
    call: 'dot', dup: 'dot', assign: 'arrow', reassign: 'shuffle', hold: 'hold', stale: 'clock', veto: 'lock',
    deliver: 'check', 'step-off': 'users', overload: 'weight', 'overload-clear': 'check', malfunction: 'alert',
    out: 'wrench', repair: 'wrench', finish: 'flag', scenario: 'flag', inject: 'bolt', timeout: 'clock', fallback: 'alert',
  };
  const INCIDENT = new Set(['overload', 'overload-clear', 'malfunction', 'out', 'repair', 'reassign', 'veto', 'finish', 'scenario', 'inject']);
  const DECISION = new Set(['assign', 'reassign', 'hold', 'stale', 'veto', 'timeout', 'fallback']);
  const TL_ICON = { overload: 'weight', malfunction: 'alert', out: 'wrench', repair: 'wrench', veto: 'lock', finish: 'flag' };

  // ── Timeline ─────────────────────────────────────────────────────────

  class Timeline {
    constructor(host, contestants, markers) {
      host.innerHTML = `
        <div class="tl-head">
          <span class="card-k">Scenario timeline</span>
          <span class="tl-hint"><i class="tl-hint-tick"></i> passenger delivered, colored by destination <span class="sep">·</span> ${icon('alert')} incident <span class="sep">·</span> dashed line scripted or injected event</span>
        </div>
        <div class="tl-body">
          <div class="tl-labels"><span></span>${contestants.map((c) => `<span class="lane lane-${c.key}">${c.key}</span>`).join('')}</div>
          <div class="tl-plot">
            <div class="tl-ruler"></div>
            ${contestants.map((c) => `<div class="tl-lane lane-${c.key}" data-lane="${c.key}"><i class="tl-lane-head"></i></div>`).join('')}
            <div class="tl-marks"></div>
            <div class="tl-play"><span></span></div>
          </div>
        </div>`;
      this.ruler = host.querySelector('.tl-ruler');
      this.marks = host.querySelector('.tl-marks');
      this.play = host.querySelector('.tl-play');
      this.playT = this.play.querySelector('span');
      this.lanes = {};
      this.heads = {};
      host.querySelectorAll('.tl-lane').forEach((n) => {
        this.lanes[n.dataset.lane] = n;
        this.heads[n.dataset.lane] = n.querySelector('.tl-lane-head');
      });
      this.domain = 120;
      this.items = [];
      this.drawRuler();
      markers.forEach((m) => this.addMarker(m));
    }

    place(node, t) {
      node.style.left = `${((t / this.domain) * 100).toFixed(3)}%`;
    }

    track(node, t) {
      this.items.push({ node, t });
      this.place(node, t);
    }

    drawRuler() {
      let html = '';
      const tick = this.domain <= 180 ? 15 : this.domain <= 600 ? 60 : 120;
      for (let s = 0; s <= this.domain; s += tick) html += `<span style="left:${(s / this.domain) * 100}%">${clock(s).slice(0, 5)}</span>`;
      this.ruler.innerHTML = html;
    }

    addMarker(m) {
      const n = document.createElement('div');
      n.className = `tl-mark k-${m.kind}`;
      n.innerHTML = `<span>${esc(m.label)}</span>`;
      n.title = `${clock(m.t)} · ${m.label}`;
      this.marks.appendChild(n);
      this.track(n, m.t);
    }

    onEvent(ev) {
      const lane = this.lanes[ev.b];
      if (!lane) return;
      if (ev.type === 'deliver') {
        const n = document.createElement('i');
        n.className = 'tl-tick';
        n.style.background = `var(--f${ev.dest})`;
        lane.appendChild(n);
        this.track(n, ev.t);
      } else if (TL_ICON[ev.type]) {
        const n = document.createElement('span');
        n.className = `tl-ev t-${ev.type}`;
        n.title = `${clock(ev.t)} · ${ev.text}`;
        n.innerHTML = icon(TL_ICON[ev.type]);
        lane.appendChild(n);
        this.track(n, ev.t);
      }
    }

    // Each lane has its own head: at max speed the runs advance independently.
    update(worlds) {
      const t = Math.max(...worlds.map((w) => w.t));
      if (t > this.domain - 6) {
        this.domain = Math.ceil((t + 30) / 30) * 30;
        this.drawRuler();
        for (const it of this.items) this.place(it.node, it.t);
      }
      this.place(this.play, t);
      this.playT.textContent = clock(t).slice(0, 5);
      for (const w of worlds) this.place(this.heads[w.id], w.t);
    }
  }

  // ── Race ─────────────────────────────────────────────────────────────

  class Race {
    constructor(host, contestants) {
      this.contestants = contestants;
      host.innerHTML = `
        <div class="card-h"><span class="card-k">First to clear the wave</span><span class="tag-soft" title="The building and its traffic are simulated; the decisions are real">simulated</span></div>
        <div class="race-rows">
          ${contestants
            .map(
              (c) => `
            <div class="race-row lane-${c.key}" data-k="${c.key}">
              <span class="lane">${c.key}</span>
              <div class="race-main">
                <div class="race-name">${esc(c.policy.name)} <small>${c.policy.kind === 'model' ? 'model' : 'algorithm'}</small></div>
                <div class="track"><i></i></div>
              </div>
              <div class="race-n"><b>0</b><span>/0</span><small></small></div>
            </div>`
            )
            .join('')}
        </div>
        <div class="race-result" data-r="result">Same passengers, same seed, same instant — only the policy differs.</div>`;
      this.rows = [...host.querySelectorAll('.race-row')].map((n) => ({
        n,
        bar: n.querySelector('.track i'),
        done: n.querySelector('.race-n b'),
        total: n.querySelector('.race-n span'),
        wall: n.querySelector('.race-n small'),
      }));
      this.result = host.querySelector('[data-r=result]');
      this.resultKey = null;
    }

    update(sums) {
      sums.forEach((s, i) => {
        const r = this.rows[i];
        r.bar.style.transform = `scaleX(${s.total ? (s.delivered / s.total).toFixed(4) : 0})`;
        r.done.textContent = s.finishedAt !== null ? clock(s.finishedAt) : s.delivered;
        r.total.textContent = s.finishedAt !== null ? '' : `/${s.total}`;
        r.wall.textContent = s.fast && s.finishedAt !== null ? `computed in ${wallLabel(s.wall)}` : '';
        r.n.classList.toggle('done', s.finishedAt !== null);
      });
      const fin = sums.map((s, i) => ({ s, c: this.contestants[i] })).filter((x) => x.s.finishedAt !== null);
      const key = fin.map((x) => x.c.key + x.s.finishedAt).join('|');
      if (key === this.resultKey) return;
      this.resultKey = key;
      this.rows.forEach((r) => r.n.classList.remove('winner'));
      if (fin.length === 0) return;
      fin.sort((a, b) => a.s.finishedAt - b.s.finishedAt);
      const w = fin[0];
      this.rows[this.contestants.indexOf(w.c)].n.classList.add('winner');
      if (fin.length < sums.length) {
        this.result.innerHTML = `${icon('flag')}<b>${w.c.key} · ${esc(w.c.policy.name)}</b> cleared at ${clock(w.s.finishedAt)} — the other building is still serving its wave.`;
      } else {
        const gap = fin[1].s.finishedAt - w.s.finishedAt;
        this.result.innerHTML =
          gap < 0.05
            ? `${icon('flag')}Dead heat at ${clock(w.s.finishedAt)}.`
            : `${icon('flag')}<b>${w.c.key} · ${esc(w.c.policy.name)}</b> clears the wave first, by <b>${secs(gap)}</b> of sim time. One seeded run — not a ranking.`;
      }
      this.result.classList.add('show');
    }
  }

  // ── Scoreboard ───────────────────────────────────────────────────────

  const wh = (x, d = 1) => `${x.toFixed(d)} Wh`;

  const METRICS = [
    { group: 'Service' },
    { label: 'Delivered', v: (s) => s.delivered, f: (s) => `${s.delivered}/${s.total}`, better: 'high' },
    { label: 'Avg wait', v: (s) => s.avgWait, f: (s) => secs(s.avgWait), better: 'low' },
    { label: 'P95 wait', v: (s) => s.p95Wait, f: (s) => secs(s.p95Wait), better: 'low' },
    { label: 'Longest wait', v: (s) => s.longest, f: (s) => secs(s.longest), better: 'low' },
    { label: 'Waiting now', v: (s) => s.waiting, f: (s) => String(s.waiting), better: 'low' },
    { group: 'Elevator energy', note: 'simplified physics' },
    { label: 'Net energy', v: (s) => s.energyWh, f: (s) => wh(s.energyWh), better: 'low' },
    { label: 'Per passenger', v: (s) => (s.delivered ? s.energyWh / s.delivered : null), f: (s) => (s.delivered ? wh(s.energyWh / s.delivered, 2) : '—'), better: 'low' },
    { label: 'Recovered (regen)', v: (s) => s.regenWh, f: (s) => wh(s.regenWh), better: 'high' },
    { label: 'Empty travel', v: (s) => s.emptyFloors, f: (s) => `${s.emptyFloors.toFixed(1)} fl`, better: 'low' },
    { group: 'Decision cost', note: 'scored separately' },
    { label: 'Decisions', v: (s) => s.decisions, f: (s) => String(s.decisions), better: null },
    { label: 'Avg decision time', v: (s) => s.decTime, f: (s) => (s.decTime == null ? '—' : EDA.util.decTime(s.decTime)), better: 'low' },
    {
      label: 'Decision energy',
      v: (s) => (s.remoteDecisions ? null : s.decisionWh), // remote inference can't be compared
      f: (s) => (s.remoteDecisions ? 'remote · n/a' : s.decisionWh < 0.01 ? '< 0.01 Wh' : s.decisionWh < 1 ? `${s.decisionWh.toFixed(2)} Wh est.` : `${wh(s.decisionWh)} est.`),
      better: 'low',
    },
    // Measured from each API response's token usage; local models cost nothing here.
    { label: 'API cost', v: () => null, f: (s) => (s.apiCostUsd ? `$${s.apiCostUsd.toFixed(4)} · ${(s.apiTokens / 1000).toFixed(1)}k tok` : s.apiTokens ? 'local · no charge' : '—'), better: null },
    { label: 'Fallback decisions', v: (s) => s.fallbacks, f: (s) => String(s.fallbacks ?? 0), better: 'low' },
    { label: 'Safety vetoes', v: (s) => s.vetoes, f: (s) => String(s.vetoes), better: 'low' },
    {
      label: 'Wall-clock to result',
      v: (s) => (s.fast && s.finishedAt !== null ? s.wall : null),
      f: (s) => (s.mixed ? 'mixed modes' : !s.fast ? 'max speed only' : s.finishedAt !== null ? wallLabel(s.wall) : '…'),
      better: 'low',
    },
  ];

  class Scoreboard {
    constructor(host, contestants) {
      const head = contestants.map((c) => `<th><span class="lane lane-${c.key}">${c.key}</span></th>`).join('');
      const body = METRICS.map((m) =>
        m.group
          ? `<tr class="grp"><th colspan="${contestants.length + 1}">${m.group}${m.note ? ` <small>${m.note}</small>` : ''}</th></tr>`
          : `<tr><th>${m.label}</th>${contestants.map(() => '<td>—</td>').join('')}</tr>`
      ).join('');
      host.innerHTML = `
        <div class="card-h"><span class="card-k">Scoreboard</span><span class="tag-soft" title="Measured in the simulated building">simulated</span></div>
        <table class="score-t"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
      const rows = [...host.querySelectorAll('tbody tr:not(.grp)')];
      this.metrics = METRICS.filter((m) => !m.group).map((m, i) => ({ ...m, cells: [...rows[i].querySelectorAll('td')] }));
    }

    update(sums) {
      for (const m of this.metrics) {
        const vals = sums.map(m.v);
        let lead = -1;
        if (m.better && vals.every((v) => v != null) && new Set(vals).size > 1) {
          const best = m.better === 'high' ? Math.max(...vals) : Math.min(...vals);
          lead = vals.indexOf(best);
        }
        m.cells.forEach((td, i) => {
          const text = m.f(sums[i]);
          if (td.textContent !== text) td.textContent = text;
          td.classList.toggle('lead', i === lead);
        });
      }
    }
  }

  // ── Active incidents ─────────────────────────────────────────────────

  const MODE_LABEL = { overload: 'overloaded', malfunction: 'malfunctioning', out: 'out of service' };
  const MODE_ICON = { overload: 'weight', malfunction: 'alert', out: 'wrench' };

  class Incidents {
    constructor(host) {
      host.innerHTML = `<div class="card-h"><span class="card-k">Active incidents</span><span class="inc-n" data-r="n"></span></div><div class="inc-list" data-r="list"></div>`;
      this.list = host.querySelector('[data-r=list]');
      this.n = host.querySelector('[data-r=n]');
      this.key = null;
    }

    update(worlds) {
      const items = [];
      for (const w of worlds) {
        for (const c of w.cars) if (c.mode !== 'normal') items.push({ lane: w.id, mode: c.mode, text: `Car ${c.idx + 1} ${MODE_LABEL[c.mode]}` });
        const d = w.decisions;
        if (d.active && w.t - d.active.startT > 0.9) items.push({ lane: w.id, mode: 'slow', text: 'Decision taking > 0.9 s' });
      }
      const key = items.map((i) => i.lane + i.mode + i.text).join('|');
      if (key === this.key) return;
      this.key = key;
      this.n.textContent = items.length ? String(items.length) : '';
      this.list.innerHTML = items.length
        ? items.map((i) => `<span class="inc m-${i.mode}"><span class="lane lane-${i.lane}">${i.lane}</span>${icon(MODE_ICON[i.mode] ?? 'clock')}${esc(i.text)}</span>`).join('')
        : `<span class="inc-empty">${icon('check')}All cars operating normally</span>`;
    }
  }

  // ── Event feed ───────────────────────────────────────────────────────

  class Feed {
    constructor(host) {
      host.innerHTML = `
        <div class="card-h">
          <span class="card-k">Event feed</span>
          <div class="chips" role="group" aria-label="Filter events">
            <button data-f="all" class="on">All</button><button data-f="dec">Decisions</button><button data-f="inc">Incidents</button>
          </div>
        </div>
        <ol class="feed-list" data-f="all"></ol>`;
      this.list = host.querySelector('.feed-list');
      host.querySelectorAll('.chips button').forEach((b) =>
        b.addEventListener('click', () => {
          host.querySelectorAll('.chips button').forEach((x) => x.classList.toggle('on', x === b));
          this.list.dataset.f = b.dataset.f;
        })
      );
    }

    push(ev) {
      const li = document.createElement('li');
      li.className = `ev sev-${ev.sev}${INCIDENT.has(ev.type) ? ' is-inc' : ''}${DECISION.has(ev.type) ? ' is-dec' : ''}`;
      const lane = ev.b === 'both' ? 'A+B' : ev.b;
      li.innerHTML = `<span class="ev-t">${clock(ev.t).slice(0, 5)}</span><span class="lane lane-${ev.b}">${lane}</span>${icon(ICON[ev.type] ?? 'dot', 'ico ev-i')}<span class="ev-x">${esc(ev.text)}</span>`;
      this.list.prepend(li);
      while (this.list.childElementCount > 160) this.list.lastElementChild.remove();
    }
  }

  // ── Composition ──────────────────────────────────────────────────────

  class Hud {
    constructor(hosts, worlds, contestants, markers) {
      this.worlds = worlds;
      this.timeline = new Timeline(hosts.timeline, contestants, markers);
      this.race = new Race(hosts.race, contestants);
      this.score = new Scoreboard(hosts.score, contestants);
      this.incidents = new Incidents(hosts.incidents);
      this.feed = new Feed(hosts.feed);
      this.lastSlow = -Infinity;
    }

    onEvent(ev) {
      // At max speed thousands of low-level events arrive per second; only
      // the ones that matter reach the feed.
      if (!this.quiet || ev.sev !== 'low') this.feed.push(ev);
      this.timeline.onEvent(ev);
    }

    addMarker(m) {
      this.timeline.addMarker(m);
    }

    update(force = false) {
      this.timeline.update(this.worlds);
      const now = performance.now();
      if (!force && now - this.lastSlow < 250) return;
      this.lastSlow = now;
      const sums = this.worlds.map((w) => w.summary());
      this.race.update(sums);
      this.score.update(sums);
      this.incidents.update(this.worlds);
    }
  }

  EDA.Hud = Hud;
})(window.EDA);
