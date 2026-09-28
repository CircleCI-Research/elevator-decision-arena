/*
 * Live models through the arena runner (runner/, docs/model-setups.md §3–§4).
 *
 * When the page is served by the runner, its live contestants (local Laya,
 * Jev through the API) join the registry. The runner holds the keys and
 * talks to the models; this page only sends the observation and the legal
 * options, and gets back probabilities, timings and the raw request and
 * response. Opened any other way, the page runs on mocks alone.
 */
(function (EDA) {
  'use strict';

  const state = { connected: false, checked: false, runner: null, error: null, contestants: [] };
  const listeners = new Set();

  async function ask(p, req, obs, options, timeoutS) {
    const t0 = performance.now();
    const body = {
      contestant: p.cid,
      request: req,
      observation: obs,
      options: options.map((o, i) => ({ i, car: o.car, label: o.label, short: o.short, legal: !o.veto })),
      timeoutMs: timeoutS == null ? null : Math.round(timeoutS * 1000),
    };
    try {
      const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return { ok: false, error: `failure: runner ${r.status} ${j?.error ?? ''}`.trim(), latencyMs: performance.now() - t0 };
      return j;
    } catch (_) {
      return { ok: false, error: 'failure: runner unreachable', latencyMs: performance.now() - t0 };
    }
  }

  async function connect() {
    if (!/^https?:$/.test(location.protocol)) {
      state.checked = true;
      emit();
      return state;
    }
    try {
      const r = await fetch('/api/contestants', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      state.runner = j.runner;
      state.contestants = j.contestants;
      state.connected = true;
      state.error = null;
      EDA.registry.setLive(j.contestants, ask);
    } catch (e) {
      state.connected = false;
      state.error = 'Not served by the arena runner: live models are unavailable. Start it with `npm start` in runner/.';
    }
    state.checked = true;
    emit();
    return state;
  }

  function emit() {
    for (const f of listeners) {
      try {
        f(state);
      } catch (_) {
        /* a listener's failure doesn't stop the others */
      }
    }
  }

  EDA.live = { connect, state, onChange: (f) => listeners.add(f) };
})(window.EDA);
