import { randomBytes } from 'crypto';
import { statSync } from 'fs';
import * as vscode from 'vscode';
import { Activity, RepoImpact } from './activity';
import { UsageEvent, UsageSummary, UserAnalytics } from './api';

export type PeriodKey = 'cycle' | 'week' | 'today';
const PERIOD_KEYS: PeriodKey[] = ['cycle', 'week', 'today'];

// Data shared by every period: the webview aggregates it for the selected one.
export interface CoreData {
  summary: UsageSummary;
  events: UsageEvent[];
  fetchStart: number; // events before this were not fetched
  totalEvents: number;
  truncated: boolean; // the page cap was hit, so the oldest requests are missing
  titles: Record<string, string>; // conversationId -> chat title
  activity?: Activity; // own analytics per day: agent/Tab, requests, commits, languages, cloud agents
  sections: Record<string, boolean>; // which panel sections are enabled
  order: string[]; // block order from cursorUsage.sectionOrder (normalized by the webview)
}

// Data the API only serves per period; loaded the first time that period is shown.
export interface PeriodData {
  analytics?: UserAnalytics;
  repos?: RepoImpact[];
}

export interface PanelHost {
  core(): Promise<CoreData>;
  period(period: PeriodKey, core: CoreData): Promise<PeriodData>;
  maxAgeMs(): number; // cached data older than this is fetched again
  saveOrder(order: string[]): Thenable<void>;
  openSettings(): Thenable<unknown>;
  accentColor(): string | undefined; // validated #rrggbb, or undefined to follow the theme
}

// Relative luminance and contrast ratio (WCAG 2.x).
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const darken = (hex: string, amount: number) => '#' + [1, 3, 5]
  .map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0')).join('');

// CSS variables for a custom accent. Buttons prefer white text, darkening the fill (up to 30%) until it
// reaches 4.5:1; light colors that can't get there use black text on the original color instead.
export function accentCss(color: string): string {
  let strong = color;
  for (let k = 0.05; contrast(strong, '#ffffff') < 4.5 && k <= 0.3; k += 0.05) strong = darken(color, k);
  const white = contrast(strong, '#ffffff') >= 4.5;
  return `:root{--primary:${color};--primary-strong:${white ? strong : color};--primary-hover:${color};--on-primary:${white ? '#ffffff' : '#000000'}}`;
}

export class UsagePanel {
  private static current?: UsagePanel;

  static show(extensionUri: vscode.Uri, host: PanelHost, onError: (err: unknown) => void) {
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal();
      return;
    }
    UsagePanel.current = new UsagePanel(extensionUri, host, onError);
  }

  // Settings changed: drop the cache and reload if the panel is open.
  static reloadIfOpen() {
    void UsagePanel.current?.send(undefined, true);
  }

  // The accent color changed: rebuild the page; the webview then replays the cached data.
  static restyle() {
    const panel = UsagePanel.current;
    if (panel) panel.panel.webview.html = panel.html(vscode.Uri.joinPath(panel.extensionUri, 'media'));
  }

  // The block order changed in the settings (or from the panel itself): no refetch needed.
  static setOrder(order: string[]) {
    const panel = UsagePanel.current;
    if (!panel) return;
    if (panel.core) panel.core.data.order = order;
    panel.post({ type: 'order', order });
  }

  private readonly panel: vscode.WebviewPanel;
  private core?: { data: CoreData; at: number };
  private periods = new Map<PeriodKey, PeriodData>();
  private loadingCore?: Promise<void>;
  private lastPeriod: PeriodKey = 'cycle';

  private constructor(private readonly extensionUri: vscode.Uri, private readonly host: PanelHost, private readonly onError: (err: unknown) => void) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('cursorUsage', 'Usage Panel for Cursor', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The webview is torn down while hidden (saving its renderer's memory); when shown again it
      // asks for data and gets the cached copy, without new requests while it's fresh.
      retainContextWhenHidden: false,
      localResourceRoots: [media],
    });
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => {
      UsagePanel.current = undefined;
      this.core = undefined;
      this.periods.clear();
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      const period: PeriodKey = PERIOD_KEYS.includes(msg?.period) ? msg.period : 'cycle';
      if (msg?.type === 'ready') void this.send(period, false);
      if (msg?.type === 'refresh') void this.send(period, true);
      if (msg?.type === 'period') void this.sendPeriod(period);
      if (msg?.type === 'saveOrder' && Array.isArray(msg.order)) {
        void Promise.resolve(this.host.saveOrder(msg.order.filter((id: unknown) => typeof id === 'string'))).catch(this.onError);
      }
      if (msg?.type === 'openSettings') void this.host.openSettings();
    });
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async send(period: PeriodKey | undefined, force: boolean) {
    this.lastPeriod = period ?? this.lastPeriod;
    try {
      if (force || !this.core || Date.now() - this.core.at > this.host.maxAgeMs()) {
        this.post({ type: 'loading' });
        // A refresh and a webview reload can overlap; share one load.
        this.loadingCore ??= this.host.core()
          .then((data) => {
            this.core = { data, at: Date.now() };
            this.periods.clear();
          })
          .finally(() => (this.loadingCore = undefined));
        await this.loadingCore;
      }
      this.post({ type: 'data', data: this.core!.data });
      await this.sendPeriod(this.lastPeriod);
    } catch (err) {
      this.onError(err);
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async sendPeriod(period: PeriodKey) {
    if (!this.core) return;
    this.lastPeriod = period;
    let data = this.periods.get(period);
    if (!data) {
      try {
        data = await this.host.period(period, this.core.data);
        this.periods.set(period, data);
      } catch (err) {
        this.onError(err);
        data = {};
      }
    }
    this.post({ type: 'period', period, data });
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    // The file's mtime in the URL makes the webview drop a cached copy after an update.
    const asset = (name: string) => {
      const file = vscode.Uri.joinPath(media, name);
      return webview.asWebviewUri(file).with({ query: `v=${Math.round(statSync(file.fsPath).mtimeMs)}` });
    };
    const css = asset('panel.css');
    const color = this.host.accentColor();
    const accent = color ? accentCss(color) : '';
    const js = asset('panel.js');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">${accent ? `
<style>${accent}</style>` : ''}
<title>Usage Panel for Cursor</title>
</head>
<body>
<div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
