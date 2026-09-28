/*
 * Scenarios page: the catalog of traffic definitions, each with a preview of
 * the traffic it generates for a chosen building, what it stresses, how often
 * it has been run, and a way to start an experiment or batch with it.
 * Custom scenarios are created by duplicating one; saving makes a new,
 * read-only version.
 */
(function (EDA) {
  'use strict';

  const { makeConfig, buildScript, defaultEvents, eventLabels, scenarioKey, specHash, makeSpec } = EDA.scenario;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  const SIZES = [
    [6, 3],
    [12, 4],
    [24, 6],
    [60, 10],
  ];
  const PROFILES = { flat: 'Steady', peak: 'Peaked', burst: 'Burst' };
  const HOTSPOTS = { none: 'None', low: 'Low floor', middle: 'Middle floor', top: 'Top floor' };

  // Traffic a scenario generates for one building (seed fixed for previews).
  function sample(spec, floors, cars) {
    const cfg = makeConfig(floors, cars, { seed: 24301, events: defaultEvents(spec), scenario: spec });
    const script = buildScript(cfg);
    const a = script.arrivals;
    const up = a.filter((x) => x.origin === 0).length;
    const down = a.filter((x) => x.dest === 0).length;
    const heavy = a.filter((x) => x.accessory === 'cart').length;
    return { cfg, script, n: a.length, up, down, inter: a.length - up - down, heavy, end: Math.max(1, ...a.map((x) => x.t)) };
  }

  class ScenariosView {
    constructor(host, store, records, api) {
      this.host = host;
      this.store = store;
      this.records = records;
      this.api = api; // { use(spec), batch(spec) }
      this.size = 0;
      this.draft = null;
      this.renderedKey = null;
      host.innerHTML = `
        <header class="hx-head">
          <div>
            <h2>Scenarios</h2>
            <p class="hx-sub">The traffic an experiment runs. Every scenario is versioned and hashed, so a run always points at exactly the traffic it used.</p>
          </div>
          <div class="hx-tools">
            <div class="seg small" role="group" aria-label="Preview building" data-r="sizes">
              ${SIZES.map(([f, c], i) => `<button data-size="${i}" class="${i === 0 ? 'on' : ''}">${f} × ${c}</button>`).join('')}
            </div>
            <button class="btn-new" data-r="new">${icon('plus')}New scenario</button>
          </div>
        </header>
        <div data-r="editor"></div>
        <div class="scn-grid" data-r="grid"></div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.r.sizes.addEventListener('click', (e) => {
        const b = e.target.closest('[data-size]');
        if (!b) return;
        this.size = Number(b.dataset.size);
        this.r.sizes.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.render(true);
      });
      this.r.new.addEventListener('click', () => this.edit(this.store.get('normal'), 'My scenario'));
      this.r.grid.addEventListener('click', (e) => this.onClick(e));
      this.r.editor.addEventListener('click', (e) => this.onEditorClick(e));
      this.r.editor.addEventListener('input', (e) => this.onEditorInput(e));
      this.r.editor.addEventListener('change', (e) => this.onEditorInput(e));
    }

    enter() {
      this.render(true);
    }

    usage(spec) {
      const key = scenarioKey(spec);
      const recs = this.records.records.filter((r) => (r.def.scenarioKey ?? r.def.scenario) === key);
      return { runs: recs.length, done: recs.filter((r) => r.status === 'done').length };
    }

    onClick(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const spec = this.store.get(b.dataset.id);
      if (!spec) return;
      const act = b.dataset.act;
      if (act === 'use') this.api.use(spec);
      else if (act === 'batch') this.api.batch(spec);
      else if (act === 'edit') this.edit(spec, spec.name);
      else if (act === 'remove') {
        this.store.remove(spec.id);
        this.render(true);
      }
    }

    // ── Editor (saving makes a new, read-only version) ──────────────────

    edit(base, name) {
      const src = base.legacy ? this.store.get('normal') : base;
      this.draft = JSON.parse(JSON.stringify({ ...src, name, description: base.legacy ? 'Based on Normal traffic.' : src.description, stresses: [...(src.stresses ?? [])] }));
      delete this.draft.id;
      this.renderEditor();
      this.r.editor.scrollIntoView({ block: 'start' });
    }

    onEditorClick(e) {
      const b = e.target.closest('[data-ed]');
      if (!b) return;
      if (b.dataset.ed === 'cancel') this.draft = null;
      else if (b.dataset.ed === 'save') {
        const s = this.store.add(this.draft);
        this.draft = null;
        this.flash = s.id;
      }
      this.renderEditor();
      this.render(true);
    }

    onEditorInput(e) {
      if (!this.draft) return;
      const t = e.target;
      const f = t.dataset.f;
      if (!f) return;
      const d = this.draft;
      const num = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0));
      const v = t.type === 'checkbox' ? t.checked : t.value;
      const set = {
        name: () => (d.name = v.trim() || 'Untitled scenario'),
        description: () => (d.description = v),
        stresses: () => (d.stresses = v.split(',').map((x) => x.trim()).filter(Boolean)),
        profile: () => (d.profile = v),
        window: () => (d.window = num(v, 10, 600)),
        base: () => (d.base = num(v, 0, 200)),
        perFloor: () => (d.perFloor = num(v, 0, 20)),
        up: () => (d.shares.up = num(v, 0, 100) / 100),
        down: () => (d.shares.down = num(v, 0, 100) / 100),
        inter: () => (d.shares.inter = num(v, 0, 100) / 100),
        hotspot: () => (d.hotspot = v),
        hotspotShare: () => (d.hotspotShare = num(v, 0, 100) / 100),
        heavyShare: () => (d.heavyShare = num(v, 0, 100) / 100),
        pressAnyway: () => (d.pressAnyway = num(v, 0, 100) / 100),
        cluster: () => (d.cluster = Math.round(num(v, 1, 10))),
        heavyOn: () => (d.events.heavy.on = v),
        heavyAt: () => (d.events.heavy.at = num(v, 0, 100) / 100),
        heavySize: () => (d.events.heavy.size = Math.round(num(v, 1, 20))),
        heavyHeavy: () => (d.events.heavy.heavy = Math.round(num(v, 0, 20))),
        spikeOn: () => (d.events.spike.on = v),
        spikeAt: () => (d.events.spike.at = num(v, 0, 100) / 100),
        spikeSize: () => (d.events.spike.size = Math.round(num(v, 1, 60))),
        spikeFloor: () => (d.events.spike.floor = v),
        faultOn: () => (d.events.fault.on = v),
        faultCount: () => {
          const n = Number(v);
          const f = d.events.fault.faults;
          d.events.fault.faults = n === 2 ? [f[0], f[1] ?? { car: 'first', at: Math.min(0.9, f[0].at + 0.35), repair: f[0].repair }] : [f[0]];
          this.renderEditor();
        },
        fault0At: () => (d.events.fault.faults[0].at = num(v, 0, 100) / 100),
        fault1At: () => d.events.fault.faults[1] && (d.events.fault.faults[1].at = num(v, 0, 100) / 100),
        faultRepair: () => d.events.fault.faults.forEach((x) => (x.repair = Math.round(num(v, 5, 600)))),
      };
      set[f]?.();
      this.renderPreview();
    }

    renderEditor() {
      const d = this.draft;
      if (!d) {
        this.r.editor.innerHTML = '';
        return;
      }
      const E = d.events;
      const opt = (map, sel) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
      const field = (label, html, hint = '') => `<label class="scn-f"><span>${label}${hint ? ` <small>${hint}</small>` : ''}</span>${html}</label>`;
      const n = (f, val, attrs = '') => `<input type="number" data-f="${f}" value="${val}" ${attrs}>`;
      this.r.editor.innerHTML = `
        <section class="sla-def editing scn-editor">
          <div class="sla-def-h">
            <label class="sla-name">Name <input data-f="name" value="${esc(d.name)}"></label>
            <span class="lock-chip">${icon('lock')}Saving creates a new, read-only version</span>
          </div>
          <div class="scn-ed-grid">
            <fieldset>
              <legend>About</legend>
              ${field('Description', `<textarea data-f="description" rows="3">${esc(d.description ?? '')}</textarea>`)}
              ${field('Stresses', `<input data-f="stresses" value="${esc((d.stresses ?? []).join(', '))}">`, 'comma separated')}
            </fieldset>
            <fieldset>
              <legend>Arrivals</legend>
              ${field('Intensity', `<select data-f="profile">${opt(PROFILES, d.profile)}</select>`)}
              ${field('Window', n('window', d.window, 'min="10" step="5"'), 'seconds')}
              ${field('Passengers', `<span class="scn-inline">${n('base', d.base, 'min="0"')} + ${n('perFloor', d.perFloor, 'min="0" step="0.5"')} × floors</span>`)}
              ${field('Groups of', n('cluster', d.cluster, 'min="1" max="10"'), 'people arriving together')}
            </fieldset>
            <fieldset>
              <legend>Directions and destinations</legend>
              ${field('Up from lobby', n('up', Math.round(d.shares.up * 100), 'min="0" max="100"'), '%')}
              ${field('Down to lobby', n('down', Math.round(d.shares.down * 100), 'min="0" max="100"'), '%')}
              ${field('Between floors', n('inter', Math.round(d.shares.inter * 100), 'min="0" max="100"'), '%')}
              ${field('Hotspot floor', `<select data-f="hotspot">${opt(HOTSPOTS, d.hotspot)}</select>`)}
              ${field('Hotspot share', n('hotspotShare', Math.round(d.hotspotShare * 100), 'min="0" max="100"'), '% of trips')}
            </fieldset>
            <fieldset>
              <legend>Passengers</legend>
              ${field('Heavy share', n('heavyShare', Math.round(d.heavyShare * 100), 'min="0" max="100"'), '%, 110–140 kg with carts')}
              ${field('Press a lit button anyway', n('pressAnyway', Math.round(d.pressAnyway * 100), 'min="0" max="100"'), '%')}
            </fieldset>
            <fieldset>
              <legend>Scripted events <small>on = default in New experiment</small></legend>
              <div class="scn-ev"><label class="nx-check"><input type="checkbox" data-f="heavyOn" ${E.heavy.on ? 'checked' : ''}> Heavy group</label>
                ${field('at', n('heavyAt', Math.round(E.heavy.at * 100), 'min="0" max="100"'), '% of window')}${field('size', n('heavySize', E.heavy.size, 'min="1"'))}${field('heavy', n('heavyHeavy', E.heavy.heavy, 'min="0"'))}</div>
              <div class="scn-ev"><label class="nx-check"><input type="checkbox" data-f="spikeOn" ${E.spike.on ? 'checked' : ''}> Demand spike</label>
                ${field('at', n('spikeAt', Math.round(E.spike.at * 100), 'min="0" max="100"'), '% of window')}${field('size', n('spikeSize', E.spike.size, 'min="1"'))}${field('from', `<select data-f="spikeFloor">${opt({ low: 'Low', middle: 'Middle', top: 'Top' }, E.spike.floor)}</select>`)}</div>
              <div class="scn-ev"><label class="nx-check"><input type="checkbox" data-f="faultOn" ${E.fault.on ? 'checked' : ''}> Car fault</label>
                ${field('faults', `<select data-f="faultCount">${opt({ 1: 'One car', 2: 'Two cars in turn' }, String(E.fault.faults.length))}</select>`)}
                ${field('first at', n('fault0At', Math.round(E.fault.faults[0].at * 100), 'min="0" max="100"'), '%')}
                ${E.fault.faults[1] ? field('second at', n('fault1At', Math.round(E.fault.faults[1].at * 100), 'min="0" max="100"'), '%') : ''}
                ${field('repair after', n('faultRepair', E.fault.faults[0].repair, 'min="5"'), 's')}</div>
            </fieldset>
          </div>
          <div class="scn-ed-preview" data-r="edPreview"></div>
          <div class="sla-edit-foot">
            <span class="nx-note">Directions are normalised if they don't add up to 100%. The preview uses the building selected above.</span>
            <span class="sla-edit-a">
              <button class="btn-ghost" data-ed="cancel">Cancel</button>
              <button class="btn-new" data-ed="save">${icon('check')}Save version</button>
            </span>
          </div>
        </section>`;
      this.renderPreview();
    }

    renderPreview() {
      const host = this.r.editor.querySelector('[data-r="edPreview"]');
      if (!host || !this.draft) return;
      const [f, c] = SIZES[this.size];
      const s = makeSpec({ ...this.draft, id: 'draft', version: 0, builtIn: false });
      const smp = sample(s, f, c);
      host.innerHTML = `<h4 class="scn-h4">Preview · ${f} × ${c} · hash <code>${specHash(s)}</code></h4>${this.stats(smp)}${this.chart(smp, s)}`;
    }

    // ── Catalog ─────────────────────────────────────────────────────────

    render(force = false) {
      const k = `${this.records.version}|${this.store.version}|${this.size}`;
      if (!force && k === this.renderedKey) return;
      if (!force && this.host.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
      this.renderedKey = k;
      const [f, c] = SIZES[this.size];
      const list = this.store.all();
      this.r.grid.innerHTML = list.map((s) => this.card(s, f, c)).join('');
      if (this.flash) {
        const el = this.r.grid.querySelector(`[data-card="${this.flash}"]`);
        el?.classList.add('fresh');
        el?.scrollIntoView({ block: 'nearest' });
        this.flash = null;
      }
      if (this.draft) this.renderPreview();
    }

    stats(smp) {
      const share = (x) => pct(x / Math.max(1, smp.n));
      return `
        <div class="scn-stats">
          <span><b>${smp.n}</b> passengers</span>
          <span><i class="scn-k up"></i>up ${share(smp.up)}</span>
          <span><i class="scn-k down"></i>down ${share(smp.down)}</span>
          <span><i class="scn-k inter"></i>between ${share(smp.inter)}</span>
          <span>${share(smp.heavy)} heavy</span>
          <span>arrivals over ${mmss(smp.end)}</span>
        </div>`;
    }

    // Arrivals over time (stacked by direction) and destination spread.
    chart(smp, spec) {
      const a = smp.script.arrivals;
      const bins = 30;
      const w = smp.end / bins;
      const cols = Array.from({ length: bins }, () => ({ up: 0, down: 0, inter: 0 }));
      for (const x of a) {
        const b = Math.min(bins - 1, Math.floor(x.t / w));
        cols[b][x.origin === 0 ? 'up' : x.dest === 0 ? 'down' : 'inter']++;
      }
      const peak = Math.max(1, ...cols.map((col) => col.up + col.down + col.inter));
      const bw = 300 / bins;
      const rects = cols
        .map((col, i) => {
          let y = 60;
          return ['up', 'down', 'inter']
            .map((k) => {
              const h = (col[k] / peak) * 56;
              if (!h) return '';
              y -= h;
              return `<rect class="scn-b ${k}" x="${(i * bw + 0.6).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" height="${h.toFixed(1)}"/>`;
            })
            .join('');
        })
        .join('');
      const marks = smp.script.markers
        .filter((m) => m.kind !== 'wave' && m.t <= smp.end * 1.02)
        .map((m) => `<line class="scn-m ${m.kind}" x1="${((m.t / smp.end) * 300).toFixed(1)}" x2="${((m.t / smp.end) * 300).toFixed(1)}" y1="0" y2="60"><title>${esc(m.label)} · ${mmss(m.t)}</title></line>`)
        .join('');
      // Destinations: share of trips ending on each floor (lobby first).
      const floors = smp.cfg.floors;
      const dest = new Array(floors).fill(0);
      for (const x of a) dest[x.dest]++;
      const dmax = Math.max(1, ...dest);
      const dw = 300 / floors;
      const dbars = dest
        .map((v, i) => `<rect class="scn-d${i === 0 ? ' lobby' : ''}" x="${(i * dw + 0.4).toFixed(1)}" y="${(24 - (v / dmax) * 22).toFixed(1)}" width="${Math.max(0.8, dw - 0.8).toFixed(1)}" height="${((v / dmax) * 22).toFixed(1)}"><title>${i === 0 ? 'Lobby' : `Floor ${i}`}: ${v}</title></rect>`)
        .join('');
      return `
        <div class="scn-chart">
          <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Arrivals over time for ${esc(spec.name)}">${rects}${marks}</svg>
          <div class="scn-axis"><span>0:00</span><span>arrivals over time · lines mark scripted events</span><span>${mmss(smp.end)}</span></div>
          <svg class="scn-dest" viewBox="0 0 300 24" preserveAspectRatio="none" role="img" aria-label="Destinations by floor">${dbars}</svg>
          <div class="scn-axis"><span>lobby</span><span>destinations by floor</span><span>top</span></div>
        </div>`;
    }

    card(s, f, c) {
      const smp = sample(s, f, c);
      const labels = eventLabels(s, f, c);
      const on = defaultEvents(s);
      const use = this.usage(s);
      return `
        <article class="lb-card scn-card" data-card="${s.id}">
          <header>
            <b>${esc(s.name)}</b>
            <span class="scn-meta"><span class="hx-chip">v${s.version}</span><code>${specHash(s)}</code><span class="scn-kind ${s.builtIn ? '' : 'custom'}">${s.builtIn ? 'Catalog' : 'Custom'}</span></span>
          </header>
          <p class="scn-desc">${esc(s.description ?? '')}</p>
          <div class="scn-tags">${(s.stresses ?? []).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
          ${this.stats(smp)}
          ${this.chart(smp, s)}
          <ul class="scn-events">
            ${['heavy', 'fault', 'spike']
              .map((k) => `<li class="${on[k] ? 'on' : ''}"><span>${on[k] ? 'On' : 'Off'}</span>${esc(labels[k])}</li>`)
              .join('')}
          </ul>
          <footer>
            <span class="hx-muted">${use.runs ? `${use.done} finished run${use.done === 1 ? '' : 's'}${use.runs > use.done ? ` · ${use.runs - use.done} other` : ''}` : 'Not run yet'}</span>
            <span class="scn-actions">
              <button class="btn-ghost" data-act="edit" data-id="${s.id}" title="Duplicate & edit">${icon('restart')}Duplicate</button>
              ${s.builtIn ? '' : `<button class="btn-ghost" data-act="remove" data-id="${s.id}">Remove</button>`}
              <button class="btn-ghost" data-act="batch" data-id="${s.id}">${icon('bolt')}Batch</button>
              <button class="btn-new" data-act="use" data-id="${s.id}">${icon('play')}Use</button>
            </span>
          </footer>
        </article>`;
    }
  }

  EDA.ScenariosView = ScenariosView;
})(window.EDA);
