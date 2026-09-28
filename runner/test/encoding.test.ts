import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, encode } from '../src/encoding.ts';
import type { Observation, Opt } from '../src/types.ts';

// The spike fixture (docs/spike/fixture-enc1.json), as the engine would send it.
const obs: Observation = {
  t: 132.4,
  n: 7,
  floors: 24,
  vmax: 2.5,
  request: { kind: 'assign', floor: 7, dir: 'up', reason: 'new' },
  cars: [
    { idx: 0, floor: 3.2, dir: 1, mode: 'normal', doorPhase: 'closed', loadKg: 150, capacityKg: 630, stops: 2, assigned: 1, coming: false },
    { idx: 1, floor: 12, dir: 0, mode: 'normal', doorPhase: 'open', loadKg: 0, capacityKg: 630, stops: 0, assigned: 0, coming: false },
    { idx: 2, floor: 6, dir: 1, mode: 'normal', doorPhase: 'closed', loadKg: 610, capacityKg: 630, stops: 1, assigned: 0, coming: false },
    { idx: 3, floor: 0, dir: 0, mode: 'out', doorPhase: 'closed', loadKg: 0, capacityKg: 630, stops: 0, assigned: 0, coming: false },
  ],
};
const options: Opt[] = [0, 1, 2, 3].map((i) => ({ i, car: i, label: `Car ${i + 1}`, legal: i !== 3 }));

test('encoding 1 reproduces the spike fixture, minus the illegal car', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../docs/spike/fixture-enc1.json', import.meta.url), 'utf8'));
  const enc = encode(1, 'jev-1.13.0', obs, options);
  const want = { ...fixture.questions.car.criteria };
  delete want.D; // the engine only offers legal options
  assert.deepEqual(enc.body.questions.decision.criteria, want);
  assert.equal(enc.body.questions.decision.instructions, fixture.questions.car.instructions);
  assert.deepEqual(enc.legal, [0, 1, 2]);
});

test('encodings are deterministic', () => {
  assert.equal(JSON.stringify(encode(2, 'english', obs, options)), JSON.stringify(encode(2, 'english', obs, options)));
});

test('encoding 2 describes cars relative to the call', () => {
  const c = encode(2, 'english', obs, options).body.questions.decision.criteria;
  assert.equal(c.A, '4 floors below the call, moving towards it, about a quarter full, 2 stops planned');
  assert.equal(c.B, '5 floors above the call, idle, doors open, empty, no stops planned');
  assert.equal(c.C, '1 floor below the call, moving towards it, almost full, 1 stop planned');
});

test('encoding 3 states an arrival estimate the contestant computed', () => {
  const c = encode(3, 'english', obs, options).body.questions.decision.criteria;
  // Car 1: 3.8 floors at 2.5 × 0.85 floors/s ≈ 1.8 s, + 3 × 2.4 s = 9 s; moving towards the call.
  assert.equal(c.A, 'arrives in about 9 s, about a quarter full (480 kg of room), 2 stops planned');
  // Car 2: 5 floors ≈ 2.4 s + 1.5 s for open doors ≈ 4 s.
  assert.equal(c.B, 'arrives in about 4 s, empty (630 kg of room), no stops planned');
  // Car 3: 1 floor ≈ 0.5 s + 2.4 s ≈ 3 s; almost full.
  assert.equal(c.C, 'arrives in about 3 s, almost full (20 kg of room), 1 stop planned');
});

test('decode aligns probabilities with engine options and rejects bad answers', () => {
  const enc = encode(1, 'x', obs, options);
  const out = decode(enc, 4, { answers: { decision: { type: 'choice', choice: 'C', probabilities: { A: 0.2, B: 0.2, C: 0.6 } } } });
  assert.deepEqual(out, { probs: [0.2, 0.2, 0.6, 0], choice: 2 });
  assert.throws(() => decode(enc, 4, { answers: { decision: { type: 'choice', choice: 'D', probabilities: { A: 1, B: 0, C: 0 } } } }), /not an offered option/);
  assert.throws(() => decode(enc, 4, {}), /malformed/);
});
