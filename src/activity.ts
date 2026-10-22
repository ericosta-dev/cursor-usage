import { CursorApi } from './api';

// The user's own activity from the dashboard's Analytics (v2) endpoints, normalized per day so the
// panel can aggregate any period (and the previous one) without more requests.

export interface DayActivity {
  date: string; // YYYY-MM-DD
  // Agent (composer) diffs
  diffsSuggested: number;
  diffsAccepted: number;
  diffsRejected: number;
  agentLinesSuggested: number;
  agentLinesAccepted: number;
  // Tab completions
  tabSuggestions: number;
  tabAccepts: number;
  tabRejects: number;
  tabLinesSuggested: number;
  tabLinesAccepted: number;
  // Commits tracked by Cursor
  commits: number;
  commitLines: number;
  aiCommitLines: number;
  aiIdeLines: number;
  aiCliLines: number;
  aiCloudLines: number;
  agentCommitLines: number;
  tabCommitLines: number;
}

export interface ExtensionDay {
  date: string;
  extension: string;
  linesSuggested: number;
  linesAccepted: number;
  accepts: number;
  rejects: number;
}

export interface RepoImpact {
  repo: string;
  commits: number;
  linesAdded: number;
  aiLines: number;
  agentLines: number;
  tabLines: number;
}

export interface CloudAgents {
  prs: number;
  lines: number;
}

export interface Activity {
  days: DayActivity[];
  extensions: ExtensionDay[];
  cloud?: CloudAgents;
}

// Which panel sections need data; endpoints feeding only hidden sections are not called.
export interface ActivityNeeds {
  quality: boolean; // composer + tabs
  impact: boolean; // ai-commits
  languages: boolean; // top-files
  cloud: boolean; // bg/*
}

type Row = Record<string, unknown>;
type Rows = { data?: Row[] };

const num = (v: unknown) => Number(v ?? 0) || 0;

function emptyDay(date: string): DayActivity {
  return {
    date,
    diffsSuggested: 0, diffsAccepted: 0, diffsRejected: 0, agentLinesSuggested: 0, agentLinesAccepted: 0,
    tabSuggestions: 0, tabAccepts: 0, tabRejects: 0, tabLinesSuggested: 0, tabLinesAccepted: 0,
    commits: 0, commitLines: 0, aiCommitLines: 0, aiIdeLines: 0, aiCliLines: 0, aiCloudLines: 0, agentCommitLines: 0, tabCommitLines: 0,
  };
}

export async function loadActivity(
  api: CursorApi,
  start: number,
  end: number,
  needs: ActivityNeeds,
  onError: (err: unknown) => void,
): Promise<Activity> {
  // Each source is optional: one failing endpoint only hides its own section.
  const get = (endpoint: string, wanted: boolean) => (wanted
    ? api.analytics<Rows>(endpoint, start, end).catch((err) => { onError(err); return undefined; })
    : Promise.resolve(undefined));
  const [composer, tabs, files, commits, prs, loc] = await Promise.all([
    get('composer', needs.quality), get('tabs', needs.quality), get('top-files', needs.languages),
    get('ai-commits/timeseries', needs.impact), get('bg/prs', needs.cloud), get('bg/loc', needs.cloud),
  ]);

  const days = new Map<string, DayActivity>();
  const day = (date: unknown) => {
    const key = String(date).slice(0, 10);
    if (!days.has(key)) days.set(key, emptyDay(key));
    return days.get(key)!;
  };
  for (const r of composer?.data ?? []) {
    const d = day(r.event_date);
    d.diffsSuggested += num(r.total_suggested_diffs);
    d.diffsAccepted += num(r.total_accepted_diffs);
    d.diffsRejected += num(r.total_rejected_diffs);
    d.agentLinesSuggested += num(r.total_lines_suggested);
    d.agentLinesAccepted += num(r.total_lines_accepted);
  }
  for (const r of tabs?.data ?? []) {
    const d = day(r.event_date);
    d.tabSuggestions += num(r.total_suggestions);
    d.tabAccepts += num(r.total_accepts);
    d.tabRejects += num(r.total_rejects);
    d.tabLinesSuggested += num(r.total_lines_suggested);
    d.tabLinesAccepted += num(r.total_lines_accepted);
  }
  for (const r of commits?.data ?? []) {
    const d = day(r.date);
    d.commits += num(r.total_commits);
    d.commitLines += num(r.total_lines_added);
    d.aiCommitLines += num(r.ai_lines_added);
    d.aiIdeLines += num(r.ai_ide_lines_added);
    d.aiCliLines += num(r.ai_cli_lines_added);
    d.aiCloudLines += num(r.ai_cloud_lines_added);
    d.agentCommitLines += num(r.composer_lines_added);
    d.tabCommitLines += num(r.tab_lines_added);
  }

  const extensions: ExtensionDay[] = (files?.data ?? []).map((r) => ({
    date: String(r.event_date).slice(0, 10),
    extension: String(r.file_extension || '(no extension)'),
    linesSuggested: num(r.total_lines_suggested),
    linesAccepted: num(r.total_lines_accepted),
    accepts: num(r.total_accepts),
    rejects: num(r.total_rejects),
  }));


  // Cloud (background) agents: the shapes are only known empty so far, so count rows and sum
  // any "lines added" fields instead of relying on exact field names.
  const prRows = prs?.data ?? [];
  const locRows = loc?.data ?? [];
  const lines = locRows.reduce((sum, r) => sum + Object.entries(r)
    .filter(([k, v]) => /lines?_added|^loc$|lines_of_code/i.test(k) && typeof v !== 'object')
    .reduce((s, [, v]) => s + num(v), 0), 0);
  const cloud = prRows.length || lines ? { prs: prRows.length, lines } : undefined;

  return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), extensions, cloud };
}

// Commits per repository for one period (the API has no daily breakdown for this).
export async function loadRepos(api: CursorApi, start: number, end: number): Promise<RepoImpact[]> {
  const res = await api.analytics<Rows>('ai-commits/by-repo', start, end);
  return (res.data ?? []).map((r) => ({
    repo: String(r.repo_name || '—'),
    commits: num(r.total_commits),
    linesAdded: num(r.total_lines_added),
    aiLines: num(r.ai_lines_added),
    agentLines: num(r.composer_lines_added),
    tabLines: num(r.tab_lines_added),
  })).sort((a, b) => b.aiLines - a.aiLines);
}

// Totals for a closed range, used by the weekly digest.
export async function activityTotals(api: CursorApi, start: number, end: number) {
  const [composer, commits] = await Promise.all([
    api.analytics<Rows>('composer', start, end),
    api.analytics<Rows>('ai-commits/timeseries', start, end),
  ]);
  const sum = (rows: Row[] | undefined, key: string) => (rows ?? []).reduce((s, r) => s + num(r[key]), 0);
  return {
    diffsSuggested: sum(composer.data, 'total_suggested_diffs'),
    diffsAccepted: sum(composer.data, 'total_accepted_diffs'),
    commits: sum(commits.data, 'total_commits'),
    commitLines: sum(commits.data, 'total_lines_added'),
    aiCommitLines: sum(commits.data, 'ai_lines_added'),
  };
}
