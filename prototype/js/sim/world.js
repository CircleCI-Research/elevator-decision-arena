/*
 * Stand-in world that drives the visual prototype.
 *
 * PLACEHOLDER — this is not the simulation engine. It is the least behavior
 * that makes every visual state appear: calls, duplicate presses, boarding,
 * overloads, faults and reassignment. The real engine (event queue, safety
 * layer, observation schema, metrics, replay) replaces this file in a later
 * phase; the views only read the snapshot fields used here.
 */
(function (EDA) {
  'use strict';

  const { mulberry32 } = EDA.scenario;
  const { floorLabel: fl, arrow, secs, clock } = EDA.util;

  const ACC = 1.1; // floors / s²
  const LIMP = 0.3; // floors / s while a faulty car creeps to a landing
  const DOOR_T = 0.7;
  const DWELL = 1.3;
  const BOARD_GAP = 0.35;
  const OUT_GAP = 0.3;
  const PRESS_T = 0.8;
  const ENTER_T = 0.35;
  const FADE_T = 0.4;
  const WALK = 1.7; // m / s
  const WALK_HEAVY = 1.2;

  const dirNum = (d) => (d === 'up' ? 1 : -1);
  const dirKey = (n) => (n > 0 ? 'up' : 'down');
  const newHall = () => ({ lit: false, presses: 0, assigned: null, pulse: -1 });

  class World {
    constructor({ id, cfg, script, policy }) {
      this.id = id;
      this.cfg = cfg;
      this.L = cfg.landing;
      this.policy = policy;
      this.rng = mulberry32((cfg.seed ^ policy.salt) >>> 0);
      this.t = 0;
      this.arrivals = script.arrivals.map((a) => ({ ...a }));
      this.nextArrival = 0;
      this.incidents = script.incidents.map((i) => ({ ...i }));
      this.passengers = [];
      this.byId = new Map();
      this.cars = cfg.startFloors.map((pos, idx) => ({
        idx,
        pos,
        v: 0,
        dir: 0,
        serviceDir: 0,
        target: null,
        limpTarget: null,
        mode: 'normal', // normal | overload | malfunction | out
        door: 0,
        doorPhase: 'closed', // closed | opening | open | closing
        doorT: 0,
        riders: [],
        slots: new Array(cfg.maxRiders).fill(null),
        boarding: 0,
        incomingKg: 0, // weight of passengers still walking in: not in load yet, but already taking room
        stops: new Set(),
        assigned: [],
        load: 0,
        lastBoardT: -9,
        lastOutT: -9,
        refused: new Set(),
        full: false,
        overloadAckT: null,
        energy: { net: 0, used: 0, regen: 0, emptyFloors: 0, w: 0, stepWh: 0 },
      }));
      this.halls = Array.from({ length: cfg.floors }, () => ({ up: newHall(), down: newHall() }));
      this.queues = Array.from({ length: cfg.floors }, () => []);
      this.decisions = { active: null, queue: [], history: [], count: 0, latencySum: 0, lastLatency: 0, vetoes: 0, energyWh: 0, fallbacks: 0, apiTokens: 0, apiCostUsd: 0, drifted: 0 };
      this.waiting = false; // a live model's answer is out: the run holds this world
      this.boardSeq = 0; // boarding order, for who steps back out of an overloaded car
      this.stats = { delivered: 0, waits: [] };
      this.events = [];
      this.finishedAt = null;
      this.sweepT = 0;
      this.series = []; // one sample per simulated second, for trend lines
      this.decisionLog = [];
      this.nextSample = 0;
      this.wall = 0; // real seconds spent producing this run
    }

    get total() {
      return this.arrivals.length;
    }

    emit(type, text, sev = 'low', extra = {}) {
      this.events.push({ t: this.t, b: this.id, type, text, sev, ...extra });
    }

    inject({ arrivals = [], incidents = [] }) {
      this.arrivals.push(...arrivals.map((a) => ({ ...a })));
      this.arrivals.sort((a, b) => a.t - b.t);
      this.incidents.push(...incidents.map((i) => ({ ...i })));
      if (arrivals.length) this.finishedAt = null;
    }

    step(h) {
      this.t += h;
      while (this.nextArrival < this.arrivals.length && this.arrivals[this.nextArrival].t <= this.t) {
        this.spawn(this.arrivals[this.nextArrival++]);
      }
      for (const inc of this.incidents) {
        if (inc.done || inc.t > this.t) continue;
        inc.done = true;
        if (inc.type === 'malfunction') this.malfunction(inc.car);
        else if (inc.type === 'repair') this.repair(inc.car);
      }
      this.sweepT += h;
      if (this.sweepT >= 1) {
        this.sweepT = 0;
        this.sweep();
      }
      if (this.t >= this.nextSample) {
        this.nextSample += 1;
        let waiting = 0;
        for (const p of this.passengers) if (!p.boarded && p.phase !== 'done') waiting++;
        this.series.push({ t: this.t, waiting, delivered: this.stats.delivered });
      }
      this.pumpDecisions();
      for (const c of this.cars) {
        c.energy.stepWh = 0;
        if (c.mode !== 'out') this.addEnergy(c, (this.cfg.energy.standbyW * h) / 3600);
        this.updateCar(c, h);
        // Smoothed instantaneous power for the car display.
        c.energy.w += ((c.energy.stepWh * 3600) / h - c.energy.w) * Math.min(1, h * 6);
      }
      for (const p of this.passengers) if (p.phase !== 'done') this.updatePassenger(p, h);
      if (
        this.finishedAt === null &&
        this.nextArrival >= this.arrivals.length &&
        this.passengers.every((p) => p.phase === 'done')
      ) {
        this.finishedAt = this.t;
        this.emit('finish', `Wave cleared in ${clock(this.t)}`, 'good');
      }
    }

    // ── Passengers ────────────────────────────────────────────────────────

    spawn(a) {
      const p = {
        ...a,
        floor: a.origin,
        x: this.L.door,
        facing: 1,
        phase: 'enter', // enter | toButton | press | queue | board | ride | exit | fade | done
        phaseT: 0,
        spawnT: this.t,
        alpha: 0,
        moving: false,
        walkPhase: 0,
        car: null,
        slot: null,
        boarded: false,
        pressed: false,
      };
      this.passengers.push(p);
      this.byId.set(p.id, p);
    }

    dirOf(p) {
      return p.dest > p.floor ? 'up' : 'down';
    }

    setPhase(p, phase) {
      p.phase = phase;
      p.phaseT = 0;
      p.moving = false;
    }

    walk(p, tx, h) {
      const step = (p.accessory === 'cart' ? WALK_HEAVY : WALK) * h;
      const dx = tx - p.x;
      if (Math.abs(dx) <= step) {
        p.x = tx;
        p.moving = false;
        return true;
      }
      p.facing = Math.sign(dx);
      p.x += p.facing * step;
      p.walkPhase += step;
      p.moving = true;
      return false;
    }

    updatePassenger(p, h) {
      p.phaseT += h;
      const L = this.L;
      switch (p.phase) {
        case 'enter':
          p.alpha = Math.min(1, p.phaseT / ENTER_T);
          if (p.phaseT >= ENTER_T) this.approach(p);
          break;
        case 'toButton':
          if (this.walk(p, L.button - 0.4, h)) {
            p.pressed = false;
            this.setPhase(p, 'press');
          }
          break;
        case 'press':
          p.facing = 1;
          if (!p.pressed && p.phaseT >= 0.32) {
            p.pressed = true;
            this.press(p);
          }
          if (p.phaseT >= PRESS_T) {
            this.joinQueue(p);
            this.setPhase(p, 'queue');
          }
          break;
        case 'queue': {
          const q = this.queues[p.floor];
          const i = Math.max(0, q.indexOf(p.id));
          // Long queues squeeze together instead of spilling out of the door.
          const slot = Math.min(L.slot, (L.queueFront - 0.6) / Math.max(1, q.length - 1));
          if (this.walk(p, L.queueFront - i * slot, h)) p.facing = 1;
          break;
        }
        case 'board': {
          const c = this.cars[p.car];
          if (this.walk(p, L.carX[c.idx] + L.riderSlots[p.slot], h)) {
            c.boarding--;
            c.incomingKg -= p.weight;
            c.riders.push(p.id);
            c.load += p.weight;
            c.stops.add(p.dest);
            c.doorT = Math.min(c.doorT, DWELL - 0.5);
            this.setPhase(p, 'ride');
          }
          break;
        }
        case 'ride':
          p.x = L.carX[p.car] + L.riderSlots[p.slot];
          break;
        case 'exit':
          if (this.walk(p, L.door, h)) this.setPhase(p, 'fade');
          break;
        case 'fade':
          p.alpha = Math.max(0, 1 - p.phaseT / FADE_T);
          if (p.phaseT >= FADE_T) this.setPhase(p, 'done');
          break;
      }
    }

    approach(p) {
      const hall = this.halls[p.floor][this.dirOf(p)];
      if (!hall.lit || p.pressesAnyway) this.setPhase(p, 'toButton');
      else {
        this.joinQueue(p);
        this.setPhase(p, 'queue');
      }
    }

    joinQueue(p) {
      const q = this.queues[p.floor];
      if (!q.includes(p.id)) q.push(p.id);
    }

    press(p) {
      const d = this.dirOf(p);
      const hall = this.halls[p.floor][d];
      hall.pulse = this.t;
      if (this.carServing(p.floor, dirNum(d))) return; // doors already open for this direction
      const where = `${fl(p.floor)} ${arrow(d)}`;
      if (!hall.lit) {
        hall.lit = true;
        hall.presses = 1;
        this.emit('call', `${where} called`, 'low', { floor: p.floor, dir: d });
        this.requestAssign(p.floor, d, 'new');
      } else {
        hall.presses++;
        this.emit('dup', `${where} pressed again · ×${hall.presses}`, 'low', { floor: p.floor, dir: d, count: hall.presses });
      }
    }

    carServing(f, dn) {
      return this.cars.some(
        (c) =>
          c.mode === 'normal' &&
          !c.full &&
          Math.abs(c.pos - f) < 1e-3 &&
          (c.doorPhase === 'opening' || c.doorPhase === 'open') &&
          (c.serviceDir === dn || c.serviceDir === 0) &&
          c.slots.includes(null)
      );
    }

    // Someone left on the landing presses the button again.
    nudgeWaiting(f, d) {
      if (this.halls[f][d].lit) return;
      const pressing = this.passengers.some(
        (p) => p.floor === f && (p.phase === 'enter' || p.phase === 'toButton' || p.phase === 'press') && this.dirOf(p) === d
      );
      if (pressing) return;
      const id = this.queues[f].find((pid) => {
        const p = this.byId.get(pid);
        return p.phase === 'queue' && this.dirOf(p) === d;
      });
      if (id !== undefined) this.setPhase(this.byId.get(id), 'toButton');
    }

    // ── Decisions (policy boundary) ──────────────────────────────────────

    requestAssign(floor, dir, reason) {
      this.decisions.queue.push({ kind: 'assign', floor, dir, reason });
    }

    isPending(floor, dir) {
      const D = this.decisions;
      const same = (r) => r.kind === 'assign' && r.floor === floor && r.dir === dir;
      return D.queue.some(same) || (D.active !== null && same(D.active.req));
    }

    requestValid(req) {
      if (req.kind === 'assign') {
        const h = this.halls[req.floor][req.dir];
        return req.reason === 'crowd' ? h.lit : h.lit && h.assigned === null;
      }
      const c = this.cars[req.car];
      return c.mode === 'overload' && c.overloadAckT === null;
    }

    // Policies see aggregate car state only: total load and capacity, never
    // an individual passenger's weight.
    observe(req) {
      return {
        t: this.t,
        request: { ...req },
        n: this.decisions.count,
        floors: this.cfg.floors,
        vmax: this.cfg.vmax,
        cars: this.cars.map((c) => ({
          idx: c.idx,
          floor: c.pos,
          dir: c.dir,
          mode: c.mode,
          doorPhase: c.doorPhase,
          loadKg: Math.round(c.load),
          capacityKg: this.cfg.capacityKg,
          stops: c.stops.size,
          assigned: c.assigned.length,
          coming: req.kind === 'assign' && c.assigned.some((a) => a.floor === req.floor && a.dir === req.dir),
        })),
      };
    }

    pumpDecisions() {
      const D = this.decisions;
      if (D.active && this.t >= D.active.commitT) {
        this.commit(D.active);
        D.active = null;
      }
      while (!D.active && D.queue.length) {
        const req = D.queue.shift();
        if (!this.requestValid(req)) continue;
        const obs = this.observe(req);
        if (this.policy.async) {
          this.askLive(req, obs);
          continue; // lands later; D.active now holds the pending ask, or it already landed
        }
        this.land(this.timed(this.policy.decide(req, obs, this.rng), req, obs), req, ++D.count, this.t);
      }
    }

    land(dec, req, id, startT) {
      const D = this.decisions;
      dec.id = id;
      dec.req = req;
      dec.startT = startT;
      dec.commitT = startT + dec.latency;
      dec.outcome = 'pending';
      this.decisionLog.push(dec); // the run's only non-derivable input, kept for audit and replay
      D.latencySum += dec.latency;
      D.lastLatency = dec.latency;
      D.energyWh += this.policy.decisionWh ?? 0;
      if (dec.live) {
        D.apiTokens += dec.live.tokens ?? 0;
        D.apiCostUsd += dec.live.costUsd ?? 0;
        if (dec.live.drift) {
          if (!D.drifted) this.emit('fallback', `${this.policy.name}: the endpoint answered as ${dec.live.model}, not the pinned model · run marked drifted`, 'warn');
          D.drifted++;
        }
      }
      if (dec.latency > 0) D.active = dec;
      else this.commit(dec);
    }

    // ── Live models (via the arena runner) ───────────────────────────────

    // A live model is asked asynchronously. Sim time doesn't advance while
    // the answer is out (the run holds this world); the answer then lands
    // after its measured time in sim seconds, so the simulation depends only
    // on what was recorded, and replays exactly.
    askLive(req, obs) {
      const D = this.decisions;
      const built = EDA.registry.buildOptions(req, obs);
      const legal = built.options.filter((o) => !o.veto).length;
      const id = ++D.count;
      if (!legal) {
        // Nothing to ask: no car can take it. Same as a policy with no pick.
        this.land(this.timed({ ...built, probs: built.options.map(() => 0), choice: -1, latency: 0 }, req, obs), req, id, this.t);
        return;
      }
      const T = this.cfg.timing;
      const limit = T.mode === 'fixed' ? null : T.timeout === 'own' ? this.policy.limits?.timeoutS ?? null : T.timeout;
      const pending = { ...built, probs: built.options.map((o) => (o.veto ? 0 : 1 / legal)), choice: -1, latency: 0, id, req, startT: this.t, commitT: Infinity, outcome: 'pending', pending: true };
      D.active = pending;
      this.waiting = true;
      this.policy.request(req, obs, built.options, limit).then((res) => this.landLive(pending, res, req, obs, limit));
    }

    landLive(pending, res, req, obs, limit) {
      const D = this.decisions;
      if (D.active !== pending) return; // world discarded or reset meanwhile
      const live = { model: res.model ?? null, drift: !!res.drift, attempts: res.attempts ?? 1, queuedMs: res.queuedMs ?? 0, inferMs: res.inferMs ?? null, tokens: res.tokens ?? 0, costUsd: res.costUsd ?? 0, ...(res.ok ? {} : { error: res.error }) };
      let dec = {
        kind: pending.kind,
        title: pending.title,
        options: pending.options,
        probs: res.ok ? res.probs : pending.probs,
        choice: res.ok ? res.choice : -1,
        latency: Math.max(0.001, (res.latencyMs ?? 0) / 1000),
        live,
        io: res.io ?? null,
      };
      const timedOut = res.error === 'timeout' && limit != null;
      if (res.ok || timedOut) dec = this.timed(dec, req, obs); // a timeout exceeds the limit, so the fallback decides
      else dec = this.fallbackFor(dec, req, obs, { reason: 'failure', detail: res.error, latency: dec.latency }) ?? dec;
      this.waiting = false;
      D.active = null;
      this.land(dec, req, pending.id, pending.startT);
    }

    // Experiment timing rules, the same for both lanes: a fixed decision time,
    // or the measured one with a timeout, after which the fallback decides.
    timed(dec, req, obs) {
      const T = this.cfg.timing;
      dec.measured ??= dec.latency; // what the contestant actually took
      if (!T || dec.fallback) return dec; // replayed fallback: already resolved
      if (T.mode === 'fixed') {
        dec.latency = T.fixedS;
        return dec;
      }
      const limit = T.timeout === 'own' ? this.policy.limits?.timeoutS ?? null : T.timeout;
      if (limit == null || !(dec.latency > limit)) return dec;
      // Nothing to fall back to: the late answer still lands.
      return this.fallbackFor(dec, req, obs, { reason: 'timeout', limitS: limit, latency: limit }) ?? dec;
    }

    // The contestant's fallback decides instead; its own answer (if any) is
    // kept in the record, marked as discarded.
    fallbackFor(dec, req, obs, { reason, limitS = null, detail = null, latency }) {
      const fb = EDA.registry.byCid(this.policy.fallback ?? this.policy.base?.fallback ?? '');
      if (!fb) return null;
      const alt = fb.decide(req, obs, this.rng);
      this.decisions.fallbacks++;
      if (reason === 'timeout') this.emit('timeout', `${this.policy.name} took ${Math.round(dec.latency * 1000)} ms, over the ${Math.round(limitS * 1000)} ms timeout · ${fb.name} decides`, 'warn');
      else this.emit('fallback', `${this.policy.name} failed (${detail}) · ${fb.name} decides`, 'warn');
      return {
        ...alt,
        latency,
        measured: dec.latency,
        fallback: { reason, by: fb.cid, limitS, ...(detail ? { detail } : {}), probs: dec.probs, choice: dec.choice },
        ...(dec.live ? { live: dec.live, io: dec.io } : {}),
      };
    }

    commit(dec) {
      const D = this.decisions;
      this.apply(dec);
      D.history.unshift(dec);
      if (D.history.length > 12) D.history.length = 12;
    }

    apply(dec) {
      const opt = dec.options[dec.choice];
      if (dec.kind === 'overload') {
        const c = this.cars[dec.req.car];
        if (c.mode !== 'overload') {
          dec.outcome = 'stale';
          return;
        }
        c.overloadAckT = this.t;
        dec.outcome = 'applied';
        this.emit('hold', `Car ${c.idx + 1}: ${opt.label.toLowerCase()}`, 'warn', { car: c.idx });
        return;
      }
      const { floor, dir, reason } = dec.req;
      const hall = this.halls[floor][dir];
      const where = `${fl(floor)} ${arrow(dir)}`;
      const crowd = reason === 'crowd';
      if (!hall.lit || (hall.assigned !== null && !crowd)) {
        dec.outcome = 'stale';
        this.emit('stale', `${where} was served before the decision landed`, 'low');
        return;
      }
      if (!opt) {
        dec.outcome = 'vetoed';
        this.emit('veto', `No car can take ${where}`, 'warn');
        return;
      }
      const car = this.cars[opt.car];
      // Safety layer: the car may have failed while the policy was deciding.
      if (car.mode === 'out' || car.mode === 'malfunction') {
        dec.outcome = 'vetoed';
        this.decisions.vetoes++;
        this.emit('veto', `Safety veto: Car ${car.idx + 1} is unavailable · re-deciding ${where}`, 'warn', { car: car.idx });
        this.requestAssign(floor, dir, 'retry');
        return;
      }
      if (hall.assigned === null) hall.assigned = car.idx;
      if (!car.assigned.some((a) => a.floor === floor && a.dir === dir)) car.assigned.push({ floor, dir });
      dec.outcome = 'applied';
      const how = this.policy.kind === 'model' ? `p ${Math.round(dec.probs[dec.choice] * 100)}%` : `ETA ${opt.eta.toFixed(1)} s`;
      const re = reason === 'reassign';
      const note = re ? ' (reassigned)' : crowd ? ' (extra car for crowd)' : '';
      this.emit(re ? 'reassign' : 'assign', `${where} → Car ${car.idx + 1}${note} (${how})`, re ? 'warn' : 'low', { car: car.idx });
    }

    // ── Cars ─────────────────────────────────────────────────────────────

    updateCar(c, h) {
      if (c.mode === 'out') return;
      switch (c.doorPhase) {
        case 'opening':
          c.door = Math.min(1, c.door + h / DOOR_T);
          if (c.door >= 1) {
            c.doorPhase = 'open';
            c.doorT = 0;
          }
          return;
        case 'open':
          this.whileOpen(c, h);
          return;
        case 'closing':
          c.door = Math.max(0, c.door - h / DOOR_T);
          if (c.door <= 0) {
            c.doorPhase = 'closed';
            this.afterClose(c);
          }
          return;
      }
      if (c.mode === 'malfunction') this.limp(c, h);
      else this.drive(c, h);
    }

    whileOpen(c, h) {
      c.doorT += h;
      const f = Math.round(c.pos);
      const faulty = c.mode === 'malfunction';
      const leaving = c.riders.filter((id) => faulty || this.byId.get(id).dest === f);
      if (leaving.length) {
        if (this.t - c.lastOutT >= OUT_GAP) {
          this.alight(c, this.byId.get(leaving[0]), f);
          c.lastOutT = this.t;
        }
        c.doorT = 0;
        return;
      }
      if (faulty) {
        if (c.boarding === 0 && c.doorT > 0.8) c.doorPhase = 'closing';
        return;
      }
      // Safety layer: an overloaded car keeps its doors open and cannot move.
      if (c.load > this.cfg.capacityKg) {
        this.overloaded(c);
        c.doorT = 0;
        return;
      }
      if (c.mode === 'overload') {
        c.mode = 'normal';
        c.overloadAckT = null;
        this.emit('overload-clear', `Car ${c.idx + 1} back under capacity · ${Math.round(c.load)}/${this.cfg.capacityKg} kg`, 'good', { car: c.idx });
      }
      if (!c.full && this.t - c.lastBoardT >= BOARD_GAP && c.slots.includes(null)) {
        const p = this.nextBoarder(c, f);
        if (p) {
          this.board(c, p, f);
          return;
        }
      }
      if (c.boarding > 0) return;
      if (c.doorT >= DWELL) this.close(c);
    }

    overloaded(c) {
      c.full = true; // nobody else tries to squeeze in at this stop
      if (c.mode !== 'overload') {
        c.mode = 'overload';
        c.overloadAckT = null;
        this.emit('overload', `Car ${c.idx + 1} overloaded · ${Math.round(c.load)}/${this.cfg.capacityKg} kg · cannot move`, 'bad', { car: c.idx });
        this.decisions.queue.push({ kind: 'overload', car: c.idx });
        return;
      }
      if (c.overloadAckT === null || c.boarding > 0) return;
      if (this.t - c.overloadAckT < 0.7 || this.t - c.lastOutT < 0.7) return;
      // Whoever got in last steps back out: boarding order, not who reached
      // their spot last (a slow passenger with a cart can arrive after
      // someone who boarded later).
      const last = c.riders.reduce((a, id) => (this.byId.get(id).boardSeq > this.byId.get(a).boardSeq ? id : a));
      this.stepOff(c, this.byId.get(last), Math.round(c.pos));
      c.lastOutT = this.t;
    }

    leaveCar(c, p) {
      c.riders.splice(c.riders.indexOf(p.id), 1);
      c.slots[p.slot] = null;
      c.load -= p.weight;
      if (!c.riders.some((id) => this.byId.get(id).dest === p.dest)) c.stops.delete(p.dest);
      p.car = null;
      p.slot = null;
    }

    stepOff(c, p, f) {
      this.leaveCar(c, p);
      c.refused.add(p.id);
      // Remembered beyond this stop: someone who had to step out of a car
      // doesn't squeeze back into it later while it's still too full for them.
      (p.shedBy ??= new Set()).add(c.idx);
      p.floor = f;
      this.queues[f].unshift(p.id);
      this.setPhase(p, 'queue');
      this.emit('step-off', `A passenger steps out of Car ${c.idx + 1} to clear the overload`, 'low', { car: c.idx });
    }

    alight(c, p, f) {
      this.leaveCar(c, p);
      p.floor = f;
      if (p.dest !== f) {
        // Evacuated from a faulty car: call again from this landing.
        this.setPhase(p, 'toButton');
        return;
      }
      this.stats.delivered++;
      this.setPhase(p, 'exit');
      this.emit('deliver', `Passenger ${p.id} arrived at ${fl(f)} · ${secs(this.t - p.spawnT)} door to door`, 'low', {
        floor: f,
        dest: p.dest,
        car: c.idx,
      });
    }

    nextBoarder(c, f) {
      for (const id of this.queues[f]) {
        const p = this.byId.get(id);
        if (p.phase !== 'queue' || c.refused.has(id)) continue;
        if (p.shedBy?.has(c.idx) && c.load + c.incomingKg + p.weight > this.cfg.capacityKg) continue; // still no room for them in this car
        if (c.serviceDir === 0 || c.serviceDir === dirNum(this.dirOf(p))) return p;
      }
      return null;
    }

    board(c, p, f) {
      const q = this.queues[f];
      q.splice(q.indexOf(p.id), 1);
      const slot = c.slots.indexOf(null);
      c.slots[slot] = p.id;
      p.slot = slot;
      p.car = c.idx;
      c.boarding++;
      c.incomingKg += p.weight;
      p.boardSeq = ++this.boardSeq;
      c.lastBoardT = this.t;
      c.doorT = Math.min(c.doorT, 0.6);
      if (c.serviceDir === 0) {
        const d = this.dirOf(p);
        c.serviceDir = c.dir = dirNum(d);
        this.clearHall(c, f, d);
      }
      if (!p.boarded) {
        p.boarded = true;
        this.stats.waits.push(this.t - p.spawnT);
      }
      this.setPhase(p, 'board');
    }

    close(c) {
      if (c.load > this.cfg.capacityKg) return; // interlock
      c.doorPhase = 'closing';
    }

    afterClose(c) {
      c.refused.clear();
      c.full = false;
      if (c.mode === 'malfunction') {
        if (!c.riders.length) this.setOut(c);
        return;
      }
      if (c.serviceDir !== 0) this.nudgeWaiting(Math.round(c.pos), dirKey(c.serviceDir));
      if (!c.riders.length && !c.assigned.length) {
        c.dir = 0;
        c.serviceDir = 0;
      }
    }

    clearHall(c, f, d) {
      const hall = this.halls[f][d];
      const served = (a) => !(a.floor === f && a.dir === d);
      if (hall.assigned !== null) this.cars[hall.assigned].assigned = this.cars[hall.assigned].assigned.filter(served);
      c.assigned = c.assigned.filter(served);
      hall.lit = false;
      hall.presses = 0;
      hall.assigned = null;
    }

    workBeyond(c, f, dir) {
      if (!dir) return false;
      for (const g of c.stops) if ((g - f) * dir > 0) return true;
      return c.assigned.some((a) => (a.floor - f) * dir > 0);
    }

    wantsStop(c, f, dir) {
      if (c.stops.has(f)) return true;
      // Load bypass: a full car skips hall calls and only serves its riders.
      if (!c.slots.includes(null)) return false;
      return c.assigned.some((a) => a.floor === f && (!dir || dirNum(a.dir) === dir || !this.workBeyond(c, f, dir)));
    }

    candidates(c) {
      const set = new Set(c.stops);
      for (const a of c.assigned) set.add(a.floor);
      return [...set].filter((f) => Math.abs(f - c.pos) > 1e-3);
    }

    pickTarget(c) {
      const list = this.candidates(c);
      if (!list.length) return null;
      const near = (a, b) => Math.abs(a - c.pos) - Math.abs(b - c.pos) || a - b;
      for (const dir of c.dir ? [c.dir, -c.dir] : []) {
        const ahead = list.filter((f) => (f - c.pos) * dir > 0 && this.wantsStop(c, f, dir));
        if (ahead.length) return ahead.sort(near)[0];
      }
      return list.sort(near)[0];
    }

    closerStop(c) {
      const dir = Math.sign(c.target - c.pos);
      const brake = (c.v * c.v) / (2 * ACC) + 0.02;
      let best = null;
      for (const f of this.candidates(c)) {
        const ahead = (f - c.pos) * dir;
        if (ahead < brake || (c.target - f) * dir <= 1e-3 || !this.wantsStop(c, f, dir)) continue;
        if (best === null || ahead < (best - c.pos) * dir) best = f;
      }
      return best;
    }

    drive(c, h) {
      if (c.target === null) {
        const here = Math.round(c.pos);
        // A car with riders never reopens at the floor it just closed on;
        // a new call here waits for its next pass.
        if (Math.abs(c.pos - here) < 1e-3 && !c.riders.length && this.wantsStop(c, here, c.dir)) {
          c.pos = here;
          this.openAt(c, here);
          return;
        }
        c.target = this.pickTarget(c);
        if (c.target === null) {
          c.dir = 0;
          c.serviceDir = 0;
          return;
        }
        c.dir = Math.sign(c.target - c.pos);
        this.addEnergy(c, this.cfg.energy.startWh);
      } else {
        const closer = this.closerStop(c);
        if (closer !== null) c.target = closer;
      }
      const d = c.target - c.pos;
      const ad = Math.abs(d);
      c.v = Math.min(this.cfg.vmax, c.v + ACC * h, Math.sqrt(2 * ACC * ad) + 0.03);
      const s = c.v * h;
      if (s >= ad) {
        this.moveEnergy(c, d);
        c.pos = c.target;
        c.target = null;
        c.v = 0;
        this.openAt(c, Math.round(c.pos));
      } else {
        this.moveEnergy(c, Math.sign(d) * s);
        c.pos += Math.sign(d) * s;
      }
    }

    // ── Energy (placeholder physics) ─────────────────────────────────────

    addEnergy(c, wh) {
      c.energy.net += wh;
      c.energy.stepWh += wh;
      if (wh > 0) c.energy.used += wh;
    }

    // The motor lifts the imbalance between the car side and the
    // counterweight, so cost depends on direction, load and height: a full
    // car going up and an empty car going down both draw power, while a
    // light car going up is pulled by the counterweight and can regenerate.
    moveEnergy(c, dFloors) {
      const E = this.cfg.energy;
      const dh = Math.abs(dFloors) * E.floorHeightM;
      if (!dh) return;
      const imbalanceKg = c.load - E.balance * this.cfg.capacityKg;
      const workJ = imbalanceKg * 9.81 * dh * Math.sign(dFloors);
      let wh = dh * E.frictionWhPerM;
      if (workJ > 0) wh += workJ / E.driveEff / 3600;
      else if (E.regen) {
        const back = (-workJ * E.regenEff) / 3600;
        wh -= back;
        c.energy.regen += back;
      }
      this.addEnergy(c, wh);
      if (!c.riders.length) c.energy.emptyFloors += Math.abs(dFloors);
    }

    openAt(c, f) {
      c.stops.delete(f);
      const here = c.assigned.filter((a) => a.floor === f);
      let sd;
      if (c.dir && (this.workBeyond(c, f, c.dir) || here.some((a) => dirNum(a.dir) === c.dir))) sd = c.dir;
      else if (here.length) sd = dirNum(here[0].dir);
      else if (this.halls[f].up.lit) sd = 1;
      else if (this.halls[f].down.lit) sd = -1;
      else sd = 0;
      if (sd) this.clearHall(c, f, dirKey(sd));
      c.dir = sd;
      c.serviceDir = sd;
      c.doorPhase = 'opening';
      c.doorT = 0;
      this.addEnergy(c, this.cfg.energy.doorWh);
    }

    // ── Faults ───────────────────────────────────────────────────────────

    malfunction(i) {
      const c = this.cars[i];
      if (c.mode === 'out' || c.mode === 'malfunction') return;
      c.mode = 'malfunction';
      c.overloadAckT = null;
      c.full = false;
      this.emit('malfunction', `Car ${i + 1} malfunction · creeping to the nearest landing`, 'bad', { car: i });
      const released = c.assigned;
      c.assigned = [];
      for (const a of released) {
        this.halls[a.floor][a.dir].assigned = null;
        this.requestAssign(a.floor, a.dir, 'reassign');
      }
      if (released.length) {
        const n = released.length;
        this.emit('reassign', `${n} hall call${n > 1 ? 's' : ''} released from Car ${i + 1} for reassignment`, 'warn', { car: i });
      }
      for (const p of this.passengers) {
        if (p.phase !== 'board' || p.car !== i) continue;
        c.slots[p.slot] = null;
        c.boarding--;
        c.incomingKg -= p.weight;
        p.car = null;
        p.slot = null;
        this.queues[p.floor].unshift(p.id);
        this.setPhase(p, 'queue');
      }
      const moving = c.target !== null;
      c.limpTarget = moving ? (c.dir > 0 ? Math.ceil(c.pos - 1e-6) : Math.floor(c.pos + 1e-6)) : Math.round(c.pos);
      c.target = null;
      c.v = 0;
    }

    limp(c, h) {
      const d = c.limpTarget - c.pos;
      if (Math.abs(d) > 1e-3) {
        const step = Math.sign(d) * Math.min(Math.abs(d), LIMP * h);
        this.moveEnergy(c, step);
        c.pos += step;
        return;
      }
      c.pos = c.limpTarget;
      if (c.riders.length) {
        c.doorPhase = 'opening';
        return;
      }
      this.setOut(c);
    }

    setOut(c) {
      c.mode = 'out';
      c.dir = 0;
      c.serviceDir = 0;
      c.stops.clear();
      c.target = null;
      this.emit('out', `Car ${c.idx + 1} out of service at ${fl(Math.round(c.pos))}`, 'bad', { car: c.idx });
    }

    repair(i) {
      const c = this.cars[i];
      if (c.mode !== 'out' && c.mode !== 'malfunction') return;
      c.mode = 'normal';
      c.stops = new Set(c.riders.map((id) => this.byId.get(id).dest));
      c.target = null;
      c.v = 0;
      this.emit('repair', `Car ${i + 1} repaired · back in service`, 'good', { car: i });
    }

    // Crowded landing: when more people wait than the assigned cars can
    // carry, ask the policy for one more car (as group controllers do).
    requestBackup(f, d) {
      let waiting = 0;
      for (const id of this.queues[f]) {
        const p = this.byId.get(id);
        if (p.phase === 'queue' && this.dirOf(p) === d) waiting++;
      }
      const covering = this.cars.filter((c) => c.assigned.some((a) => a.floor === f && a.dir === d)).length;
      const available = this.cars.filter((c) => c.mode === 'normal').length;
      if (waiting > covering * this.cfg.maxRiders && covering < available) this.requestAssign(f, d, 'crowd');
    }

    // Periodic consistency pass so nothing is ever stranded.
    sweep() {
      for (let f = 0; f < this.cfg.floors; f++) {
        for (const d of ['up', 'down']) {
          const hall = this.halls[f][d];
          if (hall.lit) {
            if (hall.assigned !== null && !this.cars[hall.assigned].assigned.some((a) => a.floor === f && a.dir === d)) {
              hall.assigned = null;
            }
            if (hall.assigned === null && !this.isPending(f, d)) this.requestAssign(f, d, 'retry');
            else if (hall.assigned !== null && !this.isPending(f, d)) this.requestBackup(f, d);
          } else if (!this.carServing(f, dirNum(d))) {
            this.nudgeWaiting(f, d);
          }
        }
      }
    }

    // ── Read model for the HUD ───────────────────────────────────────────

    summary() {
      const w = this.stats.waits.slice().sort((a, b) => a - b);
      const avg = w.length ? w.reduce((s, x) => s + x, 0) / w.length : null;
      const p95 = w.length ? w[Math.min(w.length - 1, Math.ceil(w.length * 0.95) - 1)] : null;
      let longest = w.length ? w[w.length - 1] : null;
      let waiting = 0;
      for (const p of this.passengers) {
        if (p.boarded || p.phase === 'done') continue;
        waiting++;
        longest = Math.max(longest ?? 0, this.t - p.spawnT);
      }
      const D = this.decisions;
      return {
        delivered: this.stats.delivered,
        total: this.total,
        avgWait: avg,
        p95Wait: p95,
        longest,
        waiting,
        decisions: D.count,
        avgLatency: D.count ? D.latencySum / D.count : null,
        fallbacks: D.fallbacks,
        apiTokens: D.apiTokens,
        apiCostUsd: D.apiCostUsd,
        drifted: D.drifted,
        remoteDecisions: !!(this.policy.external ?? this.policy.base?.external), // inference energy not measurable here
        vetoes: D.vetoes,
        decisionWh: D.energyWh,
        energyWh: this.cars.reduce((a, c) => a + c.energy.net, 0),
        regenWh: this.cars.reduce((a, c) => a + c.energy.regen, 0),
        emptyFloors: this.cars.reduce((a, c) => a + c.energy.emptyFloors, 0),
        finishedAt: this.finishedAt,
        wall: this.wall,
        fast: this.fastRun === true,
        mixed: this.mixedRun === true,
        t: this.t,
      };
    }
  }

  EDA.World = World;
})(window.EDA);
