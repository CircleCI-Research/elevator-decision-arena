// Hindsight labels for Laya fine-tuning, and the rollout dispatcher they come from.
//
// At a decision, try every legal option: replay the run up to that decision
// (the simulator is deterministic, so a replay with the same choices is
// exact), force the option, then let a continuation policy drive for a
// horizon. Score each option by the total passenger waiting time in that
// window. The best option is the label; the soft target puts more weight on
// better options and splits ties evenly. Choosing by this rule online is the
// classic "rollout" of the continuation policy: it can only improve on it, up
// to the horizon's short-sightedness.
//
//   Labels (a dataset, like export-dataset.ts but with hindsight targets):
//     node --experimental-strip-types tools/hindsight.ts label --out ../runtime/laya/data/hindsight \
//       --split train --seeds 1-60 [--shard 0/8]
//   Ceiling (race the rollout itself, no model involved):
//     node --experimental-strip-types tools/hindsight.ts rollout --seeds 1001-1010 --scenarios normal,morning-wave
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { encode } from '../src/encoding.ts';
import type { Observation, Opt } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const EVAL = [1001, 1010];
const H = 1 / 60;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const range = (s: string) => {
  const [a, b] = s.split('-').map(Number);
  return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
};

const mode = process.argv[2];
const scenarios = arg('scenarios', 'normal,morning-wave').split(',');
const [floors, cars] = arg('size', '24x4').split('x').map(Number);
const horizon = Number(arg('horizon', '90')); // sim seconds after the decision
const tau = Number(arg('tau', '5')); // seconds of waiting per e-fold in the soft target
const encoding = Number(arg('encoding', '3')) as 1 | 2 | 3;
const contCid = arg('continuation', 'nearest-car-eta@v1.3.0');
const [shard, shards] = arg('shard', '0/1').split('/').map(Number);
const seeds = range(arg('seeds', '1-60')).filter((_, i) => i % shards === shard);

// The simulator, loaded exactly as the page does.
const mem = new Map<string, string>();
const ctx: any = { console, performance, Math, JSON, Map, Set, localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['js/util.js', 'js/sim/scenario.js', 'js/sim/world.js', 'js/sim/registry.js', 'js/setup.js', 'js/history-store.js']) {
  vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const EDA = ctx.EDA;
const cont = EDA.registry.byCid(contCid);
if (!cont) throw new Error(`unknown continuation policy ${contCid}`);

function makeCfg(scn: string, seed: number) {
  const spec = EDA.scenario.byId(scn);
  return EDA.scenario.makeConfig(floors, cars, { seed, scenario: spec, events: EDA.scenario.defaultEvents(spec), timing: { mode: 'fixed', fixedS: 0.25, timeout: 'own' } });
}

const waitingNow = (w: any) => {
  let n = 0;
  for (const p of w.passengers) if (!p.boarded && p.phase !== 'done') n++;
  return n;
};

// A policy that replays given choices, then forces one, then continues.
function scripted(prefix: number[], forced: number | null) {
  let i = 0;
  return {
    ...cont,
    decide(req: any, obs: any, rng: any) {
      const dec = cont.decide(req, obs, rng);
      const want = i < prefix.length ? prefix[i] : i === prefix.length ? forced : null;
      i++;
      if (want !== null && want !== undefined && want !== dec.choice) {
        dec.choice = want;
        dec.probs = dec.options.map((_: any, j: number) => (j === want ? 1 : 0));
      }
      return dec;
    },
  };
}

// Waiting cost of forcing `option` at decision `k`, given the choices before it.
function forkCost(scn: string, seed: number, prefix: number[], option: number, tStart: number): number {
  const cfg = makeCfg(scn, seed);
  const w = new EDA.World({ id: 'F', cfg, script: EDA.scenario.buildScript(cfg), policy: scripted(prefix, option) });
  let cost = 0;
  const end = tStart + horizon;
  for (let s = 0; s < 60 * 4000 && w.t < end; s++) {
    w.step(H);
    w.events.length = 0;
    if (w.t > tStart) cost += waitingNow(w) * H;
    if (w.finishedAt !== null) break;
  }
  return cost;
}

// Score every legal option at every decision of one run. `choose` decides
// which option the run itself takes: the continuation policy (labelling) or
// the best option (online rollout).
function runWithForks(scn: string, seed: number, onDecision: (d: any) => number | null) {
  const taken: number[] = [];
  const cfg = makeCfg(scn, seed);
  const policy = {
    ...cont,
    decide(req: any, obs: Observation, rng: any) {
      const dec = cont.decide(req, obs, rng);
      const built = EDA.registry.buildOptions(req, obs);
      const options: Opt[] = built.options.map((o: any, i: number) => ({ i, car: o.car, label: o.label, short: o.short, legal: !o.veto }));
      const legal = options.filter((o) => o.legal).map((o) => o.i);
      let choice = dec.choice;
      if (legal.length >= 2 && dec.choice >= 0) {
        const costs = legal.map((j) => forkCost(scn, seed, taken, j, obs.t));
        const pick = onDecision({ req, obs, options, legal, costs, teacher: dec.choice });
        if (pick !== null) choice = pick;
      }
      taken.push(choice);
      if (choice !== dec.choice) {
        dec.choice = choice;
        dec.probs = dec.options.map((_: any, j: number) => (j === choice ? 1 : 0));
      }
      return dec;
    },
  };
  const w = new EDA.World({ id: 'A', cfg, script: EDA.scenario.buildScript(cfg), policy });
  for (let s = 0; s < 60 * 4000 && w.finishedAt === null; s++) {
    w.step(H);
    w.events.length = 0;
  }
  return w;
}

function softTarget(costs: number[]): number[] {
  const m = Math.min(...costs);
  const e = costs.map((c) => Math.exp(-(c - m) / tau));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => Math.round((x / s) * 1e4) / 1e4);
}

const t0 = performance.now();
if (mode === 'label') {
  const split = arg('split', 'train');
  for (const s of seeds) if (s >= EVAL[0] && s <= EVAL[1]) throw new Error(`seed ${s} is an evaluation seed; refusing to train on it`);
  const out = arg('out', '../runtime/laya/data/hindsight');
  mkdirSync(out, { recursive: true });
  const rows: string[] = [];
  let agree = 0;
  for (const scn of scenarios) {
    for (const seed of seeds) {
      runWithForks(scn, seed, (d) => {
        const enc = encode(encoding, 'english', d.obs, d.options);
        // enc.legal is the engine indices of the legal options, in key order.
        const byIdx = new Map(d.legal.map((j: number, n: number) => [j, d.costs[n]]));
        const costs = enc.legal.map((j) => byIdx.get(j) as number);
        const target = softTarget(costs);
        const best = costs.indexOf(Math.min(...costs));
        if (enc.legal[best] === d.teacher) agree++;
        rows.push(JSON.stringify({
          id: `${scn}-${seed}-${rows.length}`, split, scenario: scn, seed, t: Math.round(d.obs.t * 10) / 10, kind: d.req.kind,
          state: enc.body.state, question: enc.body.questions.decision, keys: enc.keys,
          target, label: enc.keys[best], costs: costs.map((c) => Math.round(c * 10) / 10),
          teacher: enc.keys[enc.legal.indexOf(d.teacher)],
        }));
        return null; // labelling follows the continuation policy's own trajectory
      });
    }
  }
  const file = join(out, shards > 1 ? `${split}.part${shard}.jsonl` : `${split}.jsonl`);
  writeFileSync(file, rows.join('\n') + (rows.length ? '\n' : ''));
  console.log(JSON.stringify({ file, samples: rows.length, teacherAgreesWithHindsight: rows.length ? agree / rows.length : null, seeds: seeds.length, seconds: Math.round((performance.now() - t0) / 1000) }));
} else if (mode === 'rollout') {
  const res: any[] = [];
  for (const scn of scenarios) {
    for (const seed of seeds) {
      const w = runWithForks(scn, seed, (d) => d.legal[d.costs.indexOf(Math.min(...d.costs))]);
      const s = w.summary();
      res.push({ scenario: scn, seed, avgWait: s.avgWait, p95Wait: s.p95Wait, finishedAt: s.finishedAt, decisions: s.decisions });
    }
  }
  console.log(JSON.stringify({ shard, rows: res, seconds: Math.round((performance.now() - t0) / 1000) }));
} else {
  console.error('usage: hindsight.ts label|rollout [options]');
  process.exit(2);
}
