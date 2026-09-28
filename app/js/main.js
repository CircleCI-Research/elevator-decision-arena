/*
 * App director.
 *
 * An experiment is defined once, in the New experiment dialog, and becomes a
 * run. Its parameters are fixed for the life of the run. Several runs can
 * exist in a session and all of them keep simulating in the background; the
 * Arena only draws the one being viewed. The one live control is the run
 * mode (timeline playback vs max speed), which changes wall-clock time but
 * never the simulated results.
 */
(function (EDA) {
  'use strict';

  const { LIMITS, VISUAL_MAX, DEFAULT_EVENTS, makeConfig, buildScript } = EDA.scenario;
  const { clock, floorLabel: fl, destColor } = EDA.util;

  const { byCid, DEFAULT_PAIR } = EDA.registry;
  // Each experiment picks its two contestants from the registry.
  const lanesFor = (def) => ['A', 'B'].map((key, i) => ({ key, policy: byCid(def.contestants?.[i]) ?? byCid(DEFAULT_PAIR[i]) }));

  const H = 1 / 60; // fixed sim step
  const FAST_BUDGET_MS = 12; // shared by all max-speed runs, per frame
  const LOG_CAP = 8000; // events kept per run for replaying the HUD
  const $ = (id) => document.getElementById(id);

  const S = { runs: [], active: null, nextRunId: 1, last: 0, view: null, page: 'arena', batches: [], nextBatch: 1 };

  // Run history outlives the page; run numbers stay unique across visits.
  const store = new EDA.history.HistoryStore();
  const scenarios = new EDA.ScenarioStore();
  const specFor = (def) => def.scenarioSpec ?? scenarios.get(def.scenarioId ?? 'morning-wave') ?? EDA.scenario.CATALOG[0];
  store.markInterrupted();
  S.nextRunId = store.nextId();

  function persist(run) {
    if (run.noRecord) return;
    const rec = EDA.history.fromRun(run, run.contestants, run.done ? 'done' : 'running');
    // Finished runs keep a hash of their decision log, so a run file can be
    // checked against this browser's record later.
    if (run.done) rec.decisionsHash = EDA.audit.decisionsHash(EDA.audit.compactLogs(run));
    store.upsert(rec);
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  function createRun(def) {
    const demo = !!def.demo;
    def = { ...def };
    delete def.demo;
    const cfg = makeConfig(def.floors, def.cars, { seed: def.seed, events: def.events, scenario: specFor(def), timing: def.timing });
    const script = buildScript(cfg);
    const contestants = lanesFor(def);
    const run = {
      id: S.nextRunId++,
      contestants,
      def: { ...def },
      cfg,
      passengers: script.arrivals.length,
      markers: script.markers.map((m) => ({ ...m })),
      worlds: contestants.map((c) => new EDA.World({ id: c.key, cfg, script, policy: c.policy })),
      mode: def.mode,
      modes: new Set([def.mode]), // every mode this run has used
      speed: def.mode === 'fast' ? 2 : cfg.mode === 'stats' ? 16 : 2,
      playing: true,
      done: false,
      acc: 0,
      log: [],
      createdAt: Date.now(),
      auto: demo,
      noRecord: demo,
    };
    syncFastFlags(run);
    S.runs.push(run);
    persist(run);
    return run;
  }

  // Wall-clock is only a clean measurement when the whole run was computed
  // at max speed.
  function syncFastFlags(run) {
    const pure = run.modes.size === 1 && run.mode === 'fast';
    for (const w of run.worlds) {
      w.fastRun = pure;
      w.mixedRun = run.modes.size > 1;
    }
  }

  function record(run, ev, i) {
    run.log.push(ev);
    if (run.log.length > LOG_CAP) run.log.splice(0, run.log.length - LOG_CAP);
    if (run === S.active) {
      S.view.hud.onEvent(ev);
      if (i !== undefined) S.view.views[i].onEvent(ev);
    }
  }

  function stepWorld(run, i) {
    const w = run.worlds[i];
    w.step(H);
    for (const ev of w.events.splice(0)) record(run, ev, i);
  }

  function fireMarkers(run) {
    const t = Math.max(...run.worlds.map((w) => w.t));
    for (const m of run.markers) {
      if (m.fired || m.t > t) continue;
      m.fired = true;
      record(run, { t: m.t, b: 'both', type: 'scenario', text: m.label, sev: 'info' });
    }
  }

  // Timeline playback: both worlds advance together with the clock.
  function advance(run, simDt) {
    // A live model's answer is out: hold both lanes, so they stay in step.
    // The answer then lands after its measured time, in sim seconds.
    if (run.worlds.some((w) => w.waiting)) return;
    run.acc += simDt;
    while (run.acc >= H) {
      run.acc -= H;
      run.worlds.forEach((w, i) => w.finishedAt === null && stepWorld(run, i));
      fireMarkers(run);
    }
  }

  // A decision can only land once the policy has actually produced it. Only
  // a live model takes real time (the world waits for its answer); an
  // algorithm answers at once, whatever sim time the decision takes.
  function awaitingDecision(run, w) {
    return w.waiting;
  }

  // Max speed: each world runs as fast as the CPU allows, held back only by
  // its own policy. Sim results are identical to timeline playback.
  function fastAdvance(run, budgetMs) {
    const deadline = performance.now() + budgetMs;
    let moved = true;
    while (moved && performance.now() < deadline) {
      moved = false;
      run.worlds.forEach((w, i) => {
        for (let n = 0; n < 120; n++) {
          if (w.finishedAt !== null || awaitingDecision(run, w)) break;
          stepWorld(run, i);
          moved = true;
        }
      });
    }
    fireMarkers(run);
  }

  function tick(dt) {
    const live = S.runs.filter((r) => r.playing && !r.done);
    const fast = live.filter((r) => r.mode === 'fast');
    for (const run of live) {
      for (const w of run.worlds) if (w.finishedAt === null) w.wall += dt;
      if (run.mode === 'fast') fastAdvance(run, FAST_BUDGET_MS / fast.length);
      else advance(run, dt * run.speed);
      if (run.worlds.every((w) => w.finishedAt !== null)) {
        run.done = true;
        run.playing = false;
        run.finishedWall = Date.now();
        persist(run);
        if (!run.noRecord) EDA.audit.storage.save(EDA.audit.bundleFromRun(run, run.contestants));
        if (run.batch) {
          const b = S.batches.find((x) => x.id === run.batch);
          if (b && batchProgress(b).done === b.runIds.length) toast(`Batch ${b.id} finished: ${b.runIds.length} runs`);
        } else if (run !== S.active) toast(`Run ${run.id} finished`);
        else syncControls();
      }
    }
  }

  // ── Viewing a run ─────────────────────────────────────────────────────

  function mount(run) {
    S.active = run;
    const cfg = run.cfg;
    const View = cfg.mode === 'stats' ? EDA.StatsView : EDA.BuildingView;
    const views = run.contestants.map((c, i) => new View($(`bldg-${c.key}`), run.worlds[i], { key: c.key, name: c.policy.name, kind: c.policy.kind }));
    const panels = run.contestants.map((c, i) => new EDA.DecisionPanel($(`dp-${c.key}`), run.worlds[i], { key: c.key, policy: c.policy }));
    const hud = new EDA.Hud(
      { timeline: $('timeline'), race: $('race'), score: $('score'), incidents: $('incidents'), feed: $('feed') },
      run.worlds,
      run.contestants,
      run.markers
    );
    hud.quiet = run.mode === 'fast';
    for (const ev of run.log) hud.onEvent(ev); // rebuild timeline and feed from the run's history
    S.view = { views, panels, hud };

    $('run-title').textContent = `${run.auto ? 'Demo run (not recorded)' : `Run ${run.id}`} · ${cfg.scenario}`;
    $('meta').textContent = `${cfg.floors} floors · ${cfg.cars} cars · ${cfg.capacityKg} kg per car · ${run.passengers} passengers`;
    const seed = $('seed');
    seed.innerHTML = `<svg class="ico"><use href="#i-info"/></svg>Seed ${cfg.seed}`;
    seed.title = `Random seed ${cfg.seed}: the same seed replays exactly the same passengers, weights and scripted events.`;
    const g = cfg.geo;
    document.querySelector('.arena').classList.toggle('roomy', cfg.mode === 'visual' && (g.W > 700 || g.H > 700));
    document.body.classList.toggle('stats-mode', cfg.mode === 'stats');
    renderExperiment();
    renderLegend();
    renderRunList(true);
    syncControls();
    render(0, true);
  }

  function render(dt, force = false) {
    const run = S.active;
    const { views, panels, hud } = S.view;
    for (const v of views) v.render();
    for (const p of panels) p.update(dt);
    hud.update(force);
    $('clock').textContent = clock(Math.max(...run.worlds.map((w) => w.t)));
    const done = run.worlds.map((w) => w.finishedAt);
    views.forEach((v, i) => {
      const t = done[i];
      v.setResult(t === null ? 0 : 1 + done.filter((x) => x !== null && x < t).length, t);
    });
  }

  let persistAt = 0;

  // Runs one part of a frame; a failure is logged once per part and never
  // stops the loop, so a bug in one page can't freeze the others.
  const failed = new Set();
  function guard(part, fn) {
    try {
      fn();
      failed.delete(part);
    } catch (err) {
      if (!failed.has(part)) console.error(`[${part}]`, err);
      failed.add(part);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame); // schedule first: nothing below can stop the loop
    const dt = S.last ? Math.min(0.1, (now - S.last) / 1000) : 0;
    S.last = now;
    guard('simulation', () => tick(dt));
    // Progress of unfinished runs is saved every couple of seconds.
    if (now - persistAt > 2000) {
      persistAt = now;
      guard('history', () => {
        for (const r of S.runs) if (!r.done) persist(r);
      });
    }
    guard(S.page, () => {
      if (S.page === 'arena') render(dt);
      else if (S.page === 'history') S.history.render();
      else if (S.page === 'audit') S.audit.frame(dt);
      else if (S.page === 'leaderboard') S.leaderboard.render();
      else if (S.page === 'sla') S.sla.render();
      else if (S.page === 'scenarios') S.scenarios.render();
      else S.contestants.render();
    });
    guard('sidebar', () => {
      renderRunList();
      renderHistoryBadge();
    });
  }

  // ── Pages ─────────────────────────────────────────────────────────────

  function showPage(page, focusRun) {
    S.page = page;
    document.body.classList.toggle('view-page', page !== 'arena');
    $('view-history').hidden = page !== 'history';
    $('view-audit').hidden = page !== 'audit';
    $('view-leaderboard').hidden = page !== 'leaderboard';
    $('view-sla').hidden = page !== 'sla';
    $('view-scenarios').hidden = page !== 'scenarios';
    $('view-contestants').hidden = page !== 'contestants';
    document.querySelectorAll('.nav a[data-page]').forEach((a) => {
      if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (page === 'history') S.history.render(true);
    // Audit the run being viewed, unless it's the session's automatic demo
    // run: then Audit opens on the latest finished run instead.
    else if (page === 'audit') S.audit.enter(focusRun ?? (S.active && !S.active.auto ? `run:${S.active.id}` : null));
    else if (page === 'leaderboard') S.leaderboard.enter(focusRun);
    else if (page === 'sla') S.sla.enter();
    else if (page === 'scenarios') S.scenarios.enter();
    else if (page === 'contestants') S.contestants.enter();
    else render(0, true);
    window.scrollTo(0, 0);
  }

  function renderHistoryBadge() {
    const n = store.records.length;
    const b = $('history-count');
    if (b.__n !== n) {
      b.__n = n;
      b.textContent = n ? String(n) : '';
    }
  }

  const historyApi = {
    live: (id) => S.runs.find((r) => r.id === id) ?? null,
    open(id) {
      const run = S.runs.find((r) => r.id === id);
      if (!run) return;
      if (run !== S.active) mount(run);
      showPage('arena');
    },
    rerun(rec) {
      const lanes = ['A', 'B'].map((k) => rec.contestants.find((c) => c.key === k));
      // Never substitute another contestant: a rerun must be the same definition.
      const missing = lanes.find((c) => {
        const p = byCid(c.cid ?? `${c.id}@${c.version}`);
        return !p || (p.live && !p.available);
      });
      if (missing) {
        toast(`Can't rerun: ${missing.name} ${missing.version} isn't available${missing.live ? ' (start the arena runner and its model)' : ''}`);
        return;
      }
      const run = createRun({
        contestants: lanes.map((c) => c.cid ?? `${c.id}@${c.version}`),
        scenarioId: rec.def.scenarioId ?? 'morning-wave',
        ...(rec.def.scenarioSpec ? { scenarioSpec: rec.def.scenarioSpec } : {}),
        floors: rec.def.floors,
        cars: rec.def.cars,
        seed: rec.def.seed,
        events: { ...rec.def.events },
        timing: { ...EDA.scenario.normTiming(rec.def.timing) },
        mode: rec.def.startMode,
      });
      mount(run);
      showPage('arena');
      toast(`Run ${run.id}: rerun of Run ${rec.id}`);
    },
    remove(id) {
      const run = S.runs.find((r) => r.id === id);
      if (run) run.noRecord = true; // stop re-saving a live run whose record was removed
      store.remove(id);
      EDA.audit.storage.remove(id);
    },
    clear() {
      const keep = new Set(S.runs.filter((r) => !r.done && !r.noRecord).map((r) => r.id));
      for (const r of S.runs) if (!keep.has(r.id)) r.noRecord = true;
      store.clear(keep);
      EDA.audit.storage.clear();
      toast('History cleared');
    },
    hasAudit: (id) => S.runs.some((r) => r.id === id) || EDA.audit.storage.ids().includes(id),
    audit(id) {
      const live = S.runs.some((r) => r.id === id);
      showPage('audit', live ? `run:${id}` : `saved:${id}`);
    },
  };

  // Run files: live runs are snapshotted on demand; finished ones are also
  // kept in browser storage so they can be audited after a reload.
  const auditApi = {
    sources() {
      const live = new Set(S.runs.map((r) => r.id));
      const status = (r) => (r.done ? 'done' : r.playing ? 'running' : 'paused');
      const saved = EDA.audit.storage.ids().filter((id) => !live.has(id));
      // Name the contestants: runs of different pairs otherwise look alike.
      const who = (cs) => cs.map((c) => `${c.name} ${c.version}`).join(' vs ');
      const runs = S.runs.filter((r) => !r.auto); // the unrecorded demo run has no run file
      return [
        {
          label: 'This session',
          items: runs
            .slice()
            .reverse()
            .map((r) => ({ key: `run:${r.id}`, done: r.done, label: `Run ${r.id} · ${who(r.contestants.map((c) => c.policy))} · ${r.cfg.floors}×${r.cfg.cars} · seed ${r.cfg.seed} · ${status(r)}${r.done ? '' : ' (snapshot)'}` })),
        },
        {
          label: 'Saved in this browser',
          items: saved.map((id) => {
            const rec = store.get(id);
            return { key: `saved:${id}`, done: true, label: rec ? `Run ${id} · ${who(rec.contestants)} · ${rec.def.floors}×${rec.def.cars} · seed ${rec.def.seed} · done` : `Run ${id}` };
          }),
        },
      ];
    },
    recordFor: (bundle) => store.get(bundle.run.id),
    bundleFor(key) {
      const [kind, raw] = key.split(':');
      const id = Number(raw);
      if (kind === 'run') {
        const run = S.runs.find((r) => r.id === id);
        return run ? EDA.audit.bundleFromRun(run, run.contestants) : null;
      }
      return EDA.audit.storage.load(id);
    },
  };

  // ── Experiment card (read-only definition + the live run mode) ────────

  function eventsLabel(ev) {
    const on = [ev.heavy && 'heavy group', ev.fault && 'car fault', ev.spike && 'demand spike'].filter(Boolean);
    return on.length ? on.join(' · ') : 'none';
  }

  function renderExperiment() {
    const run = S.active;
    const c = run.cfg;
    const drawing =
      c.mode === 'stats' ? 'None · stats only' : c.geo.detail === 'full' ? 'Full pictograms' : c.geo.detail === 'compact' ? 'Compact pictograms' : 'Dots';
    $('exp-def').innerHTML = [
      ['Building', `${c.floors} floors × ${c.cars} cars`],
      ['Scenario', `${c.scenario} v${c.scenarioVersion}`],
      ['Seed', String(c.seed)],
      ['Scripted events', eventsLabel(c.events)],
      ['Contestants', run.contestants.map((x) => `${x.key} · ${esc(x.policy.name)} ${esc(x.policy.version)}`).join('  vs  ')],
      ['Decision timing', esc(EDA.scenario.timingTag(c.timing) ?? 'measured · each contestant\'s own timeout')],
      ['Setup check', setupChip(run)],
      ['Drawing', drawing],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
    renderRunMode();
  }

  function setupChip(run) {
    const [a, b] = ['A', 'B'].map((k) => run.contestants.find((x) => x.key === k)?.policy);
    return a && b ? EDA.setupView.chip(EDA.setup.check(a, b, { timing: run.cfg.timing })) : '—';
  }

  function renderRunMode() {
    const run = S.active;
    document.querySelectorAll('[data-run]').forEach((b) => b.classList.toggle('on', b.dataset.run === run.mode));
    const mixed = run.modes.size > 1;
    $('set-run-note').textContent =
      run.mode === 'fast'
        ? `Computing as fast as possible; only decision time slows it down.${mixed ? ' Wall-clock is marked “mixed” because this run changed modes.' : ''}`
        : `Plays on the timeline at the chosen speed.${mixed ? ' Wall-clock is marked “mixed” because this run changed modes.' : ''}`;
    document.body.classList.toggle('fast-run', run.mode === 'fast');
  }

  function setRunMode(mode) {
    const run = S.active;
    if (run.mode === mode) return;
    run.mode = mode;
    run.modes.add(mode);
    run.acc = 0;
    syncFastFlags(run);
    persist(run);
    S.view.hud.quiet = mode === 'fast';
    renderRunMode();
    syncControls();
  }

  // Destination legend: one swatch per floor in small buildings, colour bands
  // with floor ranges in tall ones.
  function renderLegend() {
    const floors = S.active.cfg.floors;
    const bands = new Map();
    for (let f = 0; f < floors; f++) {
      const c = destColor(f, floors);
      if (!bands.has(c)) bands.set(c, []);
      bands.get(c).push(f);
    }
    $('lg-dests').innerHTML = [...bands]
      .map(([c, fs]) => {
        const label = fs.length === 1 ? fl(fs[0]) : `${fl(fs[0])}–${fl(fs[fs.length - 1])}`;
        return `<i class="${c === 2 ? 'dark' : ''}${fs.length > 1 ? ' band' : ''}" style="--c:var(--f${c})">${label}</i>`;
      })
      .join('');
  }

  // ── Session runs in the sidebar ───────────────────────────────────────

  let runListAt = 0;

  function runStatus(run) {
    if (run.done) return 'done';
    if (!run.playing) return 'paused';
    return run.mode === 'fast' ? 'fast' : 'playing';
  }

  // Session runs in the sidebar: newest first, in a fixed-height scrolling
  // list, so forty runs take the same room as four. The full list, with
  // filters and comparison, lives in Run history.
  const runListUi = { open: true, filter: 'all', current: null };

  function renderRunList(force = false) {
    const now = performance.now();
    if (!force && now - runListAt < 250) return;
    runListAt = now;
    const host = $('run-list');
    const solo = S.runs.filter((r) => !r.batch);
    const batchDone = (b) => batchProgress(b).done === b.runIds.length;
    // One timeline of entries, newest first.
    const entries = [
      // Run numbers only grow, so they order entries even within one millisecond.
      ...S.batches.map((b) => ({ kind: 'batch', b, seq: Math.max(...b.runIds), done: batchDone(b) })),
      ...solo.map((r) => ({ kind: 'run', r, seq: r.id, done: r.done })),
    ].sort((a, b) => b.seq - a.seq);
    const shown = runListUi.filter === 'live' ? entries.filter((e) => !e.done || e.r === S.active) : entries;
    const live = entries.filter((e) => !e.done).length;

    const key = `${runListUi.open}|${runListUi.filter}|${entries.map((e) => (e.kind === 'run' ? `r${e.r.id}:${runStatus(e.r)}:${e.r === S.active}` : `b${e.b.id}:${batchProgress(e.b).done}`)).join('|')}`;
    if (host.__key !== key) {
      host.__key = key;
      $('run-count').textContent = String(entries.length);
      $('run-live').textContent = live ? `Live ${live}` : 'Live';
      $('run-toggle').setAttribute('aria-expanded', String(runListUi.open));
      $('run-body').hidden = !runListUi.open;
      document.querySelectorAll('[data-runfilter]').forEach((b) => b.classList.toggle('on', b.dataset.runfilter === runListUi.filter));
      host.innerHTML = shown.length
        ? shown
            .map((e) => {
              if (e.kind === 'batch') {
                const b = e.b;
                const p = batchProgress(b);
                return `
            <div class="run-item batch">
              <button class="run-open" data-batch="${b.id}">
                <span class="run-dot s-${e.done ? 'done' : 'fast'}"></span>
                <span class="run-text"><b>Batch ${b.id}</b><small>${esc(b.label)}</small></span>
                <span class="run-pct">${e.done ? '✓' : `${p.done}/${b.runIds.length}`}</span>
              </button>
              <button class="run-x" data-discard-batch="${b.id}" aria-label="Discard batch ${b.id}" title="Discard batch">×</button>
            </div>`;
              }
              const r = e.r;
              const c = r.cfg;
              return `
            <div class="run-item${r === S.active ? ' current' : ''}" data-run-id="${r.id}">
              <button class="run-open" data-open="${r.id}" ${r === S.active ? 'aria-current="true"' : ''}>
                <span class="run-dot s-${runStatus(r)}"></span>
                <span class="run-text"><b>${r.auto ? 'Demo run' : `Run ${r.id}`}</b><small>${r.auto ? 'not recorded · ' : ''}${esc(c.scenario)} · ${c.floors}×${c.cars} · seed ${c.seed}</small></span>
                <span class="run-pct" data-pct="${r.id}"></span>
              </button>
              ${solo.length > 1 ? `<button class="run-x" data-discard="${r.id}" aria-label="Discard run ${r.id}" title="Discard run">×</button>` : ''}
            </div>`;
            })
            .join('')
        : '<p class="run-empty">No live runs. Switch to All to see finished ones.</p>';
      // Keep the run being viewed in sight when it changes.
      if (runListUi.current !== S.active?.id) {
        runListUi.current = S.active?.id;
        host.querySelector('.run-item.current')?.scrollIntoView({ block: 'nearest' });
      }
      host.classList.toggle('scrolls', host.scrollHeight > host.clientHeight + 1);
    }
    for (const r of solo) {
      const n = host.querySelector(`[data-pct="${r.id}"]`);
      if (!n) continue;
      const total = r.worlds.reduce((a, w) => a + w.total, 0);
      const got = r.worlds.reduce((a, w) => a + w.stats.delivered, 0);
      n.textContent = r.done ? '✓' : `${Math.floor((got / total) * 100)}%`;
    }
  }

  // ── Benchmark batches ─────────────────────────────────────────────────
  //
  // One definition repeated over consecutive seeds (optionally with and
  // without the car fault), all at max speed in the background. They feed
  // the Leaderboard; the sidebar shows each batch as one entry.

  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function batchProgress(b) {
    const done = b.runIds.filter((id) => {
      const r = S.runs.find((x) => x.id === id);
      return !r || r.done; // discarded runs no longer block the batch
    }).length;
    return { done };
  }

  const familyOf = (def) => {
    const s = specFor(def);
    return EDA.leaderboard.familyKey({ sim: EDA.history.SIM_VERSION, def: { scenario: s.name, scenarioKey: EDA.scenario.scenarioKey(s), floors: def.floors, cars: def.cars, events: def.events, timing: def.timing } });
  };

  function launchBatch(def) {
    const id = S.nextBatch++;
    const seeds = Array.from({ length: def.reps }, (_, i) => def.seed + i);
    const variants = def.pairs ? [true, false] : [def.events.fault];
    const runIds = [];
    for (const seed of seeds) {
      for (const fault of variants) {
        const run = createRun({ ...def, seed, events: { ...def.events, fault }, mode: 'fast', reps: 1, pairs: false });
        run.batch = id;
        runIds.push(run.id);
      }
    }
    const ev = [def.events.heavy && 'heavy', def.pairs ? 'fault ±' : def.events.fault && 'fault', def.events.spike && 'spike'].filter(Boolean).join(' · ');
    S.batches.push({ id, createdAt: Date.now(), runIds, label: `${specFor(def).name} · ${def.floors}×${def.cars} · ${def.reps} seeds${ev ? ` · ${ev}` : ''}`, family: familyOf(def) });
    renderRunList(true);
    return S.batches[S.batches.length - 1];
  }

  function discardBatch(id) {
    const b = S.batches.find((x) => x.id === id);
    if (!b) return;
    for (const rid of b.runIds) {
      const i = S.runs.findIndex((r) => r.id === rid);
      if (i < 0) continue;
      const [run] = S.runs.splice(i, 1);
      if (!run.done) store.setStatus(run.id, 'stopped');
      run.noRecord = true;
    }
    S.batches = S.batches.filter((x) => x !== b);
    renderRunList(true);
    toast(`Batch ${id} discarded`);
  }

  function discardRun(id) {
    const i = S.runs.findIndex((r) => r.id === id);
    if (i < 0 || S.runs.filter((r) => !r.batch).length < 2) return;
    const [run] = S.runs.splice(i, 1);
    if (!run.done) store.setStatus(run.id, 'stopped');
    run.noRecord = true;
    if (run === S.active) mount(S.runs.filter((r) => !r.batch).at(-1));
    else renderRunList(true);
    toast(`Run ${id} discarded`);
  }

  // ── New experiment dialog ─────────────────────────────────────────────

  const PRESETS = { low: [6, 3], mid: [12, 4], tower: [24, 6], sky: [60, 10], mega: [120, 16] };
  const draft = { contestants: [...DEFAULT_PAIR], scenarioId: 'morning-wave', floors: 6, cars: 3, seed: 0x5eed, events: { ...DEFAULT_EVENTS }, timing: { ...EDA.scenario.DEFAULT_TIMING }, mode: 'timeline', reps: 1, pairs: false };

  // Fine steps inside the drawable range, coarse ones beyond it.
  function stepValue(k, d) {
    const v = draft[k];
    if (k === 'floors') {
      if (d > 0) return v >= VISUAL_MAX.floors ? v + 6 : v + 1;
      return v > VISUAL_MAX.floors ? Math.max(VISUAL_MAX.floors, v - 6) : v - 1;
    }
    return v + d;
  }

  function renderDraft() {
    $('nx-floors').textContent = draft.floors;
    $('nx-cars').textContent = draft.cars;
    document.querySelectorAll('[data-step]').forEach((b) => {
      const [k, d] = b.dataset.step.split(':');
      const next = stepValue(k, Number(d));
      b.disabled = next < LIMITS[k][0] || next > LIMITS[k][1];
    });
    document.querySelectorAll('[data-preset]').forEach((b) => {
      const [f, c] = PRESETS[b.dataset.preset];
      b.classList.toggle('on', f === draft.floors && c === draft.cars);
    });
    const stats = draft.floors > VISUAL_MAX.floors || draft.cars > VISUAL_MAX.cars;
    const detail = stats ? 'stats' : EDA.util.geometry(draft.floors, draft.cars).detail;
    $('nx-drawing').textContent =
      detail === 'stats'
        ? 'No drawing: stats board only (above 24 floors or 6 cars)'
        : detail === 'full'
          ? 'Drawn with full pictograms'
          : detail === 'compact'
            ? 'Drawn with compact pictograms'
            : 'Drawn with dots (circle lights)';
    $('nx-seed').value = draft.seed;
    // Scenario picker, and event descriptions for this scenario and building.
    const spec = specFor(draft);
    const all = scenarios.all();
    $('nx-scenario').innerHTML = [
      ['Catalog', all.filter((s) => s.builtIn)],
      ['Custom', all.filter((s) => !s.builtIn)],
    ]
      .filter(([, list]) => list.length)
      .map(([label, list]) => `<optgroup label="${label}">${list.map((s) => `<option value="${s.id}">${esc(s.name)} · v${s.version}</option>`).join('')}</optgroup>`)
      .join('');
    $('nx-scenario').value = spec.id;
    $('nx-scenario-desc').textContent = spec.description ?? '';
    // Lane pickers, from the registry, models and algorithms kept apart.
    const reg = EDA.registry.list();
    // A live pick whose runner went away falls back to the default lane.
    draft.contestants = draft.contestants.map((c, i) => (byCid(c) ? c : DEFAULT_PAIR[i]));
    const live = reg.filter((p) => p.live);
    const laneOpts = (sel) =>
      [
        ['Live models · arena runner', live],
        ['Deterministic algorithms', reg.filter((p) => p.kind === 'algorithm')],
      ]
        .filter(([, list]) => list.length)
        .map(
          ([label, list]) =>
            `<optgroup label="${label}">${list
              .map((p) => `<option value="${p.cid}" ${p.cid === sel ? 'selected' : ''} ${p.live && !p.available ? 'disabled' : ''}>${esc(p.name)} · ${esc(p.version)}${p.live && !p.available ? ' · offline' : ''}</option>`)
              .join('')}</optgroup>`
        )
        .join('');
    ['A', 'B'].forEach((k, i) => {
      $(`nx-lane-${k}`).innerHTML = laneOpts(draft.contestants[i]);
      const p = byCid(draft.contestants[i]);
      $(`nx-lane-${k}-d`).textContent = p ? `${p.live ? 'Live model' : p.kind === 'model' ? 'Model' : 'Algorithm'} · ${p.description}${p.live ? ` · ${p.status}` : ''}` : '';
    });
    const same = draft.contestants[0] === draft.contestants[1];
    const offline = draft.contestants.map(byCid).find((p) => p.live && !p.available);
    const calls = draft.contestants.map(byCid).filter((p) => p.live);
    $('nx-lane-note').textContent = same
      ? 'Pick two different contestants: a policy against itself tells you nothing.'
      : offline
        ? `${offline.name} ${offline.version} is offline: ${offline.status}`
        : calls.length
          ? `Real model calls: ${calls.map((p) => `${p.name} (${p.external ?? 'local'})`).join(', ')}. The run pauses while an answer is out; each answer lands after its measured time.${calls.some((p) => p.external) ? ' API calls cost about $0.00002 each, a few hundred per run.' : ''}`
          : byCid(draft.contestants[0]).id === byCid(draft.contestants[1]).id
            ? 'Two versions of the same policy: a version comparison.'
            : '';
    // Say plainly when live models can't be here at all: a page not served
    // by the arena runner has only the algorithms.
    if (!same && !offline && EDA.live.state.checked && !EDA.live.state.connected) {
      $('nx-lane-note').textContent = `${$('nx-lane-note').textContent} Live models aren't available on this page: it isn't served by the arena runner. Open http://127.0.0.1:8787/ for local Laya and the Jev API.`.trim();
    }
    $('nx-lane-note').classList.toggle('bad', same || !!offline);
    $('nx-launch').disabled = same || !!offline;
    const labels = EDA.scenario.eventLabels(spec, draft.floors, draft.cars);
    for (const k of Object.keys(DEFAULT_EVENTS)) {
      $(`nx-ev-${k}`).checked = draft.events[k];
      $(`nx-ev-${k}-t`).textContent = labels[k];
    }
    $('nx-fault-note').hidden = draft.cars > 1;
    // Decision timing applies to both lanes; the setup check reads it.
    const T = EDA.scenario.normTiming(draft.timing);
    $('nx-timing').value = T.mode;
    $('nx-timeout').value = String(T.timeout);
    $('nx-timeout').disabled = T.mode === 'fixed';
    $('nx-timing-note').textContent =
      T.mode === 'fixed'
        ? `Every decision takes ${T.fixedS} s in both lanes, whoever makes it. Speed can't affect the result.`
        : T.timeout === 'own'
          ? 'Decisions land after the time they took. Each contestant keeps its own timeout, after which its fallback decides.'
          : `Decisions land after the time they took. After ${T.timeout} s, in either lane, the contestant's fallback decides.`;
    const [pa, pb] = draft.contestants.map(byCid);
    $('nx-setup').innerHTML = same ? '' : EDA.setupView.panel(EDA.setup.check(pa, pb, { timing: T, reps: draft.reps }), pa, pb);
    const batch = draft.reps > 1 || draft.pairs;
    $('nx-reps').value = String(draft.reps);
    $('nx-pairs').checked = draft.pairs;
    const n = draft.reps * (draft.pairs ? 2 : 1);
    $('nx-reps-note').textContent = batch
      ? `Launches ${n} runs at max speed, seeds ${draft.seed}–${draft.seed + draft.reps - 1}${draft.pairs ? ', each with and without the car fault' : ''}. They run in the background and feed the Leaderboard.`
      : 'A single run. Repeat over several seeds to get rankings with confidence intervals.';
    // Batches always compute at max speed; the Start-in choice is for single runs.
    document.querySelectorAll('[data-nx-mode]').forEach((b) => {
      b.classList.toggle('on', batch ? b.dataset.nxMode === 'fast' : b.dataset.nxMode === draft.mode);
      b.disabled = batch;
    });
    $('nx-launch').lastChild.textContent = batch ? `Launch batch (${n} runs)` : 'Launch run';
  }

  function openNewExperiment() {
    // Start from the run being viewed, so a variation is one change away.
    const d = S.active ? S.active.def : draft;
    Object.assign(draft, { scenarioId: 'morning-wave', contestants: [...DEFAULT_PAIR], ...d, events: { ...d.events }, timing: { ...EDA.scenario.normTiming(d.timing) }, reps: 1, pairs: false });
    draft.contestants = [...draft.contestants];
    delete draft.scenarioSpec;
    if (!scenarios.get(draft.scenarioId)) draft.scenarioId = 'morning-wave';
    renderDraft();
    setMenu(false);
    $('new-exp').showModal();
  }

  function launch() {
    const seed = Math.floor(Number($('nx-seed').value));
    draft.seed = Number.isFinite(seed) && seed >= 0 ? seed : 0x5eed;
    if (draft.reps > 1 || draft.pairs) {
      const b = launchBatch({ ...draft, events: { ...draft.events } });
      $('new-exp').close();
      showPage('leaderboard', b.family);
      toast(`Batch ${b.id} started: ${b.runIds.length} runs at max speed`);
      return;
    }
    const run = createRun(draft);
    $('new-exp').close();
    mount(run);
    if (S.page !== 'arena') showPage('arena');
    toast(`Run ${run.id} started`);
  }

  // ── Controls ──────────────────────────────────────────────────────────

  function syncControls() {
    const run = S.active;
    const b = $('btn-play');
    b.innerHTML = `<svg class="ico"><use href="#i-${run.playing ? 'pause' : 'play'}"/></svg>`;
    b.setAttribute('aria-label', run.playing ? 'Pause' : 'Play');
    b.disabled = run.done;
    document.body.classList.toggle('paused', !run.playing);
    document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === run.speed));
  }

  function setPlaying(on) {
    const run = S.active;
    if (run.done) return;
    run.playing = on;
    syncControls();
    renderRunList(true);
  }

  function setSpeed(x) {
    S.active.speed = x;
    syncControls();
  }

  function step() {
    const run = S.active;
    if (run.done) return;
    setPlaying(false);
    if (run.mode === 'fast') {
      for (let n = 0; n < 30; n++) run.worlds.forEach((w, i) => w.finishedAt === null && stepWorld(run, i));
      fireMarkers(run);
    } else advance(run, 0.5);
  }

  // Rerun the same definition from the start, as a fresh run in the session.
  function rerun() {
    const run = createRun(S.active.def);
    mount(run);
    toast(`Run ${run.id}: same settings as before`);
  }

  function toast(text) {
    const n = $('toast');
    n.textContent = text;
    n.classList.remove('show');
    void n.offsetWidth;
    n.classList.add('show');
  }

  const THEMES = ['auto', 'light', 'dark'];

  function applyTheme(th) {
    if (th === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = th;
    $('btn-theme').title = `Theme: ${th} (T)`;
    try {
      localStorage.setItem('eda-theme', th);
    } catch (_) {
      /* storage unavailable */
    }
  }

  function currentTheme() {
    return document.documentElement.dataset.theme ?? 'auto';
  }

  // Mobile navigation drawer.
  function setMenu(open) {
    const sb = $('sidebar');
    sb.classList.toggle('open', open);
    $('scrim').classList.toggle('show', open);
    $('btn-menu').setAttribute('aria-expanded', String(open));
    if (open) $('btn-close-menu').focus();
    else if (sb.contains(document.activeElement)) $('btn-menu').focus();
  }

  const menuOpen = () => $('sidebar').classList.contains('open');

  // Desktop icon rail. Labels stay in the accessibility tree; titles give
  // sighted users a tooltip while the text is hidden.
  function setCollapsed(on) {
    document.body.classList.toggle('sb-collapsed', on);
    const b = $('btn-collapse');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Expand sidebar ([)' : 'Collapse sidebar ([)';
    b.querySelector('.nav-label').textContent = on ? 'Expand sidebar' : 'Collapse sidebar';
    document.querySelectorAll('.nav a.nav-item').forEach((a) => {
      if (on) a.title = a.querySelector('.nav-label').textContent;
      else a.removeAttribute('title');
    });
    try {
      localStorage.setItem('eda-sb', on ? 'collapsed' : 'expanded');
    } catch (_) {
      /* storage unavailable */
    }
  }

  function wire() {
    $('btn-menu').addEventListener('click', () => setMenu(true));
    $('btn-close-menu').addEventListener('click', () => setMenu(false));
    $('scrim').addEventListener('click', () => setMenu(false));
    document.querySelectorAll('.nav a.nav-item').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (a.dataset.soon) toast(`${a.dataset.soon} arrives in a later phase`);
        else if (a.dataset.page) showPage(a.dataset.page);
        setMenu(false);
      })
    );
    $('run-toggle').addEventListener('click', () => {
      runListUi.open = !runListUi.open;
      renderRunList(true);
    });
    document.querySelectorAll('[data-runfilter]').forEach((b) =>
      b.addEventListener('click', () => {
        runListUi.filter = b.dataset.runfilter;
        renderRunList(true);
      })
    );
    $('run-more').addEventListener('click', (e) => {
      e.preventDefault();
      showPage('history');
      setMenu(false);
    });
    $('run-list').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      const bx = e.target.closest('[data-discard-batch]');
      const bo = e.target.closest('[data-batch]');
      if (bx) return discardBatch(Number(bx.dataset.discardBatch));
      if (bo) {
        const b = S.batches.find((x) => x.id === Number(bo.dataset.batch));
        if (b) showPage('leaderboard', b.family);
        setMenu(false);
        return;
      }
      const x = e.target.closest('[data-discard]');
      if (x) discardRun(Number(x.dataset.discard));
      else if (open) {
        const run = S.runs.find((r) => r.id === Number(open.dataset.open));
        if (run && run !== S.active) mount(run);
        if (S.page !== 'arena') showPage('arena');
        setMenu(false);
      }
    });
    document.querySelectorAll('[data-new-exp]').forEach((b) => b.addEventListener('click', openNewExperiment));

    // New experiment dialog
    document.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        const [k, d] = b.dataset.step.split(':');
        draft[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], stepValue(k, Number(d))));
        renderDraft();
      })
    );
    document.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        [draft.floors, draft.cars] = PRESETS[b.dataset.preset];
        renderDraft();
      })
    );
    for (const k of Object.keys(DEFAULT_EVENTS)) $(`nx-ev-${k}`).addEventListener('change', (e) => (draft.events[k] = e.target.checked));
    // Keep the typed seed in the draft, so other dialog clicks don't reset it.
    $('nx-seed').addEventListener('input', (e) => {
      const v = Math.floor(Number(e.target.value));
      if (Number.isFinite(v) && v >= 0) draft.seed = v;
    });
    $('nx-seed-random').addEventListener('click', () => {
      draft.seed = Math.floor(Math.random() * 99999) + 1;
      renderDraft();
    });
    $('nx-timing').addEventListener('change', (e) => {
      draft.timing = { ...draft.timing, mode: e.target.value };
      renderDraft();
    });
    $('nx-timeout').addEventListener('change', (e) => {
      draft.timing = { ...draft.timing, timeout: e.target.value === 'own' ? 'own' : Number(e.target.value) };
      renderDraft();
    });
    // One-click fixes offered by the setup check.
    $('nx-setup').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sc-act]');
      if (!b) return;
      if (b.dataset.scAct === 'shared-timeout') draft.timing = { ...draft.timing, mode: 'measured', timeout: 1.5 };
      if (b.dataset.scAct === 'fixed') draft.timing = { ...draft.timing, mode: 'fixed' };
      renderDraft();
    });
    document.querySelectorAll('[data-nx-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        draft.mode = b.dataset.nxMode;
        renderDraft();
      })
    );
    ['A', 'B'].forEach((k, i) =>
      $(`nx-lane-${k}`).addEventListener('change', (e) => {
        draft.contestants[i] = e.target.value;
        renderDraft();
      })
    );
    $('nx-lane-swap').addEventListener('click', () => {
      draft.contestants.reverse();
      renderDraft();
    });
    // A new scenario brings its own event defaults.
    $('nx-scenario').addEventListener('change', (e) => {
      draft.scenarioId = e.target.value;
      draft.events = EDA.scenario.defaultEvents(specFor(draft));
      renderDraft();
    });
    $('nx-reps').addEventListener('change', (e) => {
      draft.reps = Number(e.target.value);
      renderDraft();
    });
    $('nx-pairs').addEventListener('change', (e) => {
      draft.pairs = e.target.checked;
      renderDraft();
    });
    $('nx-launch').addEventListener('click', (e) => {
      e.preventDefault();
      launch();
    });
    $('nx-cancel').addEventListener('click', () => $('new-exp').close());

    // Live controls
    document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => setRunMode(b.dataset.run)));
    $('btn-collapse').addEventListener('click', () => setCollapsed(!document.body.classList.contains('sb-collapsed')));
    matchMedia('(min-width: 1024px)').addEventListener('change', (e) => e.matches && setMenu(false));
    $('btn-play').addEventListener('click', () => setPlaying(!S.active.playing));
    $('btn-step').addEventListener('click', step);
    $('btn-restart').addEventListener('click', rerun);
    $('btn-theme').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]));
    document.querySelectorAll('#speed button').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));

    document.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape' && menuOpen()) {
        setMenu(false);
        return;
      }
      if (menuOpen()) return;
      if (S.page === 'audit' && S.audit.key(k)) {
        e.preventDefault();
        return;
      }
      // Run controls only apply while looking at a run.
      if (S.page !== 'arena' && !['h', 'a', 'l', 's', 'c', 'p', 'n', 't', '['].includes(k)) return;
      if (k === ' ') {
        e.preventDefault();
        setPlaying(!S.active.playing);
      } else if (k === 'arrowright' || k === '.') step();
      else if (k === '1' || k === '2' || k === '4') setSpeed(Number(k));
      else if (k === 'm') setRunMode(S.active.mode === 'fast' ? 'timeline' : 'fast');
      else if (k === 'n') openNewExperiment();
      else if (k === 'h') showPage(S.page === 'history' ? 'arena' : 'history');
      else if (k === 'a') showPage(S.page === 'audit' ? 'arena' : 'audit');
      else if (k === 'l') showPage(S.page === 'leaderboard' ? 'arena' : 'leaderboard');
      else if (k === 's') showPage(S.page === 'sla' ? 'arena' : 'sla');
      else if (k === 'c') showPage(S.page === 'scenarios' ? 'arena' : 'scenarios');
      else if (k === 'p') showPage(S.page === 'contestants' ? 'arena' : 'contestants');
      else if (k === 'r') rerun();
      else if (k === 't') $('btn-theme').click();
      else if (k === '[' && matchMedia('(min-width: 1024px)').matches) $('btn-collapse').click();
    });

    try {
      const saved = localStorage.getItem('eda-theme');
      if (saved && THEMES.includes(saved)) applyTheme(saved);
      if (localStorage.getItem('eda-sb') === 'collapsed') setCollapsed(true);
    } catch (_) {
      /* storage unavailable */
    }
  }

  // The first run of the session: defaults, or a layout from the URL
  // (e.g. #floors=60&cars=10).
  const hash = new URLSearchParams(location.hash.slice(1));
  const first = { ...draft, events: { ...draft.events } };
  if (hash.has('floors')) first.floors = Math.min(LIMITS.floors[1], Math.max(LIMITS.floors[0], Number(hash.get('floors')) || 6));
  if (hash.has('cars')) first.cars = Math.min(LIMITS.cars[1], Math.max(LIMITS.cars[0], Number(hash.get('cars')) || 3));
  if (first.floors > VISUAL_MAX.floors || first.cars > VISUAL_MAX.cars) first.mode = 'fast';

  S.history = new EDA.HistoryView($('view-history'), store, historyApi);
  S.audit = new EDA.AuditView($('view-audit'), auditApi);
  // Scenario catalog: start an experiment or batch from a scenario card.
  const useScenario = (spec, batch) => {
    openNewExperiment();
    Object.assign(draft, { scenarioId: spec.id, events: EDA.scenario.defaultEvents(spec) });
    if (batch) Object.assign(draft, { reps: 10, pairs: true });
    renderDraft();
  };
  // Contestant registry: put a contestant (or two versions) into lanes.
  S.contestants = new EDA.ContestantsView($('view-contestants'), store, {
    use(cids, timing) {
      openNewExperiment();
      if (timing) draft.timing = { ...EDA.scenario.normTiming(draft.timing), ...timing };
      const [a, b] = cids;
      draft.contestants[0] = a;
      if (b) draft.contestants[1] = b;
      else if (draft.contestants[1] === a) draft.contestants[1] = DEFAULT_PAIR.find((x) => x !== a);
      renderDraft();
    },
    leaderboard: () => showPage('leaderboard'),
  });
  S.scenarios = new EDA.ScenariosView($('view-scenarios'), scenarios, store, {
    use: (spec) => useScenario(spec, false),
    batch: (spec) => useScenario(spec, true),
  });

  // SLA evaluation needs both conditions, so its batches default to fault pairs.
  S.sla = new EDA.SlaView($('view-sla'), store, {
    newBatch(def) {
      openNewExperiment();
      if (def) Object.assign(draft, { floors: def.floors, cars: def.cars, events: { ...def.events } });
      Object.assign(draft, { reps: 10, pairs: true });
      renderDraft();
    },
  });
  S.leaderboard = new EDA.LeaderboardView($('view-leaderboard'), store, {
    newBatch(def) {
      openNewExperiment();
      if (def) Object.assign(draft, { floors: def.floors, cars: def.cars, events: { ...def.events } });
      Object.assign(draft, { reps: 10 });
      renderDraft();
    },
    batches: () =>
      S.batches.map((b) => ({ id: b.id, label: b.label, family: b.family, total: b.runIds.length, done: batchProgress(b).done })),
  });
  wire();
  // The page's own demo run is a showcase, not an experiment: it isn't
  // recorded, so Run history, Audit and the Leaderboard hold only runs the
  // user launched. The same run can be launched from New experiment.
  const demo = createRun({ ...first, demo: true });
  mount(demo);
  requestAnimationFrame(frame);

  // Live models join the registry once the runner answers.
  EDA.live.onChange((st) => {
    if (!st.connected) return;
    const up = st.contestants.filter((c) => c.available).length;
    $('page-foot').textContent =
      'The building, its traffic and physics are simulated. Decisions come from real algorithms and real models: local Laya and the Jev API, through the arena runner. Results are rankings within this simulation, not of real buildings.';
    $('sb-foot').textContent = `Simulated building and traffic. Decisions from real algorithms and ${up} of ${st.contestants.length} live models, through the arena runner.`;
    toast(`Arena runner connected: ${up} of ${st.contestants.length} live models available`);
    guard('live', () => {
      S.contestants.render(true);
      if ($('new-exp').open) renderDraft();
    });
  });
  EDA.live.connect();
})(window.EDA);
