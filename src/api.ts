import { Session } from './session';

// Undocumented endpoints used by cursor.com/dashboard. They can change without notice.
const BASE = 'https://cursor.com';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export class AuthError extends Error {}

interface CurrentPeriodResponse {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    individualUsed?: number;
    pooledLimit?: string;
    pooledUsed?: number;
  };
}

interface UsageEventResponse {
  timestamp: string;
  model: string;
  kind: string;
  chargedCents?: number;
  conversationId?: string;
  owningUser?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  };
}

// All money values are in US cents.
export interface UsageSummary {
  cycleStart: number;
  cycleEnd: number;
  planUsedCents: number;
  planIncludedCents: number;
  planBonusCents: number;
  planPercent: number;
  onDemandCents: number;
  totalCents: number;
  teamPool?: { usedCents: number; limitCents: number };
  fetchedAt: number;
}

export interface UsageEvent {
  timestamp: number;
  model: string;
  kind: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cents: number;
  conversationId?: string;
}

export interface EventsResult {
  events: UsageEvent[];
  total: number; // as reported by the API (for admins this may count the whole team)
  truncated: boolean; // stopped at the page cap with more events left
}

// The user's productivity in a period and where it stands in the team (from the dashboard's analytics).
export interface UserAnalytics {
  applyLines: number;
  applyLinesRank: number;
  teamAverageApplyLines: number;
  tabsAccepted: number;
  tabsAcceptedRank: number;
  teamAverageTabsAccepted: number;
  activeMembers: number;
  agentRequests: number;
}

// One row of the dashboard's Analytics "Usage Leaderboard" (visible to every team member).
export interface LeaderboardEntry {
  rank: number;
  name: string;
  pictureUrl?: string;
  favoriteModel?: string;
  isMe: boolean;
  accepts: number; // agent: diffs accepted · tab: suggestions accepted
  linesAccepted: number;
  linesSuggested: number;
  acceptRatio?: number; // tab only: accepted ÷ shown
}

export interface Leaderboard {
  agent: LeaderboardEntry[];
  tab: LeaderboardEntry[];
  activeMembers: number;
}

export class CursorApi {
  private teamId?: number;
  private teamUserId?: number;
  private teamUserEmail?: string;

  constructor(private readonly getSession: (forceReload: boolean) => Promise<Session | undefined>) {}

  async summary(): Promise<UsageSummary> {
    const r = await this.post<CurrentPeriodResponse>('/api/dashboard/get-current-period-usage', {});
    const plan = r.planUsage ?? {};
    const limit = r.spendLimitUsage ?? {};
    const planUsedCents = plan.totalSpend ?? 0;
    const onDemandCents = limit.individualUsed ?? 0;
    const poolLimit = Number(limit.pooledLimit ?? 0);
    return {
      cycleStart: Number(r.billingCycleStart),
      cycleEnd: Number(r.billingCycleEnd),
      planUsedCents,
      planIncludedCents: plan.includedSpend ?? 0,
      planBonusCents: plan.bonusSpend ?? 0,
      planPercent: plan.totalPercentUsed ?? 0,
      onDemandCents,
      totalCents: planUsedCents + onDemandCents,
      teamPool: poolLimit > 0 ? { usedCents: limit.pooledUsed ?? 0, limitCents: poolLimit } : undefined,
      fetchedAt: Date.now(),
    };
  }

  // Only the current user's requests, whatever their role: admins may get the whole team's events
  // from this endpoint, so each event is also checked against its owner.
  async events(start: number, end: number, maxPages = MAX_PAGES): Promise<EventsResult> {
    const teamId = await this.getTeamId();
    const me = await this.getTeamUserId();
    const events: UsageEvent[] = [];
    let total = 0;
    let seen = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.post<{ totalUsageEventsCount?: number; usageEventsDisplay?: UsageEventResponse[] }>(
        '/api/dashboard/get-filtered-usage-events',
        { teamId, userId: me, startDate: String(start), endDate: String(end), page, pageSize: PAGE_SIZE },
      );
      total = r.totalUsageEventsCount ?? 0;
      const batch = r.usageEventsDisplay ?? [];
      seen += batch.length;
      events.push(...batch.filter((e) => isOwnEvent(e, me)).map(toEvent));
      if (batch.length < PAGE_SIZE || seen >= total) break;
      truncated = page === maxPages;
    }
    return { events, total, truncated };
  }

  async userAnalytics(start: number, end: number): Promise<UserAnalytics> {
    const teamId = await this.getTeamId();
    const r = await this.post<{
      applyLinesRank?: number; tabsAcceptedRank?: number; totalTeamMembers?: number;
      totalApplyLines?: number; teamAverageApplyLines?: number;
      totalTabsAccepted?: number; teamAverageTabsAccepted?: number;
      dailyMetrics?: { agentRequests?: number }[];
    }>('/api/dashboard/get-user-analytics', { teamId, startDate: start, endDate: end });
    return {
      applyLines: Number(r.totalApplyLines ?? 0),
      applyLinesRank: Number(r.applyLinesRank ?? 0),
      teamAverageApplyLines: Number(r.teamAverageApplyLines ?? 0),
      tabsAccepted: Number(r.totalTabsAccepted ?? 0),
      tabsAcceptedRank: Number(r.tabsAcceptedRank ?? 0),
      teamAverageTabsAccepted: Number(r.teamAverageTabsAccepted ?? 0),
      activeMembers: Number(r.totalTeamMembers ?? 0),
      agentRequests: (r.dailyMetrics ?? []).reduce((sum, d) => sum + Number(d.agentRequests ?? 0), 0),
    };
  }

  // Dashboard Analytics (v2). For members, everything but the leaderboard covers only their own activity.
  // The user filter matters for admins, who otherwise get team-wide numbers.
  async analytics<T>(endpoint: string, start: number, end: number): Promise<T> {
    const teamId = await this.getTeamId();
    await this.getTeamUserId();
    const query = new URLSearchParams({ startDate: isoDay(start), endDate: isoDay(end), teamId: String(teamId) });
    if (this.teamUserEmail) query.set('user', this.teamUserEmail);
    return this.request<T>('GET', `/api/v2/analytics/team/${endpoint}?${query}`);
  }

  async leaderboard(start: number, end: number): Promise<Leaderboard> {
    const teamId = await this.getTeamId();
    const me = await this.getTeamUserId();
    const day = isoDay;
    const query = new URLSearchParams({
      startDate: day(start), endDate: day(end), pageSize: '100', teamId: String(teamId), leaderboardSortBy: 'composer_lines',
    });
    type Row = {
      rank?: number; display_name?: string; user_id?: number; profile_picture_url?: string; favorite_model?: string;
      total_diff_accepts?: number; total_composer_lines_accepted?: number; total_composer_lines_suggested?: number;
      total_tab_accepts?: number; total_tab_lines_accepted?: number; total_tab_lines_suggested?: number; tab_accept_ratio?: number;
    };
    type Board = { data?: Row[]; total_users?: number };
    const r = await this.request<{ composer_leaderboard?: Board; tab_leaderboard?: Board }>('GET', `/api/v2/analytics/team/leaderboard?${query}`);
    // Emails come back too; they are dropped here and never reach the panel.
    const base = (m: Row) => ({
      rank: Number(m.rank ?? 0),
      name: m.display_name || '—',
      pictureUrl: m.profile_picture_url?.startsWith('https://') ? m.profile_picture_url : undefined,
      favoriteModel: m.favorite_model && m.favorite_model !== 'Unknown' ? m.favorite_model : undefined,
      isMe: m.user_id === me,
    });
    const byRank = (a: LeaderboardEntry, b: LeaderboardEntry) => a.rank - b.rank;
    return {
      agent: (r.composer_leaderboard?.data ?? []).map((m) => ({
        ...base(m),
        accepts: Number(m.total_diff_accepts ?? 0),
        linesAccepted: Number(m.total_composer_lines_accepted ?? 0),
        linesSuggested: Number(m.total_composer_lines_suggested ?? 0),
      })).sort(byRank),
      tab: (r.tab_leaderboard?.data ?? []).map((m) => ({
        ...base(m),
        accepts: Number(m.total_tab_accepts ?? 0),
        linesAccepted: Number(m.total_tab_lines_accepted ?? 0),
        linesSuggested: Number(m.total_tab_lines_suggested ?? 0),
        acceptRatio: m.tab_accept_ratio,
      }))
        // The API ranks both lists by the requested sort (agent lines), so rank Tab by its own metric.
        .sort((a, b) => b.accepts - a.accepts || b.linesAccepted - a.linesAccepted)
        .map((m, i) => ({ ...m, rank: i + 1 })),
      activeMembers: Number(r.composer_leaderboard?.total_users ?? r.tab_leaderboard?.total_users ?? 0),
    };
  }

  private async getTeamUserId(): Promise<number | undefined> {
    if (this.teamUserId === undefined) {
      const teamId = await this.getTeamId();
      const team = await this.post<{ userId?: number; teamMembers?: { id: number; email?: string }[] }>('/api/dashboard/team', { teamId });
      this.teamUserId = team.userId;
      this.teamUserEmail = team.teamMembers?.find((m) => m.id === team.userId)?.email;
    }
    return this.teamUserId;
  }

  private async getTeamId(): Promise<number | undefined> {
    if (this.teamId === undefined) {
      const r = await this.post<{ teams?: { id: number }[] }>('/api/dashboard/teams', {});
      this.teamId = r.teams?.[0]?.id;
    }
    return this.teamId;
  }

  private post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>('POST', endpoint, body);
  }

  private async request<T>(method: 'GET' | 'POST', endpoint: string, body?: unknown, retried = false): Promise<T> {
    const session = await this.getSession(retried);
    if (!session) throw new AuthError('No Cursor session found');
    const res = await fetch(BASE + endpoint, {
      method,
      headers: { Cookie: session.cookie, 'Content-Type': 'application/json', Origin: BASE },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      // The token may have been refreshed by Cursor since we cached it: reload once.
      if (!retried) return this.request<T>(method, endpoint, body, true);
      throw new AuthError(`Session rejected (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`${endpoint} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

// Events without an owner are kept: members only ever receive their own.
function isOwnEvent(e: UsageEventResponse, me: number | undefined): boolean {
  return me === undefined || !e.owningUser || e.owningUser === 'null' || String(e.owningUser) === String(me);
}

// YYYY-MM-DD in local time, the date format of the v2 analytics API.
export const isoDay = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');

function toEvent(e: UsageEventResponse): UsageEvent {
  const t = e.tokenUsage ?? {};
  return {
    timestamp: Number(e.timestamp),
    model: e.model || 'unknown',
    kind: e.kind,
    inputTokens: Number(t.inputTokens ?? 0),
    outputTokens: Number(t.outputTokens ?? 0),
    cacheReadTokens: Number(t.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(t.cacheWriteTokens ?? 0),
    // chargedCents includes Cursor's token fee; totalCents is the raw model cost.
    cents: Number(e.chargedCents ?? t.totalCents ?? 0),
    conversationId: e.conversationId && e.conversationId !== 'null' ? e.conversationId : undefined,
  };
}
