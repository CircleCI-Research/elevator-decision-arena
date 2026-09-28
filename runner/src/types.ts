// Shared types for the arena runner. See docs/model-setups.md §3–§7.

// What the browser engine sends for one decision: the request, the
// observation (state catalogue v1, aggregate-load profile) and the legal
// options it built. The runner never invents options.
export interface DecideBody {
  contestant: string; // cid, e.g. "jev@enc1"
  request: Req;
  observation: Observation;
  options: Opt[];
  timeoutMs: number | null; // effective limit under the experiment's timing; null = none
}

export interface Req {
  kind: 'assign' | 'overload';
  floor?: number;
  dir?: 'up' | 'down';
  reason?: string;
  car?: number;
}

export interface Car {
  idx: number;
  floor: number;
  dir: number;
  mode: string;
  doorPhase: string;
  loadKg: number;
  capacityKg: number;
  stops: number;
  assigned: number;
  coming: boolean;
}

export interface Observation {
  t: number;
  n: number;
  floors: number;
  vmax: number;
  request: Req;
  cars: Car[];
}

export interface Opt {
  i: number; // index into the engine's option list
  car?: number;
  label: string;
  short?: string;
  legal: boolean;
}

// One System One request body, exactly as sent on the wire.
export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
}

export interface Encoded {
  body: SystemOneRequest;
  keys: string[]; // option key per legal option, in order
  legal: number[]; // engine option index per key
}

export interface DecideResult {
  ok: boolean;
  error?: string; // 'timeout' | 'failure: …' | 'malformed: …'
  probs?: number[]; // aligned with the engine's options (0 for illegal ones)
  choice?: number;
  latencyMs: number; // request to answer, excluding local queueing
  queuedMs: number;
  inferMs?: number | null; // server-side model time, when the server reports it
  attempts: number;
  model?: string; // what the endpoint says answered
  drift?: boolean; // reported model ≠ pinned model
  tokens?: number;
  costUsd?: number;
  io?: { request: SystemOneRequest; response: unknown };
}
