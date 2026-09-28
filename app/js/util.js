window.EDA = window.EDA || {};

(function (EDA) {
  'use strict';

  const floorLabel = (f) => (f === 0 ? 'G' : String(f));
  const arrow = (d) => (d === 'up' || d > 0 ? '▲' : '▼');

  function clock(s) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
  }

  const secs = (s) => (s == null || !isFinite(s) ? '—' : `${s.toFixed(1)} s`);

  // FNV-1a, 32-bit: short, stable identifiers for definitions and results.
  function fnvInt(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  const fnv = (str) => fnvInt(str).toString(16).padStart(8, '0');

  // Six destination colours: the lobby keeps its own, and in taller buildings
  // the upper floors share colour bands while the number tag stays exact.
  function destColor(f, floors) {
    if (f === 0) return 0;
    if (floors <= 6) return f;
    return 1 + Math.floor(((f - 1) * 5) / (floors - 1));
  }

  // Shared building geometry. The view draws in these viewBox units and the
  // simulator walks passengers in metres derived from the same numbers, so
  // the two can never disagree about where a shaft is.
  function geometry(floors, cars) {
    const FH = Math.min(78, Math.max(26, 468 / floors)); // floor height shrinks, then the building grows
    const step = cars <= 3 ? 84 : Math.max(58, 252 / cars); // shaft pitch shrinks, then the building widens
    const SHAFT_X0 = 380;
    const SHAFT_W = step - 10;
    const ORIGIN = 58; // x of the landing entry door
    const PX = 40; // px per metre
    const detail = FH >= 56 ? 'full' : FH >= 40 ? 'compact' : 'dots';
    const figScale = detail === 'full' ? 1 : detail === 'compact' ? FH / 78 : 0;
    const CAR_W = SHAFT_W - 8;
    const half = CAR_W / 2 - 9;
    const toM = (px) => (px - ORIGIN) / PX;
    return {
      floors,
      cars,
      FH,
      k: FH / 78,
      step,
      SHAFT_X0,
      SHAFT_W,
      CAR_W,
      CAR_H: Math.round(FH * 0.8),
      TOP: 84,
      W: SHAFT_X0 + cars * step + 8,
      H: 84 + floors * FH + 38,
      ORIGIN,
      PX,
      BTN_X: 350,
      CHIP_X: 371,
      detail,
      figScale,
      landing: {
        door: 0,
        button: 7.25,
        queueFront: 6.7,
        slot: (detail === 'dots' ? 10 : 15 * Math.max(figScale, 0.6)) / PX,
        carX: Array.from({ length: cars }, (_, i) => toM(SHAFT_X0 + i * step + SHAFT_W / 2)),
        riderSlots: [0, -half, half, -half / 2, half / 2].map((p) => p / PX),
      },
    };
  }

  EDA.util = { floorLabel, arrow, clock, secs, destColor, geometry, fnv, fnvInt };
})(window.EDA);
