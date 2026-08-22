# Ledger — Project Context

Personal budget & income manager. Single-file React component (`Ledger.jsx`), currently at
**v6.4**, "Phase 3" complete and "Phase 4" in progress (Items 1-3 implemented so far, unverified —
see §5). This document is the onboarding brief for whichever agent picks up the rest of Phase 4, and
doubles as the project's own history.

---

## 1. Project Overview & Tech Stack

Ledger is a **strict serverless, frontend-only React SPA**. There is no backend, no API, no
server-side database, and no user accounts — it is meant to run entirely in one person's browser,
built with **Vite** as the dev/build tool.

Stack:

- **React** (function components + hooks only — `useState`, `useMemo`, `useRef`, `useEffect`).
  No class components, no external state library (no Redux/Zustand/Context providers) — all state
  lives in the top-level `Ledger` component and is threaded down via props.
- **`localStorage`** is the database. All transactions, budget data, merchant rules, spending
  categories, recurring-detection config, and dashboard layout preferences autosave to one JSON
  blob under a single key. There is no IndexedDB, no server sync, no multi-device story — the data
  lives in one browser profile unless the user exports/imports a JSON backup by hand.
- **`papaparse`** parses pasted/uploaded CSV bank statements into staged transaction rows before
  they're committed to the ledger.
- **`recharts`** renders every chart on the Dashboard (line, area, pie, bar) — no other charting
  library, no D3 direct usage.
- **`lucide-react`** supplies every icon used in the UI.
- **Theming** is done via CSS custom properties (`var(--surface-1)`, `var(--border)`, `var(--text-secondary)`,
  etc.), defined in a `THEME_CSS` string constant and injected via a `<style>{THEME_CSS}</style>`
  tag scoped under `.ledger-root[data-theme]`. Light/dark is a `data-theme` attribute on the root
  element, toggled and persisted separately from the main autosave (see `PREF_KEY` below). This
  keeps the component fully self-contained — no CSS files, no Tailwind, no build-time CSS
  dependency — so it renders correctly whether embedded in an artifact host or a plain Vite app.
- A second injected style block, `PRINT_CSS`, handles `@media print` styling for the "Export
  Summary → Print/Save PDF" feature (see §2 and the v6.0/v6.1 history below).

**Non-goals, on purpose:** no backend, no auth, no multi-user support, no mobile app wrapper. If
Phase 4 or later introduces any of these, it's a deliberate architecture change, not an oversight —
flag it explicitly rather than assuming it fits the existing patterns below.

**Update, v6.5:** "no cloud sync" was on this list through v6.4. Phase 4 Item 4 deliberately lifts
it — Cloud Sync (Settings tab) syncs an encrypted copy of the full `STORAGE_KEY` payload to the
person's own Google Drive AppData folder. This was a discussed, explicit departure, not drift, and
it's still consistent with every other non-goal above: there's still no backend this project runs
or controls (every request goes straight from the browser to Google's own OAuth/Drive APIs — see
§3's Cloud Sync Payload subsection), still no auth for *this app* (Google's own OAuth login is the
only identity involved, and it gates nothing but this one feature), and it's opt-in — a person who
never enters a Google Client ID never triggers a network call, and every other feature keeps working
exactly as before, entirely offline, with or without it configured.

**Update, v6.6:** Cloud Sync is now dual-provider — a provider toggle (Google Drive / Dropbox) inside
the same Settings > Cloud Sync panel. Everything the v6.5 note above says still holds per-provider:
Dropbox calls go straight from the browser to Dropbox's own OAuth/REST APIs, no backend of this
project's own is involved, and it's equally opt-in (a person who never enters a Dropbox App Key never
triggers a Dropbox network call, independent of whether Google Drive is configured). The two
providers share one encryption engine and one plaintext payload shape — see §3's Cloud Sync Payload
subsection, now split into a shared part and a per-provider transport part.

**Update, v6.7:** The app is now an installable PWA (`vite-plugin-pwa`, build-time only — see §3's
PWA & Offline Caching subsection). This is a pure build/deploy-layer addition, not an architecture
change: the service worker only caches the static app shell this SPA already ships (JS/CSS/HTML/
icons), `localStorage` remains the only data store, and every Cloud Sync network call (§3) is
explicitly configured `NetworkOnly` so the offline/cache layer can never intercept, delay, or stale-
serve a sync request. A person who never installs the app or never goes offline sees no behavior
change at all.

**Update, v6.8:** Two independent additions, neither of which touches `STORAGE_KEY`. First, a Manual
Single-Transaction Form (Log tab) as a mobile-optimized alternative to the bulk CSV/paste flow, behind
an Ingestion Mode Selector — the bulk parser itself is untouched. Second, an optional local App Lock
(Settings tab): a PBKDF2-hashed backup PIN plus an optional WebAuthn platform-authenticator (Face/
Fingerprint/Windows Hello) biometric unlock, gating a full-screen overlay shown on open/resume. Like
Cloud Sync, App Lock is an explicit, discussed exception to "no auth for this app" from §1's non-goals —
but it's a *local* device lock, not an account system: there's still no server, still no user accounts,
and the lock protects only this browser's live view of the app, not a JSON backup or a cloud sync copy.
See §3's Ingestion Mode & Manual Entry and App Lock subsections for the full breakdown, including why
the biometric check is meaningful without a server to verify its signature against.

**Update, v6.9:** A built-in Master Seed Auto-Categorization Dataset — ~825 common North American
merchant substrings, covering Groceries, Dining, Transport, Subscriptions, Telecom, Utilities, Hardware,
Apparel & Gear, INCOME: Benefits, INCOME: Employment, and both TRANSFER categories — is now consulted as
a second tier inside `categorize()`, only once a person's own `lookup` rules have all missed. It changes
no data shape (`DEFAULT_LOOKUP`/`DEFAULT_LOOKUP_COMPILED` are module-scope constants, never persisted,
never part of `STORAGE_KEY` or JSON export/import, never shown in Settings > Merchant rules) and adds
zero network calls — this is a hardcoded, build-time-only dataset, not a lookup service. Two new default
spending categories, "Utilities" and "Hardware", were added (with a migration ensuring every existing
browser's saved category list picks them up automatically) since the dataset's Utilities/Hardware
merchant entries needed somewhere real to land. See §3's Master Seed Auto-Categorization Dataset
subsection for the full breakdown.

---

## 2. Core Architecture & Logic Constraints

### The no-backend rule

Every feature must be implementable as pure client-side JS + `localStorage`. There is no server to
validate against, no network calls (aside from nothing — the app makes zero fetch/XHR calls in
normal operation), and no async data source. All "persistence" is synchronous `JSON.stringify` /
`JSON.parse` against `window.localStorage`. Any new feature should ask "does this need a backend?"
— if yes, that's a Phase 4+ conversation to have explicitly with the user, not something to
introduce quietly.

### The `STORAGE_KEY` autosave pattern

```js
const STORAGE_KEY = "ledger:autosave:v1";
```

All persisted state lives under this **one** localStorage key, as a single JSON object, in the
same shape used by manual JSON export/import (`exportData` / `importData`). Currently the payload
shape is:

```js
{ transactions, lookup, spendingCategories, budget, recurringConfig, dashboardLayout }
```

Reading back in happens through `readPersistedStore()`, which:

1. Runs once per page load and caches its result at module scope (`_persistedCache`), so the
   several `useState(() => persisted.X || DEFAULT_X)` lazy initializers across the component don't
   each independently re-parse the same JSON blob.
2. Is wrapped end-to-end in `try/catch` — `localStorage` access itself can throw (private/blocked
   browsing contexts), not just `JSON.parse` — so any failure anywhere in this function silently
   falls back to empty/default state rather than crashing the app.
3. Validates **every** section independently with a dedicated `isValidX` predicate before trusting
   it (`isValidTransaction`, `isValidLookupEntry`, `isValidBudget`, `isValidRecurringConfig`,
   `isValidDashboardLayout`). A malformed or missing section just falls back to its own default —
   it never takes down the other sections.
4. Runs the relevant migration function on every section that has one (`migrateWealthsimpleTransactions`,
   `migrateWealthsimpleLookup`, `ensureWealthsimpleCategory`, `migrateBudget`, `normalizeDashboardLayout`)
   so that old data shapes are transparently upgraded on load.

A separate `useEffect` (the autosave effect) re-serializes and writes this same payload back to
`STORAGE_KEY` on every relevant state change, debounced/guarded by a `suppressDirtyCheck` ref so
that state updates made *by* an import don't immediately re-trigger a redundant "dirty" write.

Theme preference (light/dark) is intentionally **not** part of this payload — it's stored under a
separate `PREF_KEY`, since it's a per-browser display preference, not financial data, and shouldn't
be bundled into JSON backups the user might share or restore across machines with different
preferences.

### `computeNextId` — safe ID generation under deletion

```js
function computeNextId(transactions) {
  let max = -1;
  for (const t of transactions) { if (Number.isFinite(t.id) && t.id > max) max = t.id; }
  return max + 1;
}
```

IDs are **never** derived from `array.length`. Once row deletion exists (transactions, committed
costs, net worth items, income streams, target scenarios), `length` and `max id` diverge the
moment something in the middle of the array is removed — deriving the next id from length would
then hand out an id that already exists, silently colliding with a surviving row. `computeNextId`
instead does a linear scan for the true maximum id and returns `max + 1`, which is correct
regardless of gaps left by deletions. It's written as an explicit loop rather than
`Math.max(...ids)` specifically so it can't blow the call stack on a large CSV import.

This exact pattern is reused for every id-bearing list in the app: `nextId` (transactions),
`nextCostId` (committed costs), `nextNetWorthId`, `nextIncomeStreamId`, `nextTargetId` (target
scenarios). Any new list of user-addable/removable rows should follow the same pattern — a `useRef`
initialized via `computeNextId(list)`, incremented on add, never reset on delete.

### `migrateBudget` — safe forward migration of legacy data shapes

The budget object has evolved several times (flat fields → dynamic lists) across versions. Rather
than one big gated function, `migrateBudget` does **N independent, idempotent migrations**, one per
field family, each only running if its *target* shape isn't already present:

```js
function migrateBudget(b) {
  const { gym, carInsurance, mealPrep, subs, phone,
          portfolio, osap, incoming, aafcMonthly, reserveLow, reserveHigh,
          targetFloor, targetMid, targetStretch, ...migrated } = b;

  if (Array.isArray(b.committedCosts)) { migrated.committedCosts = b.committedCosts; }
  else { /* build committedCosts[] from gym/carInsurance/mealPrep/subs/phone */ }

  if (Array.isArray(b.netWorthItems)) { migrated.netWorthItems = b.netWorthItems; }
  else { /* build netWorthItems[] from portfolio/incoming/osap */ }

  if (Array.isArray(b.incomeStreams)) { migrated.incomeStreams = b.incomeStreams; }
  else { /* build incomeStreams[] from aafcMonthly/reserveLow/reserveHigh */ }

  if (Array.isArray(b.targetScenarios)) { migrated.targetScenarios = b.targetScenarios; }
  else { /* build targetScenarios[] from targetFloor/targetMid/targetStretch */ }

  return migrated;
}
```

Why independent blocks rather than one early-return gate: a real backup might be a hybrid — e.g. a
v3 budget that already has `netWorthItems` (migrated once already) but is being re-loaded alongside
a hand-edited `targetFloor` the user never got a chance to convert. Each block asks "do *I* already
have my modern shape?" rather than "is the whole object modern?", so migration is safe to run
unconditionally on **every** load (autosave and JSON import alike), on data from any historical
version, and is a guaranteed no-op if run twice on already-current data.

**This same pattern — small independent idempotent per-field migrations, run on both load paths —
is the template for any future data-shape change.** The newer `normalizeDashboardLayout` (v6.1)
follows the same spirit for a different problem shape (an ordered array rather than a flat object):
it drops unknown/stale section ids, dedups (first occurrence wins), and backfills any known section
missing from the saved array — so a dashboard layout saved by an older or newer version of the app
always merges safely.

### Other constraints worth preserving into Phase 4

- **Strict-validate-then-apply-as-one-batch** for JSON import (`importData`): every section's shape
  is validated *before any state setter runs at all*. This guarantees a backup file with one
  malformed section can never partially overwrite good data in an unrelated section. Each section
  is validated, then applied guarded by its own `hasX` boolean.
- **"Excluded set" vs. "ordered array" filter patterns**: the Dashboard's category multi-select
  filter tracks what's *excluded* (so newly-added categories are included by default with zero sync
  logic needed); `dashboardLayout` tracks an *ordered array* of `{id, visible}` instead, because
  order is meaningful there in a way it isn't for the category filter. Pick the pattern that matches
  whether order matters.
- **Popover/dropdown UI pattern** (reused 3×: `CategoryFilterMenu`, `ExportSummaryMenu`,
  `DashboardLayoutMenu`): `useState(open)` + `useRef(boxRef)` + a `useEffect` registering a
  `document.addEventListener("mousedown", onDocClick)` that closes the popover on outside click.
  Reuse this rather than inventing a new popover mechanism.
- **`confirm()` for consequential actions**: category removal, transaction deletion, and the bulk
  "update merchant lookup rules?" prompt all use the native `window.confirm()` dialog rather than a
  custom modal — this has been a deliberate simplicity choice throughout, not an oversight.
- **Print stylesheet**: `.ledger-no-print` is reserved *only* for genuine app chrome (header, tab
  nav, storage-warning banner, the filter-bar/customize-layout/export controls row) that should
  never print regardless of dashboard layout settings. As of v6.1, which Dashboard *sections* print
  is governed entirely by `dashboardLayout`'s `visible` flags, since a hidden section isn't just
  CSS-hidden — it's not rendered into the DOM at all, so it's automatically excluded from print too.
  Don't reintroduce a parallel hardcoded print-exclusion list for dashboard sections.

---

## 3. Data Schema

All of the shapes below are validated by an `isValidX` predicate in the source and, where
applicable, upgraded by a migration function on every load. Field names are exact.

### Transaction

```js
{
  id: number,          // via computeNextId — unique, never reused, gaps OK after deletion
  date: string,         // "YYYY-MM-DD", validated by isValidDateString
  description: string,  // raw statement text (may be blank if merchant is present)
  merchant: string,     // cleaned/short merchant name (may be blank if description is present)
  amount: number,       // signed: negative = spend, positive = income/credit
  category: string | null,  // null = uncategorized ("Pending review" / "REVIEW: Ambiguous")
  splitParentId?: number,   // present only on a "split child" row — see Transaction Splitting below
}
```

Validated by `isValidTransaction`: requires a valid date, *either* `merchant` or `description` as a
string, a finite `amount`, and `category` that's either `null`/`undefined` or a string.
`splitParentId` is optional/additive — old data simply won't have it.

#### Transaction Splitting (v6.2+)

Splitting a transaction (Log tab, "Split" button) divides its amount across two or more categories.
There is no separate "split line item" shape — a split **replaces** the one original row with N
ordinary transaction rows (same `date`/`merchant`/`description`, one `category` and partial `amount`
each), each tagged with `splitParentId` set to the original transaction's `id`. That id is retired
(the original row is removed) but never reused, since `nextId`/`computeNextId` only ever hand out
values larger than any id seen so far — so `splitParentId` stays a stable, collision-free way to find
every sibling later, even though no row with that `id` still exists. `mergeSplitGroup` un-splits by
collecting every row sharing a `splitParentId`, summing their amounts back into one row (category
reset to `null`, since the point of a split was dividing across more than one), and dropping the old
`splitParentId` link. The save path enforces — both in the row editor and again at the point of
actually writing state — that every part has a category and the parts sum to *exactly* the original
amount, compared in whole cents rather than as floats to avoid binary rounding false negatives.

Deliberately **not** modeled as one parent row plus attached split-lines: every dashboard chart,
filter, and total already sums plain transactions by category/date/amount, so expanding a split into
ordinary rows means none of that aggregation code needs to know splits exist — a split row is just a
transaction, and every total, chart, filter, and CSV/print export is correct by construction with zero
split-specific logic. The one known soft edge: `detectRecurring` groups by merchant, so several same-
day split children of one recurring charge add same-day/zero-gap entries into that merchant's interval
average — a pre-existing consequence of grouping by merchant alone, not something splitting uniquely
breaks (two genuinely separate same-day purchases at one merchant would do the same).

Categories are one of:
- A **system category** (`SYSTEM_CATEGORIES` — fixed, not user-editable, drives core math):
  `"TRANSFER: Credit Card Payment"`, `"TRANSFER: Internal/Other"`, `"INCOME: Employment"`,
  `"INCOME: Benefits"`, `"INCOME: Reimbursement"`, `"INCOME: Resale"`, `"EXCLUDE: Failed Transfer"`,
  `"REVIEW: Ambiguous"`.
- A **user-editable spending category** — see `spendingCategories` below. As of v4.1, `"Investing"`
  is a normal spending category (formerly the system category `"TRANSFER: Wealthsimple"`, migrated
  forward by `migrateWealthsimpleTransactions`/`migrateWealthsimpleLookup`/`ensureWealthsimpleCategory`).

### Merchant Lookup

```js
lookup: Array<[matchKey: string, category: string]>
```

An array of 2-tuples, not a plain object — order matters. `sortLookup()` keeps entries sorted by
**descending key length**, so a more specific rule (e.g. `"amazon.ca prime"`) always wins over a
shorter, more general one (`"amazon.ca"`) without the user having to manually reorder rules.
Validated per-entry by `isValidLookupEntry` (`Array.isArray(e) && e.length === 2 &&` both elements
strings). New/corrected rules are **upserted** (a re-correction replaces the prior entry for the
same normalized key), never duplicated.

#### Regex Rules (v6.3+)

A key wrapped in slashes with optional trailing flags — e.g. `"/^uber\\s*eats/i"` — is a **regex
rule** instead of a plain substring, detected by shape alone (`REGEX_RULE_SHAPE`), not a stored flag.
This means the `[key, category]` tuple shape above didn't need to change, and every pre-v6.3 key
(which never starts with `/`) is automatically and correctly treated as plain text with no migration
needed.

- `categorize()` checks each key's shape and, for a regex-shaped one, compiles it (`parseRegexRule`)
  and tests it against the **raw** merchant string — not the normalized/lowercased text a plain
  substring key matches against — so the rule's own flags (e.g. including or omitting `/i`) fully
  control case sensitivity, the way a hand-written regex normally would. Plain keys still match the
  old way: case-insensitive substring, via both sides passing through `normalize()`.
- `parseRegexRule` wraps `new RegExp(...)` in `try/catch`: invalid pattern syntax (unbalanced
  parens/brackets, a bad flag) returns `null` rather than throwing, and a `null` result is treated
  everywhere as "this rule never matches" — never a crash, never a fallback to a nonsensical literal
  substring search on the `/pattern/flags` text itself.
- `addLookupRule` stores a regex-shaped key **exactly as typed**, skipping `normalize()` for it —
  normalize's lowercasing, whitespace-collapsing, and `-`→`" "` replacement would otherwise corrupt a
  pattern (e.g. `-` inside a character class like `[a-z]` turning into a literal space). It also
  rejects an unparseable pattern at save time with an alert, rather than silently persisting a rule
  that can never match. Plain keys are unaffected — still normalized as before.
- `isValidLookupEntry` is unchanged: a regex-shaped key is still just a string, so it's already valid
  shape-wise. It deliberately does **not** additionally require the pattern to compile — an invalid
  saved regex is "a rule that never matches," not corrupt data to reject on load, matching this app's
  general preference for safe fallback over refusing to load.
- Settings > Merchant rules has a "Test regex rule" box (`RegexRuleTester`) that runs a candidate
  `/pattern/flags` string against a sample merchant string using the same `isRegexRuleKey`/
  `parseRegexRule` functions `categorize()` and `addLookupRule` use, live-showing whether it matches
  and any capture groups — so what's previewed there is exactly how the rule behaves once saved, not
  a separate approximation of it.

### Spending Categories

```js
spendingCategories: string[]
```

Freely user-editable list of spending category names (add/rename/remove from Settings). Seeded by
default from `DEFAULT_SPENDING_CATEGORIES`. `ensureWealthsimpleCategory` guarantees `"Investing"` is
always present after migration.

### Budget object

```js
budget: {
  tithe: number,              // fraction, e.g. 0.10
  discretionary: number,
  monthsRemaining: number,
  committedCosts: Array<{ id: number, label: string, amount: number }>,
  netWorthItems: Array<{ id: number, label: string, amount: number, type: "asset" | "liability" }>,
  incomeStreams: Array<{ id: number, label: string, low: number, high: number }>,
  targetScenarios: Array<{ id: number, label: string, amount: number }>,
}
```

- `committedCosts` — recurring fixed expenses (gym, phone, subscriptions, etc.), dynamic
  add/rename/edit/delete list. Legacy flat fields folded in: `gym`, `carInsurance`, `mealPrep`,
  `subs`, `phone`.
- `netWorthItems` — each tagged `"asset"` or `"liability"`, so net position is computed generically
  (sum of assets minus sum of liabilities) rather than via hardcoded field names. Legacy flat fields
  folded in: `portfolio`, `incoming` (both assets), `osap` (liability).
- `incomeStreams` — each carries a `low`/`high` monthly range rather than a single number, so a
  guaranteed fixed source (`low === high`) and a variable source (e.g. reservist pay) share one
  shape. Legacy flat fields folded in: `aafcMonthly`, `reserveLow`, `reserveHigh`.
- `targetScenarios` — dynamic replacement (v5.0+) for the old fixed Floor/Mid/Stretch trio. Legacy
  flat fields folded in: `targetFloor`, `targetMid`, `targetStretch`.

Validated by `isValidBudget`: numeric top-level keys checked against `BUDGET_NUMERIC_KEYS`, each
array field checked (if present) against its item-level `isValidX` predicate.

`netWorthItems` and `targetScenarios` are the only two fields the v6.4 Goal Runway & Projections
section reads — it adds no new persisted fields of its own (see below).

#### Goal Runway & Projections (v6.4+)

New Budget-tab section, purely derived at render time — **nothing new is added to the persisted
`budget` object or the `STORAGE_KEY` payload.** Every number it shows is recomputed from
`transactions` and the existing `netWorthItems`/`targetScenarios` arrays on every render:

- **Historical monthly surplus** (`surplusHistory`, `avgSurplus3mo`, `avgSurplus6mo`): built from the
  Dashboard's existing full-history `monthlyTrend` (income − spend per calendar month present in the
  Log), not from `dashboardTxns` — so this section's numbers can't quietly change if the Dashboard
  tab's own period/category filter happens to be narrowed elsewhere. The 3-month and 6-month averages
  are each computed over however many recent months actually exist (0 if there's no history yet)
  rather than requiring a full window before showing anything.
- **Current net position**: reuses the same `netPos` (sum of `netWorthItems` typed `"asset"` minus
  those typed `"liability"`) the Net worth items card above it already computes — not a second,
  independently-derived number.
- **Milestone projection** (`estimateMilestone`, a pure module-level function): given a gap
  (`target.amount - netPos`) and a monthly rate, returns one of three statuses rather than ever
  computing an infinite or nonsensical date — `"reached"` (gap already ≤ 0), `"deficit"` (rate ≤ 0
  and gap > 0 — rendered as "Deficit / No projection available"), or `"projected"` (a concrete
  month/year, via `Math.ceil(gap / rate)` months forward from "now"). The runway table computes and
  shows both the 3-month-pace and 6-month-pace milestone for every target scenario side by side.
- **Projection chart**: a `recharts` `AreaChart` (`runwayChartData`) plotting current net position at
  month 0, then `netPos + selectedRate * monthIndex` linearly forward for `RUNWAY_PROJECTION_MONTHS`
  (24) months — a `<select>` next to the section header picks whether the 3-month or 6-month average
  drives this trajectory and the chart's `ReferenceLine`s mark each target scenario's amount. A
  negative or zero rate still draws a perfectly valid flat/declining curve here (a linear projection
  never breaks or goes infinite) — only the milestone *dates* need the explicit deficit guard above.

Because none of this is persisted, there was nothing to add to `isValidBudget`, `migrateBudget`, or
JSON export/import — a JSON backup restored into an older app version simply won't show this section,
and restoring it back into v6.4+ recomputes everything fresh from whatever `transactions`/
`netWorthItems`/`targetScenarios` the backup carried.

### Recurring-Detection Config (v6.0+)

```js
recurringConfig: {
  minOccurrences: number,   // default 3
  biweeklyMin: number,      // default 10 (days)
  biweeklyMax: number,      // default 18
  monthlyMin: number,       // default 19
  monthlyMax: number,       // default 35
}
```

Merged over `DEFAULT_RECURRING_CONFIG` at use time; `biweekly`/`monthly` are checked as two fully
independent windows (not one merged range split by a midpoint), so narrowing one window never
silently affects the other.

### Dashboard Layout (v6.1+)

```js
dashboardLayout: Array<{ id: string, visible: boolean }>
```

One entry per known dashboard section id, in display order. Known ids (`DASHBOARD_SECTION_IDS`):
`summaryCards`, `trendLine`, `cumulativeNet`, `spendSharePie`, `incomeBar`, `categoryBar`,
`recurringBills`. `normalizeDashboardLayout` drops unknown/stale ids, dedups (first wins), and
appends any known section missing from the saved array as visible — so old, new, or hand-edited
layout arrays always merge safely to exactly the 7 known sections.

### Staging rows (transient, not persisted)

CSV/paste import produces `staging` rows (not part of the persisted payload) shaped like a
transaction plus a `suggested` category field (from lookup match) and the user's chosen `category`;
`commitStaging()` converts each into a real transaction (assigning a fresh `id` via `nextId`) and
upserts any manual correction into `lookup`.

### Cloud Sync (v6.5+; dual-provider v6.6+)

Optional, off by default. A provider toggle (`cloudProvider`, `"google" | "dropbox"`) picks which
destination Sync Now / Pull from Cloud target; both share one encryption engine and one plaintext
payload shape (below), and differ only in transport — how the encrypted envelope gets moved.

**Persisted config** — small, deliberately **separate** localStorage keys per provider, same pattern
as `THEME_KEY`: none of this is part of `STORAGE_KEY` or JSON export/import, since none of it is
financial data.

```js
"ledger:cloudsync:provider:v1"                // string — "google" | "dropbox", which tab is showing
"ledger:cloudsync:clientid:v1"                // string — the person's own Google OAuth Client ID
"ledger:cloudsync:lastsynced:v1"              // string — ISO timestamp of the last successful Google sync/pull
"ledger:cloudsync:dropbox:appkey:v1"          // string — the person's own Dropbox App Key
"ledger:cloudsync:dropbox:refreshtoken:v1"    // string — Dropbox OAuth refresh token (see below)
"ledger:cloudsync:dropbox:lastsynced:v1"      // string — ISO timestamp of the last successful Dropbox sync/pull
```

The encryption passphrase (`cloudPassphrase`) is **always memory-only** for both providers —
reconnecting/re-entering it each session is the deliberate cost of a genuine zero-knowledge design,
not an oversight to fix later. The two providers' *auth* credentials differ in persistence, though,
for a structural reason rather than an inconsistency: Google's access token (`cloudAccessToken`,
`{ token, expiresAt }`) is memory-only because Google Identity Services can silently re-mint it
in-page once the scope is granted, with no navigation required — so there's nothing worth persisting.
Dropbox's PKCE flow has no equivalent in-page mechanism; it's a genuine full-page redirect to
dropbox.com and back (see `startDropboxAuth`/the redirect-handling `useEffect` in `Ledger()`), so
without persisting *something*, every single sync after the first would force another full-page
round trip. The Dropbox **refresh token** is persisted for exactly this reason — the Dropbox access
token itself is still memory-only and short-lived, minted from the refresh token on demand
(`getDropboxAccessToken`) with no redirect needed. Disconnect clears the persisted refresh token
(the part that actually matters for "can this browser still authenticate") and best-effort revokes it
with Dropbox if a live access token happens to be in memory.

**What actually gets uploaded** — one file, `ledger-vault.enc`, whose location is provider-specific:
strictly inside the hidden Google Drive `appDataFolder` (invisible in the person's normal Drive UI,
and the only place the `drive.appdata`-scoped OAuth token can even see), or at `/ledger-vault.enc`
inside the Dropbox app's own app folder (invisible in the person's normal Dropbox UI — enforced by
that Dropbox app being registered with "App folder" access in the Dropbox App Console, a one-time
setup step on Dropbox's side this code can't itself enforce, the same way the Google Cloud OAuth
client is the person's own one-time setup). Either way the file's content is one JSON envelope, not
the raw ledger JSON:

```js
{
  v: 1,                        // envelope format version
  kdf: "PBKDF2-SHA256",
  iterations: number,          // 100000 — travels with the file so a future iteration-count bump
                                // can still decrypt an older backup
  salt: string,                 // base64, 16 random bytes, fresh every encryption
  iv: string,                   // base64, 12 random bytes, fresh every encryption
  ciphertext: string,            // base64 AES-GCM ciphertext
}
```

The plaintext AES-GCM encrypts, before it's ever touched by `fetch`, is exactly the same shape
`exportData`/`importData` already use — `{ transactions, lookup, spendingCategories, budget,
recurringConfig, dashboardLayout, exportedAt }` — so Pull from Cloud can reuse `importData`'s exact
per-section `isValidX` validators and "validate everything, then apply as one atomic batch" rule
(see §2's "Strict-validate-then-apply-as-one-batch" note), unchanged and unduplicated regardless of
which provider the envelope came from. A wrong passphrase or a corrupted file fails at the AES-GCM
decrypt step itself (an authentication-tag mismatch), caught and alerted safely *before* any
validation or state update runs — local data is provably untouched either way, matching this app's
general "safe fallback over silent corruption" posture everywhere else.

Key derivation is PBKDF2 (SHA-256, 100,000 iterations) straight off `window.crypto.subtle` — no third-
party crypto library. `salt` and `iv` are regenerated on every single encryption (every Sync Now), so
two uploads under the same passphrase never share key material. There is deliberately no passphrase
recovery mechanism anywhere in this design: losing it means the cloud backup is permanently
undecryptable, by anyone, including either provider.

**Dropbox transport specifics (v6.6):** OAuth 2.0 with PKCE (`generatePkceVerifier`/
`sha256Base64Url`/`startDropboxAuth`), scope `files.content.write files.content.read`,
`token_access_type=offline` to receive the refresh token discussed above. The PKCE `code_verifier`
and anti-CSRF `state` are held in **`sessionStorage`** (not `localStorage`) under
`ledger:cloudsync:dropbox:verifier`/`ledger:cloudsync:dropbox:state` — they only need to survive the
single redirect round-trip in the same tab, and are deleted the instant that round-trip completes
(success or failure). Upload/download use `mode: "overwrite"` against the stable path
`/ledger-vault.enc` (`dropboxUploadVault`/`dropboxDownloadVault`) rather than Drive's find-by-name-
then-create-or-patch-by-id dance, since Dropbox paths are already stable names. A missing vault file
downloads as Dropbox's own 409 "not found" response, handled identically to Drive's "no file found
yet" case. Because connecting to Dropbox reloads the whole page, `connectDropbox` warns (`confirm()`)
before starting the redirect if there are uncommitted staged import rows (`staging`, transient and
never persisted — see the Staging rows subsection above), since a redirect would otherwise silently
lose them.

### PWA & Offline Caching (v6.7+)

The app is built as an installable Progressive Web App via `vite-plugin-pwa` (`generateSW` mode —
Workbox config lives entirely in `vite.config.js`, not a hand-written service worker file). This is
strictly a build-output concern: nothing about it is persisted state, nothing about it is part of
`STORAGE_KEY`, and it has no `isValidX`/migration surface, so it isn't threaded through §2's rules the
way a data-shape change would be.

- **Manifest** (`manifest.webmanifest`, generated at build time from the `manifest` block in
  `vite.config.js`): name "Ledger Personal Finance", short name "Ledger", `theme_color` and
  `background_color` both `#0f172a`, `display: "standalone"`, `orientation: "portrait-primary"`.
  Four icon entries — `icons/pwa-192x192.png`, `icons/pwa-512x512.png`,
  `icons/pwa-512x512-maskable.png` (`purpose: "maskable"`, generous ~25% safe-zone padding so the
  glyph survives any OS mask shape), and `icons/icon.svg` (`purpose: "any"`, vector fallback for
  browsers that prefer it over the PNG raster set). All four PNGs plus `favicon.ico` and
  `apple-touch-icon.png` were generated by a one-off Node script (not part of the build pipeline —
  no ImageMagick/sharp/canvas dependency was available, so it hand-rolls a minimal PNG encoder off
  `node:zlib` and a minimal PNG-in-ICO wrapper) rendering a simple three-bar "trend" glyph in
  `#a78bfa` on the `#0f172a` brand navy; regenerate by re-running that script if the glyph ever needs
  to change; nothing else in the build depends on how the icon pixels were produced.
- **Registration**: `registerType: "autoUpdate"` — `injectRegister: "auto"` (the plugin default) adds
  the registration `<script>` and the manifest `<link>` to `index.html` at build time with no
  `main.jsx` changes needed; a new deployed version's service worker activates and takes over on the
  next load automatically, no "update available" prompt to wire up.
- **`includeAssets`**: `favicon.ico`, `robots.txt`, `apple-touch-icon.png` — static files outside the
  normal Vite asset graph (nothing in JS imports them) that still need to ship in the precache
  manifest so they're available offline from the first load.
- **Caching strategy** (`workbox` block in `vite.config.js`): `globPatterns` precaches every built
  JS/CSS/HTML/icon/font file at install time — this is what makes the app open instantly offline on
  mobile, since the entire app shell is already in the Cache Storage before the person ever goes
  offline. `runtimeCaching` adds two backstops on top of the precache list: a `CacheFirst` rule for
  any runtime `script`/`style` request and a separate `CacheFirst` rule for `font` requests (30-day
  and 365-day expiry respectively) — belt-and-suspenders for anything fetched at runtime rather than
  bundled, though this app currently ships zero external fonts (system font stack only, see
  `--font-sans`/`--font-mono` in `THEME_CSS`), so today that rule is dormant future-proofing, not
  presently exercised.
- **Cloud Sync bypass — `NetworkOnly`, deliberately**: two `runtimeCaching` entries match by
  `url.hostname` and force `NetworkOnly` for every host §3's Cloud Sync subsection talks to —
  `accounts.google.com` and `www.googleapis.com` (Google Identity token issuance + Drive REST) on one
  entry, `api.dropboxapi.com` / `content.dropboxapi.com` / `www.dropbox.com` (Dropbox OAuth + Files
  API + the PKCE redirect) on the other. A cached "success" response from any of these would silently
  desync or corrupt the remote encrypted vault, so these must always hit the live network — offline,
  they correctly fail loud (the existing fetch `catch` paths in `syncNowToCloud`/`pullFromCloud`
  surface that as the same Error status Cloud Sync already shows for a network failure today) rather
  than ever appearing to succeed from a stale cache.
- **Mobile touch & viewport polish**: a `@media (max-width: 780px), (pointer: coarse)` block appended
  to `THEME_CSS` (scoped deliberately — the dense desktop/mouse layout is untouched outside this
  query) raises every button, tab, and table cell to a 44px minimum hit target (the WCAG 2.5.5 /
  Apple HIG / Material baseline for a reliably tappable control) without changing any component's
  markup. Separately, two tables that were missing their `overflowX: "auto"` wrapper (Dashboard's
  "Recurring bills detected" card, Settings' merchant lookup table) were fixed so a wide table scrolls
  within its own card on a narrow screen instead of clipping or forcing the whole page to scroll
  sideways — every other table in the app already had this wrapper (a pre-existing, consistently
  applied pattern this just extended to the two that had drifted from it). A handful of budget-editor
  rows and the split-transaction editor that lay out multiple fixed-width inputs in one unwrapped flex
  row (`incomeStreams`, `committedCosts`, `netWorthItems`, `SplitEditor`, the "add merchant rule" row)
  gained `flexWrap: "wrap"` (plus a small `minWidth` on the flexible label input) so those rows drop to
  multiple lines on a narrow screen instead of overflowing it.
- **Viewport meta / `index.html`**: `viewport-fit=cover` added to the existing viewport meta (safe-area
  support behind a notch/home-indicator), plus `theme-color`, `apple-touch-icon`, and the standalone-
  display meta tags (`mobile-web-app-capable`, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style`) — these are hand-written in `index.html` since
  `vite-plugin-pwa` injects the manifest link and SW registration script but not these tags.
- **What this doesn't change**: still no backend (§1's non-goals list), still no network calls in
  normal operation beyond the ones that already existed for Cloud Sync (§3's Cloud Sync subsection) —
  the service worker only ever serves this app's own already-downloaded static files back to itself,
  never proxies or intercepts a third-party API call. Installability and offline app-shell loading are
  the only new capabilities; there is still no offline queueing, no background sync, and no push
  notifications.
- Checked by build only so far (`npm run build` produces a clean `dist/sw.js` +
  `dist/manifest.webmanifest` with the expected precache/runtime-caching entries, verified by
  inspecting the built service worker directly) — not yet exercised as an actual installed PWA in a
  real mobile browser (Add to Home Screen, airplane-mode reload, Lighthouse PWA audit), same
  "build/lint-checked, not live-verified" caveat every other unverified Phase 4 item in §5 carries.

### Ingestion Mode & Manual Entry (v6.8+)

The Log tab's "Add a new transaction" card now offers two entry paths behind a segmented toggle
(`ingestionMode`, `"manual" | "bulk"`) sitting above the card's body:

- **Persistence**: a per-browser UI preference, same non-financial-data reasoning as `THEME_KEY` —
  `"ledger:ingestionmode:v1"`, never part of `STORAGE_KEY` or JSON export/import. A saved choice always
  wins; with none saved yet, the `useState` lazy initializer defaults to `"manual"` when
  `window.innerWidth < 780` at first mount (the same 780px breakpoint the v6.7 mobile touch CSS media
  query already uses) and `"bulk"` otherwise. This is a one-time default, not a live resize listener —
  rotating a tablet mid-session doesn't silently swap which form is showing.
- **Bulk Paste (CSV/TSV)**: byte-for-byte the pre-existing Upload CSV / Select folder / paste-textarea
  UI (`handleCSV`/`handleFolderSelect`/`handlePasteAdd`, all unchanged) — the toggle only wraps this in
  a conditional render, it doesn't touch the parser.
- **Manual Form** (`ManualTransactionForm`): Date (`<input type="date">`, defaults to today via
  `todayDateString()`, a local-timezone `YYYY-MM-DD` — deliberately not `toISOString()`, which is UTC
  and can land on the wrong calendar day depending on timezone/time of day), Description (plain text),
  Category (a `<select>` of `allCategories` plus a "+ Add new category..." option that reveals an inline
  text input wired to the existing `addCategory`), and a Type (Expense/Income) toggle paired with an
  unsigned numeric Amount input — the sign is applied when the row is built, not stored as a separate
  field.
  - **Live categorization**: a `useMemo` (`suggestedCategory`) re-runs `categorize()` — the exact same
    regex/substring rules engine `stageRows`'s "suggested" column already uses — on every Description
    keystroke. The category shown is `categoryTouched ? manualCategory : suggestedCategory`: a derived
    value, not state synced via an effect, specifically so there's no effect-triggered render cascade
    and no risk of a later suggestion clobbering a category the person picked themselves. Picking one
    from the dropdown (or confirming a new one) sets `categoryTouched = true` for the rest of that entry.
  - **Stage Transaction** vs **Add Directly**: both call into `Ledger()` functions
    (`stageManualTransaction` / `addManualTransactionDirect`) that share `dedupeAgainstCommitted` and
    `isValidDateString` with the bulk pipeline rather than duplicating validation — the one deliberate
    difference from bulk import is that a single manual entry asks via `confirm()` before proceeding on
    a likely duplicate (same date/description/amount already in the log or in staging) instead of
    silently skipping it the way a multi-row batch does, matching this app's existing "`confirm()` for
    consequential single actions" pattern (row delete, category removal) rather than the bulk path's
    silent skip-and-report. "Add Directly" additionally upserts a merchant lookup correction when the
    chosen category differs from what `categorize()` would have suggested — the same "teach the rules
    engine on correction" behavior `commitStaging` already does for staged rows, now extended to a
    direct add too. Both clear the form back to defaults on success; validation failures (missing/
    invalid date, empty description, unparseable amount, no category chosen) `alert()` instead, matching
    `saveTxnEdit`'s existing inline-edit validation style.

### App Lock (v6.8+)

Optional, off by default (`lockEnabled`). A full-screen `LockOverlay` covers the entire app — not just a
visual overlay on top of it, but the actual returned JSX branch, so ledger data is never in the DOM
until authentication succeeds — shown whenever `lockEnabled && locked`. `locked` starts `true` on mount
if App Lock was already on at the last save, and a `visibilitychange` listener sets it back to `true`
the instant the tab/PWA is backgrounded (`document.visibilityState === "hidden"`), so the overlay is
already in place by the time the tab becomes visible again — this covers both "closed and reopened" and
"switched away and back" without needing to tell them apart.

**Persisted config** — three more small, separate localStorage keys, same pattern as `THEME_KEY` and
the Cloud Sync keys: per-browser device-security config, not financial data, so none of it is part of
`STORAGE_KEY` or JSON export/import (a restored backup never carries someone else's lock settings onto a
new device, and a device's own lock settings never leak into an exported backup file).

```js
"ledger:applock:enabled:v1"     // "1" | "0"
"ledger:applock:pin:v1"         // JSON: { salt, hash, iterations, length } - see below
"ledger:applock:webauthn:v1"    // JSON: { id } - a WebAuthn credential.id, not a secret
```

**Backup PIN**: PBKDF2-SHA256, reusing the exact same iteration count (`PBKDF2_ITERATIONS`, 100,000)
Cloud Sync's passphrase derivation already uses — `derivePinHash` is `deriveBits` where
`deriveAesKey` is `deriveKey`, otherwise the identical primitive off `window.crypto.subtle`, no
third-party crypto library. `createPinRecord` stores `{ salt, hash, iterations, length }`; `length` (the
PIN's digit count, 4–6) travels alongside purely so the lock screen's keypad knows how many dots to show
and when to attempt a verify — it's metadata about the PIN, not part of the secret, the same way a login
form showing "your PIN is 6 digits" wouldn't weaken it. `verifyPinRecord` re-derives with the stored
salt/iterations and compares hashes; `LockOverlay` calls it automatically once `entered.length ===
pinLength`, clearing the attempt and showing "Incorrect PIN" on a mismatch. **App Lock cannot be turned
on without a PIN already set** (`handleToggleLockEnabled` blocks it with an `alert()`) — the PIN is the
one fully self-contained unlock method, so this guarantees a fallback that can never stop being offered
(a browser update, a different device) the way the biometric option below could.

**Biometrics (WebAuthn platform authenticator)**: `registerBiometricCredential` calls
`navigator.credentials.create()` with `authenticatorAttachment: "platform"` and
`userVerification: "required"` — this triggers the OS's native Face ID/Windows Hello/fingerprint prompt
directly; only the returned `credential.id` (already a base64url string per the Credential Management
spec, and not a secret) is persisted, never a private key, which never leaves the authenticator
hardware. `platformAuthenticatorAvailable()` (wrapping
`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`) feature-detects an actual usable
authenticator before Settings offers "Enable biometrics," so the control isn't offered somewhere it
would just fail. On unlock, `verifyBiometricCredential` calls `navigator.credentials.get()` with the
stored credential id in `allowCredentials`; `LockOverlay` auto-attempts this once per mount (tracked via
a `useRef`, not state, specifically so this doesn't need a setState-in-effect render cascade) and again
on tapping "Use Face / Fingerprint," and the PIN keypad renders unconditionally alongside it the whole
time — an immediate fallback, not one gated behind the biometric attempt failing first. Any rejection
(cancelled, timed out, no authenticator available right now) is caught and silently falls through to the
keypad, matching this app's general "safe fallback over a scary error" posture — tapping away from a
biometric prompt to type a PIN instead is routine, not a failure worth alerting on.

**Deliberately not a server-verified WebAuthn credential** — worth being explicit about, since this is
the one place this app's WebAuthn usage looks unlike how WebAuthn is normally described. A real relying
party verifies the assertion's signature against the public key it stored at registration; that needs a
COSE-key signature verifier this app has no other reason to carry, and there's no server here to hold
that verification step anyway (§1's no-backend rule). What still makes the biometric option meaningful
without one: `navigator.credentials.get()` is a browser/OS-mediated API this page's own JS cannot forge
or script around — the platform authenticator refuses to produce *any* assertion unless the real
biometric or device-PIN check the OS itself owns succeeds. A successful resolve is still genuine local
proof-of-presence; this app just can't additionally confirm the assertion was signed by the exact key it
registered, the way a real relying party's server would. This is why the PIN — fully self-contained,
verified entirely in this browser — is the required fallback rather than an afterthought.

**What App Lock doesn't protect**: a JSON export/import backup file, or a Cloud Sync copy (§3's Cloud
Sync subsection) — both are separate from this browser's live session and neither is gated by this
feature. This is the same "local, on-device" scope Settings' own App Lock panel text says explicitly.

**Touch targets (Part of the same v6.8 pass)**: the existing v6.7 mobile media query
(`@media (max-width: 780px), (pointer: coarse)`) gained a rule sizing every non-checkbox `input`/
`select` to a 44px minimum height, filling the one gap left after v6.7 (which covered buttons, tabs, and
table cells but not form fields) — the Manual Form's fields and the PIN Settings inputs both pick this up
for free. The lock screen's PIN keypad buttons are sized 64×64px unconditionally (not media-query-gated)
since a full-screen security prompt should have generous touch targets on desktop too, not only on a
narrow viewport.

Checked by `npm run build` + `npm run lint` only so far (both clean, zero new errors against the §5
baseline) — not yet exercised live: no real WebAuthn platform authenticator round-trip on an actual
device, no live-browser check of the visibilitychange re-lock behavior, no unit tests for
`derivePinHash`/`createPinRecord`/`verifyPinRecord` or the manual entry dedup/validation paths. Same
"build/lint-checked, not live-verified" caveat every other unverified Phase 4/5 item in §5 carries.

### Master Seed Auto-Categorization Dataset (v6.9+)

`categorize(merchant, lookupEntries)` has always matched a person's own `lookup` rules — Tier 1, plain
substring or regex (see the Regex Rules subsection above), longest-key-first via `sortLookup`. v6.9 adds
a Tier 2 fallback: once every Tier-1 rule has been checked and missed, `categorize()` falls through to
`DEFAULT_LOOKUP_COMPILED` — a precompiled form of `DEFAULT_LOOKUP`, a built-in, hardcoded array of
~825 `[key, category]` tuples (the exact same shape as a `lookup` entry) covering common North American
merchants across Groceries, Dining, Transport, Subscriptions, Telecom, Utilities, Hardware, Apparel &
Gear, `INCOME: Benefits`, `INCOME: Employment`, `TRANSFER: Internal/Other`, and
`TRANSFER: Credit Card Payment`.

- **Strictly a fallback, never an override.** The Tier-1 loop over `lookupEntries` runs to completion
  first; Tier 2 is only ever consulted if that loop finds nothing. A person's own rule — however broad
  or narrow — always wins, with zero precedence logic needed to make that true, since Tier 2 code simply
  never runs when Tier 1 already returned.
- **`compileDefaultLookup(entries)`** runs once at module load (not on every `categorize()` call):
  `sortLookup` applies the same longest-key-first precedence Tier 1 already gets, a regex-shaped key
  (`isRegexRuleKey`/`parseRegexRule`) is compiled once and dropped if it doesn't parse (identical
  "invalid regex = never matches" rule as Tier 1), and a plain key is pre-normalized with `normalize()`
  so the runtime check is a cheap substring test against the already-normalized merchant string. The
  result, `DEFAULT_LOOKUP_COMPILED`, is what `categorize()` actually iterates for Tier 2.
- **Never persisted, never editable.** `DEFAULT_LOOKUP`/`DEFAULT_LOOKUP_COMPILED` are module-scope
  constants — not state, not part of `STORAGE_KEY`, not part of JSON export/import, and not listed or
  editable in Settings > Merchant rules (that table still shows only the person's own `lookup`). A
  merchant this dataset gets wrong (or misses) is a one-time "no match" the person corrects exactly like
  any other suggestion; that correction becomes a real Tier-1 `lookup` rule and permanently wins over the
  dataset for that merchant from then on — the built-in dataset itself never changes as a result.
- **Two new default spending categories.** "Utilities" and "Hardware" didn't have a real home in the
  pre-v6.9 `DEFAULT_SPENDING_CATEGORIES` (the closest existing fit, "Household", would have been a
  misleading catch-all for e.g. hydro bills or a Home Depot run). `ensureMasterSeedCategories` — the
  same "small, additive, idempotent, safe on every load" pattern as `ensureWealthsimpleCategory` — adds
  both to any browser's saved `spendingCategories` that predates v6.9, so the dataset's suggestions land
  on categories that actually exist in Settings and the category filters. It's wired into every path
  `ensureWealthsimpleCategory` already runs on (`readPersistedStore`, both JSON-import call sites), and
  is a no-op the moment both categories are already present.
- **Zero network calls.** This is a hardcoded, build-time dataset shipped in the JS bundle — not a
  lookup service, not an API call, not something that can go stale without a new build. It adds nothing
  to §1's no-backend rule or the "zero network calls in normal operation" statement Cloud Sync is still
  the sole exception to.
- Settings > Merchant rules' description text now mentions the fallback explicitly, so a person seeing a
  transaction already correctly categorized with no rule of their own in the table isn't confused about
  where that suggestion came from.

Checked by `npm run build` + `npm run lint` only so far (both clean, zero new errors against the pre-v6.9
baseline — see §5) — not yet exercised live: no real bank-statement CSV run through the dataset to spot-
check false positives/negatives at scale, no unit tests for `categorize()`'s Tier 2 path or
`compileDefaultLookup`. Same "build/lint-checked, not live-verified" caveat every other unverified item
in §5 carries.

**v6.9.1 fixes, on top of the above:**

- **Regex rules are now tested against both the raw merchant text and the normalized (lowercased,
  hyphens-to-spaces) text** — either side matching is enough, at both tiers. Raw is tried first (so a
  pattern authored with an explicit `/i` still controls case sensitivity the way a hand-written regex
  normally would); normalized text is tried second, as a fallback for a pattern that assumes
  already-normalized input (e.g. a `\s*` meant to bridge a hyphen `normalize()` would have turned into a
  space).
- **`parseRegexRule` now strips `g`/`y` (global/sticky) flags before compiling.** Both make
  `RegExp#test()`/`exec()` stateful via `lastIndex` — harmless for a single one-off test, but a real bug
  risk now that a regex-shaped rule is tested twice per `categorize()` call (raw, then normalized) and
  Tier 2's `DEFAULT_LOOKUP_COMPILED` regexes are compiled once and reused across every transaction's
  `categorize()` call for the lifetime of the page. Any other flag (currently just `i`) passes through
  unchanged. `RegexRuleTester` (Settings > Merchant rules) mirrors the same dual raw/normalized test so
  its preview stays exactly what a rule would do once saved.
- **Expanded Transport regex coverage**: two new regex-shaped `DEFAULT_LOOKUP` entries layered on top of
  the existing plain-text Transport keys — one covering transit systems/apps and micromobility/carshare
  (PRESTO, OC Transpo, TTC, TransLink, STM, GO Transit, Metrolinx, UP Express, VIA Rail, Amtrak, Calgary/
  Edmonton Transit, Exo, Bixi, Lime, Bird, Communauto, Zipcar, Turo, Evo), the other covering fuel brands
  and parking operators (Esso, Petro-Canada, Shell, Chevron, Pioneer, Canadian Tire Gas+, Husky,
  Ultramar, Green P, Parkopedia, Impark, Precise ParkLink, HonkMobile, PayByPhone) — each pattern
  collapsing several real-world spelling/spacing variants (with/without a space, a hyphen vs. a space)
  that a single plain substring key can't.
- **Manual Form (§3's Ingestion Mode & Manual Entry) live-suggestion fix**: the category field now only
  locks against further live suggestions once the person has picked a *real* category — selecting the
  form's own blank "No match/choose one" option sets `categoryTouched` but leaves the category empty,
  and that no longer freezes the field against `categorize()`'s live suggestion as the description keeps
  changing. A small reset icon (reusing the `Undo2` icon already used for "Undo last import") appears
  next to the category dropdown whenever a real manual pick is in effect, clearing it back to live
  auto-detection without touching the rest of the form or reloading.
- Verified the same way as the rest of v6.9: `npm run build` clean, `npm run lint` unchanged (still
  exactly the 9 pre-existing baseline errors).

---

## 4. Version Archive Index

All `.jsx` files below are kept in `_archive/`. This is the exact feature/fix history — use it to
pick which file to restore from if a rollback is ever needed.

- **v1 — Initial ledger.** CSV import, merchant lookup matching, manual categorization, basic
  transaction table. Foundational shape of `transactions`/`lookup`/`spendingCategories`.

- **v2 — Committed costs.** Introduced the fixed monthly expenses concept as flat budget fields
  (`gym`, `carInsurance`, `mealPrep`, `subs`, `phone`) — later generalized into `committedCosts[]`
  in v3, with `migrateBudget` folding these flat fields forward ever since.

- **v3.0 — Budget Generalization.** Converted fixed net-worth fields (`portfolio`/`osap`/`incoming`)
  into a dynamic `netWorthItems[]` list (asset/liability typed), and fixed income fields
  (`aafcMonthly`/`reserveLow`/`reserveHigh`) into a dynamic `incomeStreams[]` list (low/high range).
  Added actual-vs-plan tracking. Also generalized `committedCosts` into its final dynamic
  add/rename/edit/delete list form. This is where `computeNextId` and the "small independent
  migration blocks" pattern in `migrateBudget` were established.

- **v4.0 — Dashboard Customization & Theme.** Added the Dashboard tab's period/category filter bar,
  chart drill-down (click a Pie/Bar segment to jump to the filtered Log), light/dark theme via
  `THEME_CSS` + `data-theme`, and general UI polish.

- **v4.1 — Wealthsimple Investment Expense Visualization.** Reclassified the system category
  `"TRANSFER: Wealthsimple"` (previously hidden from spend entirely) into a normal, user-editable
  spending category, `"Investing"` — investing now shows up in total spend, the category breakdown,
  and every relevant chart. Added the three-part migration
  (`migrateWealthsimpleTransactions`/`migrateWealthsimpleLookup`/`ensureWealthsimpleCategory`) that
  runs on every load path, forward-converting any historical data still using the old category.

- **v5.0 — "Phase 2 Final" (Row Edit/Delete, Undo Import, Dynamic Targets).**
  - Row-level **Edit/Delete** on the Log tab (inline edit of date/merchant/amount/category; delete
    requires `confirm()`; both correctly interoperate with `computeNextId`).
  - **Undo Last Import**: `commitStaging` now tracks the exact batch of ids it just committed
    (`lastImportBatch`); a dismissible banner offers one-click rollback of *only* that batch, never
    a wider "delete everything" action.
  - **Dynamic Target Scenarios**: generalized the fixed Floor/Mid/Stretch trio into a dynamic
    `targetScenarios[]` list, following the exact `committedCosts`/`netWorthItems`/`incomeStreams`
    pattern, with legacy `targetFloor`/`targetMid`/`targetStretch` migrated forward losslessly.

- **v6.0 — "Phase 3" (Bulk Recategorization, Reports & Tuning).**
  - **Bulk Re-categorization**: row selection checkboxes + "Select All Visible" on the Log tab; a
    sticky bulk action bar (category selector, Apply, Deselect All) appears once ≥1 row is
    selected; if the selected batch includes a merchant appearing more than once, prompts
    (`confirm()`) to also upsert a matching lookup rule.
  - **Report Exports**: "Export Summary" menu on the Dashboard offering CSV download (category
    breakdown with monthly totals/percentages) and Print/Save PDF (`window.print()` with the new
    `PRINT_CSS` print stylesheet).
  - **Recurring-Detection Tuning**: new Settings section exposing `recurringConfig`
    (`minOccurrences`, `biweeklyMin/Max`, `monthlyMin/Max`) as editable, persisted, resettable
    inputs; `detectRecurring` refactored to accept this config and check biweekly/monthly as two
    independent windows.

- **v6.1 — "Final Phase 3" (Dashboard Layout Controls).**
  - **Dashboard Section Visibility & Reordering**: "Customize Layout" popover (button next to
    "Export Summary") listing all 7 dashboard sections with visibility checkboxes, Move Up/Down
    reordering, and "Reset to Default Layout." Persisted as `dashboardLayout` inside the same
    autosave payload, merged safely via `normalizeDashboardLayout` (drops unknown ids, dedups,
    backfills missing known sections) and included in JSON export/import.
  - **Print Styles Compatibility**: because a hidden section is now genuinely absent from the DOM
    (not just CSS-hidden), Print/PDF automatically respects both the custom order and hidden state
    with no additional print-specific logic — `.ledger-no-print` was narrowed to cover only real
    app chrome.
  - **Notable visual side effect**: "Spend Share Pie Chart" and "Income by Source Bar Chart" were
    split from v6.0's 2-column side-by-side grid into two independent full-width stacked sections,
    since v6.1 requires every section to be independently reorderable.

- **v6.2 — "Phase 4 Item 1" (Transaction Splitting).**
  - **Split a transaction across categories**: new "Split" button (Log tab actions column, next to
    Edit/Delete) opens an inline row editor to divide one transaction's amount across two or more
    categories. Save is blocked until every part has a category and the parts sum to *exactly* the
    original amount (compared in whole cents, not floats).
  - **Data model**: a split replaces the one original row with N ordinary transaction rows tagged
    `splitParentId` (the retired original id) — no separate "split line" shape. See §3's Transaction
    Splitting subsection for why, and for the un-split/merge path (`mergeSplitGroup`).
  - **Dashboard/export integrity by construction**: because split rows are just transactions, every
    existing chart, filter, total, and CSV/print export handles them with zero split-aware logic
    added anywhere — this follows from the data model rather than needing per-chart changes. Checked
    by build + lint only so far, not yet exercised against real data in a running browser.
  - Also, incidentally: `src/Ledger.jsx` and the `papaparse`/`recharts`/`lucide-react` dependencies
    it needs weren't actually wired into this Vite scaffold yet when this phase started (`App.jsx`
    still rendered the default Vite demo) — fixed as a prerequisite so `npm run build` meaningfully
    exercises this file.

- **v6.3 — "Phase 4 Item 2" (Advanced Regex Rules Engine).**
  - **Regex merchant matching**: a merchant lookup key wrapped in slashes with optional trailing
    flags (e.g. `/^uber\s*eats/i`) is matched as a regular expression against the raw merchant text
    instead of a plain case-insensitive substring. Detected by shape, not a stored flag or schema
    change — see §3's Regex Rules subsection for the full `categorize()`/`parseRegexRule`/
    `addLookupRule` breakdown.
  - **Safety**: invalid regex syntax is caught at the `new RegExp(...)` call site
    (`parseRegexRule`) and treated as "this rule never matches" everywhere — categorization can never
    crash on a malformed saved rule, and saving a new one that doesn't compile is rejected up front
    with an alert instead of persisting silently.
  - **Rule Testing UI**: Settings > Merchant rules gained a "Test regex rule" box
    (`RegexRuleTester`) — a sample-merchant input and a `/pattern/flags` input, live-showing whether
    it matches and any capture groups, using the exact same matching functions the real rule engine
    runs (not a separate approximation).
  - **Persistence**: regex-shaped keys are stored verbatim, never run through `normalize()` (which
    would otherwise corrupt a pattern — e.g. turning `-` inside `[a-z]` into a literal space).
    `isValidLookupEntry`, the `STORAGE_KEY` autosave payload, and JSON export/import all already
    treat a lookup key as an opaque string, so none needed a shape change to carry regex rules
    through cleanly.
  - Checked by build + lint only so far, same caveat as v6.2 — not yet exercised against real data in
    a running browser, and no unit tests written yet for `parseRegexRule`/`categorize`'s regex branch.

- **v6.4 — "Phase 4 Item 3" (Predictive Forecasting & Runway Analytics).**
  - **Goal Runway & Projections**: new Budget-tab section computing the historical 3-month and
    6-month average net monthly surplus (income − spend, from `monthlyTrend`'s full transaction
    history) and projecting it forward from the current net position (`netPos`, from
    `netWorthItems`) toward each `targetScenarios` entry. See §3's Goal Runway & Projections
    subsection for the full breakdown.
  - **Milestone dates, not just gaps**: for each target scenario, shows the estimated month/year
    it's reached under both the 3-month and 6-month pace side by side (`estimateMilestone`), instead
    of only the static gap/feasibility the existing "Target scenarios" table already showed.
  - **Projection chart**: a `recharts` `AreaChart` plotting projected net worth 24 months forward
    under a user-selectable rate (3-mo or 6-mo average), with a `ReferenceLine` per target scenario.
  - **Graceful deficit handling**: a zero or negative surplus rate never produces an infinite or
    nonsensical date — the milestone renders as "Deficit / No projection available" instead — and
    never breaks the chart curve, since a linear projection is well-defined (flat or declining) at
    any rate.
  - **Nothing new persisted**: this entire section is derived at render time from existing
    `transactions`/`netWorthItems`/`targetScenarios` — no new `budget` field, no `isValidBudget` or
    `migrateBudget` change, no JSON export/import change.
  - Checked by build + lint only so far, same caveat as v6.2/v6.3 — not yet exercised against real
    data in a running browser, and no unit tests written yet for `estimateMilestone`.

- **v6.5 — "Phase 4 Item 4" (Serverless Cloud Sync — Google Drive AppData).**
  - **Deliberate departure from "no cloud sync"**: the one explicitly-discussed exception to the
    non-goals list in §1 — see the "Update, v6.5" note there for why this still respects the
    no-backend rule (pure client-to-Google OAuth, nothing this project runs or controls).
  - **New Cloud Sync panel, Settings tab**: a Google Client ID field (persisted to its own
    localStorage key, never hardcoded — see §3's Cloud Sync subsection), an encryption passphrase
    field (deliberately never persisted anywhere), Connect/Disconnect, Sync Now (upload/overwrite),
    Pull from Cloud (download/restore), a live status line (Idle/Encrypting/Syncing/Error/Success),
    and a last-synced timestamp.
  - **Auth**: Google Identity Services' token client
    (`google.accounts.oauth2.initTokenClient`/`requestAccessToken`), scoped to
    `drive.appdata` only — this app can never see, list, or touch anything in the person's visible
    Drive. The GIS script (`accounts.google.com/gsi/client`) loads on demand, only once Cloud Sync is
    actually used, not eagerly on app load. The access token lives in memory only; the passphrase and
    token are both cleared on Disconnect (which also best-effort revokes the OAuth grant).
  - **Zero-knowledge encryption**: `window.crypto.subtle`, PBKDF2 (SHA-256, 100,000 iterations) to
    derive an AES-GCM 256-bit key from the passphrase, fresh random salt + IV every encryption. The
    plaintext is the exact same payload shape `exportData`/`importData` already use. See §3's Cloud
    Sync subsection for the full envelope shape uploaded to Drive.
  - **Drive operations**: `ledger-vault.enc` is queried/created/overwritten strictly inside the
    hidden `appDataFolder` via Drive REST v3 (`driveFindVaultFileId`/`driveUploadVault`/
    `driveDownloadVault`) — multipart create if it doesn't exist yet, a plain media `PATCH` to
    overwrite it if it does.
  - **Safety**: Pull from Cloud reuses the exact same per-section `isValidX` validators and
    "validate everything before applying anything" rule `importData` already follows for a JSON
    backup file (§2) — a malformed or wrong-passphrase cloud payload can no more partially corrupt
    local data than a bad backup file can. A decrypt failure (wrong passphrase, or a
    corrupted/foreign file) is caught on its own, *before* any validation runs, and alerted with a
    generic message rather than surfacing the raw crypto error — local data is untouched either way.
  - **Live-verified against a real Google account**: unlike every other Phase 4 item so far, this one
    has actually been exercised end-to-end in a running browser against a real Google Cloud OAuth
    client and Drive account — connect, Sync Now, and Pull from Cloud all manually confirmed working,
    not just build/lint-checked. No unit tests written yet for the encrypt/decrypt round-trip or the
    Drive REST helpers, but the feature itself is confirmed functional, not merely plausible.

- **v6.6 — "Phase 4 Item 4 follow-up" (Dual-Provider Cloud Sync — Google Drive + Dropbox).** *Current
  production version.*
  - **Provider toggle**: the Cloud Sync panel gained a Google Drive / Dropbox tab switcher
    (`cloudProvider`, persisted). Sync Now and Pull from Cloud are unchanged as one shared pair of
    buttons — `syncNowToCloud`/`pullFromCloud` in `Ledger()` branch internally on `cloudProvider`
    rather than the UI needing two parallel sets of actions. See the "Update, v6.6" note in §1 and
    the rewritten §3 Cloud Sync subsection for the full persisted-key list and the shared-vs-per-
    provider breakdown.
  - **Dropbox auth**: OAuth 2.0 with PKCE, the standard flow for a public client with no backend to
    hold a secret (`generatePkceVerifier`/`sha256Base64Url`/`startDropboxAuth`), requesting
    `files.content.write files.content.read` scope. Unlike Google Identity Services, Dropbox's flow
    is a genuine full-page redirect to dropbox.com and back — handled by a mount-time `useEffect` in
    `Ledger()` that recognizes `?code=&state=` on load, exchanges the code (`exchangeDropboxCode`),
    and scrubs the URL via `history.replaceState` so a refresh can't replay the one-time code. The
    PKCE verifier and anti-CSRF state live in `sessionStorage` only, for the duration of that one
    round trip.
  - **Persisted Dropbox refresh token — a deliberate, documented asymmetry from Google**: because
    Dropbox's redirect flow has no in-page silent-reauth equivalent to GIS, the refresh token is
    persisted to localStorage (`DROPBOX_REFRESH_TOKEN_KEY`) so later syncs mint fresh short-lived
    access tokens (`getDropboxAccessToken`/`refreshDropboxAccessToken`) without another full-page
    redirect. Disconnect clears it and best-effort revokes it with Dropbox. See §3 for the full
    reasoning.
  - **Same shared encryption engine, same shared payload shape**: `encryptVaultPayload`/
    `decryptVaultPayload` and the `{ transactions, lookup, spendingCategories, budget,
    recurringConfig, dashboardLayout, exportedAt }` plaintext shape are untouched and unduplicated —
    only the transport (auth + REST calls) differs per provider. Pull from Cloud's validate-then-
    apply-as-one-batch logic (§2, §3) is likewise shared, not forked per provider.
  - **Dropbox operations**: `ledger-vault.enc` is uploaded/downloaded at the stable path
    `/ledger-vault.enc` inside the Dropbox app's own app folder (`dropboxUploadVault` with
    `mode: "overwrite"` / `dropboxDownloadVault`, treating Dropbox's 409 "not found" response the
    same as Drive's "no file yet" case) — simpler than Drive's find-by-name-then-create-or-patch-by-
    id dance, since Dropbox paths are already stable names.
  - **Safety**: `connectDropbox` warns (`confirm()`) before starting the redirect if there are
    uncommitted staged import rows, since a full-page redirect would otherwise silently lose them
    (staging is transient and never persisted — see §3's Staging rows subsection). Every other safety
    property from v6.5 (validate-before-apply, safe decrypt-failure handling) is provider-agnostic
    and applies identically to a Dropbox-sourced payload.
  - **Verification is split by provider, not uniform across this version**: the Google Drive path
    (provider toggle defaulting to Google, the shared encryption engine, Sync Now/Pull from Cloud) has
    been live-verified against a real Google account (see v6.5's entry above). The Dropbox-specific
    transport added in this version has **not** — `connectDropbox`/the PKCE redirect round trip/
    `dropboxUploadVault`/`dropboxDownloadVault` are still only build- and lint-checked, and
    read-reviewed against Dropbox's documented OAuth/PKCE and Files API shapes, not run live against a
    real Dropbox App Console app/account. No unit tests written yet for the PKCE helpers or the
    Dropbox REST helpers either. Treat the Dropbox side with the same "unverified" caveat every other
    Phase 4 item still carries, independent of Google Drive's now-confirmed status.

- **v6.7 — "Phase 5 Item 1" (Progressive Web App & Offline Caching Engine).**
  - **Installable PWA**: `vite-plugin-pwa` (new devDependency) wired into `vite.config.js` in
    `generateSW` mode — `registerType: "autoUpdate"`, a full manifest (name, short name, `#0f172a`
    theme/background color, standalone display, portrait-primary orientation, four icon entries
    including a maskable variant), and `includeAssets` for `favicon.ico`/`robots.txt`/
    `apple-touch-icon.png`. See §3's new PWA & Offline Caching subsection for the full breakdown.
  - **New generated icon set**: `public/icons/` (192/512/512-maskable PNG + SVG), `public/favicon.ico`,
    `public/apple-touch-icon.png`, `public/robots.txt` — produced by a one-off Node script (no image
    library available in this environment, so it hand-rolls a minimal PNG encoder + PNG-in-ICO
    wrapper) rather than hand-drawn assets; a simple three-bar brand glyph, not final visual design.
  - **Offline caching**: Workbox `globPatterns` precaches the full built app shell (JS/CSS/HTML/
    icons/fonts) so the app opens instantly offline once installed; `runtimeCaching` adds `CacheFirst`
    for runtime script/style/font requests. Google Identity Services, Drive REST, and every Dropbox
    endpoint (OAuth, Files API, the PKCE redirect) are explicitly `NetworkOnly` by hostname, so Cloud
    Sync (v6.5/v6.6) can never be served a stale/cached response for a live sync operation.
  - **Mobile touch & viewport polish**: a touch/narrow-viewport-scoped CSS block (44px minimum hit
    targets for buttons/tabs/table cells), two tables that had drifted from the app's existing
    `overflowX: "auto"` wrapper pattern fixed, `flexWrap` added to five fixed-width-input rows (budget
    editors, the split-transaction editor, the add-merchant-rule row) that could otherwise clip on a
    narrow screen, and new `index.html` meta tags (`viewport-fit=cover`, `theme-color`,
    `apple-touch-icon`, standalone-display tags).
  - **Zero architecture change**: no new `STORAGE_KEY` field, no backend, no new network call beyond
    what Cloud Sync already made — see the "Update, v6.7" note in §1 and the "What this doesn't
    change" bullet in §3's PWA subsection.
  - **Verified by `npm run build` only so far**: confirmed a clean `dist/sw.js` +
    `dist/manifest.webmanifest`, inspected the built service worker directly for the expected
    precache list and the two `NetworkOnly`/`CacheFirst` runtime-caching rules, and confirmed
    `npm run lint` still reports exactly the same 9 pre-existing errors as the Phase 4 baseline (§5) —
    zero new lint errors introduced. Not yet exercised as an installed PWA in a real mobile browser
    (Add to Home Screen, an actual airplane-mode reload, a Lighthouse PWA audit, or manual touch-target
    testing on a real device) — same "build/lint-checked, not live-verified" caveat most of Phase 4
    still carries.

- **v6.8 — "Phase 5 Item 2" (Manual Ingestion Form & App Lock).**
  - **Ingestion Mode Selector & Manual Form**: the Log tab's "Add a new transaction" card gained a
    segmented Manual Form / Bulk Paste (CSV/TSV) toggle (`ingestionMode`, persisted per-browser,
    defaulting to Manual Form on a <780px viewport at first load). Bulk Paste is the pre-existing
    CSV/folder-upload/paste-textarea flow, untouched. Manual Form (`ManualTransactionForm`) is a
    one-row Date/Description/Category/Type(Expense-Income)/Amount form with live regex-rules-engine
    categorization as the person types, and two actions — Stage Transaction and Add Directly — both
    sharing dedup/validation with the bulk staging pipeline (`stageManualTransaction`/
    `addManualTransactionDirect`). See §3's Ingestion Mode & Manual Entry subsection for the full
    breakdown.
  - **App Lock**: a new Settings > "App security & lock" panel adds an optional, off-by-default local
    lock screen — a PBKDF2-hashed 4-6 digit backup PIN (reusing Cloud Sync's exact `PBKDF2_ITERATIONS`
    primitive via `window.crypto.subtle`) plus an optional WebAuthn platform-authenticator (Face/
    Fingerprint/Windows Hello) biometric unlock. A full-screen `LockOverlay` — the entire app's returned
    JSX branches to just this overlay, not merely a visual cover — shows on open/resume
    (`visibilitychange`-driven re-lock) until either check succeeds. App Lock can't be turned on without
    a PIN already set, since the PIN is the one fully self-contained fallback. See §3's App Lock
    subsection for the full breakdown, including why the biometric check is a meaningful local gate
    despite this app having no server to verify a signed assertion against.
  - **Touch targets**: extended v6.7's mobile media query to give every non-checkbox `input`/`select` a
    44px minimum height (closing the one gap v6.7 left), and sized the lock screen's PIN keypad buttons
    at 64×64px unconditionally (not media-query-gated), since a full-screen security prompt warrants
    generous touch targets on desktop too.
  - **Zero new persisted `STORAGE_KEY` fields**: both features live entirely in their own separate
    localStorage keys (`ledger:ingestionmode:v1`, `ledger:applock:*`), same non-financial-data pattern
    as `THEME_KEY` and the Cloud Sync keys — no `isValidX`/migration change, no JSON export/import
    change, and (for App Lock specifically) a deliberate, discussed exception to §1's "no auth for this
    app" non-goal that stays a *local* device lock, not an account system — see the "Update, v6.8" note
    in §1.
  - **Verified by `npm run build` + `npm run lint` only so far**: both clean, `npm run lint` reporting
    exactly the same 9 pre-existing errors as the Phase 4 baseline (§5) — zero new lint errors or
    warnings introduced. Not yet exercised live: no real WebAuthn platform-authenticator round-trip on
    an actual device, no live-browser check of the visibilitychange re-lock behavior or the manual
    form's live categorization, no unit tests for the PIN hashing helpers or the manual-entry dedup/
    validation paths. Same "build/lint-checked, not live-verified" caveat every other unverified Phase
    4/5 item here carries.

- **v6.9 — Master Seed Auto-Categorization Dataset.**
  - **`DEFAULT_LOOKUP` / `DEFAULT_LOOKUP_COMPILED`**: a built-in, hardcoded ~825-entry `[key, category]`
    dataset covering common North American merchants across Groceries, Dining, Transport, Subscriptions,
    Telecom, Utilities, Hardware, Apparel & Gear, `INCOME: Benefits`, `INCOME: Employment`, and both
    `TRANSFER` categories, compiled once at module load (`compileDefaultLookup`) into regex/plain-text
    matchers using the same rules Tier 1 already uses.
  - **`categorize()` gains a Tier 2**: once every rule in the person's own `lookup` (Tier 1) has been
    checked and missed, `categorize()` now falls through to `DEFAULT_LOOKUP_COMPILED` before giving up.
    A user rule always wins outright — Tier 2 only ever runs after Tier 1 has already exhausted every
    entry with no match.
  - **Two new default spending categories**: `"Utilities"` and `"Hardware"`, added to
    `DEFAULT_SPENDING_CATEGORIES` and backfilled onto any existing browser's saved category list via
    `ensureMasterSeedCategories` (same additive, idempotent pattern as `ensureWealthsimpleCategory`).
  - **Settings > Merchant rules** description text now explains the fallback, so a transaction that's
    already correctly categorized with no rule of the person's own in the table isn't confusing.
  - **Zero new persisted `STORAGE_KEY` fields, zero network calls**: the dataset is a module-scope
    constant shipped in the JS bundle — never part of `STORAGE_KEY`/JSON export/import, never shown or
    editable in Settings, and not a lookup service of any kind.
  - **Verified by `npm run build` + `npm run lint` only so far**: both clean, `npm run lint` reporting
    exactly the same 9 pre-existing errors as the Phase 4 baseline (§5) — zero new lint errors or
    warnings introduced. Not yet exercised live: no real bank-statement CSV run through the dataset to
    spot-check false positives/negatives at scale, no unit tests for `categorize()`'s Tier 2 path or
    `compileDefaultLookup`. Same "build/lint-checked, not live-verified" caveat every other unverified
    item here carries.

---

## 5. Current State

The current master component is **`src/Ledger.jsx`** — version comment
`// Version: 6.9.1 - Auto-Categorization Engine Fixes (dual raw/normalized regex test, stateless
regex flags, expanded Transport regex coverage, Manual Form live-suggestion reset)`,
component export `export default function Ledger()`, rendered from `src/App.jsx`. The prior v6.1
snapshot ("Final Phase 3," all Phase 3 roadmap items complete and verified — unit tests for every
migration/validation function, a full regression suite across prior versions' features, and a
live-browser Playwright smoke test with screenshots) is kept at `_archive/Ledger_v6_1.jsx`.

Phase 4 (Items 1-4, spanning v6.2-v6.6: Transaction Splitting, Advanced Regex Rules Engine,
Predictive Forecasting & Runway Analytics, Serverless Cloud Sync, Dual-Provider Cloud Sync) is
complete. Phase 5 Items 1-2 (v6.7 PWA & Offline Caching, v6.8 Manual Ingestion Form & App Lock) are
also implemented, and v6.9 (Master Seed Auto-Categorization Dataset) has since landed on top of that —
see §3's respective subsections and §4's v6.7/v6.8 entries for the full breakdown. Across all of these,
**only Cloud Sync's Google Drive path** has been manually live-verified end-to-end (connect, Sync Now,
Pull from Cloud, against a real Google Cloud OAuth client and Drive account — see v6.5's entry in §4).
Everything else — Transaction Splitting, the Regex Rules Engine, Runway Analytics, Dropbox's transport,
the PWA/offline layer, the manual ingestion form and App Lock, and now the v6.9 dataset — is checked with
`npm run build` and `npm run lint` only, with no unit tests written yet (for
`splitTransaction`/`mergeSplitGroup`; `parseRegexRule`/`categorize`'s regex branch; `estimateMilestone`;
the encrypt/decrypt + Drive/Dropbox REST helpers; the PKCE helpers; v6.8's
`derivePinHash`/`createPinRecord`/`verifyPinRecord` or its manual-entry dedup/validation paths; v6.9's
`categorize()` Tier 2 path or `compileDefaultLookup`) and no full live-browser regression pass across the
whole app. v6.7 has not been exercised as an installed PWA in a real mobile browser (Add to Home Screen,
an actual airplane-mode reload, a Lighthouse PWA audit, or manual touch-target testing on a real device);
v6.8 has not been exercised against a real WebAuthn platform authenticator on an actual device, nor has
its `visibilitychange` re-lock behavior or the manual form's live categorization been checked in a
running browser; v6.9's ~825-entry dataset has not been run against a real bank-statement CSV to spot-
check false positives/negatives at scale — see §3 and §4's respective entries for exactly what was and
wasn't checked.

**Pre-existing `npm run lint` errors, unrelated to Phase 4/5:** `npm run lint` on the codebase as
received at the start of Phase 4 Item 4 already reported 9 errors having nothing to do with cloud
sync — an unused `Settings` icon import, two `no-useless-assignment` warnings inside `migrateBudget`,
two unused `err` catch-clause bindings (theme init, autosave), and four React Compiler
`react-hooks` findings (`set-state-in-effect` ×3, `immutability` ×1) in pre-existing effects/memos.
v6.5 through v6.9 were each written to introduce **zero new** lint errors or warnings on top of
that baseline (verified by diffing `npm run lint` before/after each) rather than silently accumulating
more debt, but none of those 9 pre-existing ones were touched or fixed here since they're out of
scope for these features — flagging them explicitly so a future pass doesn't mistake "9 errors" for
something Phase 4/5 introduced.

Everything above — the no-backend constraint, the `STORAGE_KEY` autosave shape, `computeNextId`,
the independent-idempotent-migration pattern, and the exact data schemas in §3 — should be treated
as load-bearing for Phase 5 unless the user explicitly asks to change the architecture. Cloud Sync
(v6.5, extended to a second provider in v6.6), the PWA/offline caching layer (v6.7), and App Lock
(v6.8) are the only explicitly-discussed departures from the original non-goals list (see §1's
"Update, v6.5"/"Update, v6.6"/"Update, v6.7"/"Update, v6.8" notes) — none of these license quietly
extending the app toward a real backend, multi-device sync of any other kind, a third sync provider,
background sync/push notifications, a user-account system, or a different persistence layer for the
core `STORAGE_KEY` payload; any of those would need the same explicit discussion these features
themselves got, not an assumption that "the door is open now."
