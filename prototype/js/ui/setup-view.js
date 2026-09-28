/*
 * Setup check rendering: the facet-by-facet panel (New experiment, Audit)
 * and the small verdict chip (Run history, Leaderboard).
 */
(function (EDA) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // Why a differing facet matters for this verdict.
  function tagOf(row, check) {
    if (row.inert) return ['inert', 'no effect here'];
    if (row.test) return ['compared', 'being compared'];
    if (check.verdict === 'controlled' && row.key === check.subject) return ['compared', 'being compared'];
    if (row.group === 'harness') return ['breaks', 'breaks control'];
    return ['follows', 'comes with the decider'];
  }

  // a, b: registry entries or run provenance (lane A and lane B).
  function panel(check, a, b, { actions = true } = {}) {
    const differs = check.rows.filter((r) => !r.same);
    const same = check.rows.filter((r) => r.same);
    const badge = (p, k) => `<span class="lane lane-${k}" title="${esc(`${p.name} ${p.version}`)}">${k}</span>`;
    const rows = differs
      .map((r) => {
        const [cls, tag] = tagOf(r, check);
        return `
          <div class="sc-row ${cls}">
            <div class="sc-facet"><b>${r.label}</b><small>${tag}</small></div>
            <div class="sc-val"><span class="sc-lane">${badge(a, 'A')}</span>${esc(r.a)}</div>
            <div class="sc-val"><span class="sc-lane">${badge(b, 'B')}</span>${esc(r.b)}</div>
          </div>`;
      })
      .join('');
    const breaks = differs.filter((r) => r.group === 'harness' && tagOf(r, check)[0] === 'breaks').length;
    const sub = check.verdict === 'controlled' ? check.short.replace(/^Controlled · /, 'compares the ') : `${breaks} difference${breaks === 1 ? '' : 's'} besides the decider`;
    const notes = check.notes
      .map(
        (n) => `
        <li class="${n.level}">${icon(n.level === 'warn' ? 'alert' : 'info')}<span>${esc(n.text)}</span>${
          actions && n.action ? `<button type="button" class="btn-ghost" data-sc-act="${n.action.act}">${esc(n.action.label)}</button>` : ''
        }</li>`
      )
      .join('');
    return `
      <div class="sc ${check.verdict}">
        <header>
          <span class="sc-verdict">${icon(check.verdict === 'controlled' ? 'check' : 'shuffle')}${check.label}</span>
          <span class="sc-sub">${esc(sub)}</span>
        </header>
        <p class="sc-sum">${esc(check.summary)}</p>
        ${differs.length ? `<div class="sc-rows">${rows}</div>` : ''}
        ${same.length ? `<p class="sc-same"><b>Same in both lanes</b> ${same.map((r) => r.label.toLowerCase()).join(' · ')}</p>` : ''}
        ${notes ? `<ul class="sc-notes">${notes}</ul>` : ''}
      </div>`;
  }

  // Verdict chip from a stored stamp (or a full check).
  function chip(stamp) {
    if (!stamp) return '';
    const title = stamp.verdict === 'controlled' ? 'Only one thing differs between the lanes' : `Differs in: ${stamp.differs.join(', ')}`;
    return `<span class="sc-chip ${stamp.verdict}" title="${esc(title)}">${esc(stamp.short)}</span>`;
  }

  EDA.setupView = { panel, chip };
})(window.EDA);
