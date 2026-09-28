// Arena runner: serves the prototype and connects it to real System One
// models. Loopback only. The keys stay in this process: the browser never
// sees them, and only this origin may call the API.
//
//   node --experimental-strip-types runner/src/server.ts   (or: npm start, in runner/)
//
// Keys: ~/.config/elevator-arena/env (TYPESAFE_API_KEY, LAYA_API_KEY), or the
// process environment. Values are never logged.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKENDS, decide, fineTuneBackends, fineTuneContestants, liveContestants, type Backend, type Identity } from './backends.ts';
import type { DecideBody } from './types.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ARENA_PORT ?? 8787);
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../../prototype'));
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const MAX_BODY = 256 * 1024;

// ── Keys ─────────────────────────────────────────────────────────────────

function loadEnvFile(): void {
  const file = join(homedir(), '.config/elevator-arena/env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile();

// ── Contestants and their availability ─────────────────────────────────

const FT: Backend[] = fineTuneBackends();
let LIVE = liveContestants();
let byCid = new Map(LIVE.map((c) => [c.cid, c]));
let identities: Record<string, Identity> = {};
let checkedAt = 0;

// Fine-tunes are contestants only while their server answers, pinned by the
// hash it reports, so the list is rebuilt on every check.
async function checkBackends(force = false): Promise<Record<string, Identity>> {
  if (!force && Date.now() - checkedAt < 30_000) return identities;
  const all = [...Object.values(BACKENDS), ...FT];
  const entries = await Promise.all(all.map(async (b) => [b.id, await b.identity()] as const));
  identities = Object.fromEntries(entries);
  checkedAt = Date.now();
  LIVE = [...liveContestants(), ...fineTuneContestants(FT, identities)];
  byCid = new Map(LIVE.map((c) => [c.cid, c]));
  return identities;
}

// laya-serve's first inference is slow (~2 s warm-up); do it before any race.
async function warmUp(): Promise<void> {
  const c = byCid.get('laya-local@enc1');
  if (!c || !identities.laya?.ok) return;
  const obs = { t: 0, n: 0, floors: 6, vmax: 1.25, request: { kind: 'assign' as const, floor: 1, dir: 'up' as const, reason: 'new' }, cars: [{ idx: 0, floor: 0, dir: 0, mode: 'normal', doorPhase: 'closed', loadKg: 0, capacityKg: 420, stops: 0, assigned: 0, coming: false }] };
  await decide(c, { contestant: c.cid, request: obs.request, observation: obs, options: [{ i: 0, car: 0, label: 'Car 1', legal: true }], timeoutMs: 10_000 }).catch(() => {});
}

function manifest() {
  return LIVE.map((c) => {
    const id = identities[c.backend.id];
    const facets = { ...c.facets };
    if (c.backend.id === 'laya' && id?.device) facets.compute = { label: `laya-serve · ${id.device}` };
    return {
      id: c.id,
      version: c.version,
      cid: c.cid,
      name: c.name,
      family: c.family,
      description: c.description,
      external: c.backend.id === 'jev' ? 'api.typesafe.ai' : null,
      endpoint: c.backend.url,
      model: c.backend.model,
      encoding: c.encoding,
      limits: { timeoutS: c.timeoutS },
      fallback: 'nearest-car-eta@v1.3.0',
      decisionWh: c.decisionWh,
      facets,
      available: !!id?.ok,
      status: id?.detail ?? 'not checked',
    };
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Loopback + same origin only: blocks DNS rebinding (Host) and other sites
// in the same browser (Origin) from spending the API key.
function allowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (!ORIGINS.has(`http://${host}`)) return false;
  const origin = req.headers.origin;
  if (req.method !== 'GET' && !(origin && ORIGINS.has(origin))) return false;
  if (origin && !ORIGINS.has(origin)) return false;
  return true;
}

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validDecide(b: any): b is DecideBody {
  return (
    b && typeof b.contestant === 'string' && b.request && (b.request.kind === 'assign' || b.request.kind === 'overload') &&
    b.observation && Array.isArray(b.observation.cars) && Array.isArray(b.options) && b.options.length <= 32 &&
    b.options.every((o: any) => Number.isInteger(o.i) && typeof o.label === 'string' && typeof o.legal === 'boolean') &&
    (b.timeoutMs === null || (typeof b.timeoutMs === 'number' && b.timeoutMs > 0 && b.timeoutMs <= 10_000))
  );
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && path === '/api/contestants') {
      await checkBackends();
      return send(res, 200, { runner: 'arena-runner 0.1', contestants: manifest() });
    }
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, backends: await checkBackends(true) });
    }
    if (req.method === 'POST' && path === '/api/decide') {
      const body = await readBody(req);
      if (!validDecide(body)) return send(res, 400, { error: 'invalid decide request' });
      const c = byCid.get(body.contestant);
      if (!c) return send(res, 404, { error: `unknown contestant ${body.contestant}` });
      const out = await decide(c, body);
      // One line per real call, so it's visible that models are being asked.
      // Never logs keys, and never the request or response bodies.
      if (process.env.ARENA_LOG !== '0') {
        const what = out.ok ? `choice ${out.choice}` : out.error;
        const cost = out.costUsd ? ` · $${out.costUsd.toFixed(6)}` : '';
        console.log(`${new Date().toLocaleTimeString('en-GB', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')}  ${c.cid.padEnd(16)} ${String(Math.round(out.latencyMs)).padStart(5)} ms  ${what}${out.tokens ? ` · ${out.tokens} tok` : ''}${cost}${out.drift ? ' · DRIFT' : ''}`);
      }
      return send(res, 200, out);
    }
    if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    serveStatic(req, res);
  } catch (e: any) {
    send(res, 500, { error: String(e?.message ?? e).slice(0, 200) });
  }
});

server.listen(PORT, HOST, async () => {
  const ids = await checkBackends(true);
  console.log(`arena runner on http://${HOST}:${PORT}/  (prototype + API, loopback only)`);
  for (const [b, id] of Object.entries(ids)) console.log(`  ${b.padEnd(5)} ${id.ok ? 'ok  ' : 'down'} ${id.detail}`);
  await warmUp();
});
