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
  - Checked by build + lint only so far, same caveat as every Phase 4 item before it — not yet
    exercised against a real Google Cloud OAuth client/Drive account in a running browser, and no
    unit tests written yet for the encrypt/decrypt round-trip or the Drive REST helpers.

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
  - Checked by build + lint only so far, same caveat as every Phase 4 item before it — not yet
    exercised against a real Dropbox App Console app/account in a running browser (the redirect round
    trip in particular has only been read-reviewed against Dropbox's documented OAuth/PKCE and Files
    API shapes, not run live), and no unit tests written yet for the PKCE helpers or the Dropbox REST
    helpers.

---

## 5. Current State

The current master component is **`src/Ledger.jsx`** — version comment
`// Version: 6.6 - Phase 4 Item 4 follow-up (Dual-Provider Cloud Sync - Google Drive + Dropbox)`,
component export `export default function Ledger()`, rendered from `src/App.jsx`. The prior v6.1
snapshot ("Final Phase 3," all Phase 3 roadmap items complete and verified — unit tests for every
migration/validation function, a full regression suite across prior versions' features, and a
live-browser Playwright smoke test with screenshots) is kept at `_archive/Ledger_v6_1.jsx`.

Phase 4 Items 1 through 4, the latter now spanning two versions (Transaction Splitting v6.2, Advanced
Regex Rules Engine v6.3, Predictive Forecasting & Runway Analytics v6.4, Serverless Cloud Sync v6.5,
Dual-Provider Cloud Sync v6.6) have been implemented and checked with `npm run build` and
`npm run lint` only — none has had unit tests written yet (for `splitTransaction`/`mergeSplitGroup`;
`parseRegexRule`/`categorize`'s regex branch; `estimateMilestone`; v6.5's
`encryptVaultPayload`/`decryptVaultPayload`/Drive REST helpers; or v6.6's PKCE/Dropbox REST helpers),
nor a live-browser regression pass. All are still outstanding before this phase should be considered
verified to the same bar as Phase 3. v6.5 and v6.6 in particular have never been run against a real
Google Cloud OAuth client/Drive account or a real Dropbox App Console app/account — only build- and
lint-checked, and read-reviewed against each provider's documented API shapes.

**Pre-existing `npm run lint` errors, unrelated to Phase 4:** `npm run lint` on the codebase as
received at the start of Phase 4 Item 4 already reported 9 errors having nothing to do with cloud
sync — an unused `Settings` icon import, two `no-useless-assignment` warnings inside `migrateBudget`,
two unused `err` catch-clause bindings (theme init, autosave), and four React Compiler
`react-hooks` findings (`set-state-in-effect` ×3, `immutability` ×1) in pre-existing effects/memos.
Both v6.5 and v6.6 were written to introduce **zero new** lint errors or warnings on top of that
baseline (verified by diffing `npm run lint` before/after each) rather than silently accumulating
more debt, but none of those 9 pre-existing ones were touched or fixed here since they're out of
scope for this feature — flagging them explicitly so a future pass doesn't mistake "9 errors" for
something Phase 4 Item 4 introduced.

Everything above — the no-backend constraint, the `STORAGE_KEY` autosave shape, `computeNextId`,
the independent-idempotent-migration pattern, and the exact data schemas in §3 — should be treated
as load-bearing for Phase 4 unless the user explicitly asks to change the architecture. Cloud Sync
(v6.5, extended to a second provider in v6.6) is exactly one such explicitly-discussed departure (see
§1's "Update, v6.5"/"Update, v6.6" notes) — it does not license quietly extending the app toward a
real backend, multi-device sync of any other kind, a third sync provider, or a different persistence
layer for the core `STORAGE_KEY` payload; any of those would need the same explicit discussion Cloud
Sync itself got, not an assumption that "cloud sync exists now" opens the door further.
