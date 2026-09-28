/*
 * Leaderboard page: one experiment family at a time, overall standing plus
 * a card per category with means, 95% intervals and separability.
 */
(function (EDA) {
  'use strict';

  const { clock } = EDA.util;
  const { families, board } = EDA.leaderboard;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const ORD = ['1st', '2nd', '3rd'];

  function fmt(v, f) {
    if (v == null || !isFinite(v)) return '—';
    switch (f) {
      case 'clock':
        return clock(v);
      case 'secs':
        return `${v.toFixed(1)} s`;
      case 'pct':
        return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
      case 'ms':
        return v < 1e-4 ? '< 0.1 ms' : `${Math.round(v * 1000)} ms`;
      case 'wh':
        return v < 0.01 ? '< 0.01 Wh' : `${v.toFixed(v < 10 ? 2 : 1)} Wh`;
      case 'fl':
        return `${v.toFixed(2)} fl`;
      default:
        return v.toFixed(2);
    }
  }

  function fmtHalf(h, f) {
    if (h == null) return '';
    switch (f) {
      case 'clock':
      case 'secs':
        return `± ${h.toFixed(1)} s`;
      case 'pct':
        return `± ${h.toFixed(1)} pt`;
      case 'ms':
        return h < 1e-4 ? '' : `± ${Math.round(h * 1000)} ms`;
      case 'wh':
        return h < 0.01 ? '' : `± ${h.toFixed(2)}`;
      case 'fl':
        return `± ${h.toFixed(2)}`;
      default:
        return `± ${h.toFixed(2)}`;
    }
  }

  class LeaderboardView {
    constructor(host, store, api) {
      this.host = host;
      this.store = store;
      this.api = api; // { newBatch(def), batches() }
      this.key = null;
      this.controlledOnly = false; // rank only runs whose lanes were a controlled comparison
      this.renderedKey = null;
      host.innerHTML = `
        <header class="hx-head">
          <div>
            <h2>Leaderboard</h2>
            <p class="hx-sub">Rankings per experiment family: same scenario, building and events, different seeds. Each category is ranked on its own.</p>
          </div>
          <div class="hx-tools">
            <div class="chips" role="group" aria-label="Which runs to rank">
              <button data-ctl="all" class="on">All runs</button><button data-ctl="controlled" title="Only runs where exactly one thing differed between the lanes">Controlled only</button>
            </div>
            <label class="au-pick"><span class="sr-only">Experiment family</span><select data-r="fam"></select></label>
            <button class="btn-new" data-r="batch">${icon('bolt')}Run benchmark batch</button>
          </div>
        </header>
        <div data-r="body"></div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.r.fam.addEventListener('change', () => {
        this.key = this.r.fam.value;
        this.render(true);
      });
      host.querySelectorAll('[data-ctl]').forEach((b) =>
        b.addEventListener('click', () => {
          this.controlledOnly = b.dataset.ctl === 'controlled';
          host.querySelectorAll('[data-ctl]').forEach((x) => x.classList.toggle('on', x === b));
          this.render(true);
        })
      );
      this.r.batch.addEventListener('click', () => {
        const f = families(this.store.records).find((x) => x.key === this.key);
        this.api.newBatch(f?.def ?? null);
      });
    }

    enter(key) {
      if (key) this.key = key;
      this.render(true);
    }

    render(force = false) {
      const batches = this.api.batches();
      const k = `${this.store.version}|${this.key}|${this.controlledOnly}|${batches.map((b) => `${b.id}:${b.done}`).join(',')}`;
      if (!force && k === this.renderedKey) return;
      this.renderedKey = k;

      const records = this.records();
      const hidden = this.store.records.filter((r) => r.status === 'done').length - records.filter((r) => r.status === 'done').length;
      const hiddenNote = this.controlledOnly && hidden
        ? `<p class="lb-foot">${icon('shuffle')}<span>${hidden} setup-comparison run${hidden === 1 ? '' : 's'} hidden: their lanes differed in more than one part of the setup, so they compare whole setups rather than one thing.</span></p>`
        : '';
      const fams = families(records);
      if (!fams.length) {
        this.r.fam.innerHTML = '';
        this.r.body.innerHTML = `<div class="hx-empty">${icon('trophy')}<p>${this.controlledOnly && hidden ? 'No controlled comparisons yet.' : 'No finished runs yet.'} Run a benchmark batch to get rankings with confidence intervals.</p></div>${hiddenNote}${this.batchStrip(batches)}`;
        return;
      }
      // A batch that just started has no finished runs yet: wait for it
      // rather than jumping to another family.
      const pending = batches.find((x) => x.family === this.key && x.done < x.total);
      if (!fams.some((f) => f.key === this.key) && pending) {
        this.r.fam.innerHTML = `<option value="${esc(this.key)}">${esc(pending.label)} · waiting for the first run</option>${fams
          .map((f) => `<option value="${esc(f.key)}">${esc(f.label)} · ${f.n} run${f.n === 1 ? '' : 's'}</option>`)
          .join('')}`;
        this.r.fam.value = this.key;
        this.r.body.innerHTML = `${this.batchStrip(batches)}<div class="hx-empty">${icon('clock')}<p>Batch ${pending.id} is running. Rankings appear as its runs finish.</p></div>`;
        return;
      }
      if (!fams.some((f) => f.key === this.key)) this.key = fams[0].key;
      this.r.fam.innerHTML = fams.map((f) => `<option value="${esc(f.key)}">${esc(f.label)} · ${f.n} run${f.n === 1 ? '' : 's'}</option>`).join('');
      this.r.fam.value = this.key;
      const b = board(records, this.key);
      this.r.body.innerHTML = `
        ${this.batchStrip(batches)}
        ${hiddenNote}
        ${this.sample(b)}
        ${this.overall(b)}
        <h3 class="lb-h">Categories <small>mean ± 95% confidence interval across seeds</small></h3>
        <div class="lb-grid">${b.categories.filter((c) => c.overall).map((c) => this.card(c, b)).join('')}</div>
        <h3 class="lb-h">More metrics <small>shown, not used in the overall standing</small></h3>
        <div class="lb-grid">${b.categories.filter((c) => !c.overall).map((c) => this.card(c, b)).join('')}</div>
        <p class="lb-foot">${icon('info')}<span>Overall = average rank across ${b.scored.length ? b.scored.join(', ') : 'the headline categories'} (equal weights; a category counts once two contestants have data in it). Contestants with fewer than ${EDA.leaderboard.MIN_RUNS} runs are <b>provisional</b>: listed, never placed. “Not separable” means the 95% intervals overlap: more seeds are needed before calling a leader. Numbers come from the simulated building; algorithms and live models make real decisions in it.</span></p>`;
    }

    records() {
      if (!this.controlledOnly) return this.store.records;
      return this.store.records.filter((r) => EDA.setup.ofRecord(r)?.verdict === 'controlled');
    }

    batchStrip(batches) {
      const live = batches.filter((x) => x.done < x.total);
      if (!live.length) return '';
      return live
        .map(
          (x) => `<div class="lb-batch"><span class="pulse-dot"></span><b>Batch ${x.id}</b><span>${esc(x.label)}</span><span class="lb-batch-bar"><i style="transform:scaleX(${(x.done / x.total).toFixed(3)})"></i></span><span>${x.done} / ${x.total} runs</span></div>`
        )
        .join('');
    }

    sample(b) {
      const low = b.seeds < 5;
      return `
        <div class="lb-sample${low ? ' low' : ''}">
          <span><b>${b.n}</b> unique run${b.n === 1 ? '' : 's'} · <b>${b.seeds}</b> seed${b.seeds === 1 ? '' : 's'}</span>
          ${b.dupes ? `<span>${b.dupes} replication${b.dupes === 1 ? '' : 's'} counted once</span>` : ''}
          <span>${b.pairs ? `${b.pairs} fault / no-fault pair${b.pairs === 1 ? '' : 's'}` : 'no fault pairs yet'}</span>
          ${low ? `<span class="lb-warn">${icon('alert')}Fewer than 5 seeds: intervals are wide or missing</span>` : ''}
        </div>`;
    }

    overall(b) {
      const cats = b.categories.filter((c) => c.overall);
      const head = cats.map((c) => `<th title="${esc(c.desc)}">${c.label}</th>`).join('');
      const rows = b.overall
        .map((o) => {
          const cells = cats
            .map((cat) => {
              const row = cat.rows.find((r) => r.c.cid === o.c.cid);
              if (!cat.hasData || !row.s.n) return '<td class="lb-na">—</td>';
              const lead = cat.leader === o.c.cid;
              const tie = cat.leader === 'tie';
              return `<td class="${lead ? (cat.separable ? 'lead sep' : 'lead') : ''}${tie ? ' tie' : ''}">${lead ? (cat.separable ? icon('trophy') : '<i class="lb-dot"></i>') : ''}${fmt(row.s.mean, cat.fmt)}</td>`;
            })
            .join('');
          const w = o.wins;
          return `
            <tr class="${o.qualified ? '' : 'provisional'}">
              <td class="lb-place p${o.place ?? 'x'}">${o.place == null ? '—' : ORD[o.place - 1] ?? `${o.place}th`}</td>
              <th class="lb-who">${EDA.registry.badge(o.c)}<b>${esc(o.c.name)}</b><small>${o.c.kind} · ${esc(o.c.version)}</small></th>
              <td class="lb-runs">${o.n}${o.qualified ? '' : `<small>provisional</small>`}</td>
              <td class="lb-score">${o.avgRank == null ? '—' : o.avgRank.toFixed(2)}<small>${o.leads} lead${o.leads === 1 ? '' : 's'} · ${o.sepLeads} separable</small></td>
              <td class="lb-wins">${w.w}–${w.l}${w.t ? `–${w.t}` : ''}</td>
              ${cells}
            </tr>`;
        })
        .join('');
      return `
        <div class="lb-overall-wrap">
          <table class="lb-overall">
            <thead><tr><th></th><th>Contestant</th><th title="Unique runs this contestant took part in">Runs</th><th title="Average rank across the headline categories; lower is better">Avg rank</th><th title="Head to head: waves cleared first–second–tied">W–L–T</th>${head}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    card(cat, b) {
      const rows = cat.rows;
      // Versions matter: "Nearest-Car ETA" alone could be either one.
      const who = (cid) => {
        const c = rows.find((r) => r.c.cid === cid).c;
        return `${EDA.registry.badge(c)} ${esc(c.name)} ${esc(c.version)}`;
      };
      const withData = rows.filter((r) => r.s.n > 0);
      let body;
      if (!withData.length) {
        body =
          cat.key === 'resilience'
            ? `<p class="lb-empty">No fault / no-fault pairs yet. Run a batch with <b>fault pairs</b> to measure how much each policy slows down when a car fails.</p>`
            : '<p class="lb-empty">No data yet.</p>';
      } else {
        // Shared axis across contestants: intervals if any, else means.
        const lo = Math.min(...withData.map((r) => r.s.lo ?? r.s.mean));
        const hi = Math.max(...withData.map((r) => r.s.hi ?? r.s.mean));
        const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
        const a = lo - pad;
        const z = hi + pad;
        const x = (v) => `${(((v - a) / (z - a)) * 100).toFixed(2)}%`;
        body = rows
          .map((r) => {
            const s = r.s;
            const lead = cat.leader === r.c.cid;
            const bar =
              s.n === 0
                ? ''
                : `<span class="lb-ci" style="left:${x(s.lo ?? s.mean)};width:calc(${x(s.hi ?? s.mean)} - ${x(s.lo ?? s.mean)})"></span><span class="lb-mean" style="left:${x(s.mean)}"></span>`;
            return `
              <div class="lb-row${lead ? ' lead' : ''}" style="${EDA.registry.mark(r.c).style}">
                ${EDA.registry.badge(r.c)}
                <span class="lb-val"><b>${fmt(s.mean, cat.fmt)}</b><small>${s.n > 1 ? fmtHalf(s.half, cat.fmt) : s.n === 1 ? 'n = 1' : 'no data'}</small></span>
                <span class="lb-axis">${bar}</span>
              </div>`;
          })
          .join('');
      }
      const verdict = !cat.hasData
        ? ''
        : cat.leader === 'tie'
          ? '<span class="lb-v tie">Tied</span>'
          : cat.separable
            ? `<span class="lb-v sep">${icon('trophy')}${who(cat.leader)} leads</span>`
            : `<span class="lb-v">${who(cat.leader)} ahead · not separable</span>`;
      const n = Math.max(0, ...rows.map((r) => r.s.n));
      return `
        <article class="lb-card">
          <header><b>${cat.label}</b>${verdict}</header>
          <p class="lb-desc">${esc(cat.desc)} · ${cat.better === 'low' ? 'lower is better' : 'higher is better'} · n = ${n}</p>
          ${body}
        </article>`;
    }
  }

  EDA.LeaderboardView = LeaderboardView;
})(window.EDA);
