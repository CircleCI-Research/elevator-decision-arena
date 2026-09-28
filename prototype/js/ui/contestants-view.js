/*
 * Contestants page: the registry of every policy that can take a lane.
 *
 * Decision models and deterministic algorithms are listed and recorded
 * separately (models by runtime, weights, prompt and sampling; algorithms by
 * source and code hash), but every one of them sees the same observation
 * and answers with the same action. Experiments choose from here.
 */
(function (EDA) {
  'use strict';

  const { SCHEMAS } = EDA.registry;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const ms = (s) => `${Math.round(s * 1000)} ms`;

  class ContestantsView {
    constructor(host, records, api) {
      this.host = host;
      this.records = records;
      this.api = api; // { use(cids), leaderboard() }
      this.kind = 'all';
      this.q = '';
      this.open = new Set(); // cards showing prompt / code
      this.renderedKey = null;
      host.innerHTML = `
        <header class="hx-head">
          <div>
            <h2>Contestants</h2>
            <p class="hx-sub">Every policy that can take a lane in an experiment. Models and algorithms are recorded differently, but all of them decide on the same terms.</p>
          </div>
          <div class="hx-tools">
            <label class="cst-search">${icon('list')}<span class="sr-only">Search contestants</span><input type="search" placeholder="Search name, version, family" data-r="q"></label>
            <div class="chips" role="group" aria-label="Kind">
              <button data-kind="all" class="on">All</button><button data-kind="model">Models</button><button data-kind="algorithm">Algorithms</button>
            </div>
          </div>
        </header>
        <details class="cst-contract">
          <summary>${icon('shield')}<b>Shared contract</b> <span class="hx-chip">${SCHEMAS.version}</span> <code>${SCHEMAS.hash}</code><small>the observation every contestant receives and the action it must return</small></summary>
          <div class="cst-schemas">
            <div><h4>Observation</h4><pre>${esc(JSON.stringify(SCHEMAS.observation, null, 2))}</pre></div>
            <div><h4>Action</h4><pre>${esc(JSON.stringify(SCHEMAS.action, null, 2))}</pre></div>
          </div>
          <p class="nx-note">${esc(SCHEMAS.note)} The safety layer vetoes unavailable cars and over-capacity departures for everyone.</p>
        </details>
        <div data-r="body"></div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.r.q.addEventListener('input', () => {
        this.q = this.r.q.value.trim().toLowerCase();
        this.render(true);
      });
      host.querySelectorAll('[data-kind]').forEach((b) =>
        b.addEventListener('click', () => {
          this.kind = b.dataset.kind;
          host.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
          this.render(true);
        })
      );
      this.r.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'use') this.api.use([b.dataset.cid]);
        else if (act === 'versions') this.api.use(b.dataset.cids.split(','));
        else if (act === 'pair') this.api.use(b.dataset.cids.split(','), { mode: 'measured', timeout: 1.5 });
        else if (act === 'board') this.api.leaderboard();
        else if (act === 'toggle') {
          if (this.open.has(b.dataset.cid)) this.open.delete(b.dataset.cid);
          else this.open.add(b.dataset.cid);
          this.render(true);
        }
      });
    }

    enter() {
      this.render(true);
    }

    // Head-to-head record across finished runs, per contestant.
    track() {
      const out = new Map();
      const seen = new Set();
      for (const r of this.records.records.filter((x) => x.status === 'done').sort((a, b) => a.createdAt - b.createdAt)) {
        if (seen.has(r.defHash)) continue; // replications count once
        seen.add(r.defHash);
        const lanes = r.contestants.map((c) => ({ cid: c.cid ?? `${c.id}@${c.version}`, t: r.results[c.key]?.finishedAt }));
        const best = Math.min(...lanes.map((l) => l.t));
        const firsts = lanes.filter((l) => Math.abs(l.t - best) < 0.05);
        for (const l of lanes) {
          const s = out.get(l.cid) ?? { runs: 0, w: 0, l: 0, t: 0, opponents: new Set(), scenarios: new Set() };
          s.runs++;
          if (firsts.length > 1 && firsts.includes(l)) s.t++;
          else if (firsts[0] === l && firsts.length === 1) s.w++;
          else s.l++;
          for (const o of lanes) if (o !== l) s.opponents.add(o.cid);
          s.scenarios.add(r.def.scenario);
          out.set(l.cid, s);
        }
      }
      return out;
    }

    render(force = false) {
      const k = `${this.records.version}|${this.kind}|${this.q}|${[...this.open].join(',')}`;
      if (!force && k === this.renderedKey) return;
      if (!force && this.host.contains(document.activeElement) && document.activeElement.matches('input')) return;
      this.renderedKey = k;
      const track = this.track();
      const all = EDA.registry.list();
      const match = (p) =>
        (this.kind === 'all' || p.kind === this.kind) &&
        (!this.q || [p.name, p.version, p.family, p.description, p.kind].join(' ').toLowerCase().includes(this.q));
      const groups = [
        ['model', 'Decision models', 'Live models, answering through the arena runner. Identified by endpoint, pinned model, encoding and limits.'],
        ['algorithm', 'Deterministic algorithms', 'Identified by their source and a hash of the code that runs. Same input, same choice.'],
      ];
      const html = groups
        .map(([kind, label, sub]) => {
          const list = all.filter((p) => p.kind === kind && match(p));
          if (!list.length) return '';
          return `
            <h3 class="lb-h">${label} <small>${list.length} · ${sub}</small></h3>
            <div class="cst-grid">${list.map((p) => this.card(p, track.get(p.cid), all)).join('')}</div>`;
        })
        .join('');
      this.r.body.innerHTML = html || `<div class="hx-empty">${icon('chip')}<p>No contestant matches “${esc(this.q)}”.</p></div>`;
    }

    card(p, t, all) {
      const versions = all.filter((x) => x.id === p.id);
      const others = versions.filter((x) => x.cid !== p.cid);
      // The contestant's setup facets, as they apply under default timing:
      // the same parts the setup check compares between two lanes.
      const fx = EDA.setup.effective(p);
      const L = p.params?.latency;
      const time = L ? `${ms(L.min)}–${ms(L.min + L.span)}${L.tail ? ` · ${Math.round(L.tail.p * 100)}% up to ${ms(L.min + L.span + L.tail.min + L.tail.span)}` : ''}` : '< 0.1 ms';
      const rows = [
        ...EDA.setup.FACETS.map((f) => [f.label, esc(fx[f.key]?.label ?? '—')]),
        ['Decision time', time],
        ...(p.kind === 'model' ? [['Prompt / encoding', `<code>${p.promptHash}</code>`], ['Config', `<code>${p.configHash}</code>`]] : [['Code hash', `<code>${p.codeHash}</code>`], ['Source', `<code class="wrap">${esc(p.source)}</code>`]]),
        ...(p.live
          ? [['Status', `<b class="${p.available ? 'v-ok' : 'v-bad'}">${p.available ? 'Available' : 'Offline'}</b> · ${esc(p.status)}`], ['Endpoint', `<code class="wrap">${esc(p.live.endpoint)}</code> · model <code>${esc(p.live.model)}</code>`]]
          : []),
      ];
      // A model from another family asked the same way: racing the two with a
      // shared timeout is a controlled comparison of the models.
      const peer =
        p.kind === 'model' && p.setup.interface.label.startsWith('System One')
          ? all.find((x) => x.id !== p.id && x.kind === 'model' && EDA.setup.check(p, x, { timing: { timeout: 1.5 } }).verdict === 'controlled')
          : null;
      const open = this.open.has(p.cid);
      const record = t
        ? `<span><b>${t.runs}</b> run${t.runs === 1 ? '' : 's'}</span><span>cleared first <b>${t.w}</b>–${t.l}${t.t ? `–${t.t}` : ''}</span><span>${t.opponents.size} opponent${t.opponents.size === 1 ? '' : 's'} · ${t.scenarios.size} scenario${t.scenarios.size === 1 ? '' : 's'}</span>`
        : '<span class="hx-muted">Not run yet</span>';
      return `
        <article class="lb-card cst-card" style="${EDA.registry.mark(p).style}">
          <header>
            <span class="cst-title">${EDA.registry.badge(p)}<b>${esc(p.name)}</b><span class="hx-chip">${esc(p.version)}</span></span>
            <span class="scn-kind ${p.kind === 'model' ? 'custom' : ''}">${p.live ? 'Live model' : p.kind === 'model' ? 'Model' : 'Algorithm'}</span>
          </header>
          <p class="scn-desc">${esc(p.description)}</p>
          <dl class="exp-def cst-prov">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}<dt>Contract</dt><dd><code>${SCHEMAS.hash}</code></dd></dl>
          <div class="cst-record">${record}</div>
          ${
            open
              ? `<pre class="cst-pre">${esc(p.kind === 'model' ? p.prompt : p.code)}</pre>`
              : ''
          }
          <footer>
            <button class="btn-ghost" data-act="toggle" data-cid="${p.cid}" aria-expanded="${open}">${icon(p.kind === 'model' ? 'info' : 'list')}${open ? 'Hide' : 'Show'} ${p.kind === 'model' ? (p.setup.interface.label.startsWith('System One') ? 'encoding' : 'prompt') : 'code'}</button>
            <span class="scn-actions">
              ${t ? `<button class="btn-ghost" data-act="board">${icon('trophy')}Leaderboard</button>` : ''}
              ${peer ? `<button class="btn-ghost" data-act="pair" data-cids="${p.cid},${peer.cid}" title="Controlled pairing: same encoding, shared 1.5 s timeout">${icon('check')}vs ${esc(peer.name)}</button>` : ''}
              ${others.length ? `<button class="btn-ghost" data-act="versions" data-cids="${p.cid},${others[0].cid}" title="Put ${esc(p.version)} and ${esc(others[0].version)} in lanes A and B">${icon('shuffle')}vs ${esc(others[0].version)}</button>` : ''}
              <button class="btn-new" data-act="use" data-cid="${p.cid}" ${p.live && !p.available ? 'disabled title="Offline"' : ''}>${icon('play')}Use</button>
            </span>
          </footer>
        </article>`;
    }
  }

  EDA.ContestantsView = ContestantsView;
})(window.EDA);
