// Spike: send the same System One request N times and report latency and
// consistency. Usage: node repeat.mjs jev|laya   (keys from the environment)
import { readFileSync } from 'node:fs';
const TARGETS = {
  jev: { url: 'https://api.typesafe.ai/v1/systemone', key: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0' },
  laya: { url: 'http://127.0.0.1:8000/v1/systemone', key: process.env.LAYA_API_KEY, model: 'english' },
};
const target = TARGETS[process.argv[2] ?? 'jev'];
const N = Number(process.argv[3] ?? 10);
const enc1 = JSON.parse(readFileSync(new URL('fixture-enc1.json', import.meta.url), 'utf8'));
const enc2 = structuredClone(enc1);
enc2.questions.car.criteria = {
  A: '4 floors below the call, moving towards it, about a quarter full, 2 stops on the way',
  B: '5 floors above the call, idle with doors open, empty',
  C: '1 floor below the call, moving towards it, almost full',
  D: 'out of service',
};
async function ask(body) {
  const t0 = performance.now();
  const r = await fetch(target.url, { method: 'POST', headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: target.model }) });
  const ms = performance.now() - t0;
  const j = await r.json();
  return { status: r.status, ms, inferMs: Number(r.headers.get('x-inference-time-ms')) || null, model: j.model, routing: j.routing?.model, a: j.answers?.car, tokens: j.usage?.input_tokens };
}
const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
for (const [name, body] of [['enc1', enc1], ['enc2', enc2]]) {
  const out = [];
  for (let i = 0; i < N; i++) out.push(await ask(body)); // sequential: no bursts
  const ms = out.map((o) => o.ms).sort((a, b) => a - b);
  const inf = out.map((o) => o.inferMs).filter(Boolean).sort((a, b) => a - b);
  const picks = {};
  out.forEach((o) => (picks[o.a?.choice] = (picks[o.a?.choice] ?? 0) + 1));
  const pA = out.map((o) => o.a?.probabilities?.A);
  const distinct = new Set(out.map((o) => JSON.stringify(o.a?.probabilities))).size;
  console.log(`${name}: status ${[...new Set(out.map((o) => o.status))]} · model ${[...new Set(out.map((o) => o.model))]}${out[0].routing ? ` · routed ${out[0].routing}` : ''} · tokens ${out[0].tokens}`);
  console.log(`  round trip p50 ${q(ms, 0.5).toFixed(0)} ms · min ${ms[0].toFixed(0)} · max ${ms.at(-1).toFixed(0)}${inf.length ? ` · server inference p50 ${q(inf, 0.5).toFixed(0)} ms` : ''}`);
  console.log(`  picks ${JSON.stringify(picks)} · distinct distributions ${distinct}/${N} · P(A) ${Math.min(...pA)}–${Math.max(...pA)}`);
  console.log(`  first: ${JSON.stringify(out[0].a?.probabilities)} conf ${out[0].a?.confidence}`);
}
