/*
 * Scenario catalog and traffic generators.
 *
 * A scenario is a versioned, hashed traffic definition: how many passengers,
 * over what window and with what intensity, which directions, destination
 * skew, heavy share, how eagerly people press already-lit buttons, and the
 * parameters of the three scripted events (heavy group, car fault, demand
 * spike). Event keys are fixed across scenarios so fault pairs, resilience
 * and the SLA lab's normal / failure split work everywhere.
 *
 * Morning Wave keeps its original hand-tuned generator (`legacy`), so runs
 * recorded before the catalog existed still replicate bit for bit.
 *
 * PLACEHOLDER — the real catalog lives with the engine, with generators
 * validated against measured building traffic.
 */
(function (EDA) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  const LIMITS = { floors: [3, 120], cars: [1, 16] };
  // Above the Tower preset nothing is drawn: the run is shown as live stats
  // and can be computed as fast as the policies allow.
  const VISUAL_MAX = { floors: 24, cars: 6 };

  const DEFAULT_EVENTS = { heavy: true, fault: true, spike: true };

  // ── Catalog ───────────────────────────────────────────────────────────

  // Event parameters every generic scenario starts from.
  const BASE_EVENTS = {
    heavy: { on: false, at: 0.3, size: 5, heavy: 3 },
    spike: { on: false, at: 0.7, size: 8, floor: 'middle' },
    fault: { on: false, faults: [{ car: 'third', at: 0.4, repair: 38 }] },
  };

  const spec = (s) => ({
    version: 1,
    builtIn: true,
    profile: 'flat',
    window: 80,
    perFloor: 3,
    base: 10,
    shares: { up: 0.4, down: 0.35, inter: 0.25 },
    hotspot: 'none',
    hotspotShare: 0,
    heavyShare: 0.03,
    pressAnyway: 0.55,
    cluster: 1,
    ...s,
    events: {
      heavy: { ...BASE_EVENTS.heavy, ...(s.events?.heavy ?? {}) },
      spike: { ...BASE_EVENTS.spike, ...(s.events?.spike ?? {}) },
      fault: { ...BASE_EVENTS.fault, ...(s.events?.fault ?? {}) },
    },
  });

  const CATALOG = [
    {
      id: 'morning-wave',
      version: 1,
      builtIn: true,
      legacy: true,
      name: 'Morning Wave',
      stresses: ['up-peak', 'mixed traffic', 'overload', 'one fault'],
      description: 'Lobby up-peak with some down and inter-floor traffic, a heavy group with carts, a car fault and a meeting ending mid-wave. The original prototype scenario.',
      events: { heavy: { on: true }, fault: { on: true }, spike: { on: true } },
    },
    spec({
      id: 'normal',
      name: 'Normal traffic',
      stresses: ['baseline'],
      description: 'A steady, balanced day: people going up, down and between floors in similar numbers, no surprises.',
      profile: 'flat',
      window: 90,
      perFloor: 2.5,
      base: 8,
    }),
    spec({
      id: 'rush-hour',
      name: 'Rush hour',
      stresses: ['up-peak', 'queues'],
      description: 'Everyone arrives at once: a sharp morning peak from the lobby to the upper floors.',
      profile: 'peak',
      window: 55,
      perFloor: 5,
      base: 10,
      shares: { up: 0.85, down: 0.05, inter: 0.1 },
      heavyShare: 0.05,
    }),
    spec({
      id: 'down-peak',
      name: 'Evening down-peak',
      stresses: ['down-peak'],
      description: 'End of the day: most people head down to the lobby from every floor.',
      profile: 'peak',
      window: 65,
      perFloor: 4.5,
      base: 8,
      shares: { up: 0.05, down: 0.85, inter: 0.1 },
    }),
    spec({
      id: 'uneven',
      name: 'Uneven destinations',
      stresses: ['hotspot', 'uneven demand'],
      description: 'Most people want the same floor, like a cafeteria on the top floor at lunch, leaving the rest of the building quiet.',
      profile: 'peak',
      window: 70,
      perFloor: 3.5,
      shares: { up: 0.7, down: 0.2, inter: 0.1 },
      hotspot: 'top',
      hotspotShare: 0.65,
    }),
    spec({
      id: 'heavy',
      name: 'Heavy passengers',
      stresses: ['weight', 'overload'],
      description: 'Deliveries and luggage day: a third of passengers are heavy, so cars fill by weight long before they fill by people.',
      window: 80,
      perFloor: 3,
      shares: { up: 0.6, down: 0.3, inter: 0.1 },
      heavyShare: 0.35,
      events: { heavy: { on: true, size: 6, heavy: 4 } },
    }),
    spec({
      id: 'dup-press',
      name: 'Duplicate button presses',
      stresses: ['shared hall state', 'repeat presses'],
      description: 'People arrive in groups and almost everyone presses the button even when it is already lit.',
      window: 80,
      perFloor: 3,
      shares: { up: 0.5, down: 0.3, inter: 0.2 },
      pressAnyway: 0.95,
      cluster: 4,
    }),
    spec({
      id: 'overloads',
      name: 'Elevator overloads',
      stresses: ['overload', 'recovery'],
      description: 'Large, heavy groups crowd the lobby together, so cars keep hitting their weight limit and must shed passengers.',
      profile: 'peak',
      window: 70,
      perFloor: 3.5,
      shares: { up: 0.9, down: 0.05, inter: 0.05 },
      heavyShare: 0.25,
      cluster: 6,
      events: { heavy: { on: true, size: 7, heavy: 5 } },
    }),
    spec({
      id: 'failures',
      name: 'Equipment failures',
      stresses: ['faults', 'reassignment', 'resilience'],
      description: 'Normal traffic while cars fail in turn and come back, forcing policies to reassign calls twice.',
      window: 100,
      perFloor: 3,
      events: { fault: { on: true, faults: [{ car: 'last', at: 0.22, repair: 40 }, { car: 'first', at: 0.58, repair: 40 }] } },
    }),
    spec({
      id: 'spike',
      name: 'Sudden demand spike',
      stresses: ['burst', 'recovery'],
      description: 'A quiet building until a large meeting lets out on a middle floor and everyone wants the lobby at once.',
      window: 90,
      perFloor: 1.5,
      base: 6,
      events: { spike: { on: true, at: 0.45, size: 16, floor: 'middle' } },
    }),
  ];

  const GEN_KEYS = ['profile', 'window', 'perFloor', 'base', 'shares', 'hotspot', 'hotspotShare', 'heavyShare', 'pressAnyway', 'cluster', 'events'];
  const specHash = (s) => EDA.util.fnv(JSON.stringify({ name: s.name, legacy: !!s.legacy, ...Object.fromEntries(GEN_KEYS.map((k) => [k, s[k] ?? null])) }));
  // What a run's definition hash covers. Morning Wave keeps its original key
  // so earlier runs and run files still match.
  const scenarioKey = (s) => (s.legacy ? s.name : `${s.name} v${s.version} ${specHash(s)}`);
  const defaultEvents = (s) => ({ heavy: !!s.events?.heavy?.on, fault: !!s.events?.fault?.on, spike: !!s.events?.spike?.on });

  // ── Decision timing ───────────────────────────────────────────────────

  // How decision time enters the simulation. Experiment-level: both lanes
  // always use the same rule.
  //   mode 'measured': a decision lands after the time it actually took.
  //   mode 'fixed':    every decision, for every contestant, takes fixedS.
  //   timeout 'own':   each contestant's declared timeout (if any) applies.
  //   timeout number:  one shared timeout, in seconds, for both lanes.
  const DEFAULT_TIMING = { mode: 'measured', fixedS: 0.25, timeout: 'own' };
  const normTiming = (t) => ({ ...DEFAULT_TIMING, ...(t ?? {}) });
  const isDefaultTiming = (t) => {
    const n = normTiming(t);
    return n.mode === 'measured' && n.timeout === 'own';
  };
  // Short label for non-default timing, or null. Also the timing part of
  // definition and family keys, so default runs keep their original keys.
  function timingTag(t) {
    if (isDefaultTiming(t)) return null;
    const n = normTiming(t);
    if (n.mode === 'fixed') return `fixed ${n.fixedS} s decisions`;
    return `shared ${n.timeout} s timeout`;
  }

  // ── Config ────────────────────────────────────────────────────────────

  // One experiment definition. Everything here is fixed once a run starts.
  function makeConfig(floors = 6, cars = 3, { seed = 0x5eed, events = DEFAULT_EVENTS, scenario = CATALOG[0], timing = DEFAULT_TIMING } = {}) {
    const geo = EDA.util.geometry(floors, cars);
    return {
      mode: floors > VISUAL_MAX.floors || cars > VISUAL_MAX.cars ? 'stats' : 'visual',
      scenario: scenario.name,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scenarioKey: scenarioKey(scenario),
      scenarioSpec: scenario,
      round: 1,
      seed,
      events: { ...DEFAULT_EVENTS, ...events },
      timing: normTiming(timing),
      floors,
      cars,
      // Cars start spread across the building.
      startFloors: Array.from({ length: cars }, (_, i) => (cars === 1 ? 0 : Math.floor((i * (floors - 1)) / (cars - 1)))),
      capacityKg: 420,
      maxRiders: 5,
      vmax: 1.25 * Math.sqrt(Math.max(1, floors / 6)), // floors / s; taller buildings get faster cars
      // Placeholder energy model. Real coefficients come from a documented
      // method (e.g. ISO 25745) once the engine exists.
      energy: {
        floorHeightM: 3.5,
        balance: 0.45, // counterweight = car + 45% of rated load
        driveEff: 0.7, // motoring efficiency
        regen: true, // regenerative drive feeds energy back
        regenEff: 0.6,
        frictionWhPerM: 0.08,
        startWh: 0.8, // per departure: acceleration and brake release
        doorWh: 0.1, // per door cycle
        standbyW: 120, // controller, lighting, fans, per car in service
      },
      geo,
      landing: geo.landing, // metres, derived from the view geometry
    };
  }

  // ── Shared pieces ─────────────────────────────────────────────────────

  const heavy = (t0, top) => [
    { t: t0, origin: 0, dest: Math.min(4, top), weight: 128, accessory: 'cart' },
    { t: t0 + 0.5, origin: 0, dest: Math.min(4, top), weight: 136, accessory: 'cart' },
    { t: t0 + 1.0, origin: 0, dest: Math.min(5, top), weight: 131, accessory: 'cart' },
    { t: t0 + 1.6, origin: 0, dest: Math.min(3, top) },
    { t: t0 + 2.1, origin: 0, dest: Math.min(5, top) },
  ];

  function spike(t0, floor, floors, rng, size = 8) {
    const out = [];
    for (let i = 0; i < size; i++) {
      let dest = rng() < 0.7 ? 0 : Math.floor(rng() * floors);
      if (dest === floor) dest = floor === 0 ? floors - 1 : 0;
      out.push({ t: t0 + i * 0.45, origin: floor, dest });
    }
    return out;
  }

  // Fill in the fields a scripted arrival may leave out.
  function finalize(parts, rng, firstId, pressAnyway = 0.55) {
    return parts.map((p, i) => ({
      id: firstId + i,
      t: Math.round(p.t * 100) / 100,
      origin: p.origin,
      dest: p.dest,
      weight: p.weight ?? Math.round(56 + rng() * 36),
      accessory: p.accessory ?? (rng() < 0.2 ? 'bag' : 'none'),
      pressesAnyway: rng() < pressAnyway,
    }));
  }

  // ── Morning Wave (original generator, unchanged) ──────────────────────

  function legacyScript(cfg) {
    const rng = mulberry32(cfg.seed);
    const top = cfg.floors - 1;
    const parts = [];

    // Stats-mode buildings get proportionally more, denser traffic.
    const big = cfg.mode === 'stats';
    const dense = Math.min(1, 24 / cfg.floors);

    // Up-peak from the lobby.
    let t = 0.4;
    for (let i = 0, n = big ? Math.round(cfg.floors * 2.5) : Math.min(40, 12 + cfg.floors); i < n; i++) {
      parts.push({ t, origin: 0, dest: 1 + Math.floor(rng() * top) });
      t += (0.7 + rng() * 2.1) * dense;
    }

    // Inter-floor and down traffic.
    t = 5;
    for (let i = 0, n = big ? cfg.floors : Math.min(22, 7 + Math.floor(cfg.floors / 2)); i < n; i++) {
      const origin = 1 + Math.floor(rng() * top);
      let dest = rng() < 0.6 ? 0 : Math.floor(rng() * cfg.floors);
      if (dest === origin) dest = origin === top ? 0 : origin + 1;
      parts.push({ t, origin, dest });
      t += (2 + rng() * 3.4) * dense;
    }

    const ev = cfg.events;
    const spikeFloor = Math.min(3, top);
    if (ev.heavy) parts.push(...heavy(22, top));
    if (ev.spike) parts.push(...spike(50, spikeFloor, cfg.floors, rng));
    parts.sort((a, b) => a.t - b.t);

    // A single-car building has nothing to fail over to, so skip the fault.
    const faultCar = Math.min(2, cfg.cars - 1);
    const fault = ev.fault && cfg.cars > 1;
    return {
      arrivals: finalize(parts, rng, 1),
      incidents: fault
        ? [
            { t: 34, type: 'malfunction', car: faultCar },
            { t: 72, type: 'repair', car: faultCar },
          ]
        : [],
      markers: [
        { t: 0, label: 'Morning wave begins', kind: 'wave' },
        ...(ev.heavy ? [{ t: 22, label: 'Heavy group with carts arrives', kind: 'heavy' }] : []),
        ...(fault ? [{ t: 34, label: `Scripted fault: Car ${faultCar + 1}`, kind: 'fault' }] : []),
        ...(ev.spike ? [{ t: 50, label: `Meeting ends on floor ${spikeFloor}`, kind: 'spike' }] : []),
        ...(fault ? [{ t: 72, label: `Car ${faultCar + 1} repaired`, kind: 'repair' }] : []),
      ],
    };
  }

  // ── Generic generator (every other scenario) ──────────────────────────

  // Times scale with building height so tall towers aren't swamped.
  const windowFor = (s, cfg) => s.window * Math.sqrt(Math.max(1, cfg.floors / 24));
  const sizeScale = (cfg) => (cfg.mode === 'stats' ? cfg.floors / 24 : 1);

  function hotspotFloor(s, top) {
    if (s.hotspot === 'top') return top;
    if (s.hotspot === 'middle') return Math.max(1, Math.round(top / 2));
    if (s.hotspot === 'low') return Math.min(1, top);
    return null;
  }

  function carIndex(which, cars) {
    if (which === 'first') return 0;
    if (which === 'last') return cars - 1;
    if (which === 'middle') return Math.floor((cars - 1) / 2);
    return Math.min(2, cars - 1); // 'third', like Morning Wave
  }

  // Scheduled faults, dropping any that would leave no car in service.
  function faultPlan(s, cfg) {
    if (cfg.cars < 2) return [];
    const W = windowFor(s, cfg);
    const plan = [];
    for (const f of s.events.fault.faults) {
      const car = carIndex(f.car, cfg.cars);
      const at = Math.round(f.at * W);
      const until = at + f.repair;
      if (plan.some((p) => p.car === car && at < p.until)) continue;
      const overlapping = plan.filter((p) => at < p.until && p.at < until).length;
      if (overlapping + 1 >= cfg.cars) continue;
      plan.push({ car, at, until });
    }
    return plan;
  }

  function genericScript(cfg, s) {
    const rng = mulberry32(cfg.seed ^ EDA.util.fnvInt(s.id));
    const floors = cfg.floors;
    const top = floors - 1;
    const W = windowFor(s, cfg);
    const hot = hotspotFloor(s, top);
    const n = Math.min(cfg.mode === 'stats' ? 700 : 90, Math.round(s.base + s.perFloor * floors));
    const shares = s.shares;
    const total = shares.up + shares.down + shares.inter || 1;

    const upper = () => 1 + Math.floor(rng() * top);
    const destUp = () => (hot !== null && rng() < s.hotspotShare ? hot : upper());
    const when = () => {
      if (s.profile === 'peak') return W * ((rng() + rng() + rng()) / 3); // bell-ish around the middle
      if (s.profile === 'burst') return rng() < 0.7 ? W * (0.3 + rng() * 0.15) : W * rng();
      return W * rng();
    };
    const one = (t) => {
      const u = rng() * total;
      if (u < shares.up || top < 1) return { t, origin: 0, dest: Math.max(1, destUp()) };
      if (u < shares.up + shares.down) return { t, origin: upper(), dest: 0 };
      const origin = upper();
      let dest = hot !== null && rng() < s.hotspotShare ? hot : upper();
      if (dest === origin) dest = origin === top ? Math.max(1, top - 1) : origin + 1;
      if (dest === origin) dest = 0; // a 2-floor building has no inter-floor trips
      return { t, origin, dest };
    };

    const parts = [];
    // Groups (cluster > 1) share an origin and arrive within a second or so.
    const c = Math.max(1, s.cluster);
    for (let i = 0; i < n; i += c) {
      const t0 = 0.4 + when();
      const lead = one(t0);
      parts.push(lead);
      for (let j = 1; j < c && i + j < n; j++) {
        const m = one(t0 + 0.2 + rng() * 1.4);
        m.origin = lead.origin;
        if (m.dest === m.origin) m.dest = lead.dest;
        parts.push(m);
      }
    }
    for (const p of parts) if (rng() < s.heavyShare) Object.assign(p, { weight: Math.round(110 + rng() * 32), accessory: 'cart' });

    const ev = cfg.events;
    const E = s.events;
    const markers = [{ t: 0, label: `${s.name} begins`, kind: 'wave' }];
    if (ev.heavy) {
      const at = Math.round(E.heavy.at * W);
      for (let i = 0; i < E.heavy.size; i++) {
        const p = { t: at + i * 0.45, origin: 0, dest: Math.max(1, destUp()) };
        if (i < E.heavy.heavy) Object.assign(p, { weight: Math.round(122 + rng() * 18), accessory: 'cart' });
        parts.push(p);
      }
      markers.push({ t: at, label: `Heavy group of ${E.heavy.size} arrives`, kind: 'heavy' });
    }
    if (ev.spike) {
      const at = Math.round(E.spike.at * W);
      const floor = E.spike.floor === 'top' ? top : E.spike.floor === 'low' ? Math.min(1, top) : Math.max(1, Math.round(top / 2));
      const size = Math.round(E.spike.size * sizeScale(cfg));
      parts.push(...spike(at, floor, floors, rng, size));
      markers.push({ t: at, label: `Demand spike: ${size} people on floor ${floor}`, kind: 'spike' });
    }
    parts.sort((a, b) => a.t - b.t);

    const incidents = [];
    if (ev.fault) {
      for (const f of faultPlan(s, cfg)) {
        incidents.push({ t: f.at, type: 'malfunction', car: f.car }, { t: f.until, type: 'repair', car: f.car });
        markers.push({ t: f.at, label: `Scripted fault: Car ${f.car + 1}`, kind: 'fault' }, { t: f.until, label: `Car ${f.car + 1} repaired`, kind: 'repair' });
      }
    }
    markers.sort((a, b) => a.t - b.t);
    return { arrivals: finalize(parts, rng, 1, s.pressAnyway), incidents, markers };
  }

  function buildScript(cfg) {
    const s = cfg.scenarioSpec ?? CATALOG[0];
    return s.legacy ? legacyScript(cfg) : genericScript(cfg, s);
  }

  // Human description of each event for this scenario and building.
  function eventLabels(s, floors = 6, cars = 3) {
    if (s.legacy) {
      return { heavy: 'Heavy group with carts at 0:22', fault: 'Car 3 fault at 0:34, repaired at 1:12', spike: 'Meeting ends, demand spike at 0:50' };
    }
    const cfg = { floors, cars, mode: floors > VISUAL_MAX.floors || cars > VISUAL_MAX.cars ? 'stats' : 'visual' };
    const W = windowFor(s, cfg);
    const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    const plan = faultPlan(s, cfg);
    const E = s.events;
    return {
      heavy: `Heavy group of ${E.heavy.size} (${E.heavy.heavy} heavy) at ${mmss(E.heavy.at * W)}`,
      fault: !plan.length
        ? 'Car fault (needs at least 2 cars)'
        : plan.length === 1
          ? `Car ${plan[0].car + 1} fault at ${mmss(plan[0].at)}, repaired at ${mmss(plan[0].until)}`
          : `${plan.length} cars fail in turn (${plan.map((p) => mmss(p.at)).join(', ')})`,
      spike: `Demand spike of ${Math.round(E.spike.size * sizeScale(cfg))} on a ${E.spike.floor} floor at ${mmss(E.spike.at * W)}`,
    };
  }

  const byId = (id) => CATALOG.find((s) => s.id === id) ?? null;

  EDA.scenario = {
    LIMITS,
    VISUAL_MAX,
    DEFAULT_EVENTS,
    CATALOG,
    byId,
    makeConfig,
    CONFIG: makeConfig(),
    buildScript,
    finalize,
    groups: { heavy, spike },
    mulberry32,
    gauss,
    specHash,
    scenarioKey,
    defaultEvents,
    eventLabels,
    makeSpec: spec,
    DEFAULT_TIMING,
    normTiming,
    isDefaultTiming,
    timingTag,
  };
})(window.EDA);
