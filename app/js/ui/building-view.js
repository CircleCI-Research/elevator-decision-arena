/*
 * Longitudinal cutaway of one building, drawn in SVG, plus HTML status cards.
 *
 * Read-only: it renders whatever the world snapshot says and never mutates it,
 * so the same view can sit on top of the real engine later.
 *
 * Every dimension comes from the shared geometry (EDA.util.geometry), so the
 * drawing adapts to the floor and car count:
 *   - floors shrink until a readable minimum, then the building grows taller;
 *   - shafts narrow until a minimum pitch, then the building grows wider;
 *   - passengers drop detail as floors shrink: pictograms → small pictograms
 *     → coloured dots.
 */
(function (EDA) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const { floorLabel: fl, clock, destColor } = EDA.util;

  const STATE_LABEL = { idle: 'IDLE', moving: 'MOVING', open: 'DOORS', overload: 'OVERLOAD', malfunction: 'FAULT', out: 'OUT' };
  const CHIP_LABEL = { overload: 'OVERLOAD', malfunction: 'FAULT', out: 'OFFLINE' };

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function setText(node, value) {
    if (node.__v === value) return;
    node.__v = value;
    node.textContent = value;
  }

  function setAttr(node, k, value) {
    const key = `__${k}`;
    if (node[key] === value) return;
    node[key] = value;
    node.setAttribute(k, value);
  }

  const ease = (u) => u * u * (3 - 2 * u);
  let instances = 0; // several views can be on the page; SVG ids must not collide
  const ordinal = (n) => ['1ST', '2ND', '3RD'][n - 1] ?? `${n}TH`;
  const r1 = (x) => Math.round(x * 10) / 10;

  class BuildingView {
    constructor(host, world, meta) {
      host.textContent = '';
      this.world = world;
      this.cfg = world.cfg;
      this.meta = meta;
      this.G = world.cfg.geo;
      this.uid = `${meta.key}-${++instances}`;
      // Fixtures (buttons, doors, labels) shrink with the floor, but not below half size.
      this.kb = Math.max(0.5, this.G.k);

      // Readable HTML status cards, one per car, in shaft order.
      this.strip = document.createElement('div');
      this.strip.className = `car-strip lane-${meta.key}${this.cfg.cars > 4 ? ' dense' : ''}`;
      // Balanced rows: 6 cars → 3 + 3, 7 → 4 + 3, 8 → 4 + 4.
      const rows = Math.ceil(this.cfg.cars / 4);
      this.strip.style.setProperty('--cols', Math.ceil(this.cfg.cars / rows));
      host.appendChild(this.strip);

      this.svg = el('svg', {
        viewBox: `0 0 ${this.G.W} ${this.G.H}`,
        class: `bldg lane-${meta.key} detail-${this.G.detail}`,
        role: 'img',
        'aria-label': `Building ${meta.key}: ${meta.name}, ${this.cfg.floors} floors, ${this.cfg.cars} cars`,
      }, host);
      this.buildDefs();
      this.buildStructure();
      this.shaftOverlay = el('g', { class: 'shaft-overlays' }, this.svg);
      this.hallLayer = el('g', { class: 'halls' }, this.svg);
      this.dispLayer = el('g', { class: 'displays' }, this.svg);
      this.carLayer = el('g', { class: 'cars' }, this.svg);
      this.people = el('g', { class: 'people' }, this.svg);
      this.fxLayer = el('g', { class: 'fx-layer' }, this.svg);
      this.buildHalls();
      this.cars = world.cars.map((_, i) => this.buildCar(i));
      this.stamp = this.buildStamp();
      this.pax = new Map();
      this.fx = [];
    }

    baseY(f) {
      return this.G.TOP + (this.cfg.floors - f) * this.G.FH;
    }

    px(m) {
      return this.G.ORIGIN + m * this.G.PX;
    }

    shaftX(i) {
      return this.G.SHAFT_X0 + i * this.G.step;
    }

    color(f) {
      return `var(--f${destColor(f, this.cfg.floors)})`;
    }

    // Vertical centre of the hall-button plate on floor f.
    plateY(f) {
      return this.baseY(f) - this.G.FH * 0.54;
    }

    // ── Static structure ────────────────────────────────────────────────

    buildDefs() {
      const k = this.uid;
      const d = el('defs', {}, this.svg);
      const hatch = el('pattern', { id: `hatch-${k}`, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, d);
      el('rect', { width: 3, height: 8, class: 'hatch' }, hatch);
      const hz = el('pattern', { id: `hazard-${k}`, width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, d);
      el('rect', { width: 10, height: 10, class: 'hz-a' }, hz);
      el('rect', { width: 5, height: 10, class: 'hz-b' }, hz);
    }

    buildStructure() {
      const G = this.G;
      const kb = this.kb;
      const s = el('g', { class: 'structure' }, this.svg);
      const floors = this.cfg.floors;
      const groundY = this.baseY(0);
      const L = this.world.L;
      const slabH = Math.max(4, 6 * G.k);

      el('rect', { x: 0, y: 0, width: G.W, height: groundY, class: 'sky' }, s);
      el('rect', { x: 0, y: groundY + slabH, width: G.W, height: G.H - groundY - slabH, class: 'ground' }, s);

      const mx = G.SHAFT_X0 - 8;
      const mw = this.shaftX(this.cfg.cars - 1) + G.SHAFT_W + 8 - mx;
      el('rect', { x: mx, y: G.TOP - 46, width: mw, height: 46, rx: 6, class: 'machine' }, s);
      this.buildSign(s);

      el('rect', { x: 30, y: G.TOP, width: G.W - 40, height: groundY - G.TOP, class: 'shell' }, s);

      const labelR = Math.min(10, G.FH * 0.3);
      const doorH = Math.min(48, G.FH - 12 * kb);
      const doorW = 24 * Math.max(0.65, G.k);
      const plateH = 32 * kb;
      const plateW = 12 * Math.max(0.7, kb);
      for (let f = 0; f < floors; f++) {
        const by = this.baseY(f);
        el('rect', { x: 30, y: by - G.FH, width: G.SHAFT_X0 - 36, height: G.FH, class: f % 2 ? 'wall alt' : 'wall' }, s);
        // Floor label doubles as the destination-colour key.
        const lab = el('g', { class: 'flabel' }, s);
        const cy = by - G.FH / 2 + 2 * G.k;
        el('circle', { cx: 15, cy, r: labelR, style: `fill:${this.color(f)}` }, lab);
        el('text', {
          x: 15,
          y: cy + labelR * 0.36,
          'text-anchor': 'middle',
          class: destColor(f, floors) === 2 ? 'dark' : '',
          style: `font-size:${r1(labelR * (f >= 10 ? 0.9 : 1.05))}px`,
        }, lab).textContent = fl(f);
        el('rect', { x: 58 - doorW / 2, y: by - doorH, width: doorW, height: doorH, rx: 3 * kb, class: 'entry' }, s);
        el('rect', { x: 58 - doorW / 2 + 4 * kb, y: by - doorH + 4 * kb, width: doorW - 8 * kb, height: doorH - 4 * kb, rx: 2 * kb, class: 'entry-in' }, s);
        el('line', { x1: this.px(L.queueFront) + 4, x2: this.px(L.queueFront - 9 * L.slot), y1: by - 1, y2: by - 1, class: 'lane-line' }, s);
        el('rect', { x: G.BTN_X + 6 - plateW / 2, y: this.plateY(f) - plateH / 2, width: plateW, height: plateH, rx: 3 * kb, class: 'plate' }, s);
      }

      for (let f = 0; f <= floors; f++) {
        el('rect', { x: 26, y: this.baseY(f), width: G.W - 32, height: slabH, class: 'slab' }, s);
      }

      for (let i = 0; i < this.cfg.cars; i++) {
        const sx = this.shaftX(i);
        el('rect', { x: sx, y: G.TOP, width: G.SHAFT_W, height: groundY - G.TOP + slabH, class: 'shaft' }, s);
        for (let f = 0; f < floors; f++) {
          const by = this.baseY(f);
          el('line', { x1: sx, x2: sx + G.SHAFT_W, y1: by + 1, y2: by + 1, class: 'sill' }, s);
        }
      }
    }

    buildSign(s) {
      const { key, name, kind } = this.meta;
      const x = 52;
      const y = 22;
      const w = 290;
      const h = 40;
      el('rect', { x: x + 34, y: y + h, width: 4, height: this.G.TOP - y - h, class: 'sign-leg' }, s);
      el('rect', { x: x + w - 38, y: y + h, width: 4, height: this.G.TOP - y - h, class: 'sign-leg' }, s);
      el('rect', { x, y, width: w, height: h, rx: 9, class: 'sign' }, s);
      el('circle', { cx: x + 21, cy: y + h / 2, r: 11.5, class: 'sign-lane' }, s);
      el('text', { x: x + 21, y: y + h / 2 + 4.3, 'text-anchor': 'middle', class: 'sign-lane-t' }, s).textContent = key;
      el('text', { x: x + 40, y: y + h / 2 + 5.5, class: 'sign-name' }, s).textContent = name.toUpperCase();
      el('text', { x: x + w - 12, y: y + h / 2 + 3.5, 'text-anchor': 'end', class: 'sign-kind' }, s).textContent =
        kind === 'model' ? 'MODEL' : 'ALGORITHM';
    }

    buildHalls() {
      const G = this.G;
      const kb = this.kb;
      this.halls = [];
      const top = this.cfg.floors - 1;
      const t = 4 * kb; // triangle half-width
      for (let f = 0; f <= top; f++) {
        const row = {};
        for (const d of ['up', 'down']) {
          if ((d === 'up' && f === top) || (d === 'down' && f === 0)) continue;
          const cx = G.BTN_X + 6;
          const cy = this.plateY(f) + (d === 'up' ? -7 : 7) * kb;
          const g = el('g', { class: 'hall' }, this.hallLayer);
          const ring = el('circle', { cx, cy, r: 5 * kb, class: 'ring' }, g);
          const tri = el('path', {
            d: d === 'up'
              ? `M${cx - t} ${cy + 0.75 * t}L${cx} ${cy - 0.87 * t}L${cx + t} ${cy + 0.75 * t}Z`
              : `M${cx - t} ${cy - 0.75 * t}L${cx} ${cy + 0.87 * t}L${cx + t} ${cy - 0.75 * t}Z`,
            class: 'hbtn',
          }, g);
          const spin = el('circle', { cx: G.CHIP_X, cy, r: 5.5 * kb, class: 'spin', style: 'display:none' }, g);
          const chip = el('g', { class: 'achip', style: 'display:none' }, g);
          el('circle', { cx: G.CHIP_X, cy, r: 6 * kb }, chip);
          const chipT = el('text', { x: G.CHIP_X, y: cy + 2.7 * kb, 'text-anchor': 'middle', style: `font-size:${r1(8 * kb)}px` }, chip);
          row[d] = { ring, tri, spin, chip, chipT, pulse: -1, state: null };
        }
        row.dup = el('text', {
          x: G.BTN_X + 6,
          y: this.plateY(f) - 20 * kb,
          'text-anchor': 'middle',
          class: 'dup',
          style: `font-size:${r1(8.5 * kb)}px`,
        }, this.hallLayer);
        this.halls.push(row);
      }
    }

    buildCar(i) {
      const G = this.G;
      const k = this.uid;
      const sx = this.shaftX(i);
      const CW = G.CAR_W;
      const CH = G.CAR_H;
      const inset = 3 * Math.max(0.6, G.k);
      const half = (CW - 2 * inset) / 2;

      const out = el('rect', { x: sx, y: G.TOP, width: G.SHAFT_W, height: this.baseY(0) - G.TOP + 6, fill: `url(#hatch-${k})`, class: 'shaft-out' }, this.shaftOverlay);
      const cable = el('line', { x1: sx + G.SHAFT_W / 2, x2: sx + G.SHAFT_W / 2, y1: G.TOP, y2: G.TOP, class: 'cable' }, this.carLayer);

      const g = el('g', { class: 'car st-idle' }, this.carLayer);
      el('rect', { x: 0, y: 0, width: CW, height: CH, rx: 4 * this.kb, class: 'car-body' }, g);
      el('rect', { x: inset, y: inset, width: CW - 2 * inset, height: CH - inset - 1, rx: 2, class: 'car-in' }, g);
      const riders = el('g', { class: 'riders' }, g);
      const doorL = el('rect', { x: inset, y: inset, width: half, height: CH - inset - 1, class: 'door' }, g);
      const doorR = el('rect', { x: inset + half, y: inset, width: half, height: CH - inset - 1, class: 'door' }, g);
      const pips = el('g', { class: 'pips' }, g);
      const chipH = Math.min(13, CH * 0.34);
      const chipY = CH / 2 - chipH / 2;
      el('rect', { x: inset, y: inset, width: CW - 2 * inset, height: CH - inset - 1, fill: `url(#hazard-${k})`, class: 'hazard' }, g);
      const chip = el('g', { class: 'cchip' }, g);
      el('rect', { x: 2, y: chipY, width: CW - 4, height: chipH, rx: chipH / 2 }, chip);
      const chipT = el('text', {
        x: CW / 2,
        y: chipY + chipH * 0.7,
        'text-anchor': 'middle',
        style: `font-size:${r1(Math.min(7.5, CW * 0.12, chipH * 0.6))}px`,
      }, chip);

      // Machine-room display: just car number, floor, direction and a state
      // bar. The detailed readout lives in the HTML card above the building.
      const dy = G.TOP - 40;
      const disp = el('g', { class: 'disp st-idle' }, this.dispLayer);
      el('rect', { x: sx, y: dy, width: G.SHAFT_W, height: 34, rx: 4, class: 'disp-bg' }, disp);
      el('text', { x: sx + 5, y: dy + 11, class: 'disp-car' }, disp).textContent = String(i + 1);
      const floorT = el('text', {
        x: sx + G.SHAFT_W / 2,
        y: dy + 24,
        'text-anchor': 'middle',
        class: 'disp-floor',
        style: `font-size:${r1(Math.min(19, G.SHAFT_W * 0.3))}px`,
      }, disp);
      const arrowP = el('path', { d: '', class: 'disp-arrow' }, disp);
      el('rect', { x: sx + 5, y: dy + 28, width: G.SHAFT_W - 10, height: 2.5, rx: 1.25, class: 'disp-state-bar' }, disp);

      const card = document.createElement('div');
      card.className = 'cc st-idle';
      card.innerHTML = `
        <div class="cc-top">
          <span class="cc-name">Car ${i + 1}</span>
          <span class="cc-state">Idle</span>
          <span class="cc-floor"><b>G</b><i class="cc-arrow"></i></span>
        </div>
        <div class="cc-load"><span class="cc-bar"><i></i></span><span class="cc-kg"></span></div>
        <div class="cc-energy f-idle">
          <svg class="ico" aria-hidden="true"><use href="#i-bolt"/></svg><b class="cc-wh">0.0 Wh</b><span class="cc-kw"></span>
        </div>`;
      card.addEventListener('mouseenter', () => g.classList.add('hl'));
      card.addEventListener('mouseleave', () => g.classList.remove('hl'));
      this.strip.appendChild(card);
      const q = (sel) => card.querySelector(sel);
      const cc = { card, state: q('.cc-state'), floor: q('.cc-floor b'), arrow: q('.cc-arrow'), bar: q('.cc-bar i'), kg: q('.cc-kg'), energy: q('.cc-energy'), wh: q('.cc-wh'), kw: q('.cc-kw') };

      return { sx, g, cable, riders, doorL, doorR, inset, half, pips, chipT, disp, floorT, arrowP, cc, flow: null, loadCls: null, out, st: null, pipKey: null, arrowKey: null };
    }

    buildStamp() {
      const G = this.G;
      const cy = G.TOP + (this.cfg.floors * G.FH) / 2;
      const outer = el('g', { transform: `translate(200 ${r1(cy)}) rotate(-7)`, style: 'display:none' }, this.svg);
      const inner = el('g', { class: 'stamp-in' }, outer);
      el('rect', { x: -118, y: -38, width: 236, height: 76, rx: 12, class: 'stamp-box' }, inner);
      const a = el('text', { x: 0, y: -8, 'text-anchor': 'middle', class: 'stamp-a' }, inner);
      const b = el('text', { x: 0, y: 22, 'text-anchor': 'middle', class: 'stamp-b' }, inner);
      return { outer, a, b, key: null };
    }

    makePax(p) {
      const g = el('g', { class: 'pax' });
      const col = this.color(p.dest);
      if (this.G.detail === 'dots') {
        // Lowest detail: a coloured light, as in the original spec.
        const dot = el('circle', { cx: 0, cy: -4.2, r: 3.8, class: 'dot', style: `fill:${col}` }, g);
        return { g, dot, dots: true, alpha: null, impOn: null };
      }
      const sc = el('g', { transform: `scale(${r1(this.G.figScale * 100) / 100})` }, g);
      const fig = el('g', { class: 'fig', style: `fill:${col}` }, sc);
      const legA = el('rect', { x: -1.6, y: 0, width: 3.2, height: 9.5, rx: 1.5 }, fig);
      const legB = el('rect', { x: -1.6, y: 0, width: 3.2, height: 9.5, rx: 1.5 }, fig);
      el('rect', { x: -4.2, y: -20, width: 8.4, height: 11.5, rx: 3.2 }, fig);
      el('circle', { cx: 0, cy: -25.3, r: 4.3 }, fig);
      if (p.accessory === 'bag') el('rect', { x: -7.6, y: -18.5, width: 3.6, height: 7.5, rx: 1.3, class: 'acc' }, fig);
      const arm = el('rect', { x: -1.3, y: 0, width: 2.6, height: 9, rx: 1.3 }, fig);
      if (p.accessory === 'cart') el('rect', { x: 3.5, y: -16, width: 8.5, height: 8.5, rx: 1.6, class: 'acc' }, fig);
      const tag = el('g', { class: 'tag' }, sc);
      const tw = p.dest >= 10 ? 15 : 12;
      el('rect', { x: -tw / 2, y: -43, width: tw, height: 10, rx: 3, style: `fill:${col}` }, tag);
      el('text', { x: 0, y: -35.6, 'text-anchor': 'middle', class: destColor(p.dest, this.cfg.floors) === 2 ? 'tag-t dark' : 'tag-t' }, tag).textContent = fl(p.dest);
      const imp = el('g', { class: 'imp', style: 'display:none' }, sc);
      el('circle', { cx: 9, cy: -38, r: 4.5 }, imp);
      el('text', { x: 9, y: -35.6, 'text-anchor': 'middle' }, imp).textContent = '!';
      return { g, fig, legA, legB, arm, tag, imp, dots: false, facing: null, alpha: null, tagOn: null, impOn: null };
    }

    // ── Per-frame render ────────────────────────────────────────────────

    render() {
      this.renderHalls();
      this.renderCars();
      this.renderPax();
      this.renderFx();
    }

    renderHalls() {
      const w = this.world;
      for (let f = 0; f < this.halls.length; f++) {
        const row = this.halls[f];
        let maxPress = 0;
        for (const d of ['up', 'down']) {
          const v = row[d];
          if (!v) continue;
          const h = w.halls[f][d];
          const state = !h.lit ? 'off' : h.assigned === null ? 'deciding' : `car${h.assigned}`;
          if (state !== v.state) {
            v.tri.classList.toggle('lit', h.lit);
            v.spin.style.display = state === 'deciding' ? '' : 'none';
            v.chip.style.display = h.lit && h.assigned !== null ? '' : 'none';
            if (h.assigned !== null) {
              setText(v.chipT, String(h.assigned + 1));
              v.chip.classList.remove('pop');
              void v.chip.getBoundingClientRect();
              v.chip.classList.add('pop');
            }
            v.state = state;
          }
          if (h.pulse !== v.pulse) {
            v.pulse = h.pulse;
            v.ring.classList.remove('ping');
            void v.ring.getBoundingClientRect();
            v.ring.classList.add('ping');
          }
          if (h.lit) maxPress = Math.max(maxPress, h.presses);
        }
        setText(row.dup, maxPress > 1 ? `×${maxPress}` : '');
      }
    }

    renderCars() {
      const G = this.G;
      const w = this.world;
      const cap = this.cfg.capacityKg;
      for (let i = 0; i < this.cars.length; i++) {
        const c = w.cars[i];
        const v = this.cars[i];
        const top = this.baseY(c.pos) - G.CAR_H;
        setAttr(v.g, 'transform', `translate(${v.sx + 4} ${top.toFixed(2)})`);
        setAttr(v.cable, 'y2', top.toFixed(2));
        const dw = v.half * (1 - c.door);
        setAttr(v.doorL, 'width', dw.toFixed(2));
        setAttr(v.doorR, 'width', dw.toFixed(2));
        setAttr(v.doorR, 'x', (G.CAR_W - v.inset - dw).toFixed(2));

        const st = c.mode !== 'normal' ? c.mode : c.doorPhase !== 'closed' ? 'open' : c.target !== null ? 'moving' : 'idle';
        const cc = v.cc;
        if (st !== v.st) {
          v.st = st;
          v.g.setAttribute('class', `car st-${st}${v.g.classList.contains('hl') ? ' hl' : ''}`);
          v.disp.setAttribute('class', `disp st-${st}`);
          cc.card.className = `cc st-${st}`;
          v.out.classList.toggle('on', st === 'out');
          setText(v.chipT, CHIP_LABEL[st] ?? '');
          setText(cc.state, STATE_LABEL[st]);
        }

        const floor = fl(Math.round(c.pos));
        setText(v.floorT, floor);
        setText(cc.floor, floor);
        const arrowKey = st === 'out' ? 0 : c.dir;
        if (arrowKey !== v.arrowKey) {
          v.arrowKey = arrowKey;
          const ax = v.sx + G.SHAFT_W - 9;
          const ay = G.TOP - 29;
          const a = 3;
          v.arrowP.setAttribute('d', arrowKey > 0 ? `M${ax - a} ${ay + 2}L${ax} ${ay - 2.5}L${ax + a} ${ay + 2}Z` : arrowKey < 0 ? `M${ax - a} ${ay - 2}L${ax} ${ay + 2.5}L${ax + a} ${ay - 2}Z` : '');
          setText(cc.arrow, arrowKey > 0 ? '▲' : arrowKey < 0 ? '▼' : '');
        }

        const load = Math.round(c.load);
        const ratio = load / cap;
        setText(cc.kg, `${load} / ${cap} kg`);
        cc.bar.style.transform = `scaleX(${Math.min(1, ratio).toFixed(3)})`;
        const loadCls = ratio > 1 ? 'over' : ratio > 0.85 ? 'warn' : '';
        if (loadCls !== v.loadCls) {
          v.loadCls = loadCls;
          cc.bar.parentElement.className = `cc-bar ${loadCls}`;
        }

        // Energy: running net total plus live power while the car moves.
        const e = c.energy;
        setText(cc.wh, `${e.net.toFixed(1)} Wh`);
        const moving = st === 'moving' || (st === 'malfunction' && c.doorPhase === 'closed');
        const flow = !moving ? 'idle' : e.w < -150 ? 'regen' : e.w > 4000 ? 'heavy' : 'draw';
        setText(cc.kw, flow === 'idle' ? '' : flow === 'regen' ? `↺ ${(Math.abs(e.w) / 1000).toFixed(1)} kW` : `${(e.w / 1000).toFixed(1)} kW`);
        if (flow !== v.flow) {
          v.flow = flow;
          cc.energy.className = `cc-energy f-${flow}`;
          cc.energy.title = flow === 'regen' ? 'Recovering energy: the counterweight is doing the work' : '';
        }

        const pipKey = [...c.stops].sort((a, b) => a - b).join(',');
        if (pipKey !== v.pipKey) {
          v.pipKey = pipKey;
          v.pips.textContent = '';
          const stops = [...c.stops].sort((a, b) => a - b);
          const gap = Math.min(8, (G.CAR_W - 10) / Math.max(1, stops.length));
          const r = Math.min(2.8, gap * 0.36, G.CAR_H * 0.07);
          stops.forEach((f, n) =>
            el('circle', { cx: G.CAR_W / 2 + (n - (stops.length - 1) / 2) * gap, cy: Math.max(r + 2, G.CAR_H * 0.15), r, style: `fill:${this.color(f)}` }, v.pips)
          );
        }
      }
    }

    renderPax() {
      const G = this.G;
      const w = this.world;
      for (const p of w.passengers) {
        let v = this.pax.get(p.id);
        if (p.phase === 'done') {
          if (v) {
            v.g.remove();
            this.pax.delete(p.id);
          }
          continue;
        }
        if (!v) {
          v = this.makePax(p);
          this.pax.set(p.id, v);
        }
        const riding = p.phase === 'ride';
        const layer = riding ? this.cars[p.car].riders : this.people;
        if (v.g.parentNode !== layer) layer.appendChild(v.g);

        let x;
        let y;
        if (riding) {
          x = G.CAR_W / 2 + w.L.riderSlots[p.slot] * G.PX;
          y = G.CAR_H - 1;
        } else {
          x = this.px(p.x);
          y = this.baseY(p.floor);
        }

        const alpha = p.alpha.toFixed(2);
        if (v.alpha !== alpha) {
          v.alpha = alpha;
          v.g.setAttribute('opacity', alpha);
        }
        const waiting = p.phase === 'queue' || p.phase === 'press' || p.phase === 'toButton';
        const impOn = !p.boarded && waiting && w.t - p.spawnT > 30;

        if (v.dots) {
          const bob = p.moving ? -Math.abs(Math.sin(p.walkPhase * 7.5)) * 1.2 : 0;
          const pressing = p.phase === 'press' && p.phaseT > 0.15 && p.phaseT < 0.6;
          setAttr(v.g, 'transform', `translate(${x.toFixed(1)} ${(y + bob).toFixed(2)})`);
          setAttr(v.dot, 'r', pressing ? '4.8' : '3.8');
          if (v.impOn !== impOn) {
            v.impOn = impOn;
            v.dot.classList.toggle('impatient', impOn);
          }
          continue;
        }

        let leg = 0;
        let arm = -4;
        let bob = 0;
        if (p.moving) {
          const s = Math.sin(p.walkPhase * 7.5);
          leg = 26 * s;
          arm = -4 - 20 * s;
          bob = -Math.abs(Math.cos(p.walkPhase * 7.5)) * 1.2 * G.figScale;
        } else if (p.phase === 'press') {
          const u = p.phaseT;
          const r = u < 0.2 ? u / 0.2 : u < 0.55 ? 1 : Math.max(0, 1 - (u - 0.55) / 0.22);
          arm = -4 - 112 * ease(r);
        } else if (p.phase === 'queue') {
          bob = Math.sin(w.t * 2.4 + p.id) * 0.4 * G.figScale;
        }

        setAttr(v.g, 'transform', `translate(${x.toFixed(1)} ${(y + bob).toFixed(2)})`);
        if (v.facing !== p.facing) {
          v.facing = p.facing;
          v.fig.setAttribute('transform', `scale(${p.facing} 1)`);
        }
        setAttr(v.legA, 'transform', `translate(-1.2 -9.5) rotate(${leg.toFixed(1)})`);
        setAttr(v.legB, 'transform', `translate(1.2 -9.5) rotate(${(-leg).toFixed(1)})`);
        setAttr(v.arm, 'transform', `translate(0.8 -18.5) rotate(${arm.toFixed(1)})`);

        const tagOn = !riding && p.phase !== 'exit' && p.phase !== 'fade';
        if (v.tagOn !== tagOn) {
          v.tagOn = tagOn;
          v.tag.style.display = tagOn ? '' : 'none';
        }
        if (v.impOn !== impOn) {
          v.impOn = impOn;
          v.imp.style.display = impOn ? '' : 'none';
        }
      }
    }

    // ── Transient effects ───────────────────────────────────────────────

    onEvent(ev) {
      const G = this.G;
      const mid = (i) => this.shaftX(i) + G.SHAFT_W / 2;
      if (ev.type === 'dup') {
        this.floatText(G.BTN_X + 6, this.plateY(ev.floor) - 28 * this.kb, `×${ev.count}`, 'dup');
      } else if (ev.type === 'deliver') {
        this.floatText(mid(ev.car), this.baseY(ev.floor) - G.CAR_H - 4, '+1', 'ok');
      } else if (ev.type === 'overload') {
        const c = this.world.cars[ev.car];
        this.floatText(mid(ev.car), this.baseY(c.pos) - G.CAR_H - 4, `${Math.round(c.load)} kg`, 'bad');
      }
    }

    floatText(x, y, text, cls) {
      const node = el('text', { x, y, 'text-anchor': 'middle', class: `fx-t ${cls}` }, this.fxLayer);
      node.textContent = text;
      this.fx.push({ node, y, t0: this.world.t });
    }

    renderFx() {
      const t = this.world.t;
      this.fx = this.fx.filter((f) => {
        const u = (t - f.t0) / 1.3;
        if (u >= 1 || u < 0) {
          f.node.remove();
          return false;
        }
        f.node.setAttribute('y', (f.y - 16 * ease(Math.min(1, u * 1.4))).toFixed(1));
        f.node.setAttribute('opacity', (1 - u * u).toFixed(2));
        return true;
      });
    }

    setResult(rank, t) {
      const key = rank ? `${rank}:${t}` : null;
      if (key === this.stamp.key) return;
      this.stamp.key = key;
      this.stamp.outer.style.display = rank ? '' : 'none';
      if (!rank) return;
      this.stamp.a.textContent = `${ordinal(rank)} · WAVE CLEARED`;
      this.stamp.b.textContent = clock(t);
      this.stamp.outer.setAttribute('class', rank === 1 ? 'stamp rank-1' : 'stamp');
    }
  }

  EDA.BuildingView = BuildingView;
})(window.EDA);
