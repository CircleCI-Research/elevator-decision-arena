/*
 * Audit & replay core: run files, replay and verification. No DOM.
 *
 * Principle: record the inputs, re-derive everything else. A run is fully
 * determined by its definition plus the decisions its policies made, so a
 * run file stores exactly that. Replay re-executes the definition with the
 * recorded decisions fed back in (it never asks the policy again — real
 * models are not repeatable), and verification checks that the replay
 * reproduces the recorded results.
 *
 * Planned: run files will also carry prompts, schemas, dependency
 * hashes and signatures, and live in an immutable store.
 */
(function (EDA) {
  'use strict';

  const { makeConfig, buildScript } = EDA.scenario;
  const { fromRun, definitionHash, fnv, SIM_VERSION } = EDA.history;
  const FORMAT = 'eda-run';
  const FORMAT_VERSION = 1;
  const KEY = (id) => `eda-audit-v1-${id}`;
  const INDEX = 'eda-audit-v1-index';
  const KEEP = 15; // newest run files kept in browser storage
  const H = 1 / 60;

  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

  function compactDecision(d) {
    return {
      n: d.id,
      t: d.startT,
      kind: d.kind,
      title: d.title,
      req: { ...d.req },
      options: d.options.map((o) => ({
        car: o.car,
        label: o.label,
        short: o.short,
        icon: o.icon,
        veto: o.veto ?? null,
        detail: o.detail,
        ...(o.eta !== undefined ? { eta: round(o.eta, 3) } : {}),
      })),
      probs: d.probs.map((p) => round(p)),
      choice: d.choice,
      latency: d.latency, // exact: it decides when the choice lands
      outcome: d.outcome,
      ...(d.trace ? { trace: d.trace } : {}),
      // Only when timing rules changed the decision, so older logs hash the same.
      ...(d.measured != null && d.measured !== d.latency ? { measured: d.measured } : {}),
      ...(d.fallback ? { fallback: { ...d.fallback, probs: d.fallback.probs.map((p) => round(p)) } } : {}),
      // Live models: what the endpoint reported, and the exact request and
      // response, so a decision can be checked without re-asking the model.
      ...(d.live ? { live: { ...d.live } } : {}),
      ...(d.io ? { io: d.io } : {}),
    };
  }

  // Integrity of the decision log itself. Replay catches any edit that
  // changes what happened; this also catches edits that changed nothing.
  // Limitation: a recomputable hash is not tamper-proof — that needs signed
  // run files.
  function decisionsHash(decisions) {
    return fnv(JSON.stringify(Object.keys(decisions).sort().map((k) => [k, decisions[k]])));
  }

  function compactLogs(run) {
    return Object.fromEntries(run.worlds.map((w) => [w.id, w.decisionLog.map(compactDecision)]));
  }

  // ── Run files ─────────────────────────────────────────────────────────

  function bundleFromRun(run, contestants) {
    const rec = fromRun(run, contestants, run.done ? 'done' : 'running');
    const decisions = compactLogs(run);
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      simulator: SIM_VERSION,
      note: 'Elevator Decision Arena run file: simulated building and traffic; decisions from the contestants listed (live models recorded, never re-asked).',
      run: { id: run.id, createdAt: rec.createdAt, finishedAt: rec.finishedAt, status: rec.status, modes: rec.modes },
      definition: rec.def,
      scenarioSpec: run.cfg.scenarioSpec,
      defHash: rec.defHash,
      contestants: rec.contestants,
      decisions,
      decisionsHash: decisionsHash(decisions),
      results: rec.results,
      fingerprint: rec.fingerprint,
    };
  }

  function validate(b) {
    if (!b || b.format !== FORMAT) throw new Error('Not an Elevator Decision Arena run file');
    if (b.formatVersion !== FORMAT_VERSION) throw new Error(`Unsupported run file version ${b.formatVersion}`);
    if (!b.definition || !b.decisions || !Array.isArray(b.contestants)) throw new Error('Run file is missing its definition or decisions');
    for (const c of b.contestants) {
      // A contestant no longer registered (a live model with the runner off,
      // or a retired one such as the early scripted stand-ins) replays from its record.
      if (!Array.isArray(b.decisions[c.key])) throw new Error(`No decisions recorded for contestant ${c.key}`);
    }
    return b;
  }

  const storage = {
    available: true,
    ids() {
      try {
        return JSON.parse(localStorage.getItem(INDEX) || '[]');
      } catch (_) {
        this.available = false;
        return [];
      }
    },
    save(bundle) {
      try {
        const ids = this.ids().filter((id) => id !== bundle.run.id);
        ids.unshift(bundle.run.id);
        for (const old of ids.slice(KEEP)) localStorage.removeItem(KEY(old));
        localStorage.setItem(KEY(bundle.run.id), JSON.stringify(bundle));
        localStorage.setItem(INDEX, JSON.stringify(ids.slice(0, KEEP)));
        return true;
      } catch (_) {
        this.available = false; // quota or blocked storage: the run file stays session-only
        return false;
      }
    },
    load(id) {
      try {
        const raw = localStorage.getItem(KEY(id));
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },
    remove(id) {
      try {
        localStorage.removeItem(KEY(id));
        localStorage.setItem(INDEX, JSON.stringify(this.ids().filter((x) => x !== id)));
      } catch (_) {
        /* ignore */
      }
    },
    clear() {
      for (const id of this.ids()) localStorage.removeItem(KEY(id));
      try {
        localStorage.removeItem(INDEX);
      } catch (_) {
        /* ignore */
      }
    },
  };

  // ── Replay ────────────────────────────────────────────────────────────

  const sameRequest = (a, b) => a.kind === b.kind && a.floor === b.floor && a.dir === b.dir && a.car === b.car && a.reason === b.reason;

  // Stands in for a contestant and hands back what it decided at the time.
  class ReplayPolicy {
    constructor(base, log) {
      Object.assign(this, { id: base.id, name: base.name, kind: base.kind, version: base.version, identity: base.identity, salt: base.salt, decisionWh: base.decisionWh, limits: base.limits, fallback: base.fallback, cid: base.cid });
      this.base = base;
      this.log = log;
      this.i = 0;
      this.captured = []; // { rec, obs, match }
      this.divergedAt = null; // first decision that didn't line up with the record
    }

    decide(req, obs, rng) {
      const rec = this.divergedAt === null ? this.log[this.i++] : undefined;
      const match = !!rec && sameRequest(rec.req, req);
      this.captured.push({ rec: match ? rec : null, expected: rec ?? null, obs, match, req: { ...req } });
      // Once the replay asks something the record didn't, the record no longer
      // applies: note where, and let the policy decide live from here on.
      if (!match) {
        if (this.divergedAt === null) this.divergedAt = { n: this.captured.length, t: obs.t };
        return this.base.decide(req, obs, rng);
      }
      return {
        kind: rec.kind,
        title: rec.title,
        options: rec.options.map((o) => ({ ...o })),
        probs: rec.probs.slice(),
        choice: rec.choice,
        latency: rec.latency,
        ...(rec.trace ? { trace: rec.trace } : {}),
        ...(rec.measured != null ? { measured: rec.measured } : {}),
        ...(rec.fallback ? { fallback: { ...rec.fallback } } : {}),
        ...(rec.live ? { live: { ...rec.live } } : {}),
        ...(rec.io ? { io: rec.io } : {}),
      };
    }
  }

  // Fresh worlds that replay a run file, for the player or for verification.
  function replayWorlds(bundle) {
    const d = bundle.definition;
    // Files made before the catalog existed are Morning Wave.
    const scenario = bundle.scenarioSpec ?? d.scenarioSpec ?? EDA.scenario.byId(d.scenarioId ?? 'morning-wave') ?? EDA.scenario.CATALOG[0];
    const cfg = makeConfig(d.floors, d.cars, { seed: d.seed, events: d.events, scenario, timing: d.timing });
    const script = buildScript(cfg);
    // Registered contestants replay through the registry; anyone else (a
    // live model without its runner, a retired stand-in) from the record alone.
    const contestants = bundle.contestants.map((c) => ({ key: c.key, policy: EDA.registry.get(c.id, c.version) ?? EDA.registry.recorded(c) }));
    const worlds = contestants.map((c) => new EDA.World({ id: c.key, cfg, script, policy: new ReplayPolicy(c.policy, bundle.decisions[c.key]) }));
    return { cfg, script, contestants, worlds };
  }

  // Replays the whole run headless and checks it against the record.
  // `reference` is this browser's own history record of the run, if any.
  function verify(bundle, reference = null) {
    const t0 = performance.now();
    const { cfg, contestants, worlds } = replayWorlds(bundle);
    const events = [];
    // Each contestant replays exactly as far as it got in the recorded run.
    const target = (w) => bundle.results[w.id].finishedAt ?? bundle.results[w.id].simT ?? 0;
    const busy = (w) => w.finishedAt === null && w.t < target(w) - 1e-9;
    while (worlds.some(busy)) {
      for (const w of worlds) {
        if (!busy(w)) continue;
        w.step(H);
        for (const ev of w.events.splice(0)) events.push(ev);
      }
    }
    events.sort((a, b) => a.t - b.t);
    // Wall-clock is not part of the replay; carry the recorded values over.
    const fake = { worlds, cfg, def: { mode: bundle.definition.startMode }, modes: new Set(bundle.run.modes), passengers: bundle.definition.passengers, createdAt: bundle.run.createdAt, id: bundle.run.id };
    for (const w of worlds) w.wall = bundle.results[w.id]?.wall ?? 0;
    const finished = worlds.every((w) => w.finishedAt !== null);
    const rec = fromRun(fake, contestants, finished ? 'done' : 'running');
    const decisions = Object.fromEntries(
      worlds.map((w) => {
        const p = w.policy;
        return [w.id, { captured: p.captured, recorded: p.log.length, replayed: p.captured.length, matched: p.captured.filter((c) => c.match).length, divergedAt: p.divergedAt }];
      })
    );
    // Hashed under the simulator id the file was recorded with (it may be a former name).
    const defHash = definitionHash(cfg, contestants, bundle.simulator ?? SIM_VERSION);
    const logHash = decisionsHash(bundle.decisions);
    const sameRun = reference && reference.defHash === bundle.defHash && reference.createdAt === bundle.run.createdAt;
    return {
      logHash,
      logHashOk: bundle.decisionsHash ? logHash === bundle.decisionsHash : null,
      reference: sameRun && reference.decisionsHash ? { id: reference.id, ok: reference.decisionsHash === logHash && (!reference.fingerprint || reference.fingerprint === rec.fingerprint) } : null,
      ms: performance.now() - t0,
      finished,
      endT: Math.max(...worlds.map((w) => w.t)),
      events,
      decisions,
      defHash,
      defHashOk: defHash === bundle.defHash,
      fingerprint: rec.fingerprint,
      fingerprintOk: bundle.fingerprint ? rec.fingerprint === bundle.fingerprint : null,
      decisionsOk: Object.values(decisions).every((d) => d.matched === d.recorded && d.replayed === d.recorded),
    };
  }

  function fileName(bundle) {
    const d = bundle.definition;
    return `eda-run-${bundle.run.id}-${d.floors}x${d.cars}-seed${d.seed}.json`;
  }

  EDA.audit = { bundleFromRun, validate, storage, replayWorlds, verify, fileName, decisionsHash, compactLogs, ReplayPolicy };
})(window.EDA);
