/*
 * Setup check: are two lanes a controlled comparison?
 *
 * Every contestant's setup is split into facets (see docs/model-setups.md).
 * The check compares two lanes facet by facet, under the experiment's timing
 * rules, and says what a result between them can claim:
 *
 *   controlled — exactly one thing is being compared: the decider (model or
 *                code, with its tuning), or one part of the harness such as
 *                the encoding, while everything else is identical.
 *   setup      — several parts differ, so a result compares whole setups.
 *
 * No DOM. Works on registry entries and on stored run provenance alike.
 */
(function (EDA) {
  'use strict';

  const { fnv } = EDA.util;
  const { ms } = EDA.registry;

  // group 'harness': what the arena wraps around the decider; must match for
  //   a controlled comparison of deciders.
  // group 'decider': the thing under test and its inseparable properties.
  // test: facets that define the decider; the rest follow from it.
  const FACETS = [
    { key: 'interface', label: 'Interface', group: 'harness', affects: 'whether requests can be identical' },
    { key: 'encoding', label: 'Encoding', group: 'harness', affects: 'decision quality' },
    { key: 'limits', label: 'Limits', group: 'harness', affects: 'how often the fallback decides' },
    { key: 'fallback', label: 'Fallback', group: 'harness', affects: 'results after a timeout' },
    { key: 'model', label: 'Model', group: 'decider', test: true, affects: 'decision quality' },
    { key: 'tuning', label: 'Tuning', group: 'decider', test: true, affects: 'decision quality' },
    { key: 'location', label: 'Location', group: 'decider', speed: true, affects: 'speed, privacy' },
    { key: 'compute', label: 'Compute', group: 'decider', speed: true, affects: 'speed, energy' },
    { key: 'determinism', label: 'Determinism', group: 'decider', affects: 'replications needed' },
    { key: 'cost', label: 'Cost basis', group: 'decider', affects: 'cost metrics' },
  ];
  const byKey = Object.fromEntries(FACETS.map((f) => [f.key, f]));

  // Registry versions are immutable, so the registry entry is the full
  // description (latency profile, external service). Stored provenance is
  // the fallback for contestants no longer registered.
  function resolve(c) {
    const cid = c?.cid ?? (c ? `${c.id}@${c.version}` : '');
    return EDA.registry.byCid(cid) ?? c;
  }

  const limitOf = (c, timing) => (timing.timeout === 'own' ? c.limits?.timeoutS ?? null : timing.timeout);

  // The facets as they apply in this experiment.
  function effective(c, timing) {
    const p = resolve(c);
    const t = EDA.scenario.normTiming(timing);
    const f = { ...(p.setup ?? {}) };
    const fb = p.fallback ? EDA.registry.byCid(p.fallback) : null;
    if (t.mode === 'fixed') {
      f.limits = { label: 'None apply · fixed decision time' };
      f.fallback = { label: 'Not used · fixed decision time' };
    } else {
      const limit = limitOf(p, t);
      f.limits = { label: limit == null ? 'No timeout' : `Timeout ${ms(limit)}${t.timeout === 'own' ? '' : ' · shared'}`, value: String(limit) };
      f.fallback =
        limit == null
          ? { label: 'Not used · no timeout' }
          : fb
            ? { label: `${fb.name} ${fb.version}`, value: fb.cid }
            : p.kind === 'algorithm'
              ? { label: 'Not needed · answers at once' }
              : { label: 'None · late answers still land' };
    }
    return f;
  }

  const valueOf = (x) => (x ? x.value ?? x.label : '—');

  // Worst-case decision time, for timeout warnings.
  function slowest(p) {
    const L = p.params?.latency;
    if (!L) return 0;
    return L.min + L.span + (L.tail ? L.tail.min + L.tail.span : 0);
  }
  const typical = (p) => (p.params?.latency ? p.params.latency.min + p.params.latency.span / 2 : 0);

  function check(ca, cb, def = {}) {
    const a = resolve(ca);
    const b = resolve(cb);
    const timing = EDA.scenario.normTiming(def.timing);
    const fa = effective(a, timing);
    const fb = effective(b, timing);
    const rows = FACETS.map((f) => {
      const same = valueOf(fa[f.key]) === valueOf(fb[f.key]);
      return {
        ...f,
        a: fa[f.key]?.label ?? '—',
        b: fb[f.key]?.label ?? '—',
        same,
        inert: !same && f.speed && timing.mode === 'fixed', // differs, but can't affect results
      };
    });
    const differs = rows.filter((r) => !r.same);
    const harness = differs.filter((r) => r.group === 'harness');
    const tested = differs.filter((r) => r.test);

    let verdict;
    let subject;
    if (!harness.length) {
      verdict = 'controlled';
      subject = tested.length === 1 && tested[0].key === 'tuning' ? 'tuning' : 'model';
    } else if (harness.length === 1 && !tested.length) {
      verdict = 'controlled';
      subject = harness[0].key;
    } else {
      verdict = 'setup';
      subject = null;
    }

    const names = [a.name, b.name];
    const same2 = a.name === b.name;
    const who = (p) => (same2 ? `${p.name} ${p.version}` : p.name);
    const summary =
      verdict === 'controlled'
        ? subject === 'model'
          ? 'Only the decider differs. The result compares how well each one decides, under the same interface, encoding and limits.'
          : subject === 'tuning'
            ? 'Same code, different parameters. The result compares the tuning.'
            : `Same decider; only the ${byKey[subject].label.toLowerCase()} differs. The result measures the effect of the ${byKey[subject].label.toLowerCase()}.`
        : `${harness.length} part${harness.length === 1 ? '' : 's'} of the setup differ${harness.length === 1 ? 's' : ''} besides the decider (${harness.map((r) => r.label.toLowerCase()).join(', ')}). The result compares whole setups, not models.`;

    const notes = [];
    if (timing.mode === 'fixed') {
      notes.push({ level: 'info', text: `Fixed decision time: every decision takes ${timing.fixedS} s in both lanes, so speed, location and timeouts can't affect the result.` });
    } else {
      const la = limitOf(a, timing);
      const lb = limitOf(b, timing);
      const models = [a, b].filter((p) => p.kind === 'model');
      if (la !== lb && models.length === 2) {
        notes.push({
          level: 'warn',
          text: `Timeouts differ (${la == null ? 'none' : ms(la)} vs ${lb == null ? 'none' : ms(lb)}). They decide how often the fallback takes over.`,
          action: { act: 'shared-timeout', label: 'Use a shared 1.5 s timeout' },
        });
      }
      for (const p of models) {
        const limit = limitOf(p, timing);
        if (limit != null && slowest(p) > limit) {
          const fbp = p.fallback ? EDA.registry.byCid(p.fallback) : null;
          notes.push({ level: 'info', text: `${who(p)} sometimes takes longer than ${ms(limit)}; ${fbp ? `${fbp.name} ${fbp.version} decides those calls` : 'its late answers still land'}.` });
        }
      }
      const [ta, tb] = [typical(a), typical(b)];
      const faster = ta <= tb ? a : b;
      const slower = faster === a ? b : a;
      if (models.length && Math.max(ta, tb) > 3 * Math.max(0.001, Math.min(ta, tb)) && Math.max(ta, tb) > 0.05) {
        notes.push({
          level: 'info',
          text: `Decision time is measured: ${who(slower)}'s ${slower.external ? 'network round trip counts' : 'slower answers count'} against it (about ${ms(typical(slower))} vs ${ms(typical(faster))}). Choose fixed decision time to compare decision quality only.`,
          action: { act: 'fixed', label: 'Use fixed decision time' },
        });
      }
    }
    for (const p of [a, b].filter((x) => x.external)) {
      notes.push({ level: 'info', text: `${who(p)} sends the building state to ${p.external}, through the arena runner, which holds the key.` });
    }
    if (valueOf(fa.cost) !== valueOf(fb.cost)) {
      notes.push({ level: 'info', text: `Cost is measured differently: ${who(a)} in ${valueOf(fa.cost)}, ${who(b)} in ${valueOf(fb.cost)}. They are shown side by side, never converted. Energy counters include only local inference.` });
    }
    const stochastic = [a, b].filter((p) => p.kind === 'model');
    if (stochastic.length && (def.reps ?? 1) < 5) {
      notes.push({ level: 'info', text: `${stochastic.map(who).join(' and ')} ${stochastic.length > 1 ? 'are' : 'is'} stochastic: repeat over at least 5 seeds before drawing conclusions.` });
    }

    return {
      verdict,
      subject,
      label: verdict === 'controlled' ? 'Controlled' : 'Setup comparison',
      short: verdict === 'controlled' ? `Controlled · ${subject === 'model' ? 'decider' : byKey[subject].label.toLowerCase()}` : 'Setup comparison',
      summary,
      rows,
      differs: differs.map((r) => r.key),
      notes,
      names,
      hash: fnv(JSON.stringify(rows.map((r) => [r.key, valueOf(fa[r.key]), valueOf(fb[r.key])]))),
    };
  }

  // What a run record keeps: enough to label and filter it later.
  const stamp = (c) => ({ verdict: c.verdict, subject: c.subject, short: c.short, differs: c.differs, hash: c.hash });

  // Records made before setup checks existed: derive from their contestants.
  function ofRecord(r) {
    if (r.setup) return r.setup;
    const [a, b] = ['A', 'B'].map((k) => r.contestants?.find((c) => c.key === k));
    if (!a || !b) return null;
    return stamp(check(a, b, r.def));
  }

  EDA.setup = { FACETS, check, effective, stamp, ofRecord };
})(window.EDA);
