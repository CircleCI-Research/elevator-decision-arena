/*
 * Contestant registry: every policy that can take a lane in an experiment.
 *
 * Two kinds, kept separate as the spec asks:
 *   - deterministic algorithms, defined here, identified by their source and
 *     a hash of the code that actually runs;
 *   - live decision models (local Laya, the Jev API), which join at runtime
 *     from the arena runner (js/live.js) and are identified by their setup
 *     facets: endpoint, pinned model, encoding, limits.
 * All of them see the same observation and answer with the same action.
 *
 * The scripted mock models used before the real ones were connected have
 * been removed. Runs that used them keep their recorded names and replay
 * from their records alone (see recorded()).
 */
(function (EDA) {
  'use strict';

  const { floorLabel: fl, arrow, fnv } = EDA.util;

  // ── The shared contract ───────────────────────────────────────────────

  const SCHEMAS = {
    version: 'contract v1',
    observation: {
      t: 'number · sim seconds',
      n: 'integer · decisions made so far by this policy',
      vmax: 'number · car speed, floors / s',
      request: { kind: "'assign' | 'overload'", floor: 'integer (assign)', dir: "'up' | 'down' (assign)", reason: "'new' | 'reassign' | 'retry' | 'crowd'", car: 'integer (overload)' },
      cars: [{ idx: 'integer', floor: 'number · fractional while moving', dir: '-1 | 0 | 1', mode: "'normal' | 'overload' | 'malfunction' | 'out'", doorPhase: "'closed' | 'opening' | 'open' | 'closing'", loadKg: 'integer · total load only', capacityKg: 'integer', stops: 'integer', assigned: 'integer', coming: 'boolean · already assigned to this call' }],
    },
    action: {
      options: '[{ label, veto? }] · one per car (assign) or recovery choice (overload)',
      probs: 'number[] · a distribution; deterministic policies put 1 on their choice',
      choice: 'integer · index into options',
      latency: 'number · seconds the decision took',
    },
    note: 'Individual passenger weights are never part of the observation.',
  };
  SCHEMAS.hash = fnv(JSON.stringify(SCHEMAS));

  // ── Shared helpers ────────────────────────────────────────────────────

  function eta(car, floor, vmax, p = {}) {
    const dist = Math.abs(car.floor - floor);
    let e = dist / (vmax * 0.85) + (car.stops + car.assigned) * (p.stopCost ?? 2.4);
    const toward = Math.sign(floor - car.floor);
    if (car.dir !== 0 && toward !== 0 && toward !== car.dir) e += 6;
    if (car.doorPhase !== 'closed') e += 1.5;
    if (car.mode === 'overload') e += 5;
    if (p.loadCost) e += (car.loadKg / car.capacityKg) * p.loadCost;
    return e;
  }

  function unavailable(car) {
    if (car.mode === 'out') return 'Out of service';
    if (car.mode === 'malfunction') return 'Malfunctioning';
    if (car.coming) return 'Already on its way';
    return null;
  }

  function facts(car) {
    const motion = car.dir > 0 ? '▲' : car.dir < 0 ? '▼' : 'idle';
    return `at ${fl(Math.round(car.floor))} · ${motion} · ${car.loadKg} kg`;
  }

  function assignOptions(obs, p) {
    return obs.cars.map((c) => ({
      car: c.idx,
      label: `Car ${c.idx + 1}`,
      short: `C${c.idx + 1}`,
      icon: String(c.idx + 1),
      veto: unavailable(c),
      eta: eta(c, obs.request.floor, obs.vmax, p),
      facts: facts(c),
    }));
  }

  function overloadOptions(obs) {
    const car = obs.cars[obs.request.car];
    return [
      { label: 'Hold doors, ask last in to step out', short: 'Hold', icon: 'hold', veto: null, facts: `${car.loadKg}/${car.capacityKg} kg on board` },
      { label: 'Close doors and depart', short: 'Go', icon: 'up', veto: 'Over capacity', facts: 'safety interlock' },
      { label: 'Hold doors and wait', short: 'Wait', icon: 'clock', veto: null, facts: 'no announcement' },
    ];
  }

  const title = (req) => (req.kind === 'assign' ? `Hall call ${fl(req.floor)} ${arrow(req.dir)}` : `Car ${req.car + 1} over capacity`);

  // Every algorithm answers an overload the same, safe way.
  function holdDoors(req, obs) {
    const options = overloadOptions(obs);
    options.forEach((o) => (o.detail = o.veto ?? o.facts));
    return { kind: 'overload', title: title(req), options, probs: [1, 0, 0], choice: 0, latency: 0, trace: [{ id: 'S1', text: 'Overload → hold doors, request exit', fired: true }] };
  }

  // One-hot result for a deterministic choice.
  function pick(req, options, choice, trace) {
    return { kind: 'assign', title: title(req), options, probs: options.map((_, i) => (i === choice ? 1 : 0)), choice, latency: 0, trace };
  }

  // ── Setup facets ──────────────────────────────────────────────────────

  // A contestant's setup, split into parts that are compared one by one
  // (see docs/model-setups.md). Each facet is { label, value? }; the value,
  // or else the label, is what gets hashed and compared. Timing-dependent
  // facets (limits, fallback) are resolved per experiment by EDA.setup.
  const ms = (s) => `${Math.round(s * 1000).toLocaleString('en-US')} ms`;
  function setupOf(p) {
    const own = p.setupFacets ?? {};
    const base =
      {
            interface: { label: 'Contract v1 · in-process call' },
            encoding: { label: 'None · reads the observation directly' },
            model: { label: `Code ${p.logicHash}`, value: p.logicHash },
            tuning: {
              label: Object.keys(p.params ?? {}).length ? Object.entries(p.params).map(([k, v]) => `${k} ${v}`).join(' · ') : 'No parameters',
              value: JSON.stringify(p.params ?? {}),
            },
            location: { label: 'In-process' },
            compute: { label: 'CPU' },
            determinism: { label: 'Deterministic' },
            cost: { label: 'Energy · negligible', value: 'energy' },
    };
    return { ...base, ...own };
  }

  // ── Deterministic algorithms ──────────────────────────────────────────

  function algorithm(def, decideAssign) {
    const a = {
      kind: 'algorithm',
      runtime: 'In-process JavaScript',
      ...def,
      // Identity of the code that actually runs, plus its parameters.
      codeHash: fnv(decideAssign.toString() + JSON.stringify(def.params ?? {})),
      logicHash: fnv(decideAssign.toString()), // the code alone, without parameters
      source: def.source ?? `registry.js · ${decideAssign.name}()`,
      code: decideAssign.toString(),
      decide(req, obs) {
        return req.kind === 'assign' ? decideAssign(req, obs, def.params ?? {}) : holdDoors(req, obs);
      },
    };
    a.setup = setupOf(a);
    return a;
  }

  function nearestEta(req, obs, p) {
    const options = assignOptions(obs, p);
    let choice = -1;
    options.forEach((o, i) => {
      o.detail = o.veto ?? `ETA ${o.eta.toFixed(1)} s · ${o.facts}`;
      if (!o.veto && (choice < 0 || o.eta < options[choice].eta - 1e-9)) choice = i;
    });
    const best = choice >= 0 ? options[choice].eta : 0;
    const tie = options.filter((o) => !o.veto && Math.abs(o.eta - best) < 1e-9).length > 1;
    return pick(req, options, choice, [
      { id: 'R1', text: 'Skip unavailable cars', fired: options.some((o) => o.veto) },
      { id: 'R2', text: p.loadCost ? 'Lowest ETA, loaded cars cost more' : 'Lowest ETA wins', fired: choice >= 0 },
      { id: 'R3', text: 'Tie → lowest car #', fired: tie },
    ]);
  }

  // Next available car in rotation, whatever its position.
  function roundRobin(req, obs) {
    const options = assignOptions(obs);
    options.forEach((o) => (o.detail = o.veto ?? `${o.facts}`));
    const n = options.length;
    let choice = -1;
    for (let k = 0; k < n; k++) {
      const i = (obs.n + k) % n;
      if (!options[i].veto) {
        choice = i;
        break;
      }
    }
    return pick(req, options, choice, [
      { id: 'R1', text: 'Skip unavailable cars', fired: options.some((o) => o.veto) },
      { id: 'R2', text: `Rotate: car ${(obs.n % n) + 1} is next`, fired: choice === obs.n % n },
      { id: 'R3', text: 'Next car in rotation', fired: choice >= 0 && choice !== obs.n % n },
    ]);
  }

  // Each car owns a band of floors; outside it (or if the owner is out), ETA.
  function zoned(req, obs, p) {
    const options = assignOptions(obs, p);
    const cars = options.length;
    const floors = Math.max(2, obs.floors);
    const owner = Math.min(cars - 1, Math.floor((req.floor / floors) * cars));
    options.forEach((o, i) => (o.detail = o.veto ?? `${i === owner ? 'zone owner · ' : ''}ETA ${o.eta.toFixed(1)} s`));
    let choice = !options[owner].veto && options[owner].eta < p.maxZoneEta ? owner : -1;
    const fallback = choice < 0;
    if (fallback) {
      options.forEach((o, i) => {
        if (!o.veto && (choice < 0 || o.eta < options[choice].eta - 1e-9)) choice = i;
      });
    }
    return pick(req, options, choice, [
      { id: 'R1', text: `Zone owner: car ${owner + 1}`, fired: !fallback },
      { id: 'R2', text: `Owner busy or out → lowest ETA`, fired: fallback },
    ]);
  }

  // ── Registry ──────────────────────────────────────────────────────────

  const LIST = [
    algorithm(
      {
        id: 'nearest-car-eta',
        name: 'Nearest-Car ETA',
        family: 'Nearest-Car ETA',
        version: 'v1.2.0',
        identity: 'sha256 3f9a…c21e',
        description: 'Sends the car with the lowest estimated arrival time, counting distance, stops already planned and turning around.',
        source: 'algorithms/nearest-car-eta.js',
        salt: 0x0b0b,
        decisionWh: 0.00001, // a few comparisons on a CPU
        params: {},
      },
      nearestEta
    ),
    algorithm(
      {
        id: 'nearest-car-eta',
        name: 'Nearest-Car ETA',
        family: 'Nearest-Car ETA',
        version: 'v1.3.0',
        identity: 'load-aware ETA',
        description: 'Same rule as v1.2.0, but loaded cars and cars with more planned stops count as further away.',
        salt: 0x0b0c,
        decisionWh: 0.00001,
        params: { stopCost: 3, loadCost: 6 },
      },
      nearestEta
    ),
    algorithm(
      {
        id: 'round-robin',
        name: 'Round robin',
        family: 'Round robin',
        version: 'v1.0.0',
        identity: 'rotation baseline',
        description: 'Hands calls to cars in turn, ignoring where they are. A naive baseline that anything smarter should beat.',
        salt: 0x0bb1,
        decisionWh: 0.00001,
        params: {},
      },
      roundRobin
    ),
    algorithm(
      {
        id: 'zoned',
        name: 'Zoned dispatch',
        family: 'Zoned dispatch',
        version: 'v1.0.0',
        identity: 'floor bands per car',
        description: 'Each car owns a band of floors. Calls go to the zone owner unless it is out or too far away, then to the lowest ETA.',
        salt: 0x0b20,
        decisionWh: 0.00001,
        params: { maxZoneEta: 14 },
      },
      zoned
    ),
  ].map((p) => ({ ...p, cid: `${p.id}@${p.version}` }));

  const byCid = (cid) => LIST.find((p) => p.cid === cid) ?? null;
  const get = (id, version) => LIST.find((p) => p.id === id && p.version === version) ?? null;
  // Free and always available: no runner, no calls. Live models join the
  // pickers when the runner is up.
  const DEFAULT_PAIR = ['nearest-car-eta@v1.3.0', 'round-robin@v1.0.0'];

  // What a run record keeps about each contestant: models and algorithms
  // carry different provenance, kept apart.
  function provenance(p) {
    const base = { id: p.id, name: p.name, kind: p.kind, version: p.version, identity: p.identity, cid: p.cid, schemaHash: SCHEMAS.hash, setup: p.setup, limits: p.limits ?? null, fallback: p.fallback ?? null };
    return p.kind === 'model'
      ? { ...base, ...(p.live ? { live: p.live, external: p.external ?? null } : {}), model: { runtime: p.runtime, weights: p.weights, promptHash: p.promptHash, configHash: p.configHash, params: p.params } }
      : { ...base, algorithm: { runtime: p.runtime, source: p.source, codeHash: p.codeHash, params: p.params } };
  }

  // A stable colour and short badge per contestant, for leagues where lanes
  // A/B no longer identify anyone.
  const MARKS = 12;
  const initials = (name) =>
    String(name)
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';
  // Last meaningful number of a version: v1.3.0 → 3, mock-0.2 → 2.
  const versionTag = (v) => (String(v).match(/\d+/g) ?? []).reverse().find((x) => x !== '0') ?? '';
  // Badges are unique across the registry: initials, plus the version when
  // two entries would otherwise look the same.
  const ABBR = new Map();
  function rebuildMarks() {
    ABBR.clear();
    for (const p of LIST) {
      const base = initials(p.name);
      const clash = LIST.filter((x) => initials(x.name) === base).length > 1;
      ABBR.set(p.cid, clash ? `${base}${versionTag(p.version)}` : base);
    }
    for (const [cid, a] of ABBR) {
      const same = [...ABBR].filter(([, b]) => b === a);
      if (same.length > 1) ABBR.set(cid, `${a}${same.findIndex(([c]) => c === cid) + 1}`);
    }
  }
  rebuildMarks();
  function mark(c) {
    const cid = c.cid ?? `${c.id}@${c.version}`;
    const i = LIST.findIndex((p) => p.cid === cid);
    const idx = i >= 0 ? i % MARKS : EDA.util.fnvInt(cid) % MARKS;
    return { abbr: ABBR.get(cid) ?? initials(c.name), style: `--acc:var(--m${idx});--on-acc:#fff`, title: `${c.name} ${c.version}` };
  }
  const badge = (c, cls = 'lane') => {
    const m = mark(c);
    return `<span class="${cls} mark" style="${m.style}" title="${m.title}">${m.abbr}</span>`;
  };

  // ── Live contestants (from the arena runner) ──────────────────────────

  // The engine builds the options; a live model only picks among the legal
  // ones (contestants.md §4.3). Same builders as the algorithms use.
  function buildOptions(req, obs) {
    const options = req.kind === 'assign' ? assignOptions(obs) : overloadOptions(obs);
    options.forEach((o) => (o.detail = o.veto ?? o.facts));
    return { kind: req.kind, title: title(req), options };
  }

  // A live model's own decide() is only reached by a replay that diverged
  // from its record: a live model is never re-asked, so its fallback answers.
  function notReasked(p) {
    return (req, obs) => {
      const fb = byCid(p.fallback) ?? byCid('nearest-car-eta@v1.3.0');
      return { ...fb.decide(req, obs), latency: 0, trace: [{ id: 'L0', text: 'Replay diverged: live models are never re-asked', fired: true }] };
    };
  }

  function liveEntry(m, ask) {
    const prompt = `${m.endpoint} · model ${m.model} · system-one-encoding@${m.encoding}`;
    const identity = { id: m.id, version: m.version, endpoint: m.endpoint, model: m.model, encoding: m.encoding, facets: m.facets, limits: m.limits, fallback: m.fallback };
    const p = {
      kind: 'model',
      live: { endpoint: m.endpoint, model: m.model, encoding: m.encoding },
      async: true,
      id: m.id,
      name: m.name,
      family: m.family,
      version: m.version,
      cid: m.cid,
      identity: m.status,
      description: m.description,
      runtime: `arena runner → ${m.endpoint}`,
      weights: m.facets.model.label,
      prompt,
      promptHash: fnv(prompt),
      schemaHash: SCHEMAS.hash,
      configHash: fnv(JSON.stringify(identity)),
      salt: EDA.util.fnvInt(m.cid),
      decisionWh: m.decisionWh,
      fallback: m.fallback,
      limits: m.limits,
      external: m.external,
      available: m.available,
      status: m.status,
      // Typical latency from the spike, for the setup check's notes only.
      params: { latency: m.external ? { min: 0.17, span: 0.17 } : { min: 0.034, span: 0.006 } },
      setup: m.facets,
    };
    p.decide = notReasked(p);
    p.request = (req, obs, built, timeoutS) => ask(p, req, obs, built, timeoutS);
    return p;
  }

  // Replace the live entries with what the runner reports now.
  function setLive(manifests, ask) {
    for (let i = LIST.length - 1; i >= 0; i--) if (LIST[i].live) LIST.splice(i, 1);
    for (const m of manifests) LIST.push(liveEntry(m, ask));
    rebuildMarks();
  }

  // Replaying a live run without the runner: the record is all there is.
  function recorded(c) {
    const p = { ...c, kind: 'model', live: c.live ?? {}, cid: c.cid ?? `${c.id}@${c.version}`, decisionWh: 0, recordedOnly: true };
    p.decide = notReasked(p);
    return p;
  }

  EDA.registry = { list: () => LIST.slice(), byCid, get, DEFAULT_PAIR, SCHEMAS, provenance, mark, badge, ms, buildOptions, setLive, recorded };
})(window.EDA);
