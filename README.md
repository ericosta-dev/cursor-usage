# Usage Panel for Cursor

Your Cursor spend and usage in the status bar and in a panel inside the editor, without opening the dashboard in the browser.

> **Unofficial.** This extension is not affiliated with, endorsed by or supported by Cursor or Anysphere. It reads your Cursor sign-in token from Cursor's local database and sends it **only to `cursor.com`**, calling the same **undocumented** endpoints the web dashboard uses. They can change or stop working at any time, and using them may not be covered by Cursor's terms. Use it at your own risk.

- **Status bar:** cycle spend and today's spend (`$171.99 · today $26.00`). Hover for the breakdown: plan, on-demand, cycle projection and team spend limit.
- **Panel** (click the status bar, or run `Usage Panel: Open usage panel`). The **Cycle · Week · Today** switch changes the period; the week runs Monday to Sunday and "Today" shows cost per hour. The panel has:
  - spend for the period compared with the previous period at the same point (▲/▼ %);
  - projection: where you'll close the cycle (or the week) at the current pace, and whether the team spend limit runs out before the cycle ends;
  - **cost per day** (or per hour) side by side with the **cycle activity** heatmap, GitHub style (weeks as columns, Monday to Sunday as rows), colored by requests or by cost, with active days, busiest day, current streak and longest streak;
  - **You vs team:** lines applied by the agent, Tab suggestions accepted and agent requests, with your position among active members and the team average, plus cost per 100 applied lines;
  - **Code impact:** commits tracked by Cursor, share of committed lines written by AI (IDE, CLI, cloud), **cost per commit** and **cost per 100 committed lines**, and a table per repository;
  - **Agent quality:** share of agent diffs and lines accepted, share of Tab suggestions accepted (with ▲/▼ points vs the previous period) and cost per accepted diff;
  - **by model:** requests, tokens, % cache, cost per request and total cost;
  - **languages:** lines suggested and accepted per file extension;
  - **most expensive conversations**, with the chat title read from Cursor's local database;
  - **cloud agents** (PRs and lines from background agents), only when there is usage;
  - **recent requests:** every request in the period, 25 per page, with tokens and cost.
- **Customizable layout:** **Customize layout** in the panel shows ↑ ↓ on each block to reorder them. The order is saved in `cursorUsage.sectionOrder`, and **Reset order** brings back the default.
- **Weekly digest:** from Monday on, a notification with the previous week's wrap-up (spend with comparison, commits and AI share, agent acceptance). You can also open it any time with `Usage Panel: Show last week's summary`.

## Install

Published on [Open VSX](https://open-vsx.org/extension/ericosta/usage-panel-for-cursor) as `ericosta.usage-panel-for-cursor`.

**From the Extensions view:** in Cursor, open Extensions (`Cmd/Ctrl+Shift+X`), search for **Usage Panel for Cursor** (or `ericosta.usage-panel-for-cursor`) and click **Install**. Or from a terminal on your machine:

```bash
cursor --install-extension ericosta.usage-panel-for-cursor
```

**From a `.vsix` file:** Cursor's extension gallery mirrors Open VSX with a delay, so a new release can show up as *"not found"* for a while. In that case:

1. Download the `.vsix` from Open VSX: [ericosta.usage-panel-for-cursor-0.1.0.vsix](https://open-vsx.org/api/ericosta/usage-panel-for-cursor/0.1.0/file/ericosta.usage-panel-for-cursor-0.1.0.vsix) (or from the extension's page, under *Download*).
2. In Cursor: Extensions → `···` menu → **Install from VSIX…** → pick the file. Or, from the folder where you saved it:

   ```bash
   cursor --install-extension ericosta.usage-panel-for-cursor-0.1.0.vsix
   ```

3. `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

> **WSL, SSH and other remote windows:** install on your local machine, not inside the remote. The extension runs on the local side, where Cursor keeps your sign-in and its local database. Use the Extensions view or a local terminal (PowerShell/CMD on Windows) — running `cursor --install-extension` inside a WSL or SSH terminal tries to install it on the remote side and fails.

No setup needed: the extension uses the session you're already signed in with in Cursor. If something looks wrong, check `View → Output → Usage Panel for Cursor`.

## Look

The panel follows your Cursor theme, light or dark, including its accent color. To use your own accent in charts, meters, the heatmap and buttons, set `cursorUsage.accentColor` to a hex color, for example VTEX's Rebel Pink:

```json
"cursorUsage.accentColor": "#F71963"
```

Button text switches between white and black automatically: white when the button color can be darkened slightly (up to 30%) to reach 4.5:1 contrast, black for light colors.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `cursorUsage.accentColor` | theme | Accent color as `#rrggbb`; empty follows your theme |
| `cursorUsage.statusBarMetric` | `total` | What the status bar shows: `total`, `onDemand` or `planPercent` |
| `cursorUsage.statusBarShowToday` | `true` | Also show today's spend in the status bar |
| `cursorUsage.refreshIntervalMinutes` | `10` | Refresh interval (minimum 5 min) |
| `cursorUsage.sections` | all on | One checkbox per panel section (cost chart, activity heatmap, You vs team, code impact, agent quality, models, languages, conversations, cloud agents, recent requests). A section that's off isn't shown **and doesn't fetch its data** |
| `cursorUsage.sectionOrder` | default order | Order of the panel blocks; easier to change with **Customize layout** in the panel |
| `cursorUsage.alertRequestAtUsd` | `5` | Warn when a single request costs more than this (an agent stuck in a loop, a huge context…). `0` turns it off |
| `cursorUsage.alertTeamPoolPercent` | `90` | Warn once per cycle when the team goes over this % of its spend limit. `0` turns it off |
| `cursorUsage.alertPlanExhausted` | `true` | Warn once per cycle when your plan is used up and usage becomes on-demand |
| `cursorUsage.weeklyDigest` | `true` | Weekly summary of the previous week |
| `cursorUsage.alertAtUsd` | `0` | Warn once per cycle when your spend goes over this amount. `0` turns it off |

Cycle-level alerts show up once per cycle, even with several windows open. When the team goes over the configured share of its limit, the status bar also turns yellow.

## How it works

- Reads the sign-in token from Cursor's local database (`state.vscdb`) with the runtime's built-in SQLite. It reads only that record, without loading the whole file into memory, once per session, and reads it again only when the token expires or is rejected.
- Recent Cursor versions encrypt that token with the OS secrets manager (Keychain on macOS, DPAPI on Windows, Secret Service on Linux). The extension decrypts it locally the same way Cursor does. On macOS, the first time, the system asks to let `security` use "Cursor Safe Storage": click **Allow**. The key is then kept in the extension's own secret storage, so the prompt doesn't come back.
- Conversation titles come from the same local database, looked up by key. The extension never reads the conversations themselves.
- Calls the same endpoints that `cursor.com/dashboard` uses. The token is only ever sent to `cursor.com`.
- The status bar makes **two** calls per interval (cycle summary and today's requests), and all open windows share the result. While Cursor is in the background it doesn't call anything; when it gets focus again it only refreshes if the data is stale.
- The panel only fetches data while it's open, and keeps what it fetched cached for the refresh interval. Data that depends on the period (You vs team, repositories) is only fetched when you open that period.
- When the panel tab is hidden, its webview is released from memory. When you come back, it's rebuilt from the cache, with no new requests and at the same scroll position.
- Sections turned off in `cursorUsage.sections` make no requests. With everything on, opening the panel makes about 15 calls.

### Members and admins

The extension always shows the current user's own data, whether they're a member or an admin of the team:

- Requests (chart, conversations, recent requests, "today" in the status bar, alerts and weekly digest) are filtered by each request's owner. For admins the API may return the whole team's requests, but the extension drops everyone else's.
- Analytics calls always send the user's own email as a filter, like the dashboard does, so an admin never gets team numbers in place of their own.
- The only team-level numbers are the team averages and your rank in **You vs team**, which every member also sees in the dashboard.

### Dashboard analytics

Code impact, agent quality, languages and cloud agents come from the dashboard's Analytics API (`/api/v2/analytics/team/*`). The extension always asks for the current user's own activity. Daily data is fetched once when the panel opens and summed per period in the panel itself. The cloud agents section hasn't been checked against real data yet, because there was no background usage when it was written.

### Numbers

- **Cycle spend** = covered by plan + on-demand.
- **Covered by plan**: the subscription's included amount plus bonus.
- **On-demand**: usage beyond the plan, billed to the team.
- **Week and Today**: spend is the sum of the period's requests. The split between plan and on-demand is estimated from each request's type (marked ≈), because the request that uses up the plan can be split between the two. Official values exist only for the cycle.
- **Projection**: the period's daily average times the days left. The first day counts as a full day.
- **Comparison**: the previous period up to the same point. For example, Monday to Wednesday this week against Monday to Wednesday last week.
- **Cost per request**: model cost plus Cursor's token fee.

> The endpoints are undocumented and can change without notice. If the extension stops showing data, check the **Usage Panel for Cursor** output channel (`View → Output`).

## Privacy

- The token never leaves your machine except in requests to `cursor.com`, the same way the web dashboard sends it.
- Nothing is collected or sent anywhere else: there is no telemetry and no server of its own.
- On first run, the extension shows a one-time notice explaining the above.

## Development

```bash
npm install
npm run compile   # or: npm run watch
npm run package   # builds the .vsix
```

To debug, open the folder in Cursor and run **Run Extension** (F5).

### Publishing to Open VSX

Cursor installs extensions from [Open VSX](https://open-vsx.org). With an [Open VSX access token](https://open-vsx.org/user-settings/tokens):

```bash
npx ovsx create-namespace ericosta -p <token>   # once
npm run package
npx ovsx publish usage-panel-for-cursor-0.1.0.vsix -p <token>
```

Bump `version` in `package.json` before each new release.

## License

[MIT](LICENSE) © Eric Costa
