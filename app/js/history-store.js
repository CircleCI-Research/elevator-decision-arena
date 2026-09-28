/*
 * Run history: one audit record per run, kept in browser storage.
 *
 * Limitation: records live in this browser's storage. Planned: immutable, exportable run records with
 * full event logs, prompts, schemas and dependency hashes. This stores just
 * enough to list, compare and replicate runs across page reloads.
 */
(function (EDA) {
  'use strict';

  const KEY = 'eda-history-v1';
  const CAP = 200;
  // 0.2: a passenger who stepped out to clear an overload no longer re-boards
  // the same car while it is still too full for them (0.1 let them retry at
  // every stop). Results differ, so runs from different versions never mix.
  const SIM_VERSION = 'mock-world 0.2';
  const SERIES_POINTS = 120;

  const { fnv } = EDA.util;

  // Everything that can change simulated results, and nothing that can't
  // (run mode and mock inference time only affect wall-clock).
  function definitionHash(cfg, contestants) {
    return fnv(
      JSON.stringify({
        sim: SIM_VERSION,
        scenario: cfg.scenarioKey ?? cfg.scenario, // Morning Wave keeps its original key
        floors: cfg.floors,
        cars: cfg.cars,
        seed: cfg.seed,
        events: cfg.events,
        contestants: contestants.map((c) => [c.key, c.policy.id, c.policy.version]),
        // Default timing adds nothing, so older definitions keep their hash.
        ...(EDA.scenario.isDefaultTiming(cfg.timing) ? {} : { timing: cfg.timing }),
      })
    );
  }

  // Simulated outcomes only; identical definitions must reproduce this.
  function resultFingerprint(results) {
    const keys = Object.keys(results).sort();
    return fnv(
      JSON.stringify(
        keys.map((k) => {
          const r = results[k];
          const f = (x, d) => (x == null ? null : Number(x.toFixed(d)));
          return [k, f(r.finishedAt, 3), r.delivered, f(r.avgWait, 3), f(r.p95Wait, 3), f(r.energyWh, 2), r.decisions];
        })
      )
    );
  }

  function downsample(series) {
    const step = Math.max(1, Math.ceil(series.length / SERIES_POINTS));
    const out = [];
    for (let i = 0; i < series.length; i += step) out.push([Math.round(series[i].t), series[i].waiting]);
    const last = series[series.length - 1];
    if (last && out[out.length - 1][0] !== Math.round(last.t)) out.push([Math.round(last.t), last.waiting]);
    return out;
  }

  function setupStamp(contestants, cfg) {
    const [a, b] = ['A', 'B'].map((k) => contestants.find((c) => c.key === k)?.policy);
    return a && b ? EDA.setup.stamp(EDA.setup.check(a, b, { timing: cfg.timing })) : null;
  }

  function fromRun(run, contestants, status) {
    const results = {};
    const series = {};
    run.worlds.forEach((w) => {
      const s = w.summary();
      results[w.id] = {
        delivered: s.delivered,
        total: s.total,
        finishedAt: s.finishedAt,
        avgWait: s.avgWait,
        p95Wait: s.p95Wait,
        longest: s.longest,
        energyWh: s.energyWh,
        regenWh: s.regenWh,
        emptyFloors: s.emptyFloors,
        decisions: s.decisions,
        avgLatency: s.avgLatency,
        decisionWh: s.decisionWh,
        vetoes: s.vetoes,
        fallbacks: s.fallbacks,
        ...(s.remoteDecisions ? { remoteDecisions: true } : {}),
        ...(s.apiTokens ? { apiTokens: s.apiTokens, apiCostUsd: s.apiCostUsd } : {}),
        ...(s.drifted ? { drifted: s.drifted } : {}),
        wall: s.wall,
        simT: s.t,
      };
      series[w.id] = downsample(w.series);
    });
    const done = run.worlds.map((w) => w.finishedAt);
    let winner = null;
    if (done.every((t) => t !== null)) {
      const best = Math.min(...done);
      const firsts = run.worlds.filter((w) => Math.abs(w.finishedAt - best) < 0.05);
      winner = firsts.length > 1 ? 'tie' : firsts[0].id;
    }
    const cfg = run.cfg;
    return {
      id: run.id,
      createdAt: run.createdAt,
      updatedAt: Date.now(),
      finishedAt: status === 'done' ? run.finishedWall ?? Date.now() : null,
      status,
      def: {
        scenario: cfg.scenario,
        scenarioId: cfg.scenarioId,
        scenarioVersion: cfg.scenarioVersion,
        scenarioKey: cfg.scenarioKey,
        ...(cfg.scenarioSpec && !cfg.scenarioSpec.builtIn ? { scenarioSpec: cfg.scenarioSpec } : {}),
        floors: cfg.floors,
        cars: cfg.cars,
        seed: cfg.seed,
        events: { ...cfg.events },
        timing: { ...cfg.timing },
        startMode: run.def.mode,
        passengers: run.passengers,
      },
      defHash: definitionHash(cfg, contestants),
      sim: SIM_VERSION,
      // Models and algorithms carry different provenance (see registry).
      contestants: contestants.map((c) => ({ key: c.key, ...EDA.registry.provenance(c.policy) })),
      // Whether the two lanes are a controlled comparison, under this timing.
      setup: setupStamp(contestants, cfg),
      modes: [...run.modes],
      winner,
      results,
      fingerprint: status === 'done' ? resultFingerprint(results) : null,
      series,
    };
  }

  class HistoryStore {
    constructor() {
      this.persistent = true;
      this.records = [];
      try {
        const raw = localStorage.getItem(KEY);
        const arr = raw ? JSON.parse(raw) : [];
        this.records = Array.isArray(arr) ? arr : [];
        localStorage.setItem(`${KEY}-probe`, '1');
        localStorage.removeItem(`${KEY}-probe`);
      } catch (_) {
        this.persistent = false; // private window or blocked storage: history lasts for this page only
      }
      this.version = 0;
    }

    save() {
      this.version++;
      if (!this.persistent) return;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.records));
      } catch (_) {
        this.persistent = false;
      }
    }

    nextId() {
      return this.records.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    }

    get(id) {
      return this.records.find((r) => r.id === id) ?? null;
    }

    upsert(rec) {
      const i = this.records.findIndex((r) => r.id === rec.id);
      if (i >= 0) this.records[i] = rec;
      else this.records.unshift(rec);
      // Keep the newest records; never drop one still running.
      if (this.records.length > CAP) {
        this.records.sort((a, b) => b.createdAt - a.createdAt);
        this.records = this.records.filter((r, n) => n < CAP || r.status === 'running');
      }
      this.save();
    }

    setStatus(id, status) {
      const r = this.get(id);
      if (!r || r.status === 'done') return;
      r.status = status;
      r.updatedAt = Date.now();
      this.save();
    }

    remove(id) {
      this.records = this.records.filter((r) => r.id !== id);
      this.save();
    }

    // Keeps records of runs that are still live in this session.
    clear(keepIds) {
      this.records = this.records.filter((r) => keepIds.has(r.id));
      this.save();
    }

    // A record still marked running from an earlier page load was cut off.
    markInterrupted() {
      let changed = false;
      for (const r of this.records) {
        if (r.status === 'running') {
          r.status = 'interrupted';
          changed = true;
        }
      }
      if (changed) this.save();
    }

    // Other finished runs of the same definition, and whether they agree.
    replication(rec) {
      if (rec.status !== 'done') return { peers: [], agree: 0, disagree: 0 };
      const peers = this.records.filter((r) => r.id !== rec.id && r.status === 'done' && r.defHash === rec.defHash);
      const agree = peers.filter((r) => r.fingerprint === rec.fingerprint).length;
      return { peers, agree, disagree: peers.length - agree };
    }
  }

  EDA.history = { HistoryStore, fromRun, definitionHash, fnv, SIM_VERSION };
})(window.EDA);
