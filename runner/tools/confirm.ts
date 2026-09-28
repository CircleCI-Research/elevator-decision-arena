// Confirmation run: the pre-registered test of the headline claims on fresh
// seeds (docs/confirmation/preregistration.md). Everything the analysis
// depends on is fixed in SPEC below, and its hash is recorded in the
// pre-registration before any call is made.
//
// Headless: the simulator is loaded exactly as the page loads it, and live
// contestants are asked through the running arena runner (keys stay there).
//
//   node --experimental-strip-types tools/confirm.ts                  # the pre-registered run
//   node --experimental-strip-types tools/confirm.ts --seeds 9001-9002 --out /tmp/x   # plumbing check
//   node --experimental-strip-types tools/confirm.ts --spec-hash      # print the spec hash only
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const RUNNER = 'http://127.0.0.1:8787';
const H = 1 / 60;

export const SPEC = {
  name: 'EDA confirmation run 1',
  simulator: 'eda-sim 0.2',
  building: { floors: 24, cars: 4 },
  scenarios: ['normal', 'morning-wave'], // each with its default scripted events
  seeds: [2001, 2030], // fresh: never used for training (1-60), validation (501-520), evaluation (1001-1010) or design
  timing: { mode: 'fixed', fixedS: 0.25, timeout: 'own' },
  // Each pairing is one run per scenario and seed; lanes are independent worlds.
  pairings: [
    ['jev@enc3', 'jev@enc1'],
    ['nearest-car-eta@v1.2.0', 'round-robin@v1.0.0'],
    ['nearest-car-eta@v1.3.0', 'zoned@v1.0.0'],
  ],
  metric: 'avgWait',
  primary: [
    // H1: the arrival estimate helps Jev (two-sided paired t-test, difference < 0 expected).
    { id: 'H1-normal', kind: 'difference', a: 'jev@enc3', b: 'jev@enc1', scenario: 'normal' },
    { id: 'H1-morning-wave', kind: 'difference', a: 'jev@enc3', b: 'jev@enc1', scenario: 'morning-wave' },
    // H2: with the estimate, Jev is equivalent to Nearest-Car ETA v1.2.0 within ±1.5 s (TOST).
    { id: 'H2-normal', kind: 'equivalence', a: 'jev@enc3', b: 'nearest-car-eta@v1.2.0', scenario: 'normal', margin: 1.5 },
    { id: 'H2-morning-wave', kind: 'equivalence', a: 'jev@enc3', b: 'nearest-car-eta@v1.2.0', scenario: 'morning-wave', margin: 1.5 },
  ],
  alpha: 0.05, // family-wise, Holm across the four primary tests
  exploratory: [
    ['jev@enc1', 'round-robin@v1.0.0'],
    ['jev@enc3', 'round-robin@v1.0.0'],
    ['jev@enc3', 'nearest-car-eta@v1.3.0'],
    ['nearest-car-eta@v1.3.0', 'nearest-car-eta@v1.2.0'],
  ],
  rerunRule: 'a run where more than 5% of a live lane\'s decisions failed or fell back is rerun once, and both are reported',
};

export const specHash = () => createHash('sha256').update(JSON.stringify(SPEC)).digest('hex');

function arg(name: string, def: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

// ── Statistics (Student t via the regularised incomplete beta) ─────────────

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function betacf(a: number, b: number, x: number): number {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / (1 + aa * d || 1e-30); c = 1 + aa / c || 1e-30; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / (1 + aa * d || 1e-30); c = 1 + aa / c || 1e-30;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}
function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
export function tcdf(t: number, df: number): number {
  const p = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}
export function tinv(p: number, df: number): number {
  let lo = -50, hi = 50;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tcdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function paired(a: number[], b: number[]) {
  const d = a.map((x, i) => x - b[i]);
  const n = d.length;
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = mean / se;
  const q95 = tinv(0.975, n - 1), q90 = tinv(0.95, n - 1);
  return {
    n, mean, sd, se,
    p: 2 * (1 - tcdf(Math.abs(t), n - 1)),
    ci95: [mean - q95 * se, mean + q95 * se],
    ci90: [mean - q90 * se, mean + q90 * se],
    aBetter: d.filter((x) => x < 0).length, // lower wait is better
    diffs: d,
  };
}

function tost(pr: ReturnType<typeof paired>, m: number) {
  const df = pr.n - 1;
  const pLower = 1 - tcdf((pr.mean + m) / pr.se, df); // H0: diff <= -m
  const pUpper = tcdf((pr.mean - m) / pr.se, df); // H0: diff >= +m
  return Math.max(pLower, pUpper);
}

export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const adj = new Array(ps.length);
  let run = 0;
  order.forEach(([p, i], j) => {
    run = Math.max(run, Math.min(1, (ps.length - j) * p));
    adj[i] = run;
  });
  return adj;
}

// ── Running ────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--spec-hash')) {
    console.log(specHash());
    return;
  }
  const [s0, s1] = (arg('seeds', null) ?? `${SPEC.seeds[0]}-${SPEC.seeds[1]}`).split('-').map(Number);
  const seeds = Array.from({ length: (s1 ?? s0) - s0 + 1 }, (_, i) => s0 + i);
  const preregistered = !arg('seeds', null);
  const out = arg('out', join(dirname(fileURLToPath(import.meta.url)), '../../docs/findings/evidence/confirm'))!;
  mkdirSync(join(out, 'runs'), { recursive: true });

  const mem = new Map<string, string>();
  const ctx: any = { console, performance, Math, JSON, Map, Set, Promise, localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/sim/scenario.js', 'js/sim/world.js', 'js/sim/registry.js', 'js/setup.js', 'js/history-store.js', 'js/audit.js']) {
    vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  const EDA = ctx.EDA;
  if (EDA.history.SIM_VERSION !== SPEC.simulator) throw new Error(`simulator is ${EDA.history.SIM_VERSION}, spec says ${SPEC.simulator}`);

  // Live contestants from the runner, asked through it.
  const man = await (await fetch(`${RUNNER}/api/contestants`)).json();
  let calls = 0;
  const ask = async (p: any, req: any, obs: any, options: any[], timeoutS: number | null) => {
    calls++;
    const t0 = performance.now();
    const body = { contestant: p.cid, request: req, observation: obs, options: options.map((o: any, i: number) => ({ i, car: o.car, label: o.label, short: o.short, legal: !o.veto })), timeoutMs: timeoutS == null ? null : Math.round(timeoutS * 1000) };
    try {
      const r = await fetch(`${RUNNER}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: RUNNER }, body: JSON.stringify(body) });
      const j: any = await r.json();
      if (!r.ok) return { ok: false, error: `failure: runner ${r.status} ${j?.error ?? ''}`.trim(), latencyMs: performance.now() - t0 };
      return j;
    } catch {
      return { ok: false, error: 'failure: runner unreachable', latencyMs: performance.now() - t0 };
    }
  };
  EDA.registry.setLive(man.contestants, ask);
  const cids = [...new Set(SPEC.pairings.flat())];
  for (const cid of cids) {
    const p = EDA.registry.byCid(cid);
    if (!p) throw new Error(`contestant ${cid} is not available`);
    if (p.live && !p.available) throw new Error(`${cid} is offline: ${p.status}`);
  }
  console.log(JSON.stringify({ spec: specHash(), preregistered, seeds: `${seeds[0]}-${seeds.at(-1)}`, runner: man.runner }));

  const tick = () => new Promise((r) => setTimeout(r, 2));
  async function playWorld(w: any) {
    let s = 0;
    while (w.finishedAt === null && s < 60 * 4000) {
      if (w.waiting) { await tick(); continue; }
      w.step(H);
      w.events.length = 0;
      s++;
      if (s % 600 === 0) await tick(); // let other worlds' answers land
    }
  }

  let nextId = 1;
  async function race(scn: string, seed: number, pair: string[]) {
    const spec = EDA.scenario.byId(scn);
    const cfg = EDA.scenario.makeConfig(SPEC.building.floors, SPEC.building.cars, { seed, scenario: spec, events: EDA.scenario.defaultEvents(spec), timing: SPEC.timing });
    const script = EDA.scenario.buildScript(cfg);
    const C = pair.map((cid, i) => ({ key: 'AB'[i], policy: EDA.registry.byCid(cid) }));
    const run: any = { id: nextId++, cfg, def: { mode: 'fast' }, modes: new Set(['fast']), passengers: script.arrivals.length, createdAt: Date.now(), done: false };
    run.worlds = C.map((c) => new EDA.World({ id: c.key, cfg, script, policy: c.policy }));
    run.contestants = C;
    await Promise.all(run.worlds.map(playWorld));
    run.done = run.worlds.every((w: any) => w.finishedAt !== null);
    const bundle = EDA.audit.bundleFromRun(run, C);
    return { scn, seed, pair, bundle };
  }

  const jobs: Promise<any>[] = [];
  for (const scn of SPEC.scenarios) for (const seed of seeds) for (const pair of SPEC.pairings) jobs.push(race(scn, seed, pair));
  const t0 = performance.now();
  const done = await Promise.all(jobs);

  // Rerun rule: a live lane with more than 5% failed or fallback decisions.
  const bad = (b: any) => b.contestants.some((c: any) => c.live && (b.results[c.key].fallbacks ?? 0) > 0.05 * b.results[c.key].decisions);
  const reruns: any[] = [];
  for (const d of done) if (bad(d.bundle)) reruns.push(await race(d.scn, d.seed, d.pair));

  // Values per contestant, scenario and seed (the first run; reruns reported separately).
  const val = new Map<string, number>();
  const extra = new Map<string, any>();
  for (const d of done) {
    for (const c of d.bundle.contestants) {
      const r = d.bundle.results[c.key];
      val.set(`${c.cid}|${d.scn}|${d.seed}`, r[SPEC.metric]);
      extra.set(`${c.cid}|${d.scn}|${d.seed}`, { p95Wait: r.p95Wait, decisions: r.decisions, fallbacks: r.fallbacks, drifted: r.drifted ?? 0, apiCostUsd: r.apiCostUsd ?? 0, apiTokens: r.apiTokens ?? 0 });
    }
    const name = `${d.scn}-seed${d.seed}-${d.pair.join('_vs_').replace(/[@.]/g, '-')}.json`;
    writeFileSync(join(out, 'runs', name), JSON.stringify(d.bundle));
  }
  const series = (cid: string, scn: string) => seeds.map((s) => val.get(`${cid}|${scn}|${s}`) as number);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const primary = SPEC.primary.map((h: any) => {
    const pr = paired(series(h.a, h.scenario), series(h.b, h.scenario));
    const p = h.kind === 'equivalence' ? tost(pr, h.margin) : pr.p;
    return { ...h, ...pr, pTest: p, diffs: undefined };
  });
  const adj = holm(primary.map((h: any) => h.pTest));
  primary.forEach((h: any, i: number) => {
    h.pHolm = adj[i];
    h.supported = h.pHolm < SPEC.alpha && (h.kind === 'equivalence' || h.mean < 0);
  });
  const exploratory = SPEC.scenarios.flatMap((scn) => SPEC.exploratory.map(([a, b]) => ({ a, b, scenario: scn, ...paired(series(a, scn), series(b, scn)), diffs: undefined })));
  const means = Object.fromEntries(cids.flatMap((cid) => SPEC.scenarios.map((scn) => [`${cid}|${scn}`, mean(series(cid, scn))])));
  let jevCost = 0, jevTokens = 0, fallbacks = 0, drifted = 0, liveDecisions = 0;
  for (const [k, e] of extra) {
    if (!k.startsWith('jev@')) continue;
    jevCost += e.apiCostUsd; jevTokens += e.apiTokens; fallbacks += e.fallbacks ?? 0; drifted += e.drifted; liveDecisions += e.decisions;
  }
  const result = {
    spec: SPEC, specHash: specHash(), preregistered, ranAt: new Date().toISOString(), seconds: Math.round((performance.now() - t0) / 1000),
    runs: done.length, reruns: reruns.map((r) => ({ scn: r.scn, seed: r.seed, pair: r.pair })), runnerCalls: calls,
    jev: { decisions: liveDecisions, fallbacks, drifted, tokens: jevTokens, costUsd: jevCost },
    means, primary, exploratory,
    perSeed: Object.fromEntries([...val].map(([k, v]) => [k, v])),
  };
  writeFileSync(join(out, 'analysis.json'), JSON.stringify(result, null, 1));

  const f = (x: number) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
  console.log(`\n${done.length} runs, ${reruns.length} reruns, ${calls} live calls, Jev $${jevCost.toFixed(4)}, fallbacks ${fallbacks}, drift ${drifted}, ${result.seconds} s\n`);
  for (const h of primary as any[]) {
    console.log(`${h.id.padEnd(16)} ${h.a} − ${h.b}: ${f(h.mean)} s, 95% CI [${f(h.ci95[0])}, ${f(h.ci95[1])}], 90% CI [${f(h.ci90[0])}, ${f(h.ci90[1])}], ${h.kind === 'equivalence' ? `TOST ±${h.margin}` : 't'} p=${h.pTest.toExponential(2)}, Holm ${h.pHolm.toExponential(2)} → ${h.supported ? 'SUPPORTED' : 'not supported'} · A better on ${h.aBetter}/${h.n}`);
  }
  console.log('\nmeans (s):', Object.entries(means).map(([k, v]) => `${k} ${(v as number).toFixed(1)}`).join(' | '));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
