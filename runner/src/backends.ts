// The two System One endpoints, and the contestants built on them.
//
// One transport serves both (model-setups.md §3): a plain fetch with a hard
// timeout, one retry on 429/529 inside the time budget, and a per-backend
// concurrency limit whose queueing time is reported separately.
import { createHash } from 'node:crypto';
import { decode, encode, TEMPLATES } from './encoding.ts';
import type { DecideBody, DecideResult } from './types.ts';

export interface Backend {
  id: string; // 'laya', 'jev', or 'laya-ft-<port>' for a local fine-tune
  url: string;
  keyEnv: string;
  model: string; // sent in every request
  maxInFlight: number;
  pricePerMTok: number; // input tokens, USD; 0 for local
  identity(): Promise<Identity>;
}

export interface Identity {
  ok: boolean;
  detail: string;
  revision?: string;
  device?: string;
  checkpoint?: string; // fine-tunes: directory name
  encoding?: 1 | 2 | 3; // fine-tunes: the encoding it was trained on
  valAccuracy?: number;
}

const LAYA_REVISION = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851'; // laya's reviewed pin
const JEV_MODEL = 'jev-1.13.0';

const key = (b: Backend) => process.env[b.keyEnv] ?? '';

async function getJson(url: string, token: string, ms = 4000): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ms) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

export const BACKENDS: Record<string, Backend> = {
  laya: {
    id: 'laya',
    url: 'http://127.0.0.1:8000/v1/systemone',
    keyEnv: 'LAYA_API_KEY',
    model: 'english',
    maxInFlight: 1, // laya-serve runs one inference at a time anyway
    pricePerMTok: 0,
    // Laya's responses don't say which checkpoint answered; /health does.
    async identity() {
      if (!key(this)) return { ok: false, detail: 'LAYA_API_KEY not set' };
      try {
        const { status, json } = await getJson('http://127.0.0.1:8000/health', key(this));
        if (status !== 200) return { ok: false, detail: `laya-serve /health returned ${status}` };
        const rev = json?.revisions?.english;
        const device = json?.checkpoint_devices?.english ?? json?.device;
        if (rev !== LAYA_REVISION) return { ok: false, detail: `english checkpoint at ${rev ?? 'unknown'}, expected ${LAYA_REVISION.slice(0, 7)}`, revision: rev, device };
        return { ok: true, detail: `laya-serve · english @ ${rev.slice(0, 7)} · ${device}`, revision: rev, device };
      } catch {
        return { ok: false, detail: 'laya-serve is not running on 127.0.0.1:8000 (start runtime/laya/serve.sh)' };
      }
    },
  },
  jev: {
    id: 'jev',
    url: 'https://api.typesafe.ai/v1/systemone',
    keyEnv: 'TYPESAFE_API_KEY',
    model: JEV_MODEL, // pinned; every response's `model` is checked against it
    maxInFlight: 4,
    pricePerMTok: 0.042,
    async identity() {
      if (!key(this)) return { ok: false, detail: 'TYPESAFE_API_KEY not set' };
      try {
        const { status } = await getJson('https://api.typesafe.ai/v1/models', key(this));
        if (status !== 200) return { ok: false, detail: `api.typesafe.ai /v1/models returned ${status}` };
        return { ok: true, detail: `api.typesafe.ai · ${JEV_MODEL} pinned, checked per decision` };
      } catch {
        return { ok: false, detail: 'api.typesafe.ai is unreachable' };
      }
    },
  },
};

// ── Local fine-tunes (runtime/laya/serve_local.py) ──────────────────────

// Ports of local fine-tune servers, from ARENA_LAYA_FT (for example "8001,8002").
export function fineTuneBackends(): Backend[] {
  const ports = (process.env.ARENA_LAYA_FT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ports.map((port) => ({
    id: `laya-ft-${port}`,
    url: `http://127.0.0.1:${port}/v1/systemone`,
    keyEnv: 'LAYA_API_KEY',
    model: 'local',
    maxInFlight: 1,
    pricePerMTok: 0,
    async identity() {
      if (!key(this)) return { ok: false, detail: 'LAYA_API_KEY not set' };
      try {
        const { status, json } = await getJson(`http://127.0.0.1:${port}/health`, key(this));
        if (status !== 200 || json?.status !== 'ok') return { ok: false, detail: `fine-tune server on :${port} returned ${status}` };
        return {
          ok: true,
          detail: `fine-tune ${json.checkpoint} @ ${String(json.sha256).slice(0, 12)} · ${json.device} · :${port}`,
          revision: json.sha256,
          device: json.device,
          checkpoint: json.checkpoint,
          encoding: json.encoding,
          valAccuracy: json.val_accuracy,
        };
      } catch {
        return { ok: false, detail: `no fine-tune server on 127.0.0.1:${port} (start runtime/laya/serve_local.py)` };
      }
    },
  }));
}

// One contestant per available fine-tune, pinned by the hash of its weights.
export function fineTuneContestants(backends: Backend[], ids: Record<string, Identity>): Live[] {
  const out: Live[] = [];
  for (const b of backends) {
    const id = ids[b.id];
    if (!id?.ok || !id.revision || !id.checkpoint || !id.encoding) continue;
    const n = id.encoding;
    const version = `${id.checkpoint}-${id.revision.slice(0, 7)}`;
    out.push({
      id: 'laya-ft',
      version,
      cid: `laya-ft@${version}`,
      name: 'Laya · fine-tuned',
      family: 'Laya · fine-tuned',
      description: `Live: a local fine-tune of Laya (${id.checkpoint}), asked with encoding ${n}, the one it was trained on.${id.valAccuracy != null ? ` Held-out accuracy against its labels: ${(id.valAccuracy * 100).toFixed(1)}%.` : ''}`,
      backend: b,
      encoding: n,
      timeoutS: 0.4,
      decisionWh: 0.0003,
      expectModel: `laya-ft/${id.checkpoint}@${id.revision.slice(0, 12)}`,
      facets: {
        interface: { label: 'System One · one choice question' },
        encoding: encFacet(n),
        model: { label: `laya fine-tune ${id.checkpoint} · ${id.revision.slice(0, 7)}`, value: `laya-ft@${id.revision}` },
        tuning: { label: 'Fine-tuned from 55cf4c4 · fitted temperature · top option', value: `ft:${id.revision}` },
        location: { label: `Local · 127.0.0.1:${b.url.split(':')[2].split('/')[0]}` },
        compute: { label: `laya.Agent · ${id.device}` },
        determinism: { label: 'Deterministic on identical requests (expected, as base Laya)' },
        cost: { label: 'Energy · ~0.0003 Wh per decision (GPU est.)', value: 'energy' },
      },
    });
  }
  return out;
}

// ── Contestants ─────────────────────────────────────────────────────────

export interface Live {
  id: string;
  version: string;
  cid: string;
  name: string;
  family: string;
  description: string;
  backend: Backend;
  encoding: 1 | 2 | 3;
  timeoutS: number;
  decisionWh: number;
  expectModel?: string; // what the endpoint must report as the answering model (drift check)
  facets: Record<string, { label: string; value?: string }>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const ENC_NAMES = { 1: 'raw numbers', 2: 'semantic', 3: 'derived ETA' } as const;
const encFacet = (n: 1 | 2 | 3) => ({ label: `system-one-encoding@${n} · ${ENC_NAMES[n]}`, value: sha(TEMPLATES[n]) });

export function liveContestants(): Live[] {
  const out: Live[] = [];
  for (const n of [1, 2, 3] as const) {
    out.push({
      id: 'laya-local',
      version: `enc${n}`,
      cid: `laya-local@enc${n}`,
      name: 'Laya · local',
      family: 'Laya · local',
      description: `Live: Laya's base English checkpoint on laya-serve (127.0.0.1), pinned to the reviewed commit, asked with encoding ${n}.`,
      backend: BACKENDS.laya,
      encoding: n,
      timeoutS: 0.4,
      decisionWh: 0.0003,
      facets: {
        interface: { label: 'System One · one choice question' },
        encoding: encFacet(n),
        model: { label: 'laya · reviewed commit 55cf4c4', value: `convaiinnovations/laya@${LAYA_REVISION}` },
        tuning: { label: 'Base checkpoint · no temperature · top option', value: 'laya-base' },
        location: { label: 'Local · 127.0.0.1:8000' },
        compute: { label: 'laya-serve · device from /health' },
        determinism: { label: 'Deterministic on identical requests (measured)' },
        cost: { label: 'Energy · ~0.0003 Wh per decision (GPU est.)', value: 'energy' },
      },
    });
    out.push({
      id: 'jev',
      version: `enc${n}`,
      cid: `jev@enc${n}`,
      name: 'Jev · API',
      family: 'Jev · API',
      description: `Live: TypeSafe's Jev through api.typesafe.ai, pinned to ${JEV_MODEL}, asked with encoding ${n}.`,
      backend: BACKENDS.jev,
      encoding: n,
      timeoutS: 1.5,
      decisionWh: 0,
      facets: {
        interface: { label: 'System One · one choice question' },
        encoding: encFacet(n),
        model: { label: `${JEV_MODEL} · pinned, checked per decision`, value: JEV_MODEL },
        tuning: { label: 'No fine-tuning possible · top option', value: 'jev-base' },
        location: { label: 'Remote · api.typesafe.ai · 1,200 req/min' },
        compute: { label: 'Not disclosed' },
        determinism: { label: 'Stochastic · probabilities vary on identical requests (measured)' },
        cost: { label: 'Money · tokens × $0.042/M, measured per decision', value: 'money' },
      },
    });
  }
  return out;
}

// ── Transport ───────────────────────────────────────────────────────────

const inFlight = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();

async function acquire(b: Backend): Promise<void> {
  const n = inFlight.get(b.id) ?? 0;
  if (n < b.maxInFlight) {
    inFlight.set(b.id, n + 1);
    return;
  }
  await new Promise<void>((res) => (waiters.get(b.id) ?? waiters.set(b.id, []).get(b.id)!).push(res));
  inFlight.set(b.id, (inFlight.get(b.id) ?? 0) + 1);
}

function release(b: Backend): void {
  inFlight.set(b.id, (inFlight.get(b.id) ?? 1) - 1);
  waiters.get(b.id)?.shift()?.();
}

const HARD_CAP_MS = 10_000; // when the experiment sets no timeout
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function decide(c: Live, body: DecideBody): Promise<DecideResult> {
  const b = c.backend;
  const enc = encode(c.encoding, b.model, body.observation, body.options);
  const q0 = performance.now();
  await acquire(b);
  const queuedMs = performance.now() - q0;
  const limitMs = body.timeoutMs ?? HARD_CAP_MS;
  const t0 = performance.now();
  let attempts = 0;
  try {
    for (;;) {
      attempts++;
      const left = limitMs - (performance.now() - t0);
      let r: Response;
      try {
        r = await fetch(b.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key(b)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(enc.body),
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(left + 5))), // just past the limit, so the engine sees it exceeded
        });
      } catch (e: any) {
        const latencyMs = performance.now() - t0;
        if (e?.name === 'TimeoutError' || latencyMs >= limitMs) return { ok: false, error: 'timeout', latencyMs, queuedMs, attempts, io: { request: enc.body, response: null } };
        return { ok: false, error: `failure: ${e?.cause?.code ?? e?.message ?? 'network error'}`, latencyMs, queuedMs, attempts, io: { request: enc.body, response: null } };
      }
      const latencyMs = performance.now() - t0;
      // Rate limited or overloaded: one retry, only if the budget allows it.
      if ((r.status === 429 || r.status === 529) && attempts === 1 && limitMs - latencyMs > 300) {
        await r.body?.cancel();
        await sleep(250);
        continue;
      }
      const json: any = await r.json().catch(() => null);
      if (r.status !== 200) return { ok: false, error: `failure: HTTP ${r.status}`, latencyMs, queuedMs, attempts, io: { request: enc.body, response: json } };
      const inferMs = Number(r.headers.get('x-inference-time-ms')) || null;
      const tokens = Number(json?.usage?.input_tokens) || 0;
      const model = String(json?.model ?? '');
      const base = {
        latencyMs,
        queuedMs,
        attempts,
        inferMs,
        model,
        drift: c.expectModel ? model !== c.expectModel : b.id === 'jev' ? model !== b.model : false,
        tokens,
        costUsd: (tokens / 1e6) * b.pricePerMTok,
        io: { request: enc.body, response: json },
      };
      try {
        const { probs, choice } = decode(enc, body.options.length, json);
        return { ok: true, probs, choice, ...base };
      } catch (e: any) {
        return { ok: false, error: e.message, ...base };
      }
    }
  } finally {
    release(b);
  }
}
