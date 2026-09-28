/*
 * Leaderboard statistics. No DOM.
 *
 * Rankings are computed per experiment family: runs that share scenario,
 * building, scripted events and simulator, with seeds varying. Within a
 * family raw metrics are comparable; across families they aren't. Reruns of
 * an identical definition count once, so replications don't inflate n.
 *
 * Planned: paired, per-scenario analysis
 * over a curated scenario catalog, with policy versions from the registry.
 */
(function (EDA) {
  'use strict';

  // Two-sided 95% Student t critical values by degrees of freedom.
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
  const tCrit = (df) => (df <= 0 ? Infinity : df <= T95.length ? T95[df - 1] : df <= 30 ? 2.042 : 1.96);

  function stats(values) {
    const xs = values.filter((v) => v != null && isFinite(v));
    const n = xs.length;
    if (!n) return { n: 0, mean: null, lo: null, hi: null, half: null };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    if (n === 1) return { n, mean, lo: null, hi: null, half: null };
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    const half = (tCrit(n - 1) * sd) / Math.sqrt(n);
    return { n, mean, sd, half, lo: mean - half, hi: mean + half };
  }

  const ev = (r) => r.def.events ?? {};
  function familyKey(r) {
    const e = ev(r);
    const tag = EDA.scenario.timingTag(r.def.timing);
    return JSON.stringify([EDA.history.simName(r.sim), r.def.scenarioKey ?? r.def.scenario, r.def.floors, r.def.cars, !!e.heavy, !!e.fault, !!e.spike, ...(tag ? [tag] : [])]);
  }

  function familyLabel(r) {
    const e = ev(r);
    const on = [e.heavy && 'heavy', e.fault && 'fault', e.spike && 'spike'].filter(Boolean);
    const tag = EDA.scenario.timingTag(r.def.timing);
    const sim = EDA.history.simName(r.sim);
    const old = sim && sim !== EDA.history.SIM_VERSION ? ` · ${sim} (older simulator)` : '';
    return `${r.def.scenario} · ${r.def.floors} × ${r.def.cars} · ${on.length ? on.join(' · ') : 'no events'}${tag ? ` · ${tag}` : ''}${old}`;
  }

  // Finished runs, one per distinct definition (the earliest wins).
  function uniqueDone(records) {
    const seen = new Set();
    const out = [];
    let dupes = 0;
    for (const r of records.filter((x) => x.status === 'done').sort((a, b) => a.createdAt - b.createdAt)) {
      if (seen.has(r.defHash)) {
        dupes++;
        continue;
      }
      seen.add(r.defHash);
      out.push(r);
    }
    return { runs: out, dupes };
  }

  function families(records) {
    const { runs } = uniqueDone(records);
    const map = new Map();
    for (const r of runs) {
      const k = familyKey(r);
      if (!map.has(k)) map.set(k, { key: k, label: familyLabel(r), def: r.def, n: 0, last: 0 });
      const f = map.get(k);
      f.n++;
      f.last = Math.max(f.last, r.createdAt);
    }
    return [...map.values()].sort((a, b) => b.n - a.n || b.last - a.last);
  }

  const cid = (c) => `${c.id}@${c.version}`;

  // Everything the categories read from one contestant's results.
  function metricsOf(res) {
    return {
      finishedAt: res.finishedAt,
      avgWait: res.avgWait,
      p95Wait: res.p95Wait,
      longest: res.longest,
      energyPerPax: res.delivered ? res.energyWh / res.delivered : null,
      emptyPerPax: res.delivered ? res.emptyFloors / res.delivered : null,
      decTime: res.decTime ?? null, // measured; null when it wasn't
      decEnergy: res.remoteDecisions ? null : res.decisionWh, // remote inference energy is not measurable
      vetoRate: res.decisions ? (res.vetoes / res.decisions) * 100 : 0,
    };
  }

  const MIN_RUNS = 5; // fewer runs than this and a contestant is provisional

  const CATEGORIES = [
    { key: 'speed', label: 'Speed', metric: 'finishedAt', desc: 'Time to clear the whole wave', fmt: 'clock', better: 'low', overall: true },
    { key: 'wait', label: 'Wait', metric: 'avgWait', desc: 'Average wait, arrival to boarding', fmt: 'secs', better: 'low', overall: true },
    { key: 'fairness', label: 'Fairness', metric: 'longest', desc: 'Longest wait: the worst-served passenger', fmt: 'secs', better: 'low', overall: true },
    { key: 'resilience', label: 'Resilience', metric: 'degradation', desc: 'Extra time to clear with the car fault, vs the same seed without it', fmt: 'pct', better: 'low', overall: true },
    { key: 'safety', label: 'Safety', metric: 'vetoRate', desc: 'Decisions vetoed by the safety layer, per 100', fmt: 'num', better: 'low', overall: true },
    { key: 'cost', label: 'Decision cost', metric: 'decTime', desc: 'Measured time the contestant took per decision', fmt: 'ms', better: 'low', overall: true },
    { key: 'p95', label: 'P95 wait', metric: 'p95Wait', desc: '95th-percentile wait', fmt: 'secs', better: 'low', overall: false },
    { key: 'energy', label: 'Energy', metric: 'energyPerPax', desc: 'Elevator energy per passenger delivered', fmt: 'wh', better: 'low', overall: false },
    { key: 'utilization', label: 'Utilization', metric: 'emptyPerPax', desc: 'Empty travel per passenger (floors)', fmt: 'fl', better: 'low', overall: false },
    { key: 'decEnergy', label: 'Decision energy', metric: 'decEnergy', desc: 'Estimated energy spent deciding, per run: a fixed per-decision figure for each contestant × its decisions, not measured', fmt: 'wh', better: 'low', overall: false, estimate: true },
  ];

  // Same contestants, building and seed, fault flipped: the run that
  // isolates the fault.
  const pairKey = (r) => r.contestants.map((c) => cid(c)).sort().join('|');
  function twinOf(r, pool) {
    const e = ev(r);
    return pool.find((x) => {
      const f = ev(x);
      return (
        x !== r &&
        pairKey(x) === pairKey(r) &&
        x.sim === r.sim &&
        (x.def.scenarioKey ?? x.def.scenario) === (r.def.scenarioKey ?? r.def.scenario) &&
        x.def.floors === r.def.floors &&
        x.def.cars === r.def.cars &&
        x.def.seed === r.def.seed &&
        !!f.heavy === !!e.heavy &&
        !!f.spike === !!e.spike &&
        !!f.fault !== !!e.fault
      );
    });
  }

  function board(records, key) {
    const { runs: all, dupes: allDupes } = uniqueDone(records);
    const runs = all.filter((r) => familyKey(r) === key);
    const famDupes = records.filter((r) => r.status === 'done' && familyKey(r) === key).length - runs.length;

    // Contestants, in lane order.
    const contestants = new Map();
    for (const r of runs) for (const c of r.contestants) if (!contestants.has(cid(c))) contestants.set(cid(c), { ...c, cid: cid(c) });

    const values = new Map([...contestants.keys()].map((k) => [k, {}]));
    const runsOf = new Map([...contestants.keys()].map((k) => [k, 0]));
    const push = (k, m, v) => ((values.get(k)[m] ??= []).push(v));
    const wins = new Map([...contestants.keys()].map((k) => [k, { w: 0, l: 0, t: 0 }]));
    let pairs = 0;

    for (const r of runs) {
      for (const c of r.contestants) {
        runsOf.set(cid(c), runsOf.get(cid(c)) + 1);
        const m = metricsOf(r.results[c.key]);
        for (const [name, v] of Object.entries(m)) push(cid(c), name, v);
      }
      // Head to head: who cleared this wave first.
      const times = r.contestants.map((c) => ({ k: cid(c), t: r.results[c.key].finishedAt }));
      const best = Math.min(...times.map((x) => x.t));
      const firsts = times.filter((x) => Math.abs(x.t - best) < 0.05);
      for (const x of times) {
        const w = wins.get(x.k);
        if (firsts.length > 1 && firsts.includes(x)) w.t++;
        else if (x === firsts[0] && firsts.length === 1) w.w++;
        else w.l++;
      }
      // Resilience from the fault / no-fault twin, whichever side this run is.
      const twin = twinOf(r, all);
      if (twin) {
        pairs++;
        const [withF, without] = ev(r).fault ? [r, twin] : [twin, r];
        for (const c of r.contestants) {
          const cw = withF.contestants.find((x) => cid(x) === cid(c));
          const cn = without.contestants.find((x) => cid(x) === cid(c));
          if (!cw || !cn) continue;
          const a = withF.results[cw.key].finishedAt;
          const b = without.results[cn.key].finishedAt;
          if (a != null && b) push(cid(c), 'degradation', ((a - b) / b) * 100);
        }
      }
    }

    // Fixed decision time compares decision quality only: how long deciding
    // took is shown, but it doesn't rank anyone in such a family.
    const fixed = runs.length > 0 && EDA.scenario.normTiming(runs[0].def.timing).mode === 'fixed';
    const cats = CATEGORIES.map((c) => (fixed && c.key === 'cost' ? { ...c, overall: false, note: 'not ranked: this family uses fixed decision time' } : c));
    const categories = cats.map((cat) => {
      const rows = [...contestants.values()].map((c) => ({ c, s: stats(values.get(c.cid)[cat.metric] ?? []) }));
      const ranked = rows.filter((r) => r.s.n > 0).sort((a, b) => (cat.better === 'low' ? a.s.mean - b.s.mean : b.s.mean - a.s.mean));
      let leader = null;
      let separable = false;
      if (ranked.length > 1) {
        const [a, b] = ranked;
        if (Math.abs(a.s.mean - b.s.mean) < 1e-9) leader = 'tie';
        else {
          leader = a.c.cid;
          // Separable when the 95% intervals don't overlap.
          separable = a.s.half != null && b.s.half != null && (cat.better === 'low' ? a.s.hi < b.s.lo : a.s.lo > b.s.hi);
        }
      }
      ranked.forEach((r, i) => (r.rank = i + 1));
      // A category counts once at least two contestants have data in it;
      // contestants without data there simply aren't ranked in it.
      // An estimate isn't evidence: no leader, no separability.
      if (cat.estimate) return { ...cat, rows, leader: null, separable: false, hasData: ranked.length >= 2 };
      return { ...cat, rows, leader, separable, hasData: ranked.length >= 2 };
    });

    // Overall: average rank across the headline categories each contestant
    // has data in. Too few runs → provisional: listed, never placed.
    const scored = categories.filter((c) => c.overall && c.hasData);
    const overall = [...contestants.values()]
      .map((c) => {
        const ranks = scored
          .map((cat) => {
            const row = cat.rows.find((r) => r.c.cid === c.cid);
            if (!row.s.n) return null;
            // Tied means share the better rank.
            const tie = cat.rows.filter((r) => r.s.n && Math.abs(r.s.mean - row.s.mean) < 1e-9);
            return Math.min(...tie.map((r) => r.rank));
          })
          .filter((x) => x != null);
        const leads = scored.filter((cat) => cat.leader === c.cid).length;
        const sepLeads = scored.filter((cat) => cat.leader === c.cid && cat.separable).length;
        const n = runsOf.get(c.cid);
        return { c, n, qualified: n >= MIN_RUNS, avgRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null, leads, sepLeads, wins: wins.get(c.cid) };
      })
      .sort((a, b) => b.qualified - a.qualified || (a.avgRank ?? 99) - (b.avgRank ?? 99) || b.leads - a.leads);
    overall.forEach((o, i) => {
      const prev = overall[i - 1];
      o.place = !o.qualified ? null : prev?.qualified && Math.abs(o.avgRank - prev.avgRank) < 1e-9 ? prev.place : i + 1;
    });

    return {
      key,
      label: runs[0] ? familyLabel(runs[0]) : '',
      n: runs.length,
      seeds: new Set(runs.map((r) => r.def.seed)).size,
      dupes: famDupes,
      allDupes,
      pairs,
      scored: scored.map((c) => c.label),
      contestants: [...contestants.values()],
      categories,
      overall,
    };
  }

  EDA.leaderboard = { families, board, familyKey, stats, CATEGORIES, MIN_RUNS };
})(window.EDA);
