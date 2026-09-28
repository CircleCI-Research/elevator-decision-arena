// Usage: node --experimental-strip-types tools/positions.ts <confirmation output dir, with runs/>
// Position analysis, exact: replay each run file (rebuilding the observation each
// decision saw), re-encode it with the runner's own encoder, check the rebuilt
// request equals the recorded one, and read off the order the model saw.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { encode } from '../src/encoding.ts';
const ROOT = new URL('../../app', import.meta.url).pathname;
const dir = process.argv[2];
const mem = new Map<string, string>();
const ctx: any = { console, performance, Math, JSON, Map, Set, localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } };
ctx.window = ctx; vm.createContext(ctx);
for (const f of ['js/util.js', 'js/sim/scenario.js', 'js/sim/world.js', 'js/sim/registry.js', 'js/setup.js', 'js/history-store.js', 'js/audit.js']) vm.runInContext(readFileSync(`${ROOT}/${f}`, 'utf8'), ctx);
const EDA = ctx.EDA;
const stats: Record<string, any> = {};
let mismatched = 0, checked = 0;
for (const f of readdirSync(`${dir}/runs`)) {
  const b = JSON.parse(readFileSync(`${dir}/runs/${f}`, 'utf8'));
  if (!b.contestants.some((c: any) => c.live)) continue;
  const cond = f.split('-seed')[0];
  const v = EDA.audit.verify(b);
  for (const c of b.contestants) {
    if (!c.live) continue;
    const n = Number(c.live.encoding);
    const shuffle = /enc\ds$/.test(c.cid) || c.cid.endsWith('-shuffled');
    for (const cap of v.decisions[c.key].captured) {
      const rec = cap.rec;
      if (!rec || rec.kind !== 'assign' || rec.fallback || !rec.io?.request) continue;
      const opts = rec.options.map((o: any, i: number) => ({ i, car: o.car, label: o.label, short: o.short, legal: !o.veto }));
      const legal = opts.filter((o: any) => o.legal).map((o: any) => o.i);
      if (legal.length < 2 || !legal.includes(rec.choice)) continue;
      const obs = JSON.parse(JSON.stringify(cap.obs));
      const enc = encode(n as 1 | 2 | 3, rec.io.request.model, obs, opts, shuffle);
      checked++;
      if (JSON.stringify(enc.body.questions) !== JSON.stringify(rec.io.request.questions)) { mismatched++; continue; }
      const seenPos = enc.legal.indexOf(rec.choice);
      const best = legal.reduce((a: number, i: number) => (rec.options[i].eta < rec.options[a].eta - 1e-9 ? i : a), legal[0]);
      const rulePos = enc.legal.indexOf(best);
      const k = `${c.cid}|${cond}`;
      const st = (stats[k] ??= { n: 0, pickA: 0, ruleA: 0, agree: 0, notA: 0, pickAnotA: 0, pickLastNotLast: 0, notLast: 0 });
      st.n++; st.pickA += seenPos === 0; st.ruleA += rulePos === 0; st.agree += rec.choice === best;
      if (rulePos !== 0) { st.notA++; st.pickAnotA += seenPos === 0; }
      if (rulePos !== enc.legal.length - 1) { st.notLast++; st.pickLastNotLast += seenPos === enc.legal.length - 1; }
    }
  }
}
const pct = (a: number, b: number) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
console.log(`requests rebuilt: ${checked}, identical to the recorded request: ${checked - mismatched}, mismatched: ${mismatched}`);
const out: Record<string, any> = {};
for (const [k, s] of Object.entries(stats).sort()) {
  out[k] = { n: s.n, pickA: s.pickA / s.n, ruleCarAtA: s.ruleA / s.n, agreeWithRule: s.agree / s.n, pickAWhenRuleNotA: s.pickAnotA / s.notA, pickLastWhenRuleNotLast: s.pickLastNotLast / s.notLast };
  console.log(`${k.padEnd(62)} n=${String(s.n).padStart(5)}  picks A ${pct(s.pickA, s.n).padStart(6)}  rule's car at A ${pct(s.ruleA, s.n).padStart(6)}  agrees ${pct(s.agree, s.n).padStart(6)}  | rule's car not A → picks A ${pct(s.pickAnotA, s.notA).padStart(6)}  · rule's car not last → picks last ${pct(s.pickLastNotLast, s.notLast).padStart(6)}`);
}
writeFileSync(`${dir}/positions.json`, JSON.stringify({ checked, mismatched, lanes: out }, null, 1));
