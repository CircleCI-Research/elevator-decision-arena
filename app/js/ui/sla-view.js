/*
 * SLA lab page: pick an experiment family and a saved SLA version, see
 * whether each policy meets it under normal and failure conditions, how
 * sure we are, and which clause breaks first.
 */
(function (EDA) {
  'use strict';

  const { clock } = EDA.util;
  const { SlaStore, METRICS, CONDITIONS, evaluate, families } = EDA.sla;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

  function fmtVal(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    switch (unit) {
      case 'clock':
        return clock(v).replace(/\.\d$/, '');
      case 's':
        return `${Number(v.toFixed(1))} s`;
      case 'ms':
        return `${Math.round(v)} ms`;
      case 'Wh':
        return `${Number(v.toFixed(2))} Wh`;
      default:
        return String(Math.round(v * 100) / 100);
    }
  }

  const clauseText = (cl) => `${METRICS[cl.metric].label} ≤ ${fmtVal(cl.max, METRICS[cl.metric].unit)}`;

  const VERDICT = {
    'meets-proven': ['Meets', 'Demonstrated at 95% confidence', 'ok solid'],
    meets: ['Meets', 'Observed; not yet demonstrated', 'ok'],
    fails: ['Falls short', 'Observed; not yet conclusive', 'bad'],
    'fails-proven': ['Fails', 'Demonstrated at 95% confidence', 'bad solid'],
    insufficient: ['Not enough runs', '', 'na'],
  };

  class SlaView {
    constructor(host, recordsStore, api) {
      this.host = host;
      this.records = recordsStore;
      this.api = api; // { newBatch(def) }
      this.slas = new SlaStore();
      this.slaId = this.slas.items[0].id;
      this.fam = null;
      this.draft = null; // editing state; saved SLAs stay immutable
      this.renderedKey = null;
      host.innerHTML = `
        <header class="hx-head">
          <div>
            <h2>SLA lab</h2>
            <p class="hx-sub">Can each policy keep an operational promise, reliably, under normal and failure conditions?</p>
          </div>
          <div class="hx-tools">
            <label class="au-pick"><span class="sr-only">Experiment family</span><select data-r="fam"></select></label>
            <label class="au-pick"><span class="sr-only">SLA version</span><select data-r="sla"></select></label>
            <button class="btn-new" data-r="batch">${icon('bolt')}Run batch with fault pairs</button>
          </div>
        </header>
        <div data-r="body"></div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.r.fam.addEventListener('change', () => {
        this.fam = this.r.fam.value;
        this.render(true);
      });
      this.r.sla.addEventListener('change', () => {
        this.slaId = this.r.sla.value;
        this.draft = null;
        this.render(true);
      });
      this.r.batch.addEventListener('click', () => {
        const f = families(this.records.records).find((x) => x.key === this.fam);
        this.api.newBatch(f?.def ?? null);
      });
      this.r.body.addEventListener('click', (e) => this.onClick(e));
      this.r.body.addEventListener('input', (e) => this.onInput(e));
      this.r.body.addEventListener('change', (e) => this.onInput(e));
    }

    enter() {
      this.render(true);
    }

    // ── Editing (always produces a new version) ─────────────────────────

    onClick(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const sla = this.slas.get(this.slaId);
      if (act === 'edit') {
        this.draft = { name: sla.name, target: sla.target, minRuns: sla.minRuns, clauses: sla.clauses.map((c) => ({ ...c })) };
      } else if (act === 'new') {
        this.draft = { name: 'New SLA', target: 0.9, minRuns: 10, clauses: [{ metric: 'p95Wait', max: 60, when: 'both' }] };
      } else if (act === 'add') {
        this.draft.clauses.push({ metric: 'avgWait', max: 30, when: 'both' });
      } else if (act === 'del') {
        this.draft.clauses.splice(Number(b.dataset.i), 1);
      } else if (act === 'cancel') {
        this.draft = null;
      } else if (act === 'save') {
        if (!this.draft.clauses.length) return;
        const saved = this.slas.add(this.draft);
        this.slaId = saved.id;
        this.draft = null;
      } else if (act === 'remove') {
        this.slas.remove(sla.id);
        this.slaId = this.slas.items[0].id;
      } else return;
      this.render(true);
    }

    onInput(e) {
      if (!this.draft) return;
      const t = e.target;
      const i = t.dataset.i !== undefined ? Number(t.dataset.i) : null;
      const f = t.dataset.f;
      if (!f) return;
      if (f === 'name') this.draft.name = t.value.trim() || 'Untitled SLA';
      else if (f === 'target') this.draft.target = Number(t.value);
      else if (f === 'minRuns') this.draft.minRuns = Math.max(1, Math.floor(Number(t.value) || 1));
      else if (i !== null) {
        const cl = this.draft.clauses[i];
        if (f === 'metric') cl.metric = t.value;
        else if (f === 'when') cl.when = t.value;
        else if (f === 'max') cl.max = Number(t.value);
        if (e.type === 'change' && f === 'metric') this.render(true);
      }
    }

    // ── Render ──────────────────────────────────────────────────────────

    render(force = false) {
      const k = `${this.records.version}|${this.fam}|${this.slaId}|${this.draft ? 'draft' : ''}`;
      if (!force && k === this.renderedKey) return;
      if (!force && this.host.contains(document.activeElement) && document.activeElement.matches('input, select')) return; // don't yank focus mid-edit
      this.renderedKey = k;

      const fams = families(this.records.records);
      this.r.sla.innerHTML = this.slas.items.map((s) => `<option value="${s.id}">${esc(s.name)} · v${s.version}</option>`).join('');
      this.r.sla.value = this.slaId;
      if (!fams.length) {
        this.r.fam.innerHTML = '';
        this.r.body.innerHTML = `${this.definition()}<div class="hx-empty">${icon('target')}<p>No finished runs yet. Run a batch with fault pairs to evaluate this SLA under normal and failure conditions.</p></div>`;
        return;
      }
      if (!fams.some((f) => f.key === this.fam)) this.fam = fams[0].key;
      this.r.fam.innerHTML = fams.map((f) => `<option value="${esc(f.key)}">${esc(f.label)} · ${f.normal} normal · ${f.failure} failure</option>`).join('');
      this.r.fam.value = this.fam;

      const sla = this.slas.get(this.slaId);
      const res = evaluate(this.records.records, this.fam, sla);
      this.r.body.innerHTML = `
        ${this.definition()}
        <h3 class="lb-h">Verdict <small>a run meets the SLA only if every clause for its condition passes · target ${pct(sla.target)} of runs · at least ${sla.minRuns} runs</small></h3>
        ${this.matrix(res, sla)}
        <h3 class="lb-h">Clauses <small>every run is a dot · the line is the threshold · hollow dots failed</small></h3>
        ${this.clauses(res, sla)}
        <p class="lb-foot">${icon('info')}<span><b>Meets / Falls short</b> compares the observed compliance with the target once the minimum runs are in. <b>Demonstrated</b> means the 95% Wilson interval clears the target too; until then the page says how many more clean runs it would take. Saved SLAs are immutable: editing creates a new version, so thresholds can't move after results are seen. Numbers come from the simulated building; algorithms and live models make real decisions in it.</span></p>`;
    }

    definition() {
      if (this.draft) return this.editor();
      const s = this.slas.get(this.slaId);
      return `
        <section class="sla-def">
          <div class="sla-def-h">
            <div><b>${esc(s.name)}</b> <span class="hx-chip">v${s.version}</span> <code>${s.hash}</code><small>saved ${new Date(s.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · read-only</small></div>
            <div class="sla-def-a">
              <button class="btn-ghost" data-act="edit">${icon('restart')}Duplicate &amp; edit</button>
              <button class="btn-ghost" data-act="new">${icon('plus')}New SLA</button>
              ${this.slas.items.length > 1 ? `<button class="btn-ghost" data-act="remove">Remove</button>` : ''}
            </div>
          </div>
          <ul class="sla-clauses">
            ${s.clauses.map((c) => `<li><span class="sla-when w-${c.when}">${CONDITIONS[c.when]}</span>${esc(clauseText(c))}</li>`).join('')}
          </ul>
          <p class="nx-note">Target: met in at least ${pct(s.target)} of runs, judged after at least ${s.minRuns} runs per condition.</p>
        </section>`;
    }

    editor() {
      const d = this.draft;
      const metricOpts = (sel) => Object.entries(METRICS).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${m.label}</option>`).join('');
      const whenOpts = (sel) => Object.entries(CONDITIONS).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
      const unitHint = (m) => ({ s: 'seconds', clock: 'seconds of sim time', ms: 'milliseconds', Wh: 'Wh', count: 'count' })[METRICS[m].unit];
      return `
        <section class="sla-def editing">
          <div class="sla-def-h">
            <label class="sla-name">Name <input data-f="name" value="${esc(d.name)}"></label>
            <span class="lock-chip">${icon('lock')}Saving creates a new, read-only version</span>
          </div>
          <div class="sla-edit-rows">
            ${d.clauses
              .map(
                (c, i) => `
              <div class="sla-edit-row">
                <select data-f="metric" data-i="${i}" aria-label="Metric">${metricOpts(c.metric)}</select>
                <span class="sla-op">≤</span>
                <input type="number" min="0" step="any" data-f="max" data-i="${i}" value="${c.max}" aria-label="Threshold (${unitHint(c.metric)})"><small>${unitHint(c.metric)}</small>
                <select data-f="when" data-i="${i}" aria-label="Condition">${whenOpts(c.when)}</select>
                <button class="run-x show" data-act="del" data-i="${i}" aria-label="Remove clause">×</button>
              </div>`
              )
              .join('')}
          </div>
          <button class="btn-ghost" data-act="add">${icon('plus')}Add clause</button>
          <div class="sla-edit-foot">
            <label>Target <select data-f="target">${[0.8, 0.9, 0.95, 0.99].map((t) => `<option value="${t}" ${t === d.target ? 'selected' : ''}>${pct(t)} of runs</option>`).join('')}</select></label>
            <label>Minimum runs <input type="number" min="1" step="1" data-f="minRuns" value="${d.minRuns}"></label>
            <span class="sla-edit-a">
              <button class="btn-ghost" data-act="cancel">Cancel</button>
              <button class="btn-new" data-act="save">${icon('check')}Save version</button>
            </span>
          </div>
        </section>`;
    }

    badge(v, sla) {
      const [label, sub, cls] = VERDICT[v.code];
      let note = sub;
      if (v.code === 'insufficient') note = `${v.n} of ${sla.minRuns} runs so far`;
      else if (v.code === 'meets' && v.more != null) note = `Not yet demonstrated · about ${v.more} more clean run${v.more === 1 ? '' : 's'} to prove ${pct(sla.target)}`;
      return `<span class="sla-badge ${cls}">${label}</span><small class="sla-sub">${note}</small>`;
    }

    matrix(res, sla) {
      const row = (c) => {
        const cells = ['normal', 'failure']
          .map((cond) => {
            const cell = res.cells.find((x) => x.c.id === c.id && x.c.version === c.version && x.cond === cond);
            const v = cell.overall;
            const bar = v.n
              ? `<span class="sla-rate"><i style="transform:scaleX(${v.rate.toFixed(3)})"></i><em style="left:${(v.w.lo * 100).toFixed(1)}%;width:${((v.w.hi - v.w.lo) * 100).toFixed(1)}%"></em><b style="left:${(sla.target * 100).toFixed(1)}%"></b></span>`
              : '';
            return `
              <td class="sla-cell">
                <span class="sla-cell-cond">${cond === 'normal' ? 'Normal conditions' : 'Failure conditions'}</span>
                <div class="sla-cell-top">${this.badge(v, sla)}</div>
                <div class="sla-k"><b>${v.k}/${v.n}</b> runs met it · ${pct(v.rate)}${v.n ? ` <small>(95% CI ${pct(v.w.lo)}–${pct(v.w.hi)})</small>` : ''}</div>
                ${bar}
                ${cell.unmeasured ? `<small class="sla-sub">${cell.unmeasured} older run${cell.unmeasured === 1 ? '' : 's'} left out: decision time wasn't measured then</small>` : ''}
                ${cell.weakest ? `<p class="sla-weak">${icon('alert')}Breaks first on <b>${esc(clauseText(cell.weakest))}</b> · ${cell.weakest.verdict.k}/${cell.weakest.verdict.n}</p>` : v.n ? `<p class="sla-weak ok">${icon('check')}Every clause held in every run</p>` : ''}
              </td>`;
          })
          .join('');
        return `<tr style="${EDA.registry.mark(c).style}"><th class="lb-who">${EDA.registry.badge(c)}<b>${esc(c.name)}</b><small>${c.kind} · ${esc(c.version)}</small></th>${cells}</tr>`;
      };
      return `
        <div class="lb-overall-wrap">
          <table class="sla-matrix">
            <thead><tr><th>Contestant</th><th>Normal conditions <small>car fault off</small></th><th>Failure conditions <small>car fault on</small></th></tr></thead>
            <tbody>${res.contestants.map(row).join('')}</tbody>
          </table>
        </div>`;
    }

    clauses(res, sla) {
      return `<div class="sla-cl-grid">${sla.clauses
        .map((cl, i) => {
          const conds = cl.when === 'both' ? ['normal', 'failure'] : [cl.when];
          const unit = METRICS[cl.metric].unit;
          const lines = [];
          for (const c of res.contestants) {
            for (const cond of conds) {
              const cell = res.cells.find((x) => x.c.id === c.id && x.c.version === c.version && x.cond === cond);
              const cc = cell.clauses.find((x) => x.i === i);
              lines.push({ c, cond, cc });
            }
          }
          const vals = lines.flatMap((l) => l.cc.values.map((v) => v.v)).filter((v) => v != null && isFinite(v));
          const lo = Math.min(cl.max, ...vals);
          const hi = Math.max(cl.max, ...vals);
          const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
          const a = Math.max(0, lo - pad);
          const z = hi + pad;
          const x = (v) => (((v - a) / (z - a)) * 100).toFixed(2);
          const rows = lines
            .map(({ c, cond, cc }) => {
              const dots = cc.values
                .filter((v) => v.v != null)
                .map((v) => `<i class="${v.pass ? 'p' : 'f'}" style="left:${x(v.v)}%" title="Run ${v.run}: ${fmtVal(v.v, unit)}"></i>`)
                .join('');
              const vd = cc.verdict;
              return `
                <div class="sla-strip" style="${EDA.registry.mark(c).style}">
                  ${EDA.registry.badge(c)}
                  <span class="sla-cond">${cond === 'normal' ? 'Normal' : 'Failure'}</span>
                  <span class="sla-axis"><b style="left:${x(cl.max)}%"></b>${dots}</span>
                  <span class="sla-cnt ${vd.k === vd.n ? 'ok' : 'bad'}">${vd.k}/${vd.n}</span>
                </div>`;
            })
            .join('');
          return `
            <article class="lb-card">
              <header><b>${esc(clauseText(cl))}</b><span class="sla-when w-${cl.when}">${CONDITIONS[cl.when]}</span></header>
              <p class="lb-desc">axis ${fmtVal(a, unit)} – ${fmtVal(z, unit)}</p>
              ${rows}
            </article>`;
        })
        .join('')}</div>`;
    }
  }

  EDA.SlaView = SlaView;
})(window.EDA);
