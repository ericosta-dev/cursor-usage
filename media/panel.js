// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const LOCALE = 'en-US';
  const usd = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' });
  const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
  const int = new Intl.NumberFormat(LOCALE);
  const money = (cents) => usd.format(cents / 100);
  const date = (ms) => new Date(ms).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' }); // Oct 22
  const md = (ms) => new Date(ms).toLocaleDateString(LOCALE, { month: 'numeric', day: 'numeric' }); // 10/22, for tight spots
  const time = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  const weekday = (ms) => new Date(ms).toLocaleDateString(LOCALE, { weekday: 'short' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const plural = (n, one, many) => `${int.format(n)} ${n === 1 ? one : many}`;
  const ordinal = (n) => {
    const tens = n % 100, ones = n % 10;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
    return `${n}${suffix}`;
  };

  const RECENT_PAGE_SIZE = 25;
  const PERIODS = [['cycle', 'Cycle'], ['week', 'Week'], ['today', 'Today']];
  const ON_DEMAND = 'USAGE_EVENT_KIND_USAGE_BASED';
  const KINDS = {
    USAGE_EVENT_KIND_USAGE_BASED: 'On-demand',
    USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS: 'Included',
    USAGE_EVENT_KIND_INCLUDED_IN_PRO: 'Included',
    USAGE_EVENT_KIND_FREE_CREDIT: 'Bonus',
    USAGE_EVENT_KIND_ERRORED_NOT_CHARGED: 'Errored, not charged',
  };
  const kindLabel = (k) => KINDS[k] ?? String(k || '').replace('USAGE_EVENT_KIND_', '').toLowerCase();

  // Reorderable blocks below the summary cards, in their default order (setting: cursorUsage.sectionOrder).
  const BLOCKS = {
    activity: 'Daily cost & cycle activity',
    youVsTeam: 'You vs team',
    impact: 'Code impact',
    quality: 'Agent quality',
    models: 'By model',
    languages: 'Languages',
    conversations: 'Most expensive conversations',
    cloud: 'Cloud agents',
    recent: 'Recent requests',
  };
  const DEFAULT_ORDER = Object.keys(BLOCKS);
  // Settings keys (cursorUsage.sections) behind each block; the activity row holds two.
  const BLOCK_SECTIONS = { activity: [['chart', 'Chart'], ['heatmap', 'Heatmap']] };
  const blockSections = (id) => BLOCK_SECTIONS[id] ?? [[id, 'Show']];
  // Unknown ids are dropped and missing ones appended, so an old or hand-edited setting still works.
  const normalizeOrder = (order) => {
    const known = (Array.isArray(order) ? order : []).filter((id, i, a) => id in BLOCKS && a.indexOf(id) === i);
    return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
  };

  /** @type {any} */
  let data;
  /** @type {any} */
  let view;
  let period = vscode.getState()?.period ?? 'cycle';
  let recentPage = 0;
  let heatMetric = vscode.getState()?.heatMetric ?? 'requests';
  let order = DEFAULT_ORDER;
  let editing = false;
  /** @type {Record<string, any>} per-period data (analytics, repos), loaded on demand */
  let periodData = {};
  let restoreScroll = vscode.getState()?.scrollY ?? 0;
  const saveState = () => vscode.setState({ period, heatMetric, scrollY: window.scrollY });
  const pd = () => periodData[period];
  const show = (key) => data.sections?.[key] !== false;

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'loading') setLoading(true);
    if (msg.type === 'data') { data = msg.data; order = normalizeOrder(data.order); periodData = {}; render(); }
    if (msg.type === 'period') {
      periodData[msg.period] = msg.data;
      if (data && msg.period === period) render();
    }
    if (msg.type === 'order' && data) { order = normalizeOrder(msg.order); render(); }
    if (msg.type === 'sections' && data) { data.sections = msg.sections; render(); }
    if (msg.type === 'error') renderError(msg.message);
  });
  // Heatmap tooltip: one shared element, positioned over the hovered cell.
  app.addEventListener('mouseover', (e) => {
    const cell = /** @type {HTMLElement} */ (e.target).closest?.('.heat-cell[data-tip]');
    const tip = document.getElementById('heat-tip');
    if (!tip) return;
    if (!cell) { tip.style.display = 'none'; return; }
    tip.innerHTML = cell.dataset.tip;
    tip.style.left = `${cell.offsetLeft + cell.offsetWidth / 2}px`;
    tip.style.top = `${cell.offsetTop}px`;
    tip.style.display = 'block';
  });

  // The webview is recreated when the tab comes back into view, so keep the scroll position.
  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (scrollQueued || !data) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; saveState(); });
  });
  window.addEventListener('resize', () => view && drawChart());
  app.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('#refresh')) vscode.postMessage({ type: 'refresh', period });
    const p = /** @type {HTMLElement | null} */ (t.closest('[data-period]'));
    if (p && data) {
      period = p.dataset.period;
      recentPage = 0;
      saveState();
      if (!pd()) vscode.postMessage({ type: 'period', period });
      render();
    }
    const heat = /** @type {HTMLElement | null} */ (t.closest('[data-heat-metric]'));
    if (heat && data) {
      heatMetric = heat.dataset.heatMetric;
      saveState();
      render();
    }
    const page = /** @type {HTMLElement | null} */ (t.closest('[data-recent-page]'));
    if (page && data) {
      recentPage = Number(page.dataset.recentPage);
      render();
      document.getElementById('recent')?.scrollIntoView({ block: 'start' });
    }
    // Layout editing
    if (t.closest('#customize') && data) { editing = !editing; render(); }
    if (t.closest('#reset-order') && data) saveOrder(DEFAULT_ORDER);
    const move = /** @type {HTMLElement | null} */ (t.closest('[data-move]'));
    if (move && data) {
      const id = move.closest('[data-block]')?.getAttribute('data-block');
      const i = order.indexOf(id), j = i + (move.dataset.move === 'up' ? -1 : 1);
      if (i >= 0 && j >= 0 && j < order.length) {
        const next = [...order];
        [next[i], next[j]] = [next[j], next[i]];
        saveOrder(next);
        requestAnimationFrame(() => document.querySelector(`[data-block="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
      }
    }
  });
  // Show/hide toggles in layout mode: applied at once, saved to cursorUsage.sections by the extension.
  app.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const key = input.dataset?.section;
    if (!key || !data) return;
    data.sections = { ...data.sections, [key]: input.checked };
    render();
    vscode.postMessage({ type: 'setSection', key, value: input.checked });
  });
  vscode.postMessage({ type: 'ready', period });

  // Applied right away; the extension stores it in the cursorUsage.sectionOrder setting.
  function saveOrder(next) {
    order = normalizeOrder(next);
    render();
    vscode.postMessage({ type: 'saveOrder', order });
  }

  function setLoading(on) {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh'));
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Refreshing…' : 'Refresh'; }
  }

  function renderError(message) {
    if (!data) {
      app.innerHTML = `<header><div><h1>Usage Panel</h1></div><button id="refresh">Try again</button></header>
        <p class="error">${esc(message)}</p>`;
    } else {
      setLoading(false);
      document.getElementById('status')?.replaceChildren(Object.assign(document.createElement('span'), { className: 'error', textContent: message }));
    }
  }

  // ---- Periods -------------------------------------------------------------

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Day-sized bins built with calendar arithmetic, so DST changes never skip or repeat a day.
  function dayBins(from, count) {
    const bins = [];
    const d = new Date(from);
    for (let i = 0; i < count; i++) {
      const start = d.getTime();
      d.setDate(d.getDate() + 1);
      bins.push({ start, end: d.getTime(), label: md(start), tip: `${weekday(start)}, ${date(start)}` });
    }
    return bins;
  }

  function shiftDays(ms, n) {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function periodRange(s) {
    const now = Date.now();
    if (period === 'today') {
      const start = startOfDay(now).getTime();
      const bins = [];
      for (let h = 0; h < 24; h++) {
        const d = startOfDay(now);
        d.setHours(h);
        const end = new Date(d); end.setHours(h + 1);
        const hour = (x) => new Date(x).toLocaleTimeString(LOCALE, { hour: 'numeric' });
        bins.push({ start: d.getTime(), end: end.getTime(), label: hour(d.getTime()), tip: `${hour(d.getTime())} – ${hour(end.getTime())}` });
      }
      return { start, end: bins[23].end, bins, title: `Today, ${weekday(now)} ${date(now)}`, chartTitle: 'Cost per hour', labelEvery: 3,
        prevStart: shiftDays(start, -1), prevEnd: shiftDays(now, -1), prevLabel: 'yesterday at this time' };
    }
    if (period === 'week') {
      const monday = startOfDay(now);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const bins = dayBins(monday, 7).map((b) => ({ ...b, label: `${weekday(b.start)} ${md(b.start)}` }));
      return { start: bins[0].start, end: bins[6].end, bins, title: `Week of ${date(bins[0].start)} – ${date(bins[6].start)}`, chartTitle: 'Cost per day', labelEvery: 1,
        prevStart: shiftDays(bins[0].start, -7), prevEnd: shiftDays(now, -7), prevLabel: 'last week at this point' };
    }
    const first = startOfDay(s.cycleStart);
    const days = Math.round((startOfDay(now).getTime() - first.getTime()) / 86400000) + 1;
    const bins = dayBins(first, days);
    const daysLeft = Math.max(0, Math.ceil((s.cycleEnd - now) / 86400000));
    const cycleLen = s.cycleEnd - s.cycleStart;
    return { start: s.cycleStart, end: Infinity, bins, title: `Cycle ${date(s.cycleStart)} – ${date(s.cycleEnd)} · ${plural(daysLeft, 'day', 'days')} left`, chartTitle: 'Cost per day', labelEvery: Math.ceil(days / 8),
      prevStart: s.cycleStart - cycleLen, prevEnd: now - cycleLen, prevLabel: 'last cycle at this point' };
  }

  function aggregate() {
    const range = periodRange(data.summary);
    const events = data.events.filter((e) => e.timestamp >= range.start && e.timestamp < range.end);
    const bins = range.bins.map((b) => ({ ...b, cents: 0, requests: 0 }));
    const models = new Map();
    const conversations = new Map();
    let cents = 0, onDemandCents = 0, tokens = 0;
    for (const e of events) {
      const bin = bins.find((b) => e.timestamp >= b.start && e.timestamp < b.end);
      if (bin) { bin.cents += e.cents; bin.requests++; }
      const t = e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      const m = models.get(e.model) ?? { model: e.model, requests: 0, tokens: 0, cacheTokens: 0, cents: 0 };
      m.requests++; m.tokens += t; m.cacheTokens += e.cacheReadTokens; m.cents += e.cents;
      models.set(e.model, m);
      if (e.conversationId) {
        const c = conversations.get(e.conversationId) ?? { id: e.conversationId, requests: 0, cents: 0, last: 0, models: new Map() };
        c.requests++; c.cents += e.cents; c.last = Math.max(c.last, e.timestamp);
        c.models.set(e.model, (c.models.get(e.model) ?? 0) + e.cents);
        conversations.set(e.conversationId, c);
      }
      cents += e.cents; tokens += t;
      if (e.kind === ON_DEMAND) onDemandCents += e.cents;
    }
    // Only compare when the previous window was fully fetched.
    const prevCents = data.fetchStart <= range.prevStart
      ? data.events.filter((e) => e.timestamp >= range.prevStart && e.timestamp < range.prevEnd).reduce((sum, e) => sum + e.cents, 0)
      : undefined;
    return {
      ...range,
      bins,
      cents, onDemandCents, tokens, prevCents,
      conversations: [...conversations.values()].sort((a, b) => b.cents - a.cents).slice(0, 10).map((c) => ({
        ...c,
        title: data.titles?.[c.id],
        mainModel: [...c.models.entries()].sort((a, b) => b[1] - a[1])[0][0],
        modelCount: c.models.size,
      })),
      requests: events.length,
      models: [...models.values()].sort((a, b) => b.cents - a.cents),
      recent: [...events].sort((a, b) => b.timestamp - a.timestamp),
    };
  }

  // ---- Rendering -----------------------------------------------------------

  function kpi(label, value, sub, percent, note) {
    const meter = percent === undefined ? '' :
      `<div class="meter" role="img" aria-label="${Math.round(percent)}%"><span style="width:${Math.min(100, percent)}%"></span></div>`;
    const extra = note ? `<div class="sub delta">${esc(note)}</div>` : '';
    return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div>${extra}${meter}</div>`;
  }

  // "▲ 40% vs last week at this point ($20.00)"
  function deltaText() {
    if (view.prevCents === undefined) return '';
    if (view.prevCents === 0) return view.cents ? `no usage in the previous period (${view.prevLabel})` : '';
    const change = Math.round(((view.cents - view.prevCents) / view.prevCents) * 100);
    return `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% vs ${view.prevLabel} (${money(view.prevCents)})`;
  }

  // Linear projections: cycle and team limit from the cycle's daily average, week from this week's.
  function insights(s) {
    const now = Date.now();
    const lines = [];
    if (period === 'cycle') {
      const elapsed = Math.max(1, (now - s.cycleStart) / 86400000);
      const left = Math.max(0, (s.cycleEnd - now) / 86400000);
      const daily = s.totalCents / elapsed;
      lines.push(`At the current pace (${money(daily)}/day), you'll close the cycle at <strong>≈ ${money(s.totalCents + daily * left)}</strong>.`);
      if (s.teamPool && s.teamPool.usedCents > 0) {
        const poolLeft = (s.teamPool.limitCents - s.teamPool.usedCents) / (s.teamPool.usedCents / elapsed);
        lines.push(poolLeft < left
          ? `At the team's pace, the spend limit runs out in <strong>~${plural(Math.max(1, Math.round(poolLeft)), 'day', 'days')}</strong>, before the cycle ends (${plural(Math.ceil(left), 'day', 'days')} left).`
          : "At the team's pace, the spend limit should last until the end of the cycle.");
      }
    } else if (period === 'week') {
      const elapsed = Math.max(1, (now - view.start) / 86400000);
      const left = Math.max(0, (view.end - now) / 86400000);
      const daily = view.cents / elapsed;
      lines.push(`At this week's pace (${money(daily)}/day), it'll close at <strong>≈ ${money(view.cents + daily * left)}</strong>.`);
    }
    return lines.length ? `<div class="insights">${lines.map((l) => `<p>${l}</p>`).join('')}</div>` : '';
  }

  function kpis(s) {
    if (period === 'cycle') {
      const pool = s.teamPool;
      const poolPct = pool ? (pool.usedCents / pool.limitCents) * 100 : 0;
      return kpi('Cycle spend', money(s.totalCents), `plan + on-demand · ${plural(view.requests, 'request', 'requests')}`, undefined, deltaText())
        + kpi('Covered by plan', money(s.planUsedCents), `included ${money(s.planIncludedCents)} + bonus ${money(s.planBonusCents)} · ${Math.round(s.planPercent)}% used`, s.planPercent)
        + kpi('On-demand', money(s.onDemandCents), 'billed to the team beyond the plan')
        + (pool ? kpi('Team spend limit', money(pool.usedCents), `of ${money(pool.limitCents)} · ${Math.round(poolPct)}% used by the team`, poolPct) : '');
    }
    const avg = view.requests ? money(view.cents / view.requests) : money(0);
    return kpi(period === 'week' ? 'Spend this week' : 'Spend today', money(view.cents), `${plural(view.requests, 'request', 'requests')} · ${avg} avg`, undefined, deltaText())
      + kpi('Covered by plan', `≈ ${money(view.cents - view.onDemandCents)}`, "estimated from each request's type")
      + kpi('On-demand', `≈ ${money(view.onDemandCents)}`, "estimated from each request's type")
      + kpi('Tokens', compact.format(view.tokens), 'input + output + cache');
  }

  function teamCompareSection() {
    if (!show('youVsTeam')) return '';
    if (!pd()) return loadingSection('You vs team');
    const a = pd().analytics;
    if (!a) return '';
    const rank = (r) => (r ? `${ordinal(r)} of ${a.activeMembers}` : 'no rank');
    const per100 = a.applyLines ? money((view.cents / a.applyLines) * 100) : '—';
    return `
      <section>
        <h2>You vs team</h2>
        <p class="muted rank-intro">Your position among the ${int.format(a.activeMembers)} members active in the period.</p>
        <div class="kpis">
          ${kpi('Lines applied by the agent', int.format(a.applyLines), `${rank(a.applyLinesRank)} · team avg ${int.format(Math.round(a.teamAverageApplyLines))}`)}
          ${kpi('Tab suggestions accepted', int.format(a.tabsAccepted), `${rank(a.tabsAcceptedRank)} · team avg ${int.format(Math.round(a.teamAverageTabsAccepted))}`)}
          ${kpi('Agent requests', int.format(a.agentRequests), 'in the period')}
          ${kpi('Cost per 100 lines', per100, 'period spend ÷ lines applied by the agent')}
        </div>
      </section>`;
  }

  // ---- Own analytics (v2): agent quality, code impact, languages, cloud agents ----

  const isoDay = (ms) => new Date(ms).toLocaleDateString('sv-SE');
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

  // Sum the per-day rows whose date falls in [start, end).
  function sumDays(start, end) {
    const from = isoDay(start);
    const to = isoDay(Math.min(end, Date.now() + 1) - 1);
    const total = {};
    for (const d of data.activity?.days ?? []) {
      if (d.date < from || d.date > to) continue;
      for (const [k, v] of Object.entries(d)) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
    }
    return new Proxy(total, { get: (t, k) => t[k] ?? 0 }); // missing keys read as 0
  }

  // "▲ 5 pts" style change between two percentages, for the previous period up to the same point.
  function pointsDelta(cur, prev) {
    if (prev === undefined) return '';
    const diff = cur - prev;
    return `${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff)} pts vs ${view.prevLabel}`;
  }

  function activityPeriods() {
    const cur = sumDays(view.start, view.end);
    const prevAvailable = data.fetchStart <= view.prevStart;
    return { cur, prev: prevAvailable ? sumDays(view.prevStart, view.prevEnd) : undefined };
  }

  function impactSection() {
    if (!show('impact') || !data.activity) return '';
    const { cur } = activityPeriods();
    const repos = pd()?.repos ?? [];
    if (!cur.commits && !repos.length) {
      return `<section><h2>Code impact</h2><p class="muted">No commits tracked by Cursor in this period.</p></section>`;
    }
    const aiShare = pct(cur.aiCommitLines, cur.commitLines);
    const perCommit = cur.commits ? money(view.cents / cur.commits) : '—';
    const per100 = cur.aiCommitLines ? money((view.cents / cur.aiCommitLines) * 100) : '—';
    const origin = [['IDE', cur.aiIdeLines], ['CLI', cur.aiCliLines], ['Cloud', cur.aiCloudLines]].filter(([, v]) => v).map(([k, v]) => `${k} ${int.format(v)}`).join(' · ');
    const maxRepo = Math.max(1, ...repos.map((r) => r.aiLines));
    return `
      <section>
        <h2>Code impact</h2>
        <p class="muted rank-intro">Commits Cursor tracked in your repositories, set against your spend in the period.</p>
        <div class="kpis">
          ${kpi('Commits', int.format(cur.commits), `${plural(cur.commitLines, 'line', 'lines')} added`)}
          ${kpi('Committed lines written by AI', `${aiShare}%`, `${plural(cur.aiCommitLines, 'line', 'lines')}${origin ? ' · ' + origin : ''}`, aiShare)}
          ${kpi('Cost per commit', perCommit, 'period spend ÷ commits')}
          ${kpi('Cost per 100 committed lines', per100, 'spend ÷ AI lines that reached the repository')}
        </div>
        ${repos.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Repository</th><th class="num">Commits</th><th class="num">AI lines</th><th class="num">% AI</th><th class="num">Agent</th><th class="num">Tab</th><th class="share" aria-hidden="true"></th></tr></thead>
          <tbody>${repos.slice(0, 10).map((r) => `
            <tr><td class="title-cell" title="${esc(r.repo)}">${esc(r.repo)}</td><td class="num">${int.format(r.commits)}</td><td class="num">${int.format(r.aiLines)}</td>
            <td class="num">${pct(r.aiLines, r.linesAdded)}%</td><td class="num">${int.format(r.agentLines)}</td><td class="num">${int.format(r.tabLines)}</td>
            <td class="share"><div style="width:${(r.aiLines / maxRepo) * 100}%"></div></td></tr>`).join('')}
          </tbody>
        </table></div>` : ''}
      </section>`;
  }

  function qualitySection() {
    if (!show('quality') || !data.activity) return '';
    const { cur, prev } = activityPeriods();
    if (!cur.diffsSuggested && !cur.tabSuggestions) return '';
    const diffRate = pct(cur.diffsAccepted, cur.diffsSuggested);
    const lineRate = pct(cur.agentLinesAccepted, cur.agentLinesSuggested);
    const tabRate = pct(cur.tabAccepts, cur.tabSuggestions);
    const perDiff = cur.diffsAccepted ? money(view.cents / cur.diffsAccepted) : '—';
    const prevRate = (a, b) => (prev && prev[b] ? pct(prev[a], prev[b]) : undefined);
    // No suggestions at all is "no data", not a 0% acceptance rate.
    const rateKpi = (label, part, whole, rate, sub, prevArgs) => whole
      ? kpi(label, `${rate}%`, sub, rate, pointsDelta(rate, prevRate(...prevArgs)))
      : kpi(label, '—', 'no suggestions in the period');
    return `
      <section>
        <h2>Agent quality</h2>
        <p class="muted rank-intro">How much of what the AI suggests you keep. A falling rate means money spent on code you threw away.</p>
        <div class="kpis">
          ${rateKpi('Agent diffs accepted', cur.diffsAccepted, cur.diffsSuggested, diffRate, `${int.format(cur.diffsAccepted)} of ${int.format(cur.diffsSuggested)} · ${int.format(cur.diffsRejected)} rejected`, ['diffsAccepted', 'diffsSuggested'])}
          ${rateKpi('Agent lines accepted', cur.agentLinesAccepted, cur.agentLinesSuggested, lineRate, `${int.format(cur.agentLinesAccepted)} of ${plural(cur.agentLinesSuggested, 'line', 'lines')}`, ['agentLinesAccepted', 'agentLinesSuggested'])}
          ${rateKpi('Tab suggestions accepted', cur.tabAccepts, cur.tabSuggestions, tabRate, `${int.format(cur.tabAccepts)} of ${int.format(cur.tabSuggestions)}`, ['tabAccepts', 'tabSuggestions'])}
          ${kpi('Cost per accepted diff', perDiff, 'period spend ÷ accepted diffs')}
        </div>
      </section>`;
  }

  function languagesSection() {
    if (!show('languages')) return '';
    const rows = data.activity?.extensions ?? [];
    if (!rows.length) return '';
    const from = isoDay(view.start);
    const to = isoDay(Math.min(view.end, Date.now() + 1) - 1);
    const byExt = new Map();
    for (const r of rows) {
      if (r.date < from || r.date > to) continue;
      const e = byExt.get(r.extension) ?? { extension: r.extension, linesSuggested: 0, linesAccepted: 0, accepts: 0, rejects: 0 };
      e.linesSuggested += r.linesSuggested; e.linesAccepted += r.linesAccepted; e.accepts += r.accepts; e.rejects += r.rejects;
      byExt.set(r.extension, e);
    }
    const list = [...byExt.values()].filter((e) => e.linesSuggested || e.linesAccepted).sort((a, b) => b.linesSuggested - a.linesSuggested).slice(0, 10);
    if (!list.length) return '';
    const max = Math.max(1, ...list.map((e) => e.linesSuggested));
    return `
      <section>
        <h2>Languages</h2>
        <p class="muted rank-intro">Where the AI works the most for you, by file extension.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Extension</th><th class="num">Lines suggested</th><th class="num">Lines accepted</th><th class="num">Acceptance</th><th class="num">Accepts</th><th class="num">Rejects</th><th class="share" aria-hidden="true"></th></tr></thead>
          <tbody>${list.map((e) => `
            <tr><td class="nowrap">${esc(e.extension.startsWith('.') ? e.extension : '.' + e.extension)}</td><td class="num">${int.format(e.linesSuggested)}</td><td class="num">${int.format(e.linesAccepted)}</td>
            <td class="num">${pct(e.linesAccepted, e.linesSuggested)}%</td><td class="num">${int.format(e.accepts)}</td><td class="num">${int.format(e.rejects)}</td>
            <td class="share"><div style="width:${(e.linesSuggested / max) * 100}%"></div></td></tr>`).join('')}
          </tbody>
        </table></div>
      </section>`;
  }

  function cloudSection() {
    if (!show('cloud')) return '';
    const c = data.activity?.cloud;
    if (!c) return '';
    return `
      <section>
        <h2>Cloud agents</h2>
        <p class="muted rank-intro">Background agents (since the start of the loaded history).</p>
        <div class="kpis">
          ${kpi('PRs opened by agents', int.format(c.prs), 'background agents')}
          ${kpi('Lines generated', int.format(c.lines), 'by background agents')}
        </div>
      </section>`;
  }

  function modelsSection(empty) {
    if (!show('models')) return '';
    const max = Math.max(1, ...view.models.map((m) => m.cents));
    return `
      <section>
        <h2>By model</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num" title="Tokens read from cache, which are cheaper">% cache</th><th class="num">Cost/req</th><th class="num">Cost</th><th class="share" aria-hidden="true"></th></tr></thead>
          <tbody>${view.models.length ? view.models.map((m) => `
            <tr><td class="nowrap">${esc(m.model)}</td><td class="num">${int.format(m.requests)}</td><td class="num">${compact.format(m.tokens)}</td>
            <td class="num">${m.tokens ? Math.round((m.cacheTokens / m.tokens) * 100) + '%' : '—'}</td><td class="num">${money(m.cents / m.requests)}</td>
            <td class="num">${money(m.cents)}</td><td class="share"><div style="width:${(m.cents / max) * 100}%"></div></td></tr>`).join('') : empty(7)}
          </tbody>
        </table></div>
      </section>`;
  }

  function conversationsSection() {
    if (!show('conversations') || !view.conversations.length) return '';
    const max = Math.max(1, ...view.conversations.map((c) => c.cents));
    return `
      <section>
        <h2>Most expensive conversations</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Conversation</th><th>Model</th><th class="num">Requests</th><th class="num">Last</th><th class="num">Cost</th><th class="share" aria-hidden="true"></th></tr></thead>
          <tbody>${view.conversations.map((c) => `
            <tr><td class="title-cell" title="${esc(c.title ?? c.id)}">${c.title ? esc(c.title) : `<span class="muted">Untitled · ${esc(c.id.slice(0, 8))}</span>`}</td>
            <td class="nowrap">${esc(c.mainModel)}${c.modelCount > 1 ? ` <span class="muted">+${c.modelCount - 1}</span>` : ''}</td>
            <td class="num">${int.format(c.requests)}</td><td class="num">${date(c.last)}, ${time(c.last)}</td>
            <td class="num">${money(c.cents)}</td><td class="share"><div style="width:${(c.cents / max) * 100}%"></div></td></tr>`).join('')}
          </tbody>
        </table></div>
      </section>`;
  }

  // Cost chart and cycle heatmap share one row; each fills it when the other is turned off.
  function activitySection() {
    const chart = show('chart') ? `<section class="viz-chart">
          <div class="section-head"><h2>${esc(view.chartTitle)}</h2></div>
          <div class="chart" id="chart"><div class="tooltip" id="tip"></div></div>
        </section>` : '';
    const heat = heatmapSection();
    return chart || heat ? `<div class="viz-row">${chart}${heat}</div>` : '';
  }

  function blockHtml(id, empty) {
    switch (id) {
      case 'activity': return activitySection();
      case 'youVsTeam': return teamCompareSection();
      case 'impact': return impactSection();
      case 'quality': return qualitySection();
      case 'models': return modelsSection(empty);
      case 'languages': return languagesSection();
      case 'conversations': return conversationsSection();
      case 'cloud': return cloudSection();
      case 'recent': return show('recent') ? recentSection(empty) : '';
      default: return '';
    }
  }

  // In layout mode every block gets a bar with ↑/↓, including blocks that are hidden or empty.
  function blocks(empty) {
    return order.map((id, i) => {
      const html = blockHtml(id, empty);
      if (!editing) return html;
      const toggles = blockSections(id);
      const allHidden = toggles.every(([key]) => !show(key));
      const body = html || `<p class="muted block-empty">${allHidden ? 'Hidden.' : 'No data for this period.'}</p>`;
      return `
      <div class="block editing${allHidden ? ' is-hidden' : ''}" data-block="${id}">
        <div class="block-bar">
          <span class="block-name">${esc(BLOCKS[id])}</span>
          <span class="block-toggles">${toggles.map(([key, label]) => `
            <label class="toggle"><input type="checkbox" data-section="${key}" ${show(key) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
          </span>
          <span class="block-moves">
            <button class="icon" data-move="up" title="Move up" aria-label="Move ${esc(BLOCKS[id])} up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon" data-move="down" title="Move down" aria-label="Move ${esc(BLOCKS[id])} down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </div>
        ${body}
      </div>`;
    }).join('\n');
  }

  function render() {
    const s = data.summary;
    view = aggregate();
    const empty = (cols) => `<tr><td colspan="${cols}" class="muted">No requests in this period.</td></tr>`;

    app.innerHTML = `
      <header>
        <div>
          <h1>Usage Panel</h1>
          <p class="muted" id="status">${esc(view.title)} · updated at ${time(s.fetchedAt)}</p>
        </div>
        <div class="actions">
          <div class="segmented" role="group" aria-label="Period">
            ${PERIODS.map(([id, label]) => `<button data-period="${id}" aria-pressed="${id === period}">${label}</button>`).join('')}
          </div>
          <button class="secondary" id="customize" aria-pressed="${editing}">${editing ? 'Done' : 'Customize layout'}</button>
          <button id="refresh">Refresh</button>
        </div>
      </header>
      ${editing ? `
      <div class="layout-bar">
        <span>Reorder blocks with ↑ ↓ and show or hide them with the checkboxes. Saved in your settings (<code>cursorUsage.sectionOrder</code>, <code>cursorUsage.sections</code>).</span>
        <span class="layout-actions">
          <button class="link" id="reset-order">Reset order</button>
        </span>
      </div>` : ''}

      <div class="kpis">${kpis(s)}</div>
      ${insights(s)}

      ${blocks(empty)}

      <footer>
        ${data.truncated ? `Per-period numbers only cover the ${int.format(data.events.length)} most recent requests; older ones were left out. ` : ''}
        Cost per request includes Cursor's token fee. Unofficial extension, not affiliated with Cursor: data comes from undocumented dashboard endpoints and may change.
      </footer>`;
    if (show('chart')) drawChart();
    if (restoreScroll) {
      window.scrollTo(0, restoreScroll);
      restoreScroll = 0;
    }
  }

  // GitHub-style activity map of the current cycle: weeks as columns, Monday..Sunday as rows.
  function heatmapSection() {
    if (!show('heatmap')) return '';
    const s = data.summary;
    const today = isoDay(Date.now());
    const cycleFirst = isoDay(s.cycleStart);
    const cycleLast = isoDay(s.cycleEnd - 1);
    const byDay = new Map();
    for (const e of data.events) {
      if (e.timestamp < s.cycleStart) continue;
      const k = isoDay(e.timestamp);
      const d = byDay.get(k) ?? { requests: 0, cents: 0 };
      d.requests++; d.cents += e.cents;
      byDay.set(k, d);
    }
    // Calendar from the Monday of the cycle's first week to the Sunday of its last week.
    const first = startOfDay(s.cycleStart);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const last = startOfDay(s.cycleEnd - 1);
    last.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
    const days = [];
    for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      const key = isoDay(d.getTime());
      const stats = byDay.get(key) ?? { requests: 0, cents: 0 };
      days.push({ key, ms: d.getTime(), ...stats, inCycle: key >= cycleFirst && key <= cycleLast, future: key > today });
    }
    const value = (d) => (heatMetric === 'cost' ? d.cents : d.requests);
    // Four levels from the quartiles of the active days, as GitHub does.
    const active = days.filter((d) => d.inCycle && !d.future && value(d) > 0).map(value).sort((a, b) => a - b);
    const q = (p) => active[Math.min(active.length - 1, Math.floor(p * active.length))] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const level = (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);

    const weeks = days.length / 7;
    const dayNames = ['Mon', '', 'Wed', '', 'Fri', '', ''];
    let grid = '<span></span>';
    for (let w = 0; w < weeks; w++) grid += `<span class="heat-week">${md(days[w * 7].ms)}</span>`;
    for (let r = 0; r < 7; r++) {
      grid += `<span class="heat-day">${dayNames[r]}</span>`;
      for (let w = 0; w < weeks; w++) {
        const d = days[w * 7 + r];
        if (!d.inCycle) { grid += '<span class="heat-cell out" aria-hidden="true"></span>'; continue; }
        if (d.future) { grid += '<span class="heat-cell future" aria-hidden="true"></span>'; continue; }
        const label = `${weekday(d.ms)}, ${date(d.ms)} · ${plural(d.requests, 'request', 'requests')} · ${money(d.cents)}`;
        grid += `<span class="heat-cell l${level(value(d))}${d.key === today ? ' today' : ''}" role="img" aria-label="${esc(label)}" data-tip="${esc(`${weekday(d.ms)}, ${date(d.ms)}<strong>${plural(d.requests, 'request', 'requests')}</strong>${money(d.cents)}`)}"></span>`;
      }
    }

    // Summary: active days, busiest day, current and longest streaks (days in the cycle up to today).
    const elapsed = days.filter((d) => d.inCycle && !d.future);
    const activeDays = elapsed.filter((d) => d.requests > 0);
    const busiest = activeDays.reduce((best, d) => (!best || value(d) > value(best) ? d : best), undefined);
    let longest = 0, run = 0;
    for (const d of elapsed) { run = d.requests > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
    let current = 0;
    for (let i = elapsed.length - 1; i >= 0; i--) {
      // Today without activity yet doesn't break the streak.
      if (elapsed[i].requests > 0) current++;
      else if (!(i === elapsed.length - 1 && elapsed[i].key === today)) break;
    }
    const legend = [0, 1, 2, 3, 4].map((l) => `<span class="heat-cell l${l}" aria-hidden="true"></span>`).join('');
    return `
      <section class="viz-heat">
        <div class="section-head">
          <h2>Cycle activity</h2>
          <div class="segmented small" role="group" aria-label="Heatmap metric">
            <button data-heat-metric="requests" aria-pressed="${heatMetric !== 'cost'}">Requests</button><button data-heat-metric="cost" aria-pressed="${heatMetric === 'cost'}">Cost</button>
          </div>
        </div>
        <div class="heat-layout">
          <div class="heat-wrap">
            <div class="heatmap">
              <div class="heat-grid" style="grid-template-columns: auto repeat(${weeks}, var(--heat-size))">${grid}</div>
              <div class="heat-legend muted">Less ${legend} More</div>
            </div>
            <div class="tooltip" id="heat-tip"></div>
          </div>
          <div class="heat-stats">
            <div><span class="muted">Active days</span><strong>${int.format(activeDays.length)} of ${int.format(elapsed.length)}</strong></div>
            <div><span class="muted">Busiest day</span><strong>${busiest ? `${weekday(busiest.ms)}, ${date(busiest.ms)}` : '—'}</strong>${busiest ? `<span class="muted">${plural(busiest.requests, 'request', 'requests')} · ${money(busiest.cents)}</span>` : ''}</div>
            <div><span class="muted">Current streak</span><strong>${plural(current, 'day', 'days')}</strong></div>
            <div><span class="muted">Longest streak</span><strong>${plural(longest, 'day', 'days')}</strong></div>
          </div>
        </div>
      </section>`;
  }

  function loadingSection(title) {
    return `<section><h2>${esc(title)}</h2><p class="muted">Loading…</p></section>`;
  }

  // Every request of the period, newest first, RECENT_PAGE_SIZE per page.
  function recentSection(empty) {
    const pages = Math.max(1, Math.ceil(view.recent.length / RECENT_PAGE_SIZE));
    recentPage = Math.min(recentPage, pages - 1);
    const rows = view.recent.slice(recentPage * RECENT_PAGE_SIZE, (recentPage + 1) * RECENT_PAGE_SIZE);
    const first = recentPage * RECENT_PAGE_SIZE + 1;
    const pager = pages > 1 ? `
        <div class="pager">
          <button class="link" data-recent-page="${recentPage - 1}" ${recentPage === 0 ? 'disabled' : ''}>‹ Newer</button>
          <span class="muted">${int.format(first)}–${int.format(first + rows.length - 1)} of ${int.format(view.recent.length)} · page ${recentPage + 1} of ${pages}</span>
          <button class="link" data-recent-page="${recentPage + 1}" ${recentPage >= pages - 1 ? 'disabled' : ''}>Older ›</button>
        </div>` : '';
    return `
      <section id="recent">
        <h2>Recent requests <span class="muted heading-note">· ${int.format(view.recent.length)} in the period</span></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Model</th><th>Type</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache</th><th class="num">Cost</th></tr></thead>
          <tbody>${rows.length ? rows.map((e) => `
            <tr><td class="nowrap">${date(e.timestamp)}, ${time(e.timestamp)}</td><td>${esc(e.model)}</td>
            <td><span class="badge">${esc(kindLabel(e.kind))}</span></td>
            <td class="num">${compact.format(e.inputTokens)}</td><td class="num">${compact.format(e.outputTokens)}</td>
            <td class="num">${compact.format(e.cacheReadTokens + e.cacheWriteTokens)}</td><td class="num">${money(e.cents)}</td></tr>`).join('') : empty(7)}
          </tbody>
        </table></div>
        ${pager}
      </section>`;
  }

  // Round axis: about four ticks at 1/2/2.5/5 × 10^n.
  function niceScale(v) {
    if (v <= 0) return { max: 100, step: 25 };
    const raw = v / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
    return { max: Math.ceil(v / step) * step, step };
  }

  function drawChart() {
    const host = document.getElementById('chart');
    const tip = document.getElementById('tip');
    if (!host || !tip) return;
    host.querySelector('svg')?.remove();

    const bins = view.bins;
    const W = Math.max(240, host.clientWidth), H = 260;
    const m = { top: 8, right: 4, bottom: 22, left: 56 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    const { max, step } = niceScale(Math.max(...bins.map((d) => d.cents)));
    const band = iw / bins.length;
    const bw = Math.max(2, Math.min(band - 2, 48)); // 2px gap between bars; cap width for short periods
    const y = (c) => m.top + ih - (c / max) * ih;

    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(view.chartTitle)}">`;
    for (let v = 0; v <= max; v += step) {
      const yy = y(v);
      svg += `<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="axis" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${esc(money(v))}</text>`;
    }
    bins.forEach((d, i) => {
      const x = m.left + i * band + (band - bw) / 2;
      const h = (d.cents / max) * ih;
      svg += `<rect class="hit" data-i="${i}" x="${m.left + i * band}" y="${m.top}" width="${band}" height="${ih}"/>`;
      if (h > 0) {
        const r = Math.min(4, h, bw / 2), top = m.top + ih - h, base = m.top + ih;
        svg += `<path class="bar" data-i="${i}" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z"/>`;
      }
      if (i % view.labelEvery === 0) {
        svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
      }
    });
    svg += '</svg>';
    host.insertAdjacentHTML('afterbegin', svg);

    const svgEl = host.querySelector('svg');
    svgEl?.addEventListener('mousemove', (e) => {
      const t = /** @type {SVGElement} */ (e.target);
      const i = t.dataset?.i;
      host.querySelectorAll('.bar.active').forEach((b) => b.classList.remove('active'));
      if (i === undefined) { tip.style.display = 'none'; return; }
      const d = bins[Number(i)];
      host.querySelector(`.bar[data-i="${i}"]`)?.classList.add('active');
      tip.innerHTML = `${esc(d.tip)}<strong>${esc(money(d.cents))}</strong>${plural(d.requests, 'request', 'requests')}`;
      const scale = host.clientWidth / W;
      tip.style.left = `${(m.left + Number(i) * band + band / 2) * scale}px`;
      tip.style.top = `${y(d.cents)}px`;
      tip.style.display = 'block';
    });
    svgEl?.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      host.querySelectorAll('.bar.active').forEach((b) => b.classList.remove('active'));
    });
  }
})();
