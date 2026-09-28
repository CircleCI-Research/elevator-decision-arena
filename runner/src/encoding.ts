// System One encodings: observation + legal options → one `choice` question.
//
// Pure functions: the same observation and options always give byte-identical
// requests, so decisions can be audited and encodings compared (demo set 3).
// Only facts go in (state-model.md §3). Encoding 2 describes cars relative to
// the call, computed here, which is part of the contestant, not the engine.
import { createHash } from 'node:crypto';
import type { Car, Encoded, Observation, Opt, Req } from './types.ts';

export const QUESTION = 'decision';

const INSTRUCTIONS = {
  assign: 'Which car should answer this hall call? Prefer the car that will reach the calling floor soonest and can still take passengers.',
  overload: 'This car is over capacity and its doors are open. How should it recover?',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round1 = (x: number) => Math.round(x * 10) / 10;
const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function motion(c: Car): string {
  return c.dir > 0 ? 'moving up' : c.dir < 0 ? 'moving down' : 'idle';
}

// Encoding 1: raw numbers, as the engine reports them.
function carRaw(c: Car): string {
  const extra = c.mode === 'overload' ? ', over capacity' : '';
  return `floor ${c.floor.toFixed(1)}, ${motion(c)}, doors ${c.doorPhase}, ${c.loadKg} of ${c.capacityKg} kg, ${plural(c.stops, 'stop')}, ${plural(c.assigned, 'call')}${extra}`;
}

function loadWords(c: Car): string {
  const f = c.capacityKg ? c.loadKg / c.capacityKg : 0;
  if (f < 0.05) return 'empty';
  if (f < 0.375) return 'about a quarter full';
  if (f < 0.625) return 'about half full';
  if (f < 0.875) return 'about three quarters full';
  return 'almost full';
}

// Encoding 2: relative to the call, in words.
function carSemantic(c: Car, call: number): string {
  const d = c.floor - call;
  const n = Math.max(1, Math.round(Math.abs(d)));
  const where = Math.abs(d) < 0.05 ? 'at the call floor' : `${plural(n, 'floor')} ${d < 0 ? 'below' : 'above'} the call`;
  let move = 'idle';
  if (c.dir !== 0) move = Math.sign(call - c.floor) === c.dir ? 'moving towards it' : 'moving away from it';
  const doors = c.doorPhase === 'open' || c.doorPhase === 'opening' ? ', doors open' : '';
  const stops = c.stops ? `${plural(c.stops, 'stop')} planned` : 'no stops planned';
  const over = c.mode === 'overload' ? ', over capacity' : '';
  return `${where}, ${move}${doors}, ${loadWords(c)}, ${stops}${over}`;
}

// Encoding 3: the contestant does the arithmetic (as Jev's docs advise) and
// states an arrival estimate per car. The estimate is the same simple one
// Nearest-Car ETA v1.2.0 uses: travel at 85% of top speed, 2.4 s per planned
// stop or call, 6 s to turn around, 1.5 s for doors, 5 s if overloaded. The
// model still decides; load is stated separately, since ETA ignores it.
export function etaSeconds(c: Car, call: number, vmax: number): number {
  let e = Math.abs(c.floor - call) / (vmax * 0.85) + (c.stops + c.assigned) * 2.4;
  const toward = Math.sign(call - c.floor);
  if (c.dir !== 0 && toward !== 0 && toward !== c.dir) e += 6;
  if (c.doorPhase !== 'closed') e += 1.5;
  if (c.mode === 'overload') e += 5;
  return e;
}

function carEta(c: Car, call: number, vmax: number): string {
  const s = Math.max(1, Math.round(etaSeconds(c, call, vmax)));
  const room = Math.max(0, c.capacityKg - c.loadKg);
  return `arrives in about ${s} s, ${loadWords(c)} (${room} kg of room), ${c.stops ? `${plural(c.stops, 'stop')} planned` : 'no stops planned'}`;
}

// Shuffled variants (enc1s, enc3s…): the legal options are listed in an order
// that looks random but is fixed by the request itself, so the same request
// always gets the same order. The descriptions carry no car numbers, so the
// order is the only thing that changes; decode() maps keys back through
// `legal`, which follows the same order.
function shuffled<T>(xs: T[], obs: Observation): T[] {
  const seed = createHash('sha256').update(JSON.stringify({ r: obs.request, t: obs.t, cars: obs.cars })).digest().readUInt32LE(0);
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function encode(encoding: 1 | 2 | 3, model: string, obs: Observation, options: Opt[], shuffle = false): Encoded {
  const req: Req = obs.request;
  const legalOpts = shuffle ? shuffled(options.filter((o) => o.legal), obs) : options.filter((o) => o.legal);
  const keys = legalOpts.map((_, k) => KEYS[k]);
  const criteria: Record<string, string> = {};
  let state: unknown;
  if (req.kind === 'assign') {
    const call = req.floor ?? 0;
    legalOpts.forEach((o, k) => {
      const c = obs.cars[o.car ?? -1];
      criteria[keys[k]] = c ? (encoding === 1 ? carRaw(c) : encoding === 2 ? carSemantic(c, call) : carEta(c, call, obs.vmax)) : o.label;
    });
    state = {
      request: { kind: 'assign', floor: call, dir: req.dir, reason: req.reason, t_s: round1(obs.t) },
      building: { floors: obs.floors, cars: obs.cars.length, capacity_kg: obs.cars[0]?.capacityKg },
    };
  } else {
    const c = obs.cars[req.car ?? 0];
    legalOpts.forEach((o, k) => (criteria[keys[k]] = o.label.toLowerCase()));
    state = { car: { number: (req.car ?? 0) + 1, floor: Math.round(c?.floor ?? 0), load_kg: c?.loadKg, capacity_kg: c?.capacityKg } };
  }
  return {
    body: { model, state, questions: { [QUESTION]: { type: 'choice', instructions: INSTRUCTIONS[req.kind], criteria } } },
    keys,
    legal: legalOpts.map((o) => o.i),
  };
}

// Answer → probabilities aligned with the engine's options, and the choice.
export function decode(enc: Encoded, optionCount: number, response: any): { probs: number[]; choice: number } {
  const ans = response?.answers?.[QUESTION];
  if (!ans || ans.type !== 'choice' || typeof ans.probabilities !== 'object') throw new Error('malformed: no choice answer');
  const probs = new Array(optionCount).fill(0);
  let sum = 0;
  enc.keys.forEach((k, j) => {
    const p = Number(ans.probabilities[k]);
    if (!Number.isFinite(p) || p < 0) throw new Error(`malformed: probability for ${k}`);
    probs[enc.legal[j]] = p;
    sum += p;
  });
  if (!(sum > 0)) throw new Error('malformed: empty distribution');
  for (const i of enc.legal) probs[i] /= sum;
  const j = enc.keys.indexOf(ans.choice);
  if (j < 0) throw new Error(`malformed: choice ${JSON.stringify(ans.choice)} is not an offered option`);
  return { probs, choice: enc.legal[j] };
}

// Template text, for the contestant's encoding hash and the Contestants page.
export const TEMPLATES = {
  1: `${INSTRUCTIONS.assign} · A: "floor 3.2, moving up, doors closed, 150 of 630 kg, 2 stops, 1 call"`,
  2: `${INSTRUCTIONS.assign} · A: "4 floors below the call, moving towards it, about a quarter full, 2 stops planned"`,
  3: `${INSTRUCTIONS.assign} · A: "arrives in about 7 s, about a quarter full (480 kg of room), 2 stops planned" · ETA as Nearest-Car ETA v1.2.0 computes it`,
};
