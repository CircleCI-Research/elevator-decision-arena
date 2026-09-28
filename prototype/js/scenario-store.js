/*
 * Scenario catalog store: the built-in catalog plus custom scenarios saved in
 * this browser. Every saved scenario is an immutable version; editing creates
 * a new one, so runs always point at exactly the traffic they used.
 */
(function (EDA) {
  'use strict';

  const { CATALOG, makeSpec, specHash, scenarioKey } = EDA.scenario;
  const KEY = 'eda-scenarios-v1';

  class ScenarioStore {
    constructor() {
      this.persistent = true;
      this.custom = [];
      try {
        const raw = localStorage.getItem(KEY);
        this.custom = raw ? JSON.parse(raw) : [];
      } catch (_) {
        this.persistent = false;
      }
      this.version = 0;
    }

    all() {
      return [...CATALOG, ...this.custom];
    }

    get(id) {
      return this.all().find((s) => s.id === id) ?? null;
    }

    save() {
      this.version++;
      if (!this.persistent) return;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.custom));
      } catch (_) {
        this.persistent = false;
      }
    }

    // Saves a new immutable version; the same name gets the next number.
    add(def) {
      const version = 1 + this.all().filter((s) => s.name === def.name).reduce((m, s) => Math.max(m, s.version), 0);
      const s = makeSpec({
        ...def,
        id: `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        version,
        builtIn: false,
        legacy: false,
        createdAt: Date.now(),
      });
      s.hash = specHash(s);
      this.custom.unshift(s);
      this.save();
      return s;
    }

    remove(id) {
      this.custom = this.custom.filter((s) => s.id !== id);
      this.save();
    }

    key(s) {
      return scenarioKey(s);
    }
  }

  EDA.ScenarioStore = ScenarioStore;
})(window.EDA);
