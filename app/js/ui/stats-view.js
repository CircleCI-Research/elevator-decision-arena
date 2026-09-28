/*
 * Stats board: stands in for the building drawing when the building is too
 * big to draw usefully (above the Tower preset). Same interface as
 * BuildingView — render(), onEvent(), setResult() — and equally read-only.
 */
(function (EDA) {
  'use strict';

  const { clock, secs, floorLabel: fl } = EDA.util;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ordinal = (n) => ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`;
  const MODE = { idle: 'idle', moving: 'moving', open: 'doors', overload: 'overload', malfunction: 'fault', out: 'out' };

  function wallLabel(s) {
    if (s < 1) return `${Math.round(s * 1000)} ms`;
    if (s < 60) return `${s.toFixed(1)} s`;
    return clock(s);
  }

  class StatsView {
    constructor(host, world, meta) {
      this.world = world;
      this.cfg = world.cfg;
      host.textContent = '';
      const root = document.createElement('div');
      root.className = `stats-board lane-${meta.key}`;
      root.innerHTML = `
        <div class="sb-head">
          <span class="lane">${meta.key}</span>
          <span class="sb-name">${esc(meta.name)}</span>
          <span class="kind">${meta.kind === 'model' ? 'MODEL' : 'ALGORITHM'}</span>
          <span class="sb-status" data-r="status"><i></i><span>Ready</span></span>
        </div>
        <div class="sb-hero">
          <div class="sb-big">
            <span class="sb-k">Passengers delivered</span>
            <div class="sb-num"><b data-r="delivered">0</b><span data-r="total">/ 0</span></div>
            <div class="sb-track"><i data-r="bar"></i></div>
          </div>
          <div class="sb-clocks">
            <div><span class="sb-k">Sim time</span><b data-r="sim">00:00.0</b></div>
            <div><span class="sb-k">Wall clock</span><b data-r="wall">0 ms</b></div>
          </div>
        </div>
        <div class="sb-tiles">
          <div><span class="sb-k">Waiting now</span><b data-r="waiting">0</b></div>
          <div><span class="sb-k">Avg wait</span><b data-r="avg">—</b></div>
          <div><span class="sb-k">P95 wait</span><b data-r="p95">—</b></div>
          <div><span class="sb-k">Longest wait</span><b data-r="longest">—</b></div>
          <div><span class="sb-k">Energy</span><b data-r="energy">0 Wh</b></div>
          <div><span class="sb-k">Per passenger</span><b data-r="perPax">—</b></div>
          <div><span class="sb-k">Decisions</span><b data-r="decisions">0</b></div>
          <div><span class="sb-k">Empty travel</span><b data-r="empty">0 fl</b></div>
        </div>
        <div class="sb-trend">
          <div class="sb-trend-h"><span class="sb-k">Waiting over sim time</span><span class="sb-k" data-r="peak"></span></div>
          <svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><path data-r="area" class="sb-area"/><path data-r="line" class="sb-line"/></svg>
        </div>
        <div class="sb-cars">
          <div class="sb-trend-h"><span class="sb-k">${this.cfg.cars} cars · ${this.cfg.floors} floors</span><span class="sb-k">floor · state</span></div>
          <div class="sb-cells" data-r="cells"></div>
        </div>
        <div class="sb-result" data-r="result" hidden></div>`;
      host.appendChild(root);
      this.r = {};
      root.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.cells = world.cars.map((_, i) => {
        const c = document.createElement('span');
        c.className = 'sb-cell st-idle';
        c.innerHTML = `<small>${i + 1}</small><b>G</b>`;
        this.r.cells.appendChild(c);
        return { c, floor: c.querySelector('b'), st: null };
      });
      this.lastSlow = -Infinity;
      this.seriesLen = -1;
      this.resultKey = null;
    }

    text(node, value) {
      if (node.__v === value) return;
      node.__v = value;
      node.textContent = value;
    }

    render() {
      const w = this.world;
      this.text(this.r.sim, clock(w.t));
      this.text(this.r.wall, wallLabel(w.wall));
      const D = w.decisions;
      const thinking = D.active && w.t + 1 / 60 >= D.active.commitT;
      const status = w.finishedAt !== null ? 'done' : thinking ? 'thinking' : w.t > 0 ? 'running' : 'ready';
      if (status !== this.status) {
        this.status = status;
        this.r.status.className = `sb-status s-${status}`;
        this.r.status.lastElementChild.textContent =
          status === 'done' ? 'Wave cleared' : status === 'thinking' ? 'Waiting on decision' : status === 'running' ? 'Simulating' : 'Ready';
      }

      // Everything below is fine at a few updates per second.
      const now = performance.now();
      if (now - this.lastSlow < 120) return;
      this.lastSlow = now;
      const s = w.summary();
      this.text(this.r.delivered, String(s.delivered));
      this.text(this.r.total, `/ ${s.total}`);
      this.r.bar.style.transform = `scaleX(${s.total ? (s.delivered / s.total).toFixed(4) : 0})`;
      this.text(this.r.waiting, String(s.waiting));
      this.text(this.r.avg, secs(s.avgWait));
      this.text(this.r.p95, secs(s.p95Wait));
      this.text(this.r.longest, secs(s.longest));
      this.text(this.r.energy, s.energyWh >= 1000 ? `${(s.energyWh / 1000).toFixed(s.energyWh >= 10000 ? 0 : 1)} kWh` : `${s.energyWh.toFixed(0)} Wh`);
      this.text(this.r.perPax, s.delivered ? `${(s.energyWh / s.delivered).toFixed(1)} Wh` : '—');
      this.text(this.r.decisions, String(s.decisions));
      this.text(this.r.empty, `${s.emptyFloors.toFixed(0)} fl`);

      for (let i = 0; i < this.cells.length; i++) {
        const c = w.cars[i];
        const v = this.cells[i];
        const st = c.mode !== 'normal' ? c.mode : c.doorPhase !== 'closed' ? 'open' : c.target !== null ? 'moving' : 'idle';
        if (st !== v.st) {
          v.st = st;
          v.c.className = `sb-cell st-${st}`;
          v.c.title = `Car ${i + 1} · ${MODE[st]}`;
        }
        this.text(v.floor, fl(Math.round(c.pos)));
      }

      if (w.series.length !== this.seriesLen) {
        this.seriesLen = w.series.length;
        this.drawTrend(w.series);
      }
    }

    drawTrend(series) {
      if (series.length < 2) return;
      // Keep the x axis shared with the timeline's growing domain feel:
      // at least two minutes, extended as the run goes on.
      const span = Math.max(120, series[series.length - 1].t);
      const peak = Math.max(1, ...series.map((p) => p.waiting));
      const step = Math.max(1, Math.floor(series.length / 300));
      let d = '';
      for (let i = 0; i < series.length; i += step) {
        const p = series[i];
        d += `${d ? 'L' : 'M'}${((p.t / span) * 300).toFixed(1)} ${(58 - (p.waiting / peak) * 54).toFixed(1)}`;
      }
      const last = series[series.length - 1];
      d += `L${((last.t / span) * 300).toFixed(1)} ${(58 - (last.waiting / peak) * 54).toFixed(1)}`;
      this.r.line.setAttribute('d', d);
      this.r.area.setAttribute('d', `${d}L${((last.t / span) * 300).toFixed(1)} 60L0 60Z`);
      this.text(this.r.peak, `peak ${peak}`);
    }

    onEvent() {}

    setResult(rank, t) {
      const key = rank ? `${rank}:${t}` : null;
      if (key === this.resultKey) return;
      this.resultKey = key;
      const n = this.r.result;
      n.hidden = !rank;
      if (!rank) return;
      n.className = `sb-result${rank === 1 ? ' first' : ''}`;
      const how = this.world.fastRun ? ` · computed in <b>${wallLabel(this.world.wall)}</b>` : this.world.mixedRun ? ' · wall-clock n/a (mixed modes)' : '';
      n.innerHTML = `<b>${ordinal(rank)}</b> · wave cleared at <b>${clock(t)}</b> sim${how}`;
    }
  }

  EDA.StatsView = StatsView;
})(window.EDA);
