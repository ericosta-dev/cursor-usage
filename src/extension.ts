import * as vscode from 'vscode';
import { activityTotals, loadActivity, loadRepos } from './activity';
import { AuthError, CursorApi, UsageEvent, UsageSummary } from './api';
import { CoreData, PeriodData, PeriodKey, UsagePanel } from './panel';
import { loadSession, readConversationTitles, Session, stateDbPath } from './session';

const STATUS_KEY = 'cursorUsage.status';
const ALERTS_KEY = 'cursorUsage.alerts';
const LAST_SEEN_KEY = 'cursorUsage.lastSeenEvent';
const DIGEST_KEY = 'cursorUsage.digestWeek';
const NOTICE_KEY = 'cursorUsage.noticeShown';
const DAY = 86_400_000;

// Panel sections, all on by default (see the cursorUsage.sections setting).
const SECTION_KEYS = ['chart', 'heatmap', 'youVsTeam', 'impact', 'quality', 'leaderboard', 'models', 'languages', 'conversations', 'cloud', 'recent'];

// What the status bar needs; shared between Cursor windows through globalState.
interface StatusSnapshot {
  summary: UsageSummary;
  todayCents: number;
  fetchedAt: number;
}

const LOCALE = 'en-US';
const usd = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const ordinal = (n: number) => {
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`;
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Monday 00:00 local time, matching the panel's week view.
function startOfWeek(ms: number, weeksBack = 0): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * weeksBack);
  return d.getTime();
}

// Linear projection from the cycle's average daily spend. The first day counts as a full day
// so a single morning of usage doesn't extrapolate wildly.
export function forecast(s: UsageSummary, now = Date.now()) {
  const elapsedDays = Math.max(1, (now - s.cycleStart) / DAY);
  const daysLeft = Math.max(0, (s.cycleEnd - now) / DAY);
  const dailyCents = s.totalCents / elapsedDays;
  let poolDaysLeft: number | undefined;
  if (s.teamPool) {
    const poolDaily = s.teamPool.usedCents / elapsedDays;
    poolDaysLeft = poolDaily > 0 ? Math.max(0, (s.teamPool.limitCents - s.teamPool.usedCents) / poolDaily) : Infinity;
  }
  return { dailyCents, daysLeft, projectedCents: s.totalCents + dailyCents * daysLeft, poolDaysLeft };
}

export function activate(context: vscode.ExtensionContext) {
  const dbPath = stateDbPath(context.globalStorageUri.fsPath);
  const log = vscode.window.createOutputChannel('Usage Panel for Cursor');

  // Read the token once and keep it until it expires or the API rejects it.
  let session: Session | undefined;
  const getSession = async (forceReload: boolean) => {
    if (forceReload || !session || session.expiresAt - Date.now() < 60_000) {
      session = await loadSession(dbPath);
    }
    return session;
  };
  const api = new CursorApi(getSession);

  const item = vscode.window.createStatusBarItem('cursorUsage.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Usage Panel for Cursor';
  item.command = 'cursorUsage.openPanel';
  item.text = '$(credit-card) …';
  item.show();

  const config = () => vscode.workspace.getConfiguration('cursorUsage');
  const intervalMs = () => Math.max(config().get<number>('refreshIntervalMinutes', 10), 5) * 60_000;

  function render(snap: StatusSnapshot) {
    const s = snap.summary;
    const metric = config().get<string>('statusBarMetric', 'total');
    const value = metric === 'onDemand' ? money(s.onDemandCents)
      : metric === 'planPercent' ? `${Math.round(s.planPercent)}% of plan`
      : money(s.totalCents);
    const today = config().get<boolean>('statusBarShowToday', true) ? ` · today ${money(snap.todayCents)}` : '';
    item.text = `$(credit-card) ${value}${today}`;
    item.backgroundColor = overThreshold(s) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const f = forecast(s);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Cursor — cycle ${shortDate(s.cycleStart)} – ${shortDate(s.cycleEnd)}** (${days(Math.ceil(f.daysLeft))} left)\n\n`);
    md.appendMarkdown('| | |\n|:--|--:|\n');
    md.appendMarkdown(`| Cycle spend | **${money(s.totalCents)}** |\n`);
    md.appendMarkdown(`| Today | ${money(snap.todayCents)} |\n`);
    md.appendMarkdown(`| Covered by plan (${Math.round(s.planPercent)}%) | ${money(s.planUsedCents)} |\n`);
    md.appendMarkdown(`| On-demand, billed to the team | ${money(s.onDemandCents)} |\n`);
    md.appendMarkdown(`| Cycle projection | ≈ ${money(f.projectedCents)} |\n`);
    if (s.teamPool) {
      md.appendMarkdown(`| Team spend limit | ${money(s.teamPool.usedCents)} / ${money(s.teamPool.limitCents)} |\n`);
      if (f.poolDaysLeft !== undefined && f.poolDaysLeft < f.daysLeft) {
        md.appendMarkdown(`\n$(warning) At the current pace, the team limit runs out in ~${days(Math.max(1, Math.round(f.poolDaysLeft)))}, before the cycle ends.\n`);
      }
    }
    md.appendMarkdown(`\nUpdated at ${new Date(snap.fetchedAt).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' })} · click to open the panel`);
    item.tooltip = md;
  }

  function overThreshold(s: UsageSummary): boolean {
    const totalLimit = config().get<number>('alertAtUsd', 0);
    const poolPct = config().get<number>('alertTeamPoolPercent', 90);
    return (totalLimit > 0 && s.totalCents >= totalLimit * 100)
      || (poolPct > 0 && !!s.teamPool && (s.teamPool.usedCents / s.teamPool.limitCents) * 100 >= poolPct);
  }

  // Each cycle-level alert fires at most once per billing cycle, across all windows.
  function alertOnce(cycleStart: number, id: string, show: () => void) {
    const state = context.globalState.get<{ cycleStart: number; sent: string[] }>(ALERTS_KEY);
    const sent = state?.cycleStart === cycleStart ? state.sent : [];
    if (sent.includes(id)) return;
    void context.globalState.update(ALERTS_KEY, { cycleStart, sent: [...sent, id] });
    show();
  }

  const openPanelAction = (message: string, warn = true) => {
    const show = warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(message, 'Open panel').then((choice) => choice && vscode.commands.executeCommand('cursorUsage.openPanel'));
  };

  function checkCycleAlerts(s: UsageSummary) {
    const totalLimit = config().get<number>('alertAtUsd', 0);
    if (totalLimit > 0 && s.totalCents >= totalLimit * 100) {
      alertOnce(s.cycleStart, 'total', () =>
        openPanelAction(`Cursor: cycle spend reached ${money(s.totalCents)} (alert set at ${money(totalLimit * 100)}).`));
    }
    const poolPct = config().get<number>('alertTeamPoolPercent', 90);
    if (poolPct > 0 && s.teamPool) {
      const pct = (s.teamPool.usedCents / s.teamPool.limitCents) * 100;
      if (pct >= poolPct) {
        alertOnce(s.cycleStart, 'pool', () =>
          openPanelAction(`Cursor: the team has used ${Math.round(pct)}% of its spend limit (${money(s.teamPool!.usedCents)} of ${money(s.teamPool!.limitCents)}).`));
      }
    }
    if (config().get<boolean>('alertPlanExhausted', true) && s.planPercent >= 100) {
      alertOnce(s.cycleStart, 'plan', () =>
        openPanelAction("Cursor: your plan for this cycle is used up. From now on, usage is on-demand and billed to the team.", false));
    }
  }

  // Warn about single expensive requests (an agent stuck in a loop, a huge context, …).
  function checkExpensiveRequests(events: UsageEvent[]) {
    if (!events.length) return;
    const newest = Math.max(...events.map((e) => e.timestamp));
    const lastSeen = context.globalState.get<number>(LAST_SEEN_KEY);
    if (lastSeen !== undefined && newest <= lastSeen) return;
    void context.globalState.update(LAST_SEEN_KEY, newest);
    if (lastSeen === undefined) return; // first run: don't alert about past requests
    const limit = config().get<number>('alertRequestAtUsd', 5);
    if (limit <= 0) return;
    const expensive = events.filter((e) => e.timestamp > lastSeen && e.cents >= limit * 100).sort((a, b) => b.cents - a.cents);
    if (!expensive.length) return;
    const top = expensive[0];
    openPanelAction(expensive.length === 1
      ? `Cursor: a single ${top.model} request cost ${money(top.cents)}.`
      : `Cursor: ${expensive.length} requests went over ${money(limit * 100)}. The largest cost ${money(top.cents)} (${top.model}).`);
  }

  function showError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.appendLine(`[${new Date().toISOString()}] ${message}`);
    if (err instanceof AuthError) {
      item.text = '$(account) Cursor: sign in';
      item.tooltip = "Couldn't find a valid Cursor session. Sign in to Cursor, then click to try again.";
      return;
    }
    // Keep the last value visible; just flag that it is stale.
    if (!item.text.startsWith('$(warning)')) item.text = item.text.replace('$(credit-card)', '$(warning)');
  }

  // Other Cursor windows share globalState, so a fresh value fetched by any window is reused.
  async function refresh(force = false): Promise<UsageSummary | undefined> {
    try {
      let snap = context.globalState.get<StatusSnapshot>(STATUS_KEY);
      if (force || !snap?.summary || Date.now() - snap.fetchedAt >= intervalMs() - 5_000) {
        const now = Date.now();
        const [summary, today] = await Promise.all([api.summary(), api.events(startOfDay(now), now, 3)]);
        snap = { summary, todayCents: today.events.reduce((sum, e) => sum + e.cents, 0), fetchedAt: summary.fetchedAt };
        await context.globalState.update(STATUS_KEY, snap);
        checkExpensiveRequests(today.events);
        void weeklyDigest();
      }
      render(snap);
      checkCycleAlerts(snap.summary);
      return snap.summary;
    } catch (err) {
      showError(err);
      return undefined;
    }
  }

  // Optional extras for the panel: a failure is logged and that section is just left out.
  const optional = <T>(p: Promise<T>) => p.catch((err) => { showError(err); return undefined; });

  const sections = (): Record<string, boolean> => {
    const chosen = config().get<Record<string, boolean>>('sections', {});
    return Object.fromEntries(SECTION_KEYS.map((k) => [k, chosen[k] !== false]));
  };
  // The panel normalizes it (unknown ids dropped, missing ones appended).
  const sectionOrder = () => config().get<string[]>('sectionOrder', []);

  // Everything the panel shares across periods; endpoints of hidden sections are skipped.
  async function loadCore(): Promise<CoreData> {
    const summary = await refresh(true);
    if (!summary) throw new Error("Couldn't load your usage. See the \"Usage Panel for Cursor\" output channel.");
    const now = Date.now();
    const show = sections();
    // Enough history for "vs previous period" in every view: last cycle and last week.
    const fetchStart = Math.min(summary.cycleStart - (summary.cycleEnd - summary.cycleStart), startOfWeek(now, 1));
    const needs = { quality: show.quality, impact: show.impact, languages: show.languages, cloud: show.cloud };
    const [result, activity] = await Promise.all([
      api.events(fetchStart, now),
      Object.values(needs).some(Boolean) ? optional(loadActivity(api, fetchStart, now, needs, showError)) : undefined,
    ]);
    let titles: Record<string, string> = {};
    if (show.conversations) {
      try {
        const ids = [...new Set(result.events.map((e) => e.conversationId).filter((id): id is string => !!id))];
        titles = readConversationTitles(dbPath, ids);
      } catch (err) {
        showError(err);
      }
    }
    return {
      summary, events: result.events, fetchStart, totalEvents: result.total, truncated: result.truncated,
      titles, activity, sections: show, order: sectionOrder(),
    };
  }

  // What the API only serves per period: fetched the first time the period is opened.
  async function loadPeriod(period: PeriodKey, core: CoreData): Promise<PeriodData> {
    const now = Date.now();
    const start = { cycle: core.summary.cycleStart, week: startOfWeek(now), today: startOfDay(now) }[period];
    const show = core.sections;
    const [analytics, leaderboard, repos] = await Promise.all([
      show.youVsTeam ? optional(api.userAnalytics(start, now)) : undefined,
      show.leaderboard ? optional(api.leaderboard(start, now)) : undefined,
      show.impact ? optional(loadRepos(api, start, now)) : undefined,
    ]);
    return { analytics, leaderboard, repos };
  }

  // Once a week (first refresh from Monday on), a one-line wrap-up of the previous week.
  async function weeklyDigest(force = false) {
    if (!force && !config().get<boolean>('weeklyDigest', true)) return;
    const now = Date.now();
    const thisWeek = startOfWeek(now);
    if (!force && context.globalState.get<number>(DIGEST_KEY) === thisWeek) return;
    await context.globalState.update(DIGEST_KEY, thisWeek);
    try {
      const lastWeek = startOfWeek(now, 1);
      const weekBefore = startOfWeek(now, 2);
      const lastDay = thisWeek - 1; // Sunday, for the date-based analytics endpoints
      const [cur, prev, totals, board] = await Promise.all([
        api.events(lastWeek, thisWeek),
        api.events(weekBefore, lastWeek),
        optional(activityTotals(api, lastWeek, lastDay)),
        optional(api.leaderboard(lastWeek, lastDay)),
      ]);
      const cents = cur.events.reduce((sum, e) => sum + e.cents, 0);
      const prevCents = prev.events.reduce((sum, e) => sum + e.cents, 0);
      const parts = [`${money(cents)}`];
      if (prevCents > 0) {
        const pct = Math.round(((cents - prevCents) / prevCents) * 100);
        parts[0] += ` (${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs the week before)`;
      }
      if (totals) {
        const aiPct = totals.commitLines ? Math.round((totals.aiCommitLines / totals.commitLines) * 100) : 0;
        parts.push(`${totals.commits} ${totals.commits === 1 ? 'commit' : 'commits'}${totals.commits ? ` (${aiPct}% of lines by AI)` : ''}`);
        if (totals.diffsSuggested) parts.push(`${Math.round((totals.diffsAccepted / totals.diffsSuggested) * 100)}% of agent diffs accepted`);
      }
      const rank = board?.agent.find((r) => r.isMe)?.rank;
      if (rank) parts.push(`${ordinal(rank)} of ${board!.activeMembers} on the leaderboard`);
      openPanelAction(`Cursor · week of ${shortDate(lastWeek)} – ${shortDate(lastDay)}: ${parts.join(' · ')}.`, false);
    } catch (err) {
      showError(err);
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    // No polling while Cursor is in the background; coming back refreshes only if the data is stale.
    timer = setInterval(() => vscode.window.state.focused && void refresh(), intervalMs());
  };

  const panelHost = {
    core: loadCore,
    period: loadPeriod,
    maxAgeMs: intervalMs,
    saveOrder: (order: string[]) => config().update('sectionOrder', order, vscode.ConfigurationTarget.Global),
    openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage.sections'),
    accentColor: () => {
      const color = config().get<string>('accentColor', '').trim();
      return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
    },
  };

  context.subscriptions.push(
    item,
    log,
    { dispose: () => timer && clearInterval(timer) },
    vscode.commands.registerCommand('cursorUsage.refresh', () => refresh(true)),
    vscode.commands.registerCommand('cursorUsage.weeklyDigest', () => weeklyDigest(true)),
    vscode.commands.registerCommand('cursorUsage.openPanel', () => UsagePanel.show(context.extensionUri, panelHost, showError)),
    vscode.window.onDidChangeWindowState((state) => state.focused && void refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('cursorUsage')) return;
      if (e.affectsConfiguration('cursorUsage.sections')) UsagePanel.reloadIfOpen();
      if (e.affectsConfiguration('cursorUsage.accentColor')) {
        UsagePanel.restyle();
        return; // only the panel's look changed
      }
      if (e.affectsConfiguration('cursorUsage.sectionOrder')) {
        UsagePanel.setOrder(sectionOrder());
        return; // only the panel layout changed
      }
      schedule();
      void refresh();
    }),
  );

  // Once per install: say plainly what this extension is and what it does with the session token.
  if (!context.globalState.get<boolean>(NOTICE_KEY)) {
    void context.globalState.update(NOTICE_KEY, true);
    void vscode.window.showInformationMessage(
      'Usage Panel for Cursor is an unofficial extension, not affiliated with Cursor or Anysphere. It reads your Cursor sign-in '
      + 'token locally and sends it only to cursor.com, using undocumented dashboard endpoints that may change or stop working.',
      'Got it',
    );
  }

  schedule();
  void refresh();
}

export function deactivate() {}
