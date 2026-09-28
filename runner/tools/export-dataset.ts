// Export a Laya fine-tuning dataset from the arena's simulator.
//
// Runs the app's simulator headless with a teacher policy driving,
// and at every decision records exactly what a live contestant would be
// sent (the runner's own encoder) plus a label. Pilot: imitation labels, the
// teacher's choice as a one-hot target.
//
//   node --experimental-strip-types tools/export-dataset.ts \
//     --out ../runtime/laya/data/pilot --encoding 3 \
//     --train 1-60 --val 501-520 --scenarios normal,morning-wave --size 24x4
//
// Seeds 1001–1010 are the evaluation seeds of demo sets 1 and 3 and are
// refused here, so nothing trained on can leak into the rematch.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { encode } from '../src/encoding.ts';
import type { Observation, Opt } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const EVAL_SEEDS = [1001, 1010];

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const range = (s: string) => {
  const [a, b] = s.split('-').map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
};

const out = arg('out', '../runtime/laya/data/pilot');
const encoding = Number(arg('encoding', '3')) as 1 | 2 | 3;
const teacherCid = arg('teacher', 'nearest-car-eta@v1.3.0');
const scenarios = arg('scenarios', 'normal,morning-wave').split(',');
const [floors, cars] = arg('size', '24x4').split('x').map(Number);
const splits = { train: range(arg('train', '1-60')), val: range(arg('val', '501-520')) };
for (const s of [...splits.train, ...splits.val]) {
  if (s >= EVAL_SEEDS[0] && s <= EVAL_SEEDS[1]) throw new Error(`seed ${s} is an evaluation seed (${EVAL_SEEDS.join('–')}); refusing to train on it`);
}

// Load the simulator exactly as the page does.
const mem = new Map<string, string>(); // the history module expects browser storage
const ctx: any = { console, performance, Math, JSON, Map, Set, localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['js/util.js', 'js/sim/scenario.js', 'js/sim/world.js', 'js/sim/registry.js', 'js/setup.js', 'js/history-store.js']) {
  vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const EDA = ctx.EDA;
const teacher = EDA.registry.byCid(teacherCid);
if (!teacher) throw new Error(`unknown teacher ${teacherCid}`);

mkdirSync(out, { recursive: true });
const stats: Record<string, any> = {};
for (const [split, seeds] of Object.entries(splits)) {
  const rows: string[] = [];
  let skipped = 0;
  for (const scn of scenarios) {
    const spec = EDA.scenario.byId(scn);
    for (const seed of seeds) {
      const cfg = EDA.scenario.makeConfig(floors, cars, { seed, scenario: spec, events: EDA.scenario.defaultEvents(spec), timing: { mode: 'fixed', fixedS: 0.25, timeout: 'own' } });
      // The teacher drives; each of its decisions is recorded as a sample.
      const policy = {
        ...teacher,
        decide(req: any, obs: Observation, rng: any) {
          const dec = teacher.decide(req, obs, rng);
          const built = EDA.registry.buildOptions(req, obs);
          const options: Opt[] = built.options.map((o: any, i: number) => ({ i, car: o.car, label: o.label, short: o.short, legal: !o.veto }));
          const legal = options.filter((o) => o.legal);
          if (legal.length < 2 || dec.choice < 0) {
            skipped++; // nothing to learn from a forced or empty choice
            return dec;
          }
          const enc = encode(encoding, 'english', obs, options);
          const j = enc.legal.indexOf(dec.choice);
          if (j < 0) throw new Error(`teacher chose an illegal option at seed ${seed} t=${obs.t}`);
          const q = enc.body.questions.decision;
          rows.push(JSON.stringify({
            id: `${scn}-${seed}-${rows.length}`,
            split, scenario: scn, seed, t: Math.round(obs.t * 10) / 10, kind: req.kind,
            state: enc.body.state,
            question: q,
            keys: enc.keys,
            target: enc.keys.map((_, k) => (k === j ? 1 : 0)),
            label: enc.keys[j],
          }));
          return dec;
        },
      };
      const w = new EDA.World({ id: 'A', cfg, script: EDA.scenario.buildScript(cfg), policy });
      for (let s = 0; s < 60 * 3000 && w.finishedAt === null; s++) {
        w.step(1 / 60);
        w.events.length = 0;
      }
      if (w.finishedAt === null) throw new Error(`run did not finish: ${scn} seed ${seed}`);
    }
  }
  writeFileSync(join(out, `${split}.jsonl`), rows.join('\n') + '\n');
  const parsed = rows.map((r) => JSON.parse(r));
  const byKind = parsed.reduce((m: any, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
  const byOptions = parsed.reduce((m: any, r) => ((m[r.keys.length] = (m[r.keys.length] ?? 0) + 1), m), {});
  const byLabel = parsed.reduce((m: any, r) => ((m[r.label] = (m[r.label] ?? 0) + 1), m), {});
  stats[split] = { samples: rows.length, skipped, byKind, byOptions, byLabel, seeds: `${seeds[0]}–${seeds.at(-1)}` };
}
const meta = { created: new Date().toISOString(), simulator: EDA.history.SIM_VERSION, encoding, teacher: teacherCid, labels: 'imitation (teacher choice, one-hot)', scenarios, size: `${floors}x${cars}`, timing: 'fixed 0.25 s', stats };
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
