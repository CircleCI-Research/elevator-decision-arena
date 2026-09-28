// Ask Jev (or local Laya) every decision of a dataset split and measure agreement with its label.
// Usage: node docs/spike/accuracy.mjs jev|laya <file.jsonl> [concurrency]   (keys from the environment)
import { readFileSync } from 'node:fs';
const T = {
  jev: { url: 'https://api.typesafe.ai/v1/systemone', key: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0' },
  laya: { url: 'http://127.0.0.1:8000/v1/systemone', key: process.env.LAYA_API_KEY, model: 'english' },
}[process.argv[2]];
const rows = readFileSync(process.argv[3], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const conc = Number(process.argv[4] ?? 4);
let next = 0, ok = 0, agree = 0, errors = 0, tokens = 0, drift = 0;
const lat = [];
async function worker() {
  while (next < rows.length) {
    const r = rows[next++];
    const body = { model: T.model, state: r.state, questions: { decision: r.question } };
    const t0 = performance.now();
    try {
      const res = await fetch(T.url, { method: 'POST', headers: { Authorization: `Bearer ${T.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const j = await res.json();
      lat.push(performance.now() - t0);
      if (res.status !== 200 || !j.answers?.decision) { errors++; continue; }
      ok++;
      if (j.answers.decision.choice === r.label) agree++;
      tokens += j.usage?.input_tokens ?? 0;
      if (process.argv[2] === 'jev' && j.model !== T.model) drift++;
    } catch { errors++; }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
lat.sort((a, b) => a - b);
console.log(JSON.stringify({ target: process.argv[2], file: process.argv[3], asked: rows.length, answered: ok, errors, drift, accuracy: ok ? agree / ok : null, p50ms: Math.round(lat[Math.floor(lat.length / 2)]), tokens, costUsd: process.argv[2] === 'jev' ? +(tokens / 1e6 * 0.042).toFixed(4) : 0 }));
