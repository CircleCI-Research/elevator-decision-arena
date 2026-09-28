/*
 * SLA lab core: versioned SLA definitions and their evaluation. No DOM.
 *
 * An SLA is a set of clauses (metric, threshold, condition) plus a required
 * compliance rate and a minimum number of runs. It is evaluated against the
 * recorded runs of an experiment family, split into normal runs (car fault
 * off) and failure runs (car fault on). A run meets the SLA only if every
 * clause that applies to its condition passes.
 *
 * Saved SLAs are immutable: editing makes a new version, so thresholds
 * can't be moved quietly after the results are in.
 */
(function (EDA) {
  'use strict';

  const { fnv } = EDA.history;
  const KEY = 'eda-sla-v1';

  const METRICS = {
    p95Wait: { label: 'P95 wait', unit: 's', get: (r) => r.p95Wait },
    avgWait: { label: 'Average wait', unit: 's', get: (r) => r.avgWait },
    longest: { label: 'Longest wait', unit: 's', get: (r) => r.longest },
    finishedAt: { label: 'Time to clear the wave', unit: 'clock', get: (r) => r.finishedAt },
    energyPerPax: { label: 'Energy per passenger', unit: 'Wh', get: (r) => (r.delivered ? r.energyWh / r.delivered : null) },
    vetoes: { label: 'Safety vetoes per run', unit: 'count', get: (r) => r.vetoes },
    decTime: { label: 'Avg decision time', unit: 'ms', get: (r) => (r.avgLatency == null ? null : r.avgLatency * 1000) },
  };
  const CONDITIONS = { both: 'Normal & failure', normal: 'Normal only', failure: 'Failure only' };

  const DEFAULT_SLA = {
    name: 'Office tower · baseline',
    target: 0.9,
    minRuns: 10,
    clauses: [
      { metric: 'p95Wait', max: 60, when: 'both' },
      { metric: 'longest', max: 90, when: 'normal' },
      { metric: 'longest', max: 120, when: 'failure' },
      { metric: 'finishedAt', max: 150, when: 'normal' },
      { metric: 'finishedAt', max: 180, when: 'failure' },
      { metric: 'decTime', max: 1000, when: 'both' },
      { metric: 'vetoes', max: 0, when: 'both' },
    ],
  };

  const slaHash = (s) => fnv(JSON.stringify({ target: s.target, minRuns: s.minRuns, clauses: s.clauses.map((c) => [c.metric, c.max, c.when]) }));

  class SlaStore {
    constructor() {
      this.persistent = true;
      this.items = [];
      try {
        const raw = localStorage.getItem(KEY);
        this.items = raw ? JSON.parse(raw) : [];
      } catch (_) {
        this.persistent = false;
      }
      if (!this.items.length) this.add(DEFAULT_SLA);
    }

    save() {
      if (!this.persistent) return;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.items));
      } catch (_) {
        this.persistent = false;
      }
    }

    get(id) {
      return this.items.find((s) => s.id === id) ?? null;
    }

    // Commits a new immutable version; same name → next version number.
    add(def) {
      const version = 1 + this.items.filter((s) => s.name === def.name).reduce((m, s) => Math.max(m, s.version), 0);
      const sla = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: def.name,
        version,
        createdAt: Date.now(),
        target: def.target,
        minRuns: def.minRuns,
        clauses: def.clauses.map((c) => ({ ...c })),
      };
      sla.hash = slaHash(sla);
      this.items.unshift(sla);
      this.save();
      return sla;
    }

    remove(id) {
      this.items = this.items.filter((s) => s.id !== id);
      if (!this.items.length) this.add(DEFAULT_SLA);
      this.save();
    }
  }

  // ── Statistics ───────────────────────────────────────────────────────

  // Wilson score interval for a proportion, 95%.
  function wilson(k, n) {
    if (!n) return { lo: 0, hi: 1 };
    const z = 1.96;
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }

  // Further clean runs needed before the lower bound reaches the target.
  function moreNeeded(k, n, target) {
    for (let m = 0; m <= 2000; m++) if (wilson(k + m, n + m).lo >= target) return m;
    return null;
  }

  function verdict(k, n, target, minRuns) {
    const rate = n ? k / n : null;
    const w = wilson(k, n);
    if (n < minRuns) return { code: 'insufficient', rate, w, k, n, more: minRuns - n };
    if (rate >= target) {
      if (w.lo >= target) return { code: 'meets-proven', rate, w, k, n };
      return { code: 'meets', rate, w, k, n, more: moreNeeded(k, n, target) };
    }
    if (w.hi < target) return { code: 'fails-proven', rate, w, k, n };
    return { code: 'fails', rate, w, k, n };
  }

  // ── Evaluation ───────────────────────────────────────────────────────

  const ev = (r) => r.def.events ?? {};
  // Family for SLA purposes: everything but the fault, which is the condition.
  function slaFamilyKey(r) {
    const e = ev(r);
    const tag = EDA.scenario.timingTag(r.def.timing);
    return JSON.stringify([r.sim, r.def.scenarioKey ?? r.def.scenario, r.def.floors, r.def.cars, !!e.heavy, !!e.spike, ...(tag ? [tag] : [])]);
  }

  function familyLabel(r) {
    const e = ev(r);
    const on = [e.heavy && 'heavy group', e.spike && 'demand spike'].filter(Boolean);
    const tag = EDA.scenario.timingTag(r.def.timing);
    const sim = EDA.history.simName(r.sim);
    const old = sim && sim !== EDA.history.SIM_VERSION ? ` · ${sim} (older simulator)` : '';
    return `${r.def.scenario} · ${r.def.floors} × ${r.def.cars} · ${on.length ? on.join(' · ') : 'no other events'}${tag ? ` · ${tag}` : ''}${old}`;
  }

  function uniqueDone(records) {
    const seen = new Set();
    return records
      .filter((x) => x.status === 'done')
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((r) => (seen.has(r.defHash) ? false : (seen.add(r.defHash), true)));
  }

  function families(records) {
    const map = new Map();
    for (const r of uniqueDone(records)) {
      const k = slaFamilyKey(r);
      if (!map.has(k)) map.set(k, { key: k, label: familyLabel(r), def: r.def, normal: 0, failure: 0 });
      map.get(k)[ev(r).fault ? 'failure' : 'normal']++;
    }
    return [...map.values()].sort((a, b) => b.normal + b.failure - (a.normal + a.failure));
  }

  const applies = (clause, cond) => clause.when === 'both' || clause.when === cond;

  function evaluate(records, familyKey, sla) {
    const runs = uniqueDone(records).filter((r) => slaFamilyKey(r) === familyKey);
    const contestants = new Map();
    for (const r of runs) for (const c of r.contestants) if (!contestants.has(`${c.id}@${c.version}`)) contestants.set(`${c.id}@${c.version}`, c);

    const cells = [];
    for (const c of contestants.values()) {
      for (const cond of ['normal', 'failure']) {
        // Only the runs this contestant took part in: in a league, pairings vary.
        const laneIn = (r) => r.contestants.find((x) => x.id === c.id && x.version === c.version);
        const pool = runs.filter((r) => !!ev(r).fault === (cond === 'failure') && laneIn(r));
        const clauses = sla.clauses.map((cl, i) => ({ ...cl, i })).filter((cl) => applies(cl, cond));
        const perRun = pool.map((r) => {
          const res = r.results[laneIn(r).key];
          const checks = clauses.map((cl) => {
            const v = METRICS[cl.metric].get(res);
            return { i: cl.i, v, pass: v != null && v <= cl.max + 1e-9 };
          });
          return { run: r, checks, pass: checks.every((x) => x.pass) };
        });
        const k = perRun.filter((x) => x.pass).length;
        cells.push({
          c,
          cond,
          n: pool.length,
          runs: perRun,
          overall: verdict(k, pool.length, sla.target, sla.minRuns),
          clauses: clauses.map((cl) => {
            const vals = perRun.map((x) => x.checks.find((y) => y.i === cl.i));
            const kk = vals.filter((x) => x.pass).length;
            return { ...cl, values: vals.map((x, j) => ({ v: x.v, pass: x.pass, run: perRun[j].run.id })), verdict: verdict(kk, vals.length, sla.target, sla.minRuns) };
          }),
          // Clause that fails most often: where the SLA breaks first.
          weakest: null,
        });
      }
    }
    for (const cell of cells) {
      const worst = cell.clauses.filter((cl) => cl.verdict.n).sort((a, b) => (a.verdict.rate ?? 1) - (b.verdict.rate ?? 1))[0];
      if (worst && worst.verdict.rate < 1) cell.weakest = worst;
    }
    return { runs: runs.length, contestants: [...contestants.values()], cells };
  }

  EDA.sla = { SlaStore, METRICS, CONDITIONS, DEFAULT_SLA, evaluate, families, slaFamilyKey, wilson, moreNeeded, slaHash };
})(window.EDA);
