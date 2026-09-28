# Arena runner

Serves the prototype and connects it to real **System One** models: local **Laya** (through `laya-serve`) and **Jev** (through api.typesafe.ai). The keys stay in this process; the browser never sees them.

```sh
runtime/laya/serve.sh        # terminal 1: local Laya on 127.0.0.1:8000 (optional)
cd runner && npm start       # terminal 2: open http://127.0.0.1:8787/
```

Node 22.6 or newer, with no dependencies: TypeScript runs through Node's type stripping.

## Keys

Keys are read from `~/.config/elevator-arena/env` (mode 600), or the environment:

```
TYPESAFE_API_KEY=…   # Jev
LAYA_API_KEY=…       # the local laya-serve's own key
```

Values are never logged, returned or written to run files. Run files record the request body and response, which contain no credentials.

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /` and static files | The prototype (`../prototype`) |
| `GET /api/contestants` | Live contestants with setup facets and availability. Identity is checked every 30 s: Laya's `/health` must report the pinned commit, and Jev's `/v1/models` must answer. |
| `GET /api/health` | Backend checks, forced |
| `POST /api/decide` | One decision: observation and legal options in; probabilities, choice, timings, token cost and the raw request and response out |

Per decision it does four things:

- **Encoding:** `src/encoding.ts` turns the observation into one `choice` question: encoding 1 (raw numbers), 2 (relative words) or 3 (a per-car arrival estimate computed by the encoding, as Nearest-Car ETA v1.2.0 computes it). It is pure and deterministic, and golden-tested against `docs/spike/fixture-enc1.json`. Only legal options are offered.
- **Transport:** plain `fetch`, with a hard abort just past the experiment's timeout and one retry on 429/529 if the time budget allows. At most 1 request in flight to Laya and 4 to Jev; queueing time is reported separately from latency.
- **Identity:** Jev's response `model` is compared with the pinned `jev-1.13.0` on every decision (*drift*). Laya's is checked through `/health`.
- **Failures:** timeouts, HTTP errors, unreachable servers and malformed answers come back as `ok: false` with a reason, and the browser's engine hands the decision to the contestant's fallback.

## Log

The runner prints one line per real model call: time, contestant, round trip, choice or error, tokens and cost. It never prints keys or bodies. Set `ARENA_LOG=0` to silence it.

```
14:02:11.482  jev@enc3           212 ms  choice 1 · 471 tok · $0.000020
14:02:11.530  laya-local@enc3     37 ms  choice 2 · 160 tok
```

## Security

- Binds `127.0.0.1` only.
- Rejects any request whose `Host` isn't the runner's own (DNS rebinding) and any `POST` whose `Origin` isn't the runner's own page, so other sites open in the same browser can't spend the API key.
- Serves static files from `../prototype` only, with path traversal blocked, and caps request bodies at 256 KB.

## Tests

```sh
npm test    # encoder golden files and decoder checks
```
