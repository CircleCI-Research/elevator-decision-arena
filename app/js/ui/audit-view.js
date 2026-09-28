/*
 * Audit & replay page.
 *
 * Pick a run file (from this session, browser storage, or opened from disk),
 * verify it, then replay it: the buildings at any moment, every decision
 * with the observation the policy saw, and the event log, all in sync.
 */
(function (EDA) {
  'use strict';

  const { clock, floorLabel: fl, arrow } = EDA.util;
  const { verify, replayWorlds, validate, fileName } = EDA.audit;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const H = 1 / 60;
  const KEY_TYPES = new Set(['overload', 'overload-clear', 'malfunction', 'out', 'repair', 'reassign', 'veto', 'finish', 'hold', 'stale']);

  function reqLabel(req) {
    if (req.kind === 'overload') return `Car ${req.car + 1} over capacity`;
    const tag = req.reason === 'crowd' ? ' · crowd' : req.reason === 'reassign' ? ' · reassign' : req.reason === 'retry' ? ' · retry' : '';
    return `Hall call ${fl(req.floor)} ${arrow(req.dir)}${tag}`;
  }

  function choiceLabel(rec) {
    if (!rec) return '—';
    const o = rec.options[rec.choice];
    if (!o) return 'no legal option';
    return `${o.short} <small>${Math.round((rec.probs[rec.choice] ?? 0) * 100)}%</small>`;
  }

  class AuditView {
    constructor(host, api) {
      this.host = host;
      this.api = api; // { sources(), bundleFor(key), openInHistory(id) }
      this.imported = new Map(); // key -> bundle, this page session only
      this.key = null;
      this.tab = 'A';
      this.selected = null; // decision index in the current tab
      this.playing = false;
      this.speed = 4;
      host.innerHTML = `
        <header class="au-head">
          <div>
            <h2>Audit &amp; replay</h2>
            <p class="hx-sub">A run file records the definition and every decision. Everything else is re-derived and checked against the record.</p>
          </div>
          <div class="au-tools">
            <label class="au-pick"><span class="sr-only">Run</span><select data-r="pick"></select></label>
            <button class="btn-ghost" data-r="import">${icon('upload')}Open run file…</button>
            <button class="btn-new" data-r="export">${icon('download')}Download run file</button>
            <input type="file" accept=".json,application/json" data-r="file" hidden>
          </div>
        </header>
        <p class="au-msg" data-r="msg" hidden></p>
        <div class="au-verify" data-r="verify"></div>
        <div class="au-player">
          <button class="ctl primary" data-r="play" aria-label="Play replay">${icon('play')}</button>
          <button class="ctl" data-r="next" aria-label="Next decision" title="Next decision (→)">${icon('step')}</button>
          <input type="range" data-r="scrub" min="0" max="1" step="0.1" value="0" aria-label="Replay position">
          <span class="au-time" data-r="time">00:00.0</span>
          <div class="seg small" role="group" aria-label="Replay speed">
            ${[1, 4, 16, 64].map((x) => `<button data-speed="${x}" class="${x === 4 ? 'on' : ''}">${x}×</button>`).join('')}
          </div>
        </div>
        <div class="au-stage">
          <div class="bldg-wrap" data-r="bA"></div>
          <div class="bldg-wrap" data-r="bB"></div>
        </div>
        <div class="au-lower">
          <section class="au-inspector card">
            <div class="card-h">
              <span class="card-k">Decisions</span>
              <div class="chips" role="tablist" data-r="tabs"></div>
            </div>
            <div class="au-dec-list" data-r="decs" role="list"></div>
            <div class="au-dec-detail" data-r="detail"></div>
          </section>
          <section class="au-events card">
            <div class="card-h"><span class="card-k">Event log</span><span class="mock" data-r="evCount"></span></div>
            <ol class="au-ev-list" data-r="events"></ol>
          </section>
        </div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.wire();
    }

    wire() {
      const r = this.r;
      r.pick.addEventListener('change', () => this.select(r.pick.value));
      r.import.addEventListener('click', () => r.file.click());
      r.file.addEventListener('change', () => this.importFile(r.file.files[0]));
      r.export.addEventListener('click', () => this.download());
      r.play.addEventListener('click', () => this.setPlaying(!this.playing));
      r.next.addEventListener('click', () => this.nextDecision());
      r.scrub.addEventListener('input', () => {
        this.setPlaying(false);
        this.seek(Number(r.scrub.value));
      });
      this.host.querySelectorAll('[data-speed]').forEach((b) =>
        b.addEventListener('click', () => {
          this.speed = Number(b.dataset.speed);
          this.host.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
        })
      );
      r.tabs.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        this.tab = b.dataset.tab;
        this.selected = null;
        this.renderDecisions();
      });
      r.decs.addEventListener('click', (e) => {
        const row = e.target.closest('[data-i]');
        if (!row) return;
        this.selected = Number(row.dataset.i);
        const c = this.captured()[this.selected];
        this.renderDecisions();
        if (c) {
          this.setPlaying(false);
          this.seek((c.rec ?? c.expected)?.t ?? c.obs.t);
        }
      });
      r.events.addEventListener('click', (e) => {
        const li = e.target.closest('[data-t]');
        if (!li) return;
        this.setPlaying(false);
        this.seek(Number(li.dataset.t));
      });
    }

    // ── Sources ─────────────────────────────────────────────────────────

    enter(prefer) {
      this.renderPicker(prefer);
    }

    renderPicker(prefer) {
      const groups = this.api.sources();
      if (this.imported.size) {
        groups.push({ label: 'Opened from file', items: [...this.imported].map(([k, b]) => ({ key: k, label: `Run ${b.run.id} · ${b.definition.floors}×${b.definition.cars} · seed ${b.definition.seed} (file)` })) });
      }
      const all = groups.flatMap((g) => g.items);
      this.r.pick.innerHTML = groups
        .filter((g) => g.items.length)
        .map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((i) => `<option value="${esc(i.key)}">${esc(i.label)}</option>`).join('')}</optgroup>`)
        .join('');
      // By default, the latest finished run: not this session's auto-started
      // demo run, which would otherwise be picked every time.
      const fallback = (all.find((i) => i.done) ?? all[0])?.key;
      const want = prefer && all.some((i) => i.key === prefer) ? prefer : this.key && all.some((i) => i.key === this.key) ? this.key : fallback;
      if (!want) {
        this.r.verify.innerHTML = '<p class="hx-muted">No run files yet. Every run records one as it goes.</p>';
        return;
      }
      this.r.pick.value = want;
      if (want !== this.key || prefer) this.select(want);
    }

    bundle(key) {
      return this.imported.get(key) ?? this.api.bundleFor(key);
    }

    async importFile(file) {
      this.r.file.value = '';
      if (!file) return;
      try {
        const b = validate(JSON.parse(await file.text()));
        const key = `file:${b.defHash}:${b.run.id}:${Date.now()}`;
        this.imported.set(key, b);
        this.msg(`Opened ${esc(file.name)}. It is verified below by replaying it from scratch.`, 'ok');
        this.renderPicker(key);
      } catch (err) {
        this.msg(`Could not open ${esc(file.name)}: ${esc(err.message)}`, 'bad');
      }
    }

    download() {
      if (!this.current) return;
      const b = this.current.bundle;
      const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(b);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    msg(html, tone) {
      const m = this.r.msg;
      m.hidden = !html;
      m.className = `au-msg ${tone ?? ''}`;
      m.innerHTML = html ?? '';
    }

    // ── Verify + load ───────────────────────────────────────────────────

    select(key) {
      const bundle = this.bundle(key);
      if (!bundle) return;
      if (this.key !== key && !this.imported.has(key)) this.msg(null); // file messages belong to that file
      this.key = key;
      this.setPlaying(false);
      this.r.verify.innerHTML = `<p class="au-verifying"><span class="pulse-dot"></span>Replaying the run file to verify it…</p>`;
      // Let the message paint before a potentially long replay.
      setTimeout(() => {
        if (this.key !== key) return;
        const v = verify(bundle, this.api.recordFor(bundle));
        this.current = { bundle, v };
        this.tab = bundle.contestants[0].key;
        this.selected = null;
        this.renderVerify();
        this.renderTabs();
        this.renderDecisions();
        this.r.evCount.textContent = `${v.events.length} events`;
        this.r.scrub.max = String(Math.max(1, v.endT).toFixed(1));
        this.evShown = -1;
        this.resetPlayer();
        this.seek(0);
      }, 30);
    }

    renderVerify() {
      const { bundle: b, v } = this.current;
      const ok = (x) => (x ? `<span class="v-ok">${icon('check')}</span>` : `<span class="v-bad">${icon('alert')}</span>`);
      const decs = b.contestants
        .map((c) => {
          const d = v.decisions[c.key];
          const div = d.divergedAt ? ` · diverged at #${d.divergedAt.n} (${clock(d.divergedAt.t)})` : '';
          return `${c.key} ${d.matched}/${d.recorded}${div}`;
        })
        .join(' · ');
      const fp =
        v.fingerprintOk === null
          ? `<span class="v-na">${icon('clock')}</span><div><b>Results</b><span>Run unfinished: replay verified up to ${clock(v.endT)}. No final fingerprint to compare.</span></div>`
          : `${ok(v.fingerprintOk)}<div><b>Results</b><span>Fingerprint <code>${v.fingerprint}</code> ${v.fingerprintOk ? 'matches the record' : `≠ recorded <code>${b.fingerprint}</code>`}</span></div>`;
      const integrityOk = v.logHashOk !== false && (!v.reference || v.reference.ok);
      const integrity =
        v.logHashOk === null
          ? `<span class="v-na">${icon('clock')}</span><div><b>Integrity</b><span>No decision-log hash in this file.</span></div>`
          : `${ok(integrityOk)}<div><b>Integrity</b><span>Decision log <code>${v.logHash}</code> ${
              v.logHashOk ? 'matches the file header' : '≠ the file header: the log was edited'
            }${
              v.reference
                ? v.reference.ok
                  ? ` · matches this browser's record of Run ${v.reference.id}`
                  : ` · <b class="v-bad">differs from this browser's record of Run ${v.reference.id}</b>`
                : ' · no local record to compare'
            }</span></div>`;
      const all = v.defHashOk && v.decisionsOk && v.fingerprintOk !== false && integrityOk;
      // A run recorded by an older simulator replays under today's, so a
      // mismatch there says nothing about tampering. Say so, don't fail it.
      const oldSim = b.simulator && b.simulator !== EDA.history.SIM_VERSION;
      const verdict = oldSim
        ? `<div class="au-verdict">${icon('info')}<b>Older simulator</b><small>recorded with ${esc(b.simulator)}; this page runs ${esc(EDA.history.SIM_VERSION)}, so the replay can't confirm it</small></div>`
        : `<div class="au-verdict ${all ? 'ok' : 'bad'}">${icon(all ? 'shield' : 'alert')}<b>${all ? 'Verified' : 'Verification failed'}</b><small>replayed in ${Math.round(v.ms)} ms</small></div>`;
      this.r.verify.innerHTML = `
        ${verdict}
        <div class="au-check">${ok(v.defHashOk)}<div><b>Definition</b><span>Hash <code>${v.defHash}</code> ${v.defHashOk ? 'recomputed from the definition' : `≠ recorded <code>${b.defHash}</code>`}</span></div></div>
        <div class="au-check">${ok(v.decisionsOk)}<div><b>Decisions</b><span>${decs} matched their requests</span></div></div>
        <div class="au-check">${fp}</div>
        <div class="au-check">${integrity}</div>
        ${this.setupLine(b)}`;
    }

    // A live model's decision: what the endpoint reported, and the exact
    // request and response. Replay never re-asks it; this is the record.
    liveDetail(rec) {
      const L = rec.live;
      const facts = [
        ['Answered by', L.model ? `<code>${esc(L.model)}</code>${L.drift ? ' <b class="v-bad">not the pinned model</b>' : ''}` : '—'],
        // Stored only when timing rules changed the landing time; else they're equal.
        ['Round trip', `${Math.round((rec.measured ?? rec.latency) * 1000)} ms`],
        ['Model time', L.inferMs != null ? `${Math.round(L.inferMs)} ms (reported by the server)` : 'not reported'],
        ['Queued in runner', `${Math.round(L.queuedMs ?? 0)} ms`],
        ['Attempts', String(L.attempts ?? 1)],
        ['Input tokens', L.tokens ? `${L.tokens}${L.costUsd ? ` · $${L.costUsd.toFixed(6)}` : ''}` : '—'],
        ...(L.error ? [['Error', `<b class="v-bad">${esc(L.error)}</b>`]] : []),
      ];
      const json = (x) => esc(JSON.stringify(x, null, 2));
      return `
        <h3>Live call <small>recorded; never re-asked in replay</small></h3>
        <dl class="exp-def au-live">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${
          rec.io
            ? `<details class="au-io"><summary>Request sent</summary><pre>${json(rec.io.request)}</pre></details>
               <details class="au-io"><summary>Response received</summary><pre>${json(rec.io.response)}</pre></details>`
            : ''
        }`;
    }

    // Not a pass/fail check: what the run's two lanes can be compared on.
    setupLine(b) {
      const [x, y] = ['A', 'B'].map((k) => b.contestants.find((c) => c.key === k));
      if (!x || !y) return '';
      const c = EDA.setup.check(x, y, b.definition);
      const timing = EDA.scenario.timingTag(b.definition.timing) ?? 'measured decision time, own timeouts';
      return `<div class="au-check au-setup">${icon(c.verdict === 'controlled' ? 'check' : 'info')}<div><b>Setup</b><span>${EDA.setupView.chip(c)} ${esc(c.summary)} Timing: ${esc(timing)}.</span></div></div>`;
    }

    renderTabs() {
      const { bundle: b } = this.current;
      this.r.tabs.innerHTML = b.contestants
        .map((c) => `<button data-tab="${c.key}" role="tab" aria-selected="${c.key === this.tab}" class="${c.key === this.tab ? 'on' : ''}"><span class="lane lane-${c.key}">${c.key}</span>${esc(c.name)}</button>`)
        .join('');
    }

    captured() {
      return this.current ? this.current.v.decisions[this.tab].captured : [];
    }

    renderDecisions() {
      this.renderTabs();
      const list = this.captured();
      this.r.decs.innerHTML = list
        .map((c, i) => {
          const rec = c.rec ?? c.expected;
          const t = rec?.t ?? c.obs.t;
          return `
            <button class="au-dec${i === this.selected ? ' sel' : ''}${c.match ? '' : ' diverged'}" data-i="${i}" data-t="${t}" role="listitem">
              <span class="d-n">#${rec?.n ?? i + 1}</span>
              <span class="d-t">${clock(t)}</span>
              <span class="d-req">${esc(reqLabel(c.req))}</span>
              <span class="d-choice">${c.match ? `${choiceLabel(c.rec)}${c.rec.fallback ? ' <b class="v-warn">fallback</b>' : ''}` : '<b class="v-bad">diverged</b>'}</span>
              <span class="d-lat">${rec ? (rec.latency ? `${Math.round(rec.latency * 1000)} ms` : '< 0.1 ms') : '—'}</span>
              <span class="d-out o-${rec?.outcome ?? 'none'}">${rec?.outcome ?? '—'}</span>
            </button>`;
        })
        .join('');
      this.nowIndex = -1;
      this.renderDetail();
    }

    renderDetail() {
      const c = this.captured()[this.selected];
      if (!c) {
        this.r.detail.innerHTML = '<p class="hx-muted">Select a decision to see its options, and exactly what the policy was allowed to observe.</p>';
        return;
      }
      const rec = c.rec ?? c.expected;
      const opts = rec
        ? rec.options
            .map((o, i) => {
              const p = rec.probs[i] ?? 0;
              return `<div class="au-opt${i === rec.choice ? ' pick' : ''}${o.veto ? ' veto' : ''}">
                <span>${esc(o.label)}</span><span class="o-bar"><i style="transform:scaleX(${p.toFixed(3)})"></i></span>
                <span>${o.veto ? `veto · ${esc(o.veto)}` : `${Math.round(p * 100)}%`}</span></div>`;
            })
            .join('')
        : '';
      const o = c.obs;
      const cars = o.cars
        .map(
          (x) => `<tr><td>${x.idx + 1}</td><td>${x.floor.toFixed(2)}</td><td>${x.dir > 0 ? '▲' : x.dir < 0 ? '▼' : '·'}</td><td>${x.mode}</td><td>${x.doorPhase}</td><td>${x.loadKg} / ${x.capacityKg}</td><td>${x.stops}</td><td>${x.assigned}${x.coming ? ' · coming' : ''}</td></tr>`
        )
        .join('');
      const mismatch = !c.match
        ? `<p class="au-mismatch">${icon('alert')}<span>The replay asked <b>${esc(reqLabel(c.req))}</b>${c.expected ? `, but the record says <b>${esc(reqLabel(c.expected.req))}</b>` : ', past the end of the record'}. From here on the policy decides live.</span></p>`
        : '';
      this.r.detail.innerHTML = `
        ${mismatch}
        <h3>${esc(reqLabel(c.req))} <small>at ${clock(o.t)} sim · latency ${rec?.latency ? `${Math.round(rec.latency * 1000)} ms` : '< 0.1 ms'}</small></h3>
        ${
          rec?.fallback
            ? `<p class="au-mismatch au-fallback">${icon('clock')}<span>The contestant took <b>${Math.round(rec.measured * 1000)} ms</b>, over the ${Math.round(rec.fallback.limitS * 1000)} ms timeout. Its choice (${esc(rec.options[rec.fallback.choice]?.label ?? '—')}, ${Math.round((rec.fallback.probs[rec.fallback.choice] ?? 0) * 100)}%) was discarded, and <b>${esc(EDA.registry.byCid(rec.fallback.by)?.name ?? rec.fallback.by)}</b> decided instead.</span></p>`
            : ''
        }
        <div class="au-opts">${opts}</div>
        ${rec?.live ? this.liveDetail(rec) : ''}
        <h3>Observation <small>everything the policy was allowed to see</small></h3>
        <div class="au-obs-wrap">
          <table class="au-obs">
            <thead><tr><th>Car</th><th>Floor</th><th>Dir</th><th>Mode</th><th>Doors</th><th>Load kg</th><th>Stops</th><th>Assigned</th></tr></thead>
            <tbody>${cars}</tbody>
          </table>
        </div>
        <p class="nx-note">Plus the request itself and car speed (${o.vmax.toFixed(2)} floors/s). Only total load per car is visible: individual passenger weights are not part of the observation.</p>`;
    }

    // ── Player ──────────────────────────────────────────────────────────

    resetPlayer() {
      const { bundle } = this.current;
      const rp = replayWorlds(bundle);
      this.player = rp;
      const View = rp.cfg.mode === 'stats' ? EDA.StatsView : EDA.BuildingView;
      this.views = rp.contestants.map((c, i) => new View(i === 0 ? this.r.bA : this.r.bB, rp.worlds[i], { key: c.key, name: c.policy.name, kind: c.policy.kind }));
      this.pt = 0;
    }

    // Replay is deterministic, so any moment can be reached by re-executing;
    // going backwards starts over from zero.
    seek(t, animate = false) {
      if (!this.player) return;
      const end = this.current.v.endT;
      t = Math.max(0, Math.min(end, t));
      if (t < this.pt - 1e-9) this.resetPlayer();
      const worlds = this.player.worlds;
      const bundle = this.current.bundle;
      const target = (w) => Math.min(t, bundle.results[w.id].finishedAt ?? bundle.results[w.id].simT ?? t);
      let guard = 0;
      while (worlds.some((w) => w.finishedAt === null && w.t < target(w) - 1e-9) && guard++ < 1e6) {
        worlds.forEach((w, i) => {
          if (w.finishedAt !== null || w.t >= target(w) - 1e-9) return;
          w.step(H);
          for (const ev of w.events.splice(0)) if (animate) this.views[i].onEvent(ev);
        });
      }
      this.pt = t;
      this.syncUi();
    }

    nextDecision() {
      if (!this.current) return;
      this.setPlaying(false);
      let best = Infinity;
      for (const d of Object.values(this.current.v.decisions)) {
        for (const c of d.captured) {
          const t = (c.rec ?? c.expected)?.t ?? c.obs.t;
          if (t > this.pt + 1e-6 && t < best) best = t;
        }
      }
      if (best < Infinity) this.seek(best + H);
    }

    setPlaying(on) {
      if (on && this.current && this.pt >= this.current.v.endT - 1e-6) this.seek(0);
      this.playing = on && !!this.current;
      this.r.play.innerHTML = icon(this.playing ? 'pause' : 'play');
      this.r.play.setAttribute('aria-label', this.playing ? 'Pause replay' : 'Play replay');
    }

    frame(dt) {
      if (!this.current || !this.player) return;
      if (this.playing) {
        const end = this.current.v.endT;
        this.seek(Math.min(end, this.pt + dt * this.speed), true);
        if (this.pt >= end - 1e-6) this.setPlaying(false);
      }
      for (const v of this.views) v.render();
      const done = this.player.worlds.map((w) => w.finishedAt);
      this.views.forEach((v, i) => v.setResult(done[i] === null ? 0 : 1 + done.filter((x) => x !== null && x < done[i]).length, done[i]));
    }

    syncUi() {
      this.r.scrub.value = String(this.pt.toFixed(1));
      this.r.time.textContent = `${clock(this.pt)} / ${clock(this.current.v.endT)}`;
      // Highlight the latest decision at or before the replay position.
      const list = this.captured();
      let now = -1;
      for (let i = 0; i < list.length; i++) {
        const t = (list[i].rec ?? list[i].expected)?.t ?? list[i].obs.t;
        if (t <= this.pt + 1e-6) now = i;
        else break;
      }
      if (now !== this.nowIndex) {
        const rows = this.r.decs.children;
        if (rows[this.nowIndex]) rows[this.nowIndex].classList.remove('now');
        if (rows[now]) {
          rows[now].classList.add('now');
          if (this.playing) rows[now].scrollIntoView({ block: 'nearest' });
        }
        this.nowIndex = now;
      }
      this.renderEvents();
    }

    renderEvents() {
      const evs = this.current.v.events;
      // Events up to the replay position, newest first.
      let hi = evs.length;
      let lo = 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (evs[mid].t <= this.pt + 1e-6) lo = mid + 1;
        else hi = mid;
      }
      if (lo === this.evShown) return;
      this.evShown = lo;
      const recent = evs.slice(Math.max(0, lo - 60), lo).reverse();
      this.r.events.innerHTML = recent
        .map(
          (e) =>
            `<li data-t="${e.t}" class="${KEY_TYPES.has(e.type) ? 'key' : ''} sev-${e.sev}"><span class="ev-t">${clock(e.t).slice(0, 7)}</span><span class="lane lane-${e.b}">${e.b}</span><span class="ev-x">${esc(e.text)}</span></li>`
        )
        .join('');
    }

    key(k) {
      if (k === ' ') this.setPlaying(!this.playing);
      else if (k === 'arrowright' || k === '.') this.nextDecision();
      else return false;
      return true;
    }
  }

  EDA.AuditView = AuditView;
})(window.EDA);
