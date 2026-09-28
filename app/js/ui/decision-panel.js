/*
 * Decision panel: the current decision as animated weighted choices, plus a
 * strip of recent decisions as segmented bars.
 *
 * Models and algorithms use the same component on purpose. A deterministic
 * policy simply renders as one full bar, which makes the difference in
 * certainty readable without any explanation.
 */
(function (EDA) {
  'use strict';

  const { floorLabel: fl, arrow } = EDA.util;

  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const TAG = {
    new: ['ASSIGN', ''],
    reassign: ['REASSIGN', 'warn'],
    retry: ['RETRY', 'warn'],
    crowd: ['CROWD', 'warn'],
    overload: ['RECOVER', 'bad'],
  };

  const MAX_ROWS = 6; // beyond this the options list scrolls

  class DecisionPanel {
    constructor(host, world, meta) {
      this.world = world;
      this.policy = meta.policy;
      this.model = meta.policy.kind === 'model';
      this.live = !!meta.policy.live; // a real model, answering through the arena runner
      host.className = `dpanel lane-${meta.key} ${this.model ? 'is-model' : 'is-algo'}`;
      const p = meta.policy;
      host.innerHTML = `
        <header class="dp-head">
          <div class="dp-who">
            <span class="lane">${meta.key}</span>
            <div>
              <div class="dp-name">${esc(p.name)} <span class="kind">${this.live ? `LIVE MODEL · ${/^Deterministic/.test(p.setup?.determinism?.label ?? '') ? 'deterministic' : 'stochastic'}` : this.model ? 'MODEL · stochastic' : 'ALGORITHM · deterministic'}</span></div>
              <div class="dp-ver">${esc(p.version)} · ${esc(p.identity)}</div>
              ${this.model && p.fallback ? `<div class="dp-ver dp-fallback">Fallback <b>${esc(EDA.registry.byCid(p.fallback)?.name ?? p.fallback)} ${esc(EDA.registry.byCid(p.fallback)?.version ?? '')}</b> · armed</div>` : ''}
            </div>
          </div>
          <div class="dp-meta">
            <div class="meta-item"><span class="k">Decision time</span><span class="v" data-r="lat">—</span></div>
          </div>
        </header>
        <div class="dp-card" data-r="card">
          <div class="dp-ctx">
            <span class="dp-tag" data-r="tag">IDLE</span>
            <span class="dp-title" data-r="title">Waiting for the first hall call</span>
            <span class="dp-num" data-r="num"></span>
            <span class="dp-queue" data-r="queue"></span>
            <span class="dp-status" data-r="status"></span>
          </div>
          <div class="dp-overview" data-r="ov" hidden aria-hidden="true">
            <div class="ov-bars" data-r="ovBars"></div>
            <div class="ov-win" data-r="ovWin"></div>
          </div>
          <div class="dp-scroll" data-r="scroll">
            <ol class="dp-opts" data-r="opts"></ol>
          </div>
          <div class="dp-foot" data-r="foot"></div>
        </div>
        <div class="dp-hist">
          <div class="dp-hist-h"><span>Recent decisions</span><span class="tag-soft">${this.live ? 'live model' : this.model ? 'recorded model' : 'algorithm'}</span></div>
          <ol data-r="hist"></ol>
        </div>`;
      this.r = {};
      host.querySelectorAll('[data-r]').forEach((n) => (this.r[n.dataset.r] = n));
      this.shown = null;
      this.rows = [];
      this.disp = [];
      this.histKey = null;
      this.phase = null;
      this.wireSlider();
    }

    // ── Options slider (many cars) ──────────────────────────────────────
    //
    // Beyond MAX_ROWS options the list scrolls, and a mini distribution of
    // every option sits above it. The highlighted window marks the rows in
    // view; drag or click it to move. The list follows the leading (then
    // the chosen) option until the viewer scrolls it themselves.

    wireSlider() {
      const { scroll, ov } = this.r;
      scroll.addEventListener('scroll', () => {
        if (this.progScroll) {
          this.progScroll = false;
          return;
        }
        this.follow = false;
      });
      const seek = (e) => {
        const box = ov.getBoundingClientRect();
        const u = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
        const row = Math.floor(u * this.rows.length);
        this.follow = false;
        this.scrollToRow(row, false);
      };
      ov.addEventListener('pointerdown', (e) => {
        ov.setPointerCapture(e.pointerId);
        this.dragging = true;
        seek(e);
      });
      ov.addEventListener('pointermove', (e) => this.dragging && seek(e));
      ov.addEventListener('pointerup', () => (this.dragging = false));
      ov.addEventListener('pointercancel', () => (this.dragging = false));
    }

    scrollToRow(i, programmatic = true) {
      const row = this.rows[i];
      if (!row) return;
      const { scroll } = this.r;
      const top = row.li.offsetTop - scroll.clientHeight / 2 + row.li.offsetHeight / 2;
      if (programmatic) this.progScroll = true;
      scroll.scrollTo({ top: Math.max(0, top), behavior: programmatic ? 'smooth' : 'auto' });
    }

    renderSlider(dec, lead, thinking) {
      if (!this.sliding) return;
      const { scroll, ovWin } = this.r;
      this.ovBars.forEach((bar, i) => {
        bar.style.transform = `scaleY(${Math.max(0.04, Math.min(1, this.disp[i])).toFixed(3)})`;
        bar.classList.toggle('lead', i === lead);
        bar.classList.toggle('pick', !thinking && i === dec.choice);
      });
      const target = thinking ? lead : dec.choice;
      if (this.follow && target >= 0 && target !== this.followed) {
        this.followed = target;
        this.scrollToRow(target);
      }
      const n = this.rows.length;
      const pitch = scroll.scrollHeight / n;
      const first = scroll.scrollTop / pitch;
      const count = scroll.clientHeight / pitch;
      ovWin.style.left = `${((first / n) * 100).toFixed(2)}%`;
      ovWin.style.width = `${((Math.min(count, n) / n) * 100).toFixed(2)}%`;
    }

    update(dt) {
      const D = this.world.decisions;
      const t = this.world.t;
      const dec = D.active || D.history[0] || null;

      const q = D.queue.filter((r) => r.kind === 'assign' || r.kind === 'overload').length;
      this.text(this.r.queue, q ? `+${q} queued` : '');
      this.text(this.r.lat, this.latencyLabel(D));
      this.renderHistory(D);
      if (!dec) return;
      if (dec !== this.shown) this.mount(dec);

      const thinking = D.active === dec && t < dec.commitT;
      const target = thinking ? this.deliberation(dec, t) : dec.probs;
      const k = 1 - Math.exp(-dt * (thinking ? 12 : 9));
      let lead = -1;
      for (let i = 0; i < this.disp.length; i++) {
        this.disp[i] += (target[i] - this.disp[i]) * k;
        if (!dec.options[i].veto && (lead < 0 || this.disp[i] > this.disp[lead])) lead = i;
      }
      this.rows.forEach((row) => {
        const v = this.disp[row.i];
        row.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, v)).toFixed(4)})`;
        if (!dec.options[row.i].veto) this.text(row.pct, `${Math.round(v * 100)}%`);
        row.li.classList.toggle('lead', row.i === lead);
      });

      const phase = thinking ? 'thinking' : dec.outcome;
      if (phase !== this.phase) {
        this.phase = phase;
        this.r.card.classList.toggle('thinking', thinking);
        this.rows.forEach((row) => {
          const chosen = !thinking && row.i === dec.choice;
          row.li.classList.toggle('chosen', chosen);
          if (chosen) row.li.classList.add('stamp');
        });
        this.r.status.innerHTML = this.statusHtml(dec, thinking);
      }
      this.renderSlider(dec, lead, thinking);
      if (this.model) this.renderCertainty(dec);
    }

    text(node, value) {
      if (node.__v === value) return;
      node.__v = value;
      node.textContent = value;
    }

    latencyLabel(D) {
      if (!this.model) return '< 0.1 ms';
      if (!D.count) return '—';
      // Fixed-width format so the header never reflows as values change.
      return `${D.lastLatency.toFixed(2)} s · avg ${(D.latencySum / D.count).toFixed(2)} s`;
    }

    statusHtml(dec, thinking) {
      if (thinking && dec.pending) return `<span class="pulse-dot"></span>Asking ${esc(this.policy.name)}${this.policy.external ? ` at ${esc(this.policy.external)}` : ''}<span class="dots"><i></i><i></i><i></i></span>`;
      if (thinking) return `<span class="pulse-dot"></span>Deliberating<span class="dots"><i></i><i></i><i></i></span>`;
      const opt = dec.options[dec.choice];
      if (dec.fallback && dec.outcome === 'applied') {
        const fb = EDA.registry.byCid(dec.fallback.by);
        return `${icon(dec.fallback.reason === 'timeout' ? 'clock' : 'alert')}${dec.fallback.reason === 'timeout' ? 'Timed out' : 'Failed'} · <b>${esc(fb?.name ?? 'Fallback')}</b> chose ${esc(opt?.label ?? '—')}`;
      }
      switch (dec.outcome) {
        case 'applied':
          return `${icon('check')}<b>${esc(opt.short === 'Hold' || opt.short === 'Wait' ? opt.short : opt.label)}</b>${this.live ? ' chosen' : this.model ? ' sampled' : ' selected'}`;
        case 'stale':
          return `${icon('clock')}Too late — already served`;
        case 'vetoed':
          return `${icon('lock')}Vetoed by safety layer`;
        default:
          return '';
      }
    }

    // While a model "thinks", its distribution drifts from uniform toward
    // the final answer so the viewer sees it settle rather than snap.
    deliberation(dec, t) {
      const u = Math.min(1, (t - dec.startT) / Math.max(1e-6, dec.commitT - dec.startT));
      const e = u * u * (3 - 2 * u);
      const legal = dec.options.map((o) => !o.veto);
      const n = legal.filter(Boolean).length || 1;
      const raw = dec.probs.map((p, i) =>
        legal[i] ? Math.max(0, (1 / n) * (1 - e) + p * e + Math.sin(t * 9 + i * 2.1 + dec.id) * 0.09 * (1 - e)) : 0
      );
      const s = raw.reduce((a, b) => a + b, 0) || 1;
      return raw.map((x) => x / s);
    }

    mount(dec) {
      this.shown = dec;
      this.phase = null;
      const reason = dec.kind === 'overload' ? 'overload' : dec.req.reason;
      const [tag, tone] = TAG[reason] ?? TAG.new;
      this.r.tag.textContent = tag;
      this.r.tag.className = `dp-tag ${tone}`;
      this.r.title.textContent = dec.title;
      this.r.num.textContent = `#${dec.id}`;

      const opts = this.r.opts;
      opts.textContent = '';
      opts.classList.toggle('dense', dec.options.length > 4);
      const row = (i, o) => {
        const li = document.createElement('li');
        li.className = `opt${o.veto ? ' veto' : ''}`;
        li.innerHTML = `
          <span class="o-ico">${/^\d+$/.test(o.icon) ? `<b>${o.icon}</b>` : icon(o.icon)}</span>
          <span class="o-text"><span class="o-label">${esc(o.label)}</span><span class="o-detail">${esc(o.detail)}</span></span>
          <span class="o-bar"><i></i></span>
          <span class="o-pct">${o.veto ? `${icon('lock')}veto` : ''}</span>`;
        opts.appendChild(li);
        return { i, li, bar: li.querySelector('.o-bar i'), pct: li.querySelector('.o-pct') };
      };
      this.rows = dec.options.map((o, i) => row(i, o));

      // Many options: scrolling list plus the overview slider.
      this.sliding = dec.options.length > MAX_ROWS;
      const { scroll, ov, ovBars } = this.r;
      ov.hidden = !this.sliding;
      scroll.classList.toggle('sliding', this.sliding);
      scroll.tabIndex = this.sliding ? 0 : -1;
      scroll.setAttribute('aria-label', this.sliding ? `${dec.options.length} options, scrollable` : '');
      this.follow = true;
      this.followed = -1;
      if (this.sliding) {
        const pitch = (this.rows[0].li.offsetHeight || 28) + 2;
        scroll.style.maxHeight = `${Math.round(pitch * MAX_ROWS)}px`;
        if (ovBars.childElementCount !== dec.options.length) {
          ovBars.innerHTML = dec.options.map(() => '<i></i>').join('');
        }
        this.ovBars = [...ovBars.children];
        this.ovBars.forEach((b, i) => b.classList.toggle('veto', !!dec.options[i].veto));
      } else {
        scroll.style.maxHeight = '';
      }
      // Keep the previous bars when the shape matches so the new decision
      // visibly morphs out of the old one.
      if (this.disp.length !== dec.options.length) this.disp = dec.options.map(() => 0);

      const foot = this.r.foot;
      if (this.model) {
        foot.innerHTML = `
          <span class="foot-k">Certainty</span>
          <span class="cert"><i data-r="cert"></i></span>
          <span class="cert-l" data-r="certL"></span>
          <span class="foot-note">${this.live ? "The model's own top choice, with its probabilities" : 'Choice is sampled from this distribution'}</span>`;
        this.r.cert = foot.querySelector('[data-r=cert]');
        this.r.certL = foot.querySelector('[data-r=certL]');
      } else {
        foot.innerHTML = `
          <span class="foot-k">Rule trace</span>
          ${dec.trace.map((r) => `<span class="rule${r.fired ? ' fired' : ''}"><b>${r.id}</b> ${esc(r.text)}</span>`).join('<span class="rule-sep">›</span>')}`;
      }

      const card = this.r.card;
      card.classList.remove('enter');
      void card.offsetWidth;
      card.classList.add('enter');
    }

    renderCertainty(dec) {
      const ps = this.disp.filter((_, i) => !dec.options[i].veto);
      const n = ps.length;
      let c = 1;
      if (n > 1) {
        const s = ps.reduce((a, b) => a + b, 0) || 1;
        const h = -ps.reduce((a, p) => (p > 0 ? a + (p / s) * Math.log(p / s) : a), 0);
        c = 1 - h / Math.log(n);
      }
      this.r.cert.style.transform = `scaleX(${Math.max(0.02, c).toFixed(3)})`;
      this.text(this.r.certL, c > 0.55 ? 'Confident' : c > 0.25 ? 'Leaning' : 'Torn');
    }

    renderHistory(D) {
      const items = D.history.slice(0, 6);
      const key = items.map((d) => `${d.id}${d.outcome}`).join('|');
      if (key === this.histKey) return;
      this.histKey = key;
      this.r.hist.innerHTML = items
        .map((d) => {
          const ctx = d.kind === 'assign' ? `${fl(d.req.floor)} ${arrow(d.req.dir)}` : `Car ${d.req.car + 1}`;
          const segs = d.options
            .map((o, i) => {
              const p = d.probs[i];
              if (p < 0.005) return '';
              return `<i class="${i === d.choice ? 'pick' : ''}" style="flex-grow:${p.toFixed(3)}" title="${esc(o.label)} ${Math.round(p * 100)}%"></i>`;
            })
            .join('');
          const pick = d.outcome === 'stale' ? 'late' : d.outcome === 'vetoed' ? 'veto' : d.options[d.choice]?.short ?? '—';
          return `<li class="h-row o-${d.outcome}"><span class="h-ctx">${ctx}</span><span class="h-seg">${segs}</span><span class="h-pick">${esc(pick)}</span></li>`;
        })
        .join('');
    }
  }

  EDA.DecisionPanel = DecisionPanel;
})(window.EDA);
