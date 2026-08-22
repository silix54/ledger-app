// Version: 6.3 - Phase 4 Item 2 (Advanced Regex Rules Engine)
import { useState, useMemo, useRef, useEffect } from "react";
import Papa from "papaparse";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Upload, Download, Plus, AlertCircle, Check, Copy, ChevronDown, Trash2, Settings, FolderOpen, Sun, Moon, X, Pencil, Undo2, Printer, ArrowUp, ArrowDown, LayoutGrid, Split, Merge } from "lucide-react";

// System categories drive core calculations (savings tracking, income totals, transfer exclusion) -
// not user-editable, since removing or renaming one would silently break the math elsewhere.
// "TRANSFER: Wealthsimple" used to live here, hiding investment contributions from spend entirely.
// As of v4.1 it's a normal, user-editable spending category instead (see WEALTHSIMPLE_CATEGORY below) -
// investing is now a tracked cash outflow, so it shows up everywhere spend does: total spend, the
// category breakdown, the pie/bar charts, and the dashboard's category filter.
const SYSTEM_CATEGORIES = ["TRANSFER: Credit Card Payment","TRANSFER: Internal/Other",
  "INCOME: Employment","INCOME: Benefits","INCOME: Reimbursement","INCOME: Resale",
  "EXCLUDE: Failed Transfer","REVIEW: Ambiguous"];
// The category "TRANSFER: Wealthsimple" transactions/rules are rewritten to, wherever they're loaded
// from (autosave or a JSON backup) - see migrateWealthsimpleTransactions / migrateWealthsimpleLookup /
// ensureWealthsimpleCategory below. Plain, prefix-free, like every other spending category.
const WEALTHSIMPLE_CATEGORY = "Investing";
const LEGACY_WEALTHSIMPLE_CATEGORY = "TRANSFER: Wealthsimple";
// Spending categories are freely editable - this is the default set, seeded from your audited history.
const DEFAULT_SPENDING_CATEGORIES = ["Giving","Groceries","Dining","Health","Pharmacy","Subscriptions","Telecom","Gym",
  "Apparel & Gear","Online Marketplace","Transport","Shipping (US mailbox)","Education",
  WEALTHSIMPLE_CATEGORY, "Convenience","Household","Personal Care","Events & Hobbies","Military","Debt Repayment","General Retail"];
const NON_SPEND = new Set(SYSTEM_CATEGORIES);
const INCOME_CATS = new Set(["INCOME: Employment","INCOME: Benefits","INCOME: Reimbursement","INCOME: Resale"]);

// --- v4.1 one-time data migration: fold the old "TRANSFER: Wealthsimple" category forward into the
// new "Investing" spending category, wherever ledger data gets loaded from. Three small, independent
// pieces rather than one combined function, since transactions/lookup/spendingCategories don't always
// arrive together (a JSON backup can supply just one of them).
function migrateWealthsimpleTransactions(transactions) {
  return transactions.map(t => (t.category === LEGACY_WEALTHSIMPLE_CATEGORY ? { ...t, category: WEALTHSIMPLE_CATEGORY } : t));
}
function migrateWealthsimpleLookup(lookup) {
  return lookup.map(([key, cat]) => (cat === LEGACY_WEALTHSIMPLE_CATEGORY ? [key, WEALTHSIMPLE_CATEGORY] : [key, cat]));
}
function ensureWealthsimpleCategory(spendingCategories) {
  return spendingCategories.includes(WEALTHSIMPLE_CATEGORY) ? spendingCategories : [...spendingCategories, WEALTHSIMPLE_CATEGORY];
}

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function isValidDateString(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !isNaN(new Date(t).getTime());
}

function isValidTransaction(t) {
  return t && typeof t === "object"
    && isValidDateString(t.date)
    && (typeof t.merchant === "string" || typeof t.description === "string")
    && Number.isFinite(t.amount)
    && (t.category === null || t.category === undefined || typeof t.category === "string")
    // splitParentId is optional and additive - old data simply won't have it, and a row that has
    // it is a "split child": one of two-or-more rows a single original transaction was divided
    // into across categories (see splitTransaction/mergeSplitGroup below). It's the id the parent
    // row had before the split replaced it, which stays a safe, never-reused reference even after
    // that row is gone, since computeNextId only ever hands out ids larger than any id seen so far.
    && (t.splitParentId === null || t.splitParentId === undefined || Number.isFinite(t.splitParentId));
}
// True for a transaction that's one part of a split - grouped with its siblings by splitParentId
// (the original, now-retired transaction id they were divided out of).
function isSplitChild(t) {
  return Number.isFinite(t.splitParentId);
}

// A regex-shaped key (see REGEX_RULE_SHAPE) is still just a string, so it's already covered here
// without any change - this deliberately doesn't also require it to compile. An invalid saved regex
// is a "rule that never matches" (see categorize/parseRegexRule), not corrupt data to be rejected -
// the same way the rest of this app prefers "falls back to a safe default" over "refuses to load."
function isValidLookupEntry(e) {
  return Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string";
}

const BUDGET_NUMERIC_KEYS = ["portfolio","osap","incoming","aafcMonthly","reserveLow","reserveHigh","tithe",
  "gym","carInsurance","mealPrep","subs","phone","discretionary","monthsRemaining","targetFloor","targetMid","targetStretch"];
function isValidCommittedCost(c) {
  return c && typeof c === "object" && typeof c.label === "string" && Number.isFinite(c.amount);
}
// A net worth line is either an asset (portfolio, cash, incoming money) or a liability (debt owed) -
// the "type" tag is what lets a dynamic list replace the old fixed portfolio/osap/incoming fields
// while still being able to compute net position (assets minus liabilities) generically.
function isValidNetWorthItem(i) {
  return i && typeof i === "object" && typeof i.label === "string" && Number.isFinite(i.amount)
    && (i.type === "asset" || i.type === "liability");
}
// An income stream carries a low/high monthly estimate rather than a single number, so a fixed,
// guaranteed source (low === high) and a variable one (e.g. reservist pay) use the same shape.
function isValidIncomeStream(i) {
  return i && typeof i === "object" && typeof i.label === "string" && Number.isFinite(i.low) && Number.isFinite(i.high);
}
// A target scenario is a named net-position goal (e.g. "Floor", "Mid", a custom one) - the dynamic
// replacement for the old fixed targetFloor/targetMid/targetStretch trio (see migrateBudget below).
function isValidTargetScenario(t) {
  return t && typeof t === "object" && typeof t.label === "string" && Number.isFinite(t.amount);
}
function isValidBudget(b) {
  if (!b || typeof b !== "object") return false;
  const numericOk = BUDGET_NUMERIC_KEYS.every(k => !(k in b) || Number.isFinite(b[k]));
  const committedOk = !("committedCosts" in b) || (Array.isArray(b.committedCosts) && b.committedCosts.every(isValidCommittedCost));
  const netWorthOk = !("netWorthItems" in b) || (Array.isArray(b.netWorthItems) && b.netWorthItems.every(isValidNetWorthItem));
  const incomeOk = !("incomeStreams" in b) || (Array.isArray(b.incomeStreams) && b.incomeStreams.every(isValidIncomeStream));
  const targetsOk = !("targetScenarios" in b) || (Array.isArray(b.targetScenarios) && b.targetScenarios.every(isValidTargetScenario));
  return numericOk && committedOk && netWorthOk && incomeOk && targetsOk;
}
// Upgrades any older budget shape into the current one, in place, without dropping data:
//   - flat gym/carInsurance/mealPrep/subs/phone fields         -> committedCosts list (v2)
//   - flat portfolio/osap/incoming fields                      -> netWorthItems list (v3)
//   - flat aafcMonthly/reserveLow/reserveHigh fields            -> incomeStreams list (v3)
//   - flat targetFloor/targetMid/targetStretch fields          -> targetScenarios list (v5)
// Each migration is independent and only runs if its target list isn't already present, so this is
// safe to call on a v1 backup, a v2/v3/v4 backup or localStorage save, or an already-current v5
// budget alike - every generation upgrades to v5 in one pass, nothing is lost, and calling it again
// on an already-migrated budget is a no-op for that section.
function migrateBudget(b) {
  const {
    gym, carInsurance, mealPrep, subs, phone,
    portfolio, osap, incoming, aafcMonthly, reserveLow, reserveHigh,
    targetFloor, targetMid, targetStretch,
    ...migrated
  } = b;

  if (Array.isArray(b.committedCosts)) {
    migrated.committedCosts = b.committedCosts;
  } else {
    const committedCosts = [];
    let id = 1;
    [["gym", "Gym", gym], ["carInsurance", "Car insurance", carInsurance], ["mealPrep", "Meal prep", mealPrep],
     ["subs", "Subscriptions", subs], ["phone", "Phone", phone]].forEach(([, label, amount]) => {
      if (Number.isFinite(amount)) committedCosts.push({ id: id++, label, amount });
    });
    migrated.committedCosts = committedCosts;
  }

  if (Array.isArray(b.netWorthItems)) {
    migrated.netWorthItems = b.netWorthItems;
  } else {
    const netWorthItems = [];
    let id = 1;
    if (Number.isFinite(portfolio)) netWorthItems.push({ id: id++, label: "Portfolio", amount: portfolio, type: "asset" });
    if (Number.isFinite(incoming)) netWorthItems.push({ id: id++, label: "Incoming to invest", amount: incoming, type: "asset" });
    if (Number.isFinite(osap)) netWorthItems.push({ id: id++, label: "OSAP", amount: osap, type: "liability" });
    migrated.netWorthItems = netWorthItems;
  }

  if (Array.isArray(b.incomeStreams)) {
    migrated.incomeStreams = b.incomeStreams;
  } else {
    const incomeStreams = [];
    let id = 1;
    if (Number.isFinite(aafcMonthly)) incomeStreams.push({ id: id++, label: "AAFC", low: aafcMonthly, high: aafcMonthly });
    if (Number.isFinite(reserveLow) || Number.isFinite(reserveHigh)) {
      const low = Number.isFinite(reserveLow) ? reserveLow : 0;
      const high = Number.isFinite(reserveHigh) ? reserveHigh : low;
      incomeStreams.push({ id: id++, label: "Reserve", low, high });
    }
    migrated.incomeStreams = incomeStreams;
  }

  if (Array.isArray(b.targetScenarios)) {
    migrated.targetScenarios = b.targetScenarios;
  } else {
    const targetScenarios = [];
    let id = 1;
    [["Floor", targetFloor], ["Mid", targetMid], ["Stretch", targetStretch]].forEach(([label, amount]) => {
      if (Number.isFinite(amount)) targetScenarios.push({ id: id++, label, amount });
    });
    migrated.targetScenarios = targetScenarios;
  }

  return migrated;
}

// Safe accumulator for object-keyed aggregation - avoids prototype-chain surprises if a merchant
// or category string ever collided with a built-in key like "constructor" or "__proto__".
function freshTally() { return Object.create(null); }

// Array length only equals (max id + 1) while ids stay perfectly contiguous. The moment a delete
// feature removes an id from the middle of the array, length and max-id diverge - deriving the next
// id from length would then hand out an id that already exists. This is safe regardless of gaps.
// Written as a loop rather than Math.max(...ids) so it can't blow the call stack on a large import.
function computeNextId(transactions) {
  let max = -1;
  for (const t of transactions) { if (Number.isFinite(t.id) && t.id > max) max = t.id; }
  return max + 1;
}

// Longest key wins - keeps priority correct (e.g. "amazon.ca prime" before "amazon.ca") without
// the person having to think about manual ordering when they add or edit a rule.
function sortLookup(entries) {
  return [...entries].sort((a, b) => b[0].length - a[0].length);
}

// Default budget assumptions used only when nothing has been saved to this browser yet (first run,
// or a cleared/private profile). Everything here is freely editable from the Budget tab afterward.
const DEFAULT_BUDGET = {
  tithe: 0.10, discretionary: 0, monthsRemaining: 1,
  committedCosts: [],
  netWorthItems: [],
  incomeStreams: [],
  targetScenarios: [],
};

// All persisted state lives under one localStorage key, in the same shape as a manual JSON backup,
// so the two paths (autosave and Export/Import) stay easy to reason about together.
const STORAGE_KEY = "ledger:autosave:v1";

// Reads and validates whatever this browser has saved. Runs once per page load: the result is cached
// at module scope so the four separate useState lazy-initializers below don't each re-parse the same
// JSON. Wrapped end-to-end in try/catch because localStorage access itself can throw (private/blocked
// browsing contexts), not just JSON.parse - any failure here just falls back to empty/default state
// rather than crashing the app.
let _persistedCache = null;
function readPersistedStore() {
  if (_persistedCache) return _persistedCache;
  _persistedCache = { transactions: null, lookup: null, spendingCategories: null, budget: null, recurringConfig: null, dashboardLayout: null };
  try {
    if (typeof window === "undefined" || !window.localStorage) return _persistedCache;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return _persistedCache;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return _persistedCache;
    if (Array.isArray(parsed.transactions) && parsed.transactions.every(isValidTransaction)) {
      const reidentified = parsed.transactions.map((t, i) => (Number.isFinite(t.id) ? t : { ...t, id: i }));
      _persistedCache.transactions = migrateWealthsimpleTransactions(reidentified);
    }
    if (Array.isArray(parsed.lookup) && parsed.lookup.every(isValidLookupEntry)) {
      _persistedCache.lookup = sortLookup(migrateWealthsimpleLookup(parsed.lookup));
    }
    if (Array.isArray(parsed.spendingCategories) && parsed.spendingCategories.every(c => typeof c === "string")) {
      _persistedCache.spendingCategories = ensureWealthsimpleCategory(parsed.spendingCategories);
    }
    if (parsed.budget && isValidBudget(parsed.budget)) {
      _persistedCache.budget = migrateBudget(parsed.budget);
    }
    if (parsed.recurringConfig && isValidRecurringConfig(parsed.recurringConfig)) {
      _persistedCache.recurringConfig = parsed.recurringConfig;
    }
    if (parsed.dashboardLayout && isValidDashboardLayout(parsed.dashboardLayout)) {
      _persistedCache.dashboardLayout = normalizeDashboardLayout(parsed.dashboardLayout);
    }
  } catch (err) {
    console.warn("Ledger: couldn't read saved data from this browser - starting from empty state.", err);
  }
  return _persistedCache;
}

function fingerprint(t) {
  const amt = Number.isFinite(t.amount) ? t.amount.toFixed(2) : "NaN";
  return `${t.date}|${normalize(t.merchant || t.description || "")}|${amt}`;
}

// Count-based dedup: if a fingerprint already appears N times in committed transactions, only the
// (count - N)th and later occurrences in the new batch are treated as genuinely new. This correctly
// handles re-selecting the same folder (everything already committed gets skipped) and handles two
// real same-day, same-amount charges at the same merchant (both get kept, since only one is "used up"
// by the existing committed row). It can't perfectly distinguish those two situations from a third,
// rarer one - a new statement that happens to reintroduce an old date+merchant+amount combination
// that was never actually a duplicate - so the count is surfaced to you rather than applied silently.
function dedupeAgainstCommitted(rows, committed) {
  const committedCounts = freshTally();
  committed.forEach(t => {
    const fp = fingerprint(t);
    committedCounts[fp] = (committedCounts[fp] || 0) + 1;
  });
  const seenThisBatch = freshTally();
  const kept = [];
  let duplicateCount = 0;
  rows.forEach(r => {
    const fp = fingerprint(r);
    seenThisBatch[fp] = (seenThisBatch[fp] || 0) + 1;
    const allowance = committedCounts[fp] || 0;
    if (seenThisBatch[fp] <= allowance) {
      duplicateCount++;
    } else {
      kept.push(r);
    }
  });
  return { kept, duplicateCount };
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_ROWS = 200000;
const MAX_PASTE_LINES = 5000;

// A lookup key wrapped in slashes with optional trailing flags (e.g. "/^uber\s*eats/i") is a regex
// rule instead of a plain substring - detected by shape alone, not a stored flag, so the existing
// [key, category] tuple doesn't need a new field and every pre-v6.3 key (which never starts with
// "/") is automatically and correctly treated as plain text.
const REGEX_RULE_SHAPE = /^\/(.*)\/([a-z]*)$/;
function isRegexRuleKey(key) {
  return typeof key === "string" && REGEX_RULE_SHAPE.test(key);
}
// Compiles a regex-shaped key, or returns null for anything that isn't shaped like one, or is shaped
// like one but doesn't actually compile (e.g. an unbalanced "(" from a typo, or an invalid flag).
// `new RegExp` throws SyntaxError on bad input - caught here so one malformed saved rule can never
// crash categorization for every transaction that runs after it. Callers treat null exactly like "this
// rule never matches" rather than trying to distinguish "not a regex" from "invalid regex" further.
function parseRegexRule(key) {
  if (typeof key !== "string") return null;
  const m = REGEX_RULE_SHAPE.exec(key);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    // Invalid pattern syntax is routine, expected user input here (not an environment failure worth
    // logging like the other catches in this file) - silently treated as "never matches."
    return null;
  }
}

// lookup is an array of [key, category] pairs, longest-key-first (see sortLookup). A transaction
// matches the FIRST key it hits, so more specific plain keys (e.g. "amazon.ca prime") must be listed
// before broader ones (e.g. "amazon.ca") or the broad key wins by accident.
//
// A regex-shaped key (see REGEX_RULE_SHAPE above) is tested against the RAW merchant text, not the
// normalized/lowercased text a plain substring key matches against - that's what lets the rule's own
// flags (e.g. including or omitting /i) actually control case sensitivity, the way a hand-written
// regex normally would. An invalid regex-shaped key just never matches (parseRegexRule already caught
// the construction error) and categorization moves on to the next rule, rather than falling back to a
// literal substring search for something like "/uber(/i" that could never usefully match anyway.
function categorize(merchant, lookupEntries) {
  const raw = String(merchant || "");
  const text = normalize(merchant);
  for (const [key, cat] of lookupEntries) {
    if (isRegexRuleKey(key)) {
      const regex = parseRegexRule(key);
      if (regex && regex.test(raw)) return { category: cat, norm: key, matched: true };
      continue;
    }
    if (text.includes(key)) return { category: cat, norm: key, matched: true };
  }
  return { category: null, norm: text, matched: false };
}

// Tunable thresholds for detectRecurring below - user-editable from Settings > Recurring detection,
// persisted alongside the rest of the settings store. Defaults reproduce the original hardcoded
// behavior exactly (>=3 occurrences, 10-18 day gaps flagged Biweekly, 19-35 day gaps flagged Monthly).
const DEFAULT_RECURRING_CONFIG = { minOccurrences: 3, biweeklyMin: 10, biweeklyMax: 18, monthlyMin: 19, monthlyMax: 35 };
function isValidRecurringConfig(c) {
  return c && typeof c === "object"
    && Number.isFinite(c.minOccurrences) && c.minOccurrences >= 1
    && Number.isFinite(c.biweeklyMin) && Number.isFinite(c.biweeklyMax) && c.biweeklyMin <= c.biweeklyMax
    && Number.isFinite(c.monthlyMin) && Number.isFinite(c.monthlyMax) && c.monthlyMin <= c.monthlyMax;
}

// The two day-gap windows are checked independently (not one merged range with a midpoint split) so
// narrowing one window in Settings can't silently widen or shrink the other, and a gap between the
// two windows correctly stops matching anything rather than falling back to "Monthly" by default.
function detectRecurring(transactions, config) {
  const cfg = { ...DEFAULT_RECURRING_CONFIG, ...config };
  const byMerchant = freshTally();
  transactions.forEach(t => {
    const key = t.merchant;
    if (!byMerchant[key]) byMerchant[key] = [];
    byMerchant[key].push(t);
  });
  const results = [];
  Object.entries(byMerchant).forEach(([merchant, txns]) => {
    if (txns.length < cfg.minOccurrences) return;
    const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));
    const deltas = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = (new Date(sorted[i].date) - new Date(sorted[i - 1].date)) / 86400000;
      deltas.push(d);
    }
    const avgInt = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const inBiweekly = avgInt >= cfg.biweeklyMin && avgInt <= cfg.biweeklyMax;
    const inMonthly = avgInt >= cfg.monthlyMin && avgInt <= cfg.monthlyMax;
    if (inBiweekly || inMonthly) {
      const avgAmt = txns.reduce((a, b) => a + Math.abs(b.amount), 0) / txns.length;
      results.push({ merchant, count: txns.length, avgAmt, avgInt, flag: inBiweekly ? "Biweekly" : "Monthly" });
    }
  });
  return results.sort((a, b) => b.count - a.count);
}

// The Dashboard's customizable sections - fixed vocabulary of ids the app knows how to render, each
// with a stable id (persisted) and a display label (shown in the "Customize layout" panel and used
// to build the default order below). Adding a new dashboard section in a future version means adding
// one entry here; normalizeDashboardLayout (below) then folds it into any already-saved layout.
const DASHBOARD_SECTIONS = [
  { id: "summaryCards", label: "Summary metric cards" },
  { id: "trendLine", label: "Monthly spend vs. income trend line" },
  { id: "cumulativeNet", label: "Cumulative net position area chart" },
  { id: "spendSharePie", label: "Spend share pie chart" },
  { id: "incomeBar", label: "Income by source bar chart" },
  { id: "categoryBar", label: "Category spend vertical bar chart" },
  { id: "recurringBills", label: "Recurring bills detected table" },
];
const DASHBOARD_SECTION_IDS = new Set(DASHBOARD_SECTIONS.map(s => s.id));
const DEFAULT_DASHBOARD_LAYOUT = DASHBOARD_SECTIONS.map(s => ({ id: s.id, visible: true }));

function isValidDashboardLayoutEntry(item) {
  return item && typeof item === "object" && typeof item.id === "string" && typeof item.visible === "boolean";
}
function isValidDashboardLayout(l) {
  return Array.isArray(l) && l.every(isValidDashboardLayoutEntry);
}
// Repairs a saved layout against the app's current section vocabulary: drops any id the app no
// longer recognizes, dedups (first occurrence wins), and appends any section the app knows about but
// the saved layout doesn't mention (a newer app version added it, or it was never saved) as visible
// at the end - so upgrading never silently loses a whole section from view. Applied on every load
// path (autosave and manual import) the same way ensureWealthsimpleCategory is.
function normalizeDashboardLayout(layout) {
  if (!Array.isArray(layout)) return DEFAULT_DASHBOARD_LAYOUT;
  const seen = new Set();
  const kept = [];
  layout.forEach(item => {
    if (item && typeof item === "object" && DASHBOARD_SECTION_IDS.has(item.id) && !seen.has(item.id)) {
      seen.add(item.id);
      kept.push({ id: item.id, visible: typeof item.visible === "boolean" ? item.visible : true });
    }
  });
  DASHBOARD_SECTIONS.forEach(s => { if (!seen.has(s.id)) kept.push({ id: s.id, visible: true }); });
  return kept;
}

const card = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "14px", padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" };
const label = { fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" };
const num = { fontVariantNumeric: "tabular-nums" };
const statBig = { fontSize: "26px", fontWeight: 600, letterSpacing: "-0.01em", ...num };
const statSmall = { fontSize: "18px", fontWeight: 600, letterSpacing: "-0.005em", ...num };
const btn = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "var(--radius)", border: "1px solid var(--border-strong)", background: "var(--surface-1)", color: "var(--text-primary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" };
const btnPrimary = { ...btn, background: "var(--text-accent)", color: "#fff", border: "1px solid var(--text-accent)" };
const input = { width: "100%", padding: "8px 10px", borderRadius: "var(--radius)", border: "1px solid var(--border)", fontSize: "13px", background: "var(--surface-2)", color: "var(--text-primary)", boxSizing: "border-box" };
const th = { textAlign: "left", padding: "10px 12px", fontSize: "11px", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td = { padding: "10px 12px", fontSize: "13px", borderBottom: "1px solid var(--border)" };

// Preference key, kept separate from the financial-data STORAGE_KEY above - theme is a per-browser
// display preference, not ledger data, so it deliberately isn't included in JSON export/import.
const THEME_KEY = "ledger:theme:v1";

// Defines the light palette on .ledger-root and overrides it on .ledger-root[data-theme="dark"], plus
// a handful of interaction states (hover/focus/active) that inline styles can't express on their own.
// Self-contained on purpose: the app doesn't assume an external stylesheet already has a dark palette
// for these variables, so the toggle works whether this file is dropped into a fresh Vite project or
// rendered somewhere that only ever supplied light-mode values.
const THEME_CSS = `
.ledger-root {
  --surface-0: #f7f6f3; --surface-1: #ffffff; --surface-2: #f3f1ec;
  --border: #e6e3dc; --border-strong: #d3cfc4; --border-warning: #e3b756;
  --text-primary: #23211d; --text-secondary: #6f6b61; --text-muted: #969184;
  --text-accent: #b8502d; --text-success: #17805f; --text-warning: #96691a; --text-danger: #b8402b;
  --bg-accent: #f7e7de; --bg-success: #e1f2ea; --bg-warning: #faf0d8;
  --radius: 10px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.ledger-root[data-theme="dark"] {
  --surface-0: #161513; --surface-1: #1e1c19; --surface-2: #27241f;
  --border: #38352e; --border-strong: #4a453b; --border-warning: #6b5423;
  --text-primary: #f2efe9; --text-secondary: #ada89d; --text-muted: #79756a;
  --text-accent: #e58156; --text-success: #4fc498; --text-warning: #dcae52; --text-danger: #e37360;
  --bg-accent: #3a2a20; --bg-success: #1b3129; --bg-warning: #392c14;
}
.ledger-root, .ledger-root * { transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.ledger-root button { cursor: pointer; }
.ledger-root button:hover:not(:disabled) { filter: brightness(0.95); }
.ledger-root[data-theme="dark"] button:hover:not(:disabled) { filter: brightness(1.2); }
.ledger-root button:active:not(:disabled) { transform: translateY(1px); }
.ledger-root button:disabled { cursor: default; opacity: 0.55; }
.ledger-root input:focus, .ledger-root select:focus, .ledger-root textarea:focus {
  outline: none; border-color: var(--text-accent); box-shadow: 0 0 0 3px var(--bg-accent);
}
.ledger-root table tbody tr:hover td { background: var(--surface-2); }
.ledger-root .ledger-tabs button { border-radius: 8px 8px 0 0; }
.ledger-root .ledger-tabs button:hover { background: var(--surface-2) !important; }
`;

// Print stylesheet for the Dashboard's "Print / Save PDF" export. Standard print-one-section trick:
// hide the whole page, then re-reveal only .ledger-root and its children, so this works regardless of
// what else the app is embedded inside. .ledger-no-print is reserved for genuine chrome that should
// never print regardless of layout settings (header, tabs, the filter/customize/export bar) - which
// Dashboard sections actually print is governed entirely by dashboardLayout (see DASHBOARD_SECTIONS
// below): a hidden section simply isn't rendered into the DOM at all, so it can't appear in print
// either, and visible sections print in the exact order the person arranged them in.
const PRINT_CSS = `
.ledger-print-only { display: none; }
@media print {
  body * { visibility: hidden; }
  .ledger-root, .ledger-root * { visibility: visible; }
  .ledger-root { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
  .ledger-no-print { display: none !important; }
  .ledger-print-only { display: block !important; }
  @page { margin: 0.75in; }
}
`;

function CategoryBadge({ category }) {
  let bg = "var(--bg-accent)", fg = "var(--text-accent)";
  if (INCOME_CATS.has(category)) { bg = "var(--bg-success)"; fg = "var(--text-success)"; }
  else if (category && category.startsWith("TRANSFER")) { bg = "var(--surface-0)"; fg = "var(--text-muted)"; }
  else if (category === "REVIEW: Ambiguous" || !category) { bg = "var(--bg-warning)"; fg = "var(--text-warning)"; }
  return <span style={{ background: bg, color: fg, fontSize: "11px", padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap" }}>{category || "unmatched"}</span>;
}

// Shown when a CSV's headers don't obviously map to Date/Description/Merchant/Amount - lets the
// person point at the actual columns instead of the upload silently failing or guessing wrong.
function CSVMappingPanel({ mapping, onConfirm, onCancel }) {
  const [picks, setPicks] = useState({ date: "", description: "", merchant: "", amount: "" });
  const ready = picks.date && picks.amount;
  return (
    <div style={{ ...card, borderColor: "var(--border-warning)" }}>
      <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "6px" }}>
        <AlertCircle size={15} color="var(--text-warning)" style={{ verticalAlign: "-2px", marginRight: "6px" }} />
        Couldn't auto-detect columns in "{mapping.filename}"
      </div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>Match each field to a column from this file. Date and Amount are required.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", marginBottom: "12px" }}>
        {["date", "description", "merchant", "amount"].map(field => (
          <div key={field}>
            <div style={label}>{field[0].toUpperCase() + field.slice(1)}{(field === "date" || field === "amount") ? " *" : ""}</div>
            <select value={picks[field]} onChange={e => setPicks(p => ({ ...p, [field]: e.target.value }))} style={input}>
              <option value="">-- choose column --</option>
              {mapping.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button style={btn} onClick={onCancel}>Cancel</button>
        <button style={{ ...btnPrimary, opacity: ready ? 1 : 0.5 }} disabled={!ready} onClick={() => onConfirm(picks)}>Use this mapping</button>
      </div>
    </div>
  );
}

// Row-level split editor: replaces a transaction's row in the Log table while it's being split
// across two or more categories (e.g. one $200 superstore charge -> $150 Groceries + $50 Household).
// Local state resets fresh every time this mounts (starting/cancelling a split unmounts it), so there's
// no stale-draft cleanup to worry about between rows. Amounts are compared in whole cents rather than
// as floats, so the "must sum exactly to the original" rule can't be foiled by binary floating-point
// drift (e.g. 150.10 + 49.90 failing a naive === check against 200).
function SplitEditor({ txn, categories, onSave, onCancel }) {
  const [parts, setParts] = useState(() => [
    { key: 0, category: "", amount: txn.amount.toFixed(2) },
    { key: 1, category: "", amount: "0.00" },
  ]);
  const nextKey = useRef(2);

  function updatePart(key, field, value) {
    setParts(prev => prev.map(p => (p.key === key ? { ...p, [field]: value } : p)));
  }
  function addPart() {
    setParts(prev => [...prev, { key: nextKey.current++, category: "", amount: "0.00" }]);
  }
  function removePart(key) {
    setParts(prev => (prev.length > 2 ? prev.filter(p => p.key !== key) : prev));
  }

  const parsedAmounts = parts.map(p => parseFloat(p.amount));
  const allAmountsValid = parsedAmounts.every(a => Number.isFinite(a));
  const allCategorized = parts.every(p => p.category);
  const targetCents = Math.round(txn.amount * 100);
  const sumCents = allAmountsValid ? parsedAmounts.reduce((s, a) => s + Math.round(a * 100), 0) : null;
  const sumMatches = allAmountsValid && sumCents === targetCents;
  const remainingCents = allAmountsValid ? targetCents - sumCents : null;
  const canSave = allAmountsValid && allCategorized && sumMatches;

  return (
    <div style={{ padding: "10px 4px" }}>
      <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "8px" }}>
        Splitting {txn.date} · {txn.merchant} · {txn.amount < 0 ? "-" : "+"}${Math.abs(txn.amount).toFixed(2)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {parts.map(p => (
          <div key={p.key} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <select value={p.category} onChange={e => updatePart(p.key, "category", e.target.value)}
              style={{ ...input, width: "220px", borderColor: !p.category ? "var(--border-warning)" : "var(--border)" }}>
              <option value="">Choose category...</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" step="0.01" value={p.amount} onChange={e => updatePart(p.key, "amount", e.target.value)} style={{ ...input, width: "120px", textAlign: "right" }} />
            <button type="button" style={{ ...btn, padding: "4px 8px", opacity: parts.length <= 2 ? 0.4 : 1 }} disabled={parts.length <= 2} onClick={() => removePart(p.key)} title="Remove part"><X size={13} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", flexWrap: "wrap", gap: "8px" }}>
        <button type="button" style={{ ...btn, padding: "4px 10px" }} onClick={addPart}><Plus size={13} /> Add part</button>
        <span style={{ fontSize: "12px", color: sumMatches ? "var(--text-success)" : "var(--text-warning)" }}>
          {!allAmountsValid ? "Enter a valid amount for every part."
            : sumMatches ? "Splits sum to the original amount."
            : remainingCents > 0 ? `$${(remainingCents / 100).toFixed(2)} left to allocate`
            : `$${(Math.abs(remainingCents) / 100).toFixed(2)} over the original amount`}
        </span>
      </div>
      <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
        <button type="button" style={{ ...btnPrimary, opacity: canSave ? 1 : 0.5 }} disabled={!canSave}
          onClick={() => onSave(parts.map(p => ({ category: p.category, amount: parseFloat(p.amount) })))}>
          <Check size={14} /> Save split
        </button>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Dashboard category filter: a checklist popover rather than a native <select multiple>, since
// picking several non-adjacent categories out of two dozen is painful with a native multi-select.
// "excluded" (not "included") is tracked so a category added later in Settings is included by
// default automatically - it just never entered the excluded set - instead of needing to be synced in.
function CategoryFilterMenu({ categories, excluded, onToggle, onSelectAll, onClear }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selectedCount = categories.length - excluded.size;
  const summary = excluded.size === 0 ? "All categories" : selectedCount === 0 ? "No categories" : `${selectedCount} of ${categories.length} categories`;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button type="button" style={btn} onClick={() => setOpen(o => !o)}>
        {summary} <ChevronDown size={14} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "0 10px 28px rgba(0,0,0,0.16)", padding: "10px", width: "250px", maxHeight: "340px", overflowY: "auto" }}>
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <button type="button" style={{ ...btn, padding: "4px 10px", flex: 1, justifyContent: "center" }} onClick={onSelectAll}>Select all</button>
            <button type="button" style={{ ...btn, padding: "4px 10px", flex: 1, justifyContent: "center" }} onClick={onClear}>Clear</button>
          </div>
          {categories.map(c => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", padding: "5px 2px", cursor: "pointer" }}>
              <input type="checkbox" checked={!excluded.has(c)} onChange={() => onToggle(c)} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</span>
            </label>
          ))}
          {categories.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)", padding: "4px 2px" }}>No categories yet.</div>}
        </div>
      )}
    </div>
  );
}

// Dashboard "Export summary" button: a small popover offering CSV download vs. print/PDF, same
// open/outside-click pattern as CategoryFilterMenu above.
function ExportSummaryMenu({ onExportCSV, onPrint }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button type="button" style={btn} onClick={() => setOpen(o => !o)}><Download size={14} /> Export summary <ChevronDown size={14} /></button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "0 10px 28px rgba(0,0,0,0.16)", padding: "6px", width: "210px" }}>
          <button type="button" style={{ ...btn, width: "100%", justifyContent: "flex-start", border: "none", padding: "8px 10px" }} onClick={() => { onExportCSV(); setOpen(false); }}><Download size={13} /> Download CSV</button>
          <button type="button" style={{ ...btn, width: "100%", justifyContent: "flex-start", border: "none", padding: "8px 10px", marginTop: "4px" }} onClick={() => { onPrint(); setOpen(false); }}><Printer size={13} /> Print / Save PDF</button>
        </div>
      )}
    </div>
  );
}

// Dashboard "Customize layout" button: a popover listing every dashboard section with a visibility
// checkbox and Move up/down arrows. This is the single source of truth for both what renders on
// screen and what appears in Print/PDF (see PRINT_CSS above) - a hidden section here is simply never
// rendered, in either context, and the on-screen order and print order always match.
function DashboardLayoutMenu({ sections, layout, onToggleVisible, onMoveUp, onMoveDown, onReset }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const labelFor = (id) => sections.find(s => s.id === id)?.label || id;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button type="button" style={btn} onClick={() => setOpen(o => !o)}><LayoutGrid size={14} /> Customize layout <ChevronDown size={14} /></button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "0 10px 28px rgba(0,0,0,0.16)", padding: "12px", width: "340px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>Dashboard sections</span>
            <button type="button" style={{ ...btn, padding: "4px 8px", fontSize: "12px" }} onClick={onReset}>Reset to default</button>
          </div>
          <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "0 0 10px" }}>Show, hide, and reorder what appears on the Dashboard - this also controls what's included in Print/PDF.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {layout.map((item, i) => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 2px" }}>
                <input type="checkbox" checked={item.visible} onChange={() => onToggleVisible(item.id)} />
                <span style={{ flex: 1, fontSize: "13px", opacity: item.visible ? 1 : 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelFor(item.id)}</span>
                <button type="button" style={{ ...btn, padding: "3px 6px", opacity: i === 0 ? 0.4 : 1 }} disabled={i === 0} onClick={() => onMoveUp(item.id)} title="Move up"><ArrowUp size={12} /></button>
                <button type="button" style={{ ...btn, padding: "3px 6px", opacity: i === layout.length - 1 ? 0.4 : 1 }} disabled={i === layout.length - 1} onClick={() => onMoveDown(item.id)} title="Move down"><ArrowDown size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Ledger() {
  // Loaded once from this browser's localStorage (see readPersistedStore above), falling back to
  // empty/default state on a first run. Lazy initializers so this only runs on mount, not every render.
  const persisted = readPersistedStore();
  const [transactions, setTransactions] = useState(() => persisted.transactions || []);
  const [lookup, setLookup] = useState(() => persisted.lookup || []);
  const [spendingCategories, setSpendingCategories] = useState(() => persisted.spendingCategories || DEFAULT_SPENDING_CATEGORIES);
  const [tab, setTab] = useState("log");
  // Falls back to the OS-level preference on a first visit (no saved choice yet), then remembers
  // whatever the person picks from here on, independent of that OS preference.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (err) { /* localStorage/matchMedia unavailable (private/blocked browsing) - default to light */ }
    return "light";
  });
  const [pasteText, setPasteText] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [budget, setBudget] = useState(() => persisted.budget || DEFAULT_BUDGET);
  const [recurringConfig, setRecurringConfig] = useState(() => persisted.recurringConfig || DEFAULT_RECURRING_CONFIG);
  const [dashboardLayout, setDashboardLayout] = useState(() => persisted.dashboardLayout || DEFAULT_DASHBOARD_LAYOUT);
  const [pendingMapping, setPendingMapping] = useState(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const nextCostId = useRef(computeNextId(budget.committedCosts));
  const nextNetWorthId = useRef(computeNextId(budget.netWorthItems));
  const nextIncomeStreamId = useRef(computeNextId(budget.incomeStreams));
  const nextTargetId = useRef(computeNextId(budget.targetScenarios));
  const nextId = useRef(computeNextId(transactions));
  const allCategories = useMemo(() => [...spendingCategories, ...SYSTEM_CATEGORIES], [spendingCategories]);

  const nextStageId = useRef(0);

  // Every new statement lands in staging first - nothing reaches the permanent log until confirmed.
  const [staging, setStaging] = useState([]);
  // Tracks the ids committed by the most recent commitStaging batch (or null once undone/dismissed/
  // replaced by a newer import), so the Log tab can offer a one-click "Undo last import" that rolls
  // back exactly that batch - not "delete everything", and not tied to any particular file/paste source.
  const [lastImportBatch, setLastImportBatch] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Suppresses the dirty-tracking effect for exactly one render: set to true right before importData
  // applies a batch of setters, so loading a backup doesn't immediately flag itself as "unsaved" the
  // instant it finishes loading. Also starts true so the initial mount (seed data) isn't flagged dirty.
  const suppressDirtyCheck = useRef(true);

  useEffect(() => {
    if (suppressDirtyCheck.current) { suppressDirtyCheck.current = false; return; }
    setHasUnsavedChanges(true);
  }, [transactions, lookup, budget, spendingCategories, recurringConfig, dashboardLayout]);

  useEffect(() => {
    function handleBeforeUnload(e) {
      if (hasUnsavedChanges || staging.length > 0) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges, staging.length]);

  const [storageWarning, setStorageWarning] = useState("");

  // Autosave: mirrors transactions/lookup/spendingCategories/budget into localStorage on every
  // change, in the same shape a manual JSON export uses. This is separate from hasUnsavedChanges -
  // that still tracks "backed up to a file since the last edit", which the autosave doesn't replace
  // (the browser's storage can still be cleared, e.g. a private window, so a real file backup matters).
  useEffect(() => {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ transactions, lookup, spendingCategories, budget, recurringConfig, dashboardLayout }));
      setStorageWarning("");
    } catch (err) {
      console.warn("Ledger: couldn't save to this browser's storage.", err);
      setStorageWarning("Changes aren't saving to this browser right now (storage may be full or blocked). Use Save backup below so nothing is lost.");
    }
  }, [transactions, lookup, spendingCategories, budget, recurringConfig, dashboardLayout]);

  // Persists the theme choice separately from the financial-data autosave above, so it's never part
  // of a JSON export/import - loading a backup on a different device shouldn't flip that device's
  // color scheme, and exporting a backup shouldn't leak a display preference into the file.
  useEffect(() => {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      console.warn("Ledger: couldn't save theme preference to this browser.", err);
    }
  }, [theme]);

  const [importWarning, setImportWarning] = useState("");

  function stageRows(rows) {
    const cleaned = rows.map(r => {
      const merchant = (r.merchant || r.description || "").toString().trim();
      const date = (r.date || "").toString().trim();
      const amount = parseFloat(r.amount);
      const { category, matched } = categorize(merchant, lookup);
      return {
        stageId: nextStageId.current++, date, description: r.description,
        merchant, amount, suggested: category, category: category || "", matched,
      };
    });
    const valid = cleaned.filter(r => isValidDateString(r.date) && Number.isFinite(r.amount) && r.merchant);
    const skipped = cleaned.length - valid.length;

    // Dedup against both what's already committed and what's already sitting in staging, so
    // re-selecting the same folder (or the same file twice) never creates duplicate entries.
    const { kept, duplicateCount } = dedupeAgainstCommitted(valid, [...transactions, ...staging]);

    const parts = [];
    if (skipped > 0) parts.push(`${skipped} row${skipped !== 1 ? "s" : ""} skipped - missing or unreadable date/amount`);
    if (duplicateCount > 0) parts.push(`${duplicateCount} duplicate row${duplicateCount !== 1 ? "s" : ""} already in your log, skipped`);
    setImportWarning(parts.join(". "));

    setStaging(prev => [...prev, ...kept]);
  }

  function extractRowsFromParsedCSV(res, filename) {
    const keys = res.data.length ? Object.keys(res.data[0]) : [];
    const find = (row, names) => { const k = keys.find(k => names.includes(k.toLowerCase().trim())); return k ? row[k] : ""; };
    const hasDate = keys.some(k => ["date"].includes(k.toLowerCase().trim()));
    const hasAmount = keys.some(k => ["amount"].includes(k.toLowerCase().trim()));
    if (!hasDate || !hasAmount) {
      return { needsMapping: true, headers: keys, rawRows: res.data, filename };
    }
    return {
      needsMapping: false,
      rows: res.data.map(row => ({
        date: find(row, ["date"]), description: find(row, ["description", "desc"]),
        merchant: find(row, ["merchant", "sub-description", "merchant/sub-description"]) || find(row, ["description"]),
        amount: find(row, ["amount"]),
      })),
    };
  }

  function handleCSV(file) {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      error: (err) => alert("Could not read that CSV file: " + err.message),
      complete: (res) => {
        if (!res.data || res.data.length === 0) {
          alert("That CSV didn't contain any rows Claude could read. Check it has Date, Description, Merchant, and Amount columns.");
          return;
        }
        const result = extractRowsFromParsedCSV(res, file.name);
        if (result.needsMapping) {
          setPendingMapping(result);
        } else {
          stageRows(result.rows);
        }
      },
    });
  }

  // Selecting a whole folder (<input webkitdirectory>) hands back every file inside it. Filter to
  // CSVs, parse each, combine, and run through the same staging + dedup pipeline as a single upload -
  // re-selecting the same folder later just re-runs this and dedup silently skips what's unchanged.
  function handleFolderSelect(fileList) {
    const csvFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) {
      alert("No .csv files found in that folder.");
      return;
    }
    let remaining = csvFiles.length;
    const allRows = [];
    const mappingNeeded = [];
    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          if (res.data && res.data.length > 0) {
            const result = extractRowsFromParsedCSV(res, file.name);
            if (result.needsMapping) mappingNeeded.push(result);
            else allRows.push(...result.rows);
          }
          remaining--;
          if (remaining === 0) {
            if (allRows.length) stageRows(allRows);
            if (mappingNeeded.length) {
              alert(`${mappingNeeded.length} file(s) couldn't be auto-read (no recognizable Date/Amount columns): ${mappingNeeded.map(m => m.filename).join(", ")}. Everything else was staged - you can add those separately.`);
            }
          }
        },
        error: () => { remaining--; },
      });
    });
  }

  function handlePasteAdd() {
    let lines = pasteText.trim().split("\n").filter(Boolean);
    const truncated = lines.length > MAX_PASTE_LINES;
    if (truncated) lines = lines.slice(0, MAX_PASTE_LINES);
    const rows = lines.map(line => {
      const parts = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.trim());
      return { date: parts[0], description: parts[1], merchant: parts[2] || parts[1], amount: parts[3] };
    });
    stageRows(rows);
    if (truncated) setImportWarning(prev => `Pasted content was capped at ${MAX_PASTE_LINES.toLocaleString()} lines. ${prev}`.trim());
    setPasteText("");
  }

  // Called once the person has manually matched CSV headers to fields, for a file auto-detection failed on.
  function confirmManualMapping(mapping) {
    if (!pendingMapping) return;
    const rows = pendingMapping.rawRows.map(row => ({
      date: row[mapping.date] || "", description: row[mapping.description] || "",
      merchant: (row[mapping.merchant] || row[mapping.description] || ""), amount: row[mapping.amount] || "",
    }));
    stageRows(rows);
    setPendingMapping(null);
  }


  function updateStagingCategory(stageId, category) {
    setStaging(prev => prev.map(r => r.stageId === stageId ? { ...r, category } : r));
  }

  function removeStagingRow(stageId) {
    setStaging(prev => prev.filter(r => r.stageId !== stageId));
  }

  function commitStaging() {
    // Upsert: the newest correction for a merchant replaces any older entry for the same key,
    // rather than piling a duplicate on top of it every time it's corrected again.
    const corrections = new Map();
    staging.forEach(r => {
      if (r.category && r.category !== r.suggested) {
        corrections.set(normalize(r.merchant), r.category);
      }
    });
    const committed = staging.map(r => ({
      id: nextId.current++, date: r.date, description: r.description,
      merchant: r.merchant, amount: r.amount, category: r.category || null,
    }));
    if (corrections.size) {
      setLookup(prev => sortLookup([...corrections.entries(), ...prev.filter(([k]) => !corrections.has(k))]));
    }
    setTransactions(prev => [...prev, ...committed]);
    // Replaces any previous batch - "last import" always means the one just committed, and any
    // row an earlier undo would have touched has either already been undone or is now moot.
    setLastImportBatch({ ids: new Set(committed.map(c => c.id)), count: committed.length });
    setStaging([]);
  }

  // Rolls back exactly the batch from the most recent commitStaging call, leaving every other
  // transaction (including anything added or edited since) untouched.
  function undoLastImport() {
    if (!lastImportBatch) return;
    setTransactions(prev => prev.filter(t => !lastImportBatch.ids.has(t.id)));
    setSelectedTxnIds(prev => {
      if (![...lastImportBatch.ids].some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      lastImportBatch.ids.forEach(id => next.delete(id));
      return next;
    });
    setLastImportBatch(null);
  }
  function dismissImportBatch() {
    setLastImportBatch(null);
  }

  function discardStaging() { setStaging([]); }

  // --- Category management ---
  function addCategory(name) {
    const trimmed = name.trim();
    if (!trimmed || allCategories.includes(trimmed)) return false;
    setSpendingCategories(prev => [...prev, trimmed]);
    return true;
  }
  function renameCategory(oldName, newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName || allCategories.includes(trimmed)) return false;
    setSpendingCategories(prev => prev.map(c => c === oldName ? trimmed : c));
    setTransactions(prev => prev.map(t => t.category === oldName ? { ...t, category: trimmed } : t));
    setLookup(prev => prev.map(([k, c]) => c === oldName ? [k, trimmed] : [k, c]));
    return true;
  }
  function removeCategory(name) {
    const affectedCount = transactions.filter(t => t.category === name).length;
    if (affectedCount > 0) {
      const ok = confirm(`${affectedCount} transaction${affectedCount !== 1 ? "s" : ""} currently use "${name}". Removing it will move ${affectedCount === 1 ? "that one" : "them"} to "REVIEW: Ambiguous" so nothing is silently lost. Continue?`);
      if (!ok) return;
    }
    setSpendingCategories(prev => prev.filter(c => c !== name));
    setTransactions(prev => prev.map(t => t.category === name ? { ...t, category: "REVIEW: Ambiguous" } : t));
    setLookup(prev => prev.filter(([, c]) => c !== name));
  }

  // --- Committed cost management ---
  function addCommittedCost() {
    setBudget(b => ({ ...b, committedCosts: [...b.committedCosts, { id: nextCostId.current++, label: "New item", amount: 0 }] }));
  }
  function updateCommittedCost(id, field, value) {
    setBudget(b => ({
      ...b,
      committedCosts: b.committedCosts.map(c => c.id !== id ? c : { ...c, [field]: field === "amount" ? (parseFloat(value) || 0) : value }),
    }));
  }
  // --- Net worth item management (dynamic list, same pattern as committed costs) ---
  function addNetWorthItem(type) {
    setBudget(b => ({ ...b, netWorthItems: [...b.netWorthItems, { id: nextNetWorthId.current++, label: "New item", amount: 0, type: type || "asset" }] }));
  }
  function updateNetWorthItem(id, field, value) {
    setBudget(b => ({
      ...b,
      netWorthItems: b.netWorthItems.map(i => i.id !== id ? i : { ...i, [field]: field === "amount" ? (parseFloat(value) || 0) : value }),
    }));
  }
  function removeNetWorthItem(id) {
    setBudget(b => ({ ...b, netWorthItems: b.netWorthItems.filter(i => i.id !== id) }));
  }

  // --- Income stream management (dynamic list, low/high per stream instead of one fixed number) ---
  function addIncomeStream() {
    setBudget(b => ({ ...b, incomeStreams: [...b.incomeStreams, { id: nextIncomeStreamId.current++, label: "New income stream", low: 0, high: 0 }] }));
  }
  function updateIncomeStream(id, field, value) {
    setBudget(b => ({
      ...b,
      incomeStreams: b.incomeStreams.map(i => i.id !== id ? i : { ...i, [field]: (field === "low" || field === "high") ? (parseFloat(value) || 0) : value }),
    }));
  }
  function removeIncomeStream(id) {
    setBudget(b => ({ ...b, incomeStreams: b.incomeStreams.filter(i => i.id !== id) }));
  }

  function removeCommittedCost(id) {
    setBudget(b => ({ ...b, committedCosts: b.committedCosts.filter(c => c.id !== id) }));
  }

  // --- Target scenario management (dynamic list, same pattern as committed costs - replaces the
  // old fixed Floor/Mid/Stretch trio so any number of named net-position goals can be tracked) ---
  function addTargetScenario() {
    setBudget(b => ({ ...b, targetScenarios: [...b.targetScenarios, { id: nextTargetId.current++, label: "New target", amount: 0 }] }));
  }
  function updateTargetScenario(id, field, value) {
    setBudget(b => ({
      ...b,
      targetScenarios: b.targetScenarios.map(t => t.id !== id ? t : { ...t, [field]: field === "amount" ? (parseFloat(value) || 0) : value }),
    }));
  }
  function removeTargetScenario(id) {
    setBudget(b => ({ ...b, targetScenarios: b.targetScenarios.filter(t => t.id !== id) }));
  }

  // --- Recurring-detection tuning (Settings > Recurring detection) ---
  function updateRecurringConfig(field, value) {
    setRecurringConfig(c => ({ ...c, [field]: field === "minOccurrences" ? Math.max(1, Math.round(parseFloat(value) || 1)) : (parseFloat(value) || 0) }));
  }
  function resetRecurringConfig() {
    setRecurringConfig(DEFAULT_RECURRING_CONFIG);
  }

  // --- Dashboard layout customization (Dashboard > Customize layout) ---
  function toggleSectionVisible(id) {
    setDashboardLayout(prev => prev.map(item => item.id === id ? { ...item, visible: !item.visible } : item));
  }
  function moveSectionUp(id) {
    setDashboardLayout(prev => {
      const idx = prev.findIndex(item => item.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }
  function moveSectionDown(id) {
    setDashboardLayout(prev => {
      const idx = prev.findIndex(item => item.id === id);
      if (idx === -1 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }
  function resetDashboardLayout() {
    setDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  }

  // --- Merchant rule management (direct edit, not just via staging corrections) ---
  // A regex-shaped key is stored exactly as typed, NOT run through normalize() - normalize lowercases,
  // collapses whitespace, and turns "-" into " ", any one of which would silently corrupt a pattern
  // (e.g. "-" inside a character class like [a-z] would become a literal space, breaking the range).
  // Plain keys keep going through normalize() exactly as before.
  function addLookupRule(key, category) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed || !category) return false;
    if (isRegexRuleKey(trimmed)) {
      if (!parseRegexRule(trimmed)) {
        alert("That regex pattern isn't valid (check for things like unbalanced parentheses or brackets) - fix the syntax before saving this rule.");
        return false;
      }
      setLookup(prev => sortLookup([[trimmed, category], ...prev.filter(([k]) => k !== trimmed)]));
      return true;
    }
    const norm = normalize(trimmed);
    if (!norm) return false;
    setLookup(prev => sortLookup([[norm, category], ...prev.filter(([k]) => k !== norm)]));
    return true;
  }
  function updateLookupRuleCategory(key, category) {
    setLookup(prev => prev.map(([k, c]) => k === key ? [k, category] : [k, c]));
  }
  function removeLookupRule(key) {
    setLookup(prev => prev.filter(([k]) => k !== key));
  }

  const stagingUnmatchedCount = staging.filter(r => !r.category).length;

  function copyStagingList() {
    const list = [...new Set(staging.filter(r => !r.category).map(r => normalize(r.merchant)))];
    return `Categorize each of these merchant strings into exactly one of these categories:\n${allCategories.join(", ")}\n\nMerchants:\n${list.join("\n")}\n\nReturn as "merchant: category" one per line.`;
  }

  function exportData() {
    const payload = { transactions, lookup, budget, spendingCategories, recurringConfig, dashboardLayout, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    setHasUnsavedChanges(false);
  }

  function importData(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      alert("That file is larger than a ledger backup should be (over 25MB). Import cancelled - your current data is unchanged.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => alert("Could not read that file from disk. Try again or pick a different file.");
    reader.onload = (e) => {
      let payload;
      try {
        payload = JSON.parse(e.target.result);
      } catch (err) {
        alert("That file isn't valid JSON. Make sure it's a ledger backup exported from this tool.");
        return;
      }
      if (!payload || typeof payload !== "object") {
        alert("That file doesn't look like a ledger backup. Nothing was imported.");
        return;
      }
      const hasT = "transactions" in payload, hasL = "lookup" in payload, hasB = "budget" in payload;
      const hasC = "spendingCategories" in payload;
      const hasRC = "recurringConfig" in payload;
      const hasDL = "dashboardLayout" in payload;

      // Validate everything present BEFORE applying anything - a backup with one bad section
      // should never partially overwrite good data in another section.
      if (hasT && (!Array.isArray(payload.transactions) || payload.transactions.length > MAX_IMPORT_ROWS || !payload.transactions.every(isValidTransaction))) {
        alert(`The transactions in that file look malformed or corrupted (or exceed ${MAX_IMPORT_ROWS.toLocaleString()} rows). Nothing was imported - your current data is unchanged.`);
        return;
      }
      if (hasL && (!Array.isArray(payload.lookup) || !payload.lookup.every(isValidLookupEntry))) {
        alert("The merchant lookup table in that file looks malformed. Nothing was imported - your current data is unchanged.");
        return;
      }
      if (hasB && !isValidBudget(payload.budget)) {
        alert("The budget assumptions in that file look malformed. Nothing was imported - your current data is unchanged.");
        return;
      }
      if (hasC && (!Array.isArray(payload.spendingCategories) || !payload.spendingCategories.every(c => typeof c === "string"))) {
        alert("The category list in that file looks malformed. Nothing was imported - your current data is unchanged.");
        return;
      }
      if (hasRC && !isValidRecurringConfig(payload.recurringConfig)) {
        alert("The recurring-detection settings in that file look malformed. Nothing was imported - your current data is unchanged.");
        return;
      }
      if (hasDL && !isValidDashboardLayout(payload.dashboardLayout)) {
        alert("The dashboard layout settings in that file look malformed. Nothing was imported - your current data is unchanged.");
        return;
      }

      // All validated - apply as one batch, and suppress the dirty-tracking effect for the render
      // this causes, so a freshly loaded backup doesn't immediately show as "unsaved changes."
      // Only arm the suppression if something will actually change - an empty-but-valid payload
      // (e.g. {}) would otherwise leave the flag stuck and incorrectly swallow the NEXT real edit.
      if (hasT || hasL || hasB || hasC || hasRC || hasDL) suppressDirtyCheck.current = true;
      if (hasT) {
        const reindexed = migrateWealthsimpleTransactions(payload.transactions.map((t, i) => ({ ...t, id: i })));
        setTransactions(reindexed);
        nextId.current = computeNextId(reindexed);
        // A restored backup reassigns every id from scratch, so any in-progress "undo last import"
        // batch no longer refers to anything meaningful - clear it rather than risk it matching
        // unrelated rows by id coincidence. Any bulk-selection in progress is equally stale.
        setLastImportBatch(null);
        setSelectedTxnIds(new Set());
      }
      if (hasL) setLookup(sortLookup(migrateWealthsimpleLookup(payload.lookup)));
      if (hasB) setBudget(prev => ({ ...prev, ...migrateBudget(payload.budget) }));
      if (hasC) setSpendingCategories(ensureWealthsimpleCategory(payload.spendingCategories));
      if (hasRC) setRecurringConfig(payload.recurringConfig);
      if (hasDL) setDashboardLayout(normalizeDashboardLayout(payload.dashboardLayout));
      setHasUnsavedChanges(false);
    };
    reader.readAsText(file);

  }

  const months = useMemo(() => [...new Set(transactions.map(t => t.date.slice(0, 7)))].sort(), [transactions]);

  // --- Dashboard filter bar: period + category slice. Only the summary cards, category breakdown,
  // spend-share pie, and income-by-source chart read from this - the trend line, cumulative net, and
  // recurring bills are full-history by design, so the big-picture shape never quietly narrows.
  const [dashPeriod, setDashPeriod] = useState("all"); // "all" | "YYYY-MM" | "custom"
  const [dashCustomFrom, setDashCustomFrom] = useState("");
  const [dashCustomTo, setDashCustomTo] = useState("");
  // Categories that can actually change what the filtered charts show - TRANSFER/EXCLUDE/REVIEW
  // categories never contribute to spend or income totals regardless, so they're left out of the
  // picker rather than offering checkboxes that would visibly do nothing.
  const dashboardFilterableCategories = useMemo(() => [...spendingCategories, ...INCOME_CATS], [spendingCategories]);
  // Tracks EXCLUDED categories, not included ones, so a category added later in Settings is included
  // by default automatically (it just never entered this set) instead of needing to be synced in.
  const [excludedCategories, setExcludedCategories] = useState(() => new Set());

  function toggleExcludedCategory(cat) {
    setExcludedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }
  function resetDashboardFilters() {
    setDashPeriod("all"); setDashCustomFrom(""); setDashCustomTo(""); setExcludedCategories(new Set());
  }

  const dashboardTxns = useMemo(() => {
    let rows = transactions;
    if (dashPeriod === "custom") {
      if (dashCustomFrom) rows = rows.filter(t => t.date >= dashCustomFrom);
      if (dashCustomTo) rows = rows.filter(t => t.date <= dashCustomTo);
    } else if (dashPeriod !== "all") {
      rows = rows.filter(t => t.date.slice(0, 7) === dashPeriod);
    }
    if (excludedCategories.size > 0) rows = rows.filter(t => !t.category || !excludedCategories.has(t.category));
    return rows;
  }, [transactions, dashPeriod, dashCustomFrom, dashCustomTo, excludedCategories]);

  const monthlyTrend = useMemo(() => months.map(m => {
    const inMonth = transactions.filter(t => t.date.slice(0, 7) === m);
    const spend = inMonth.filter(t => t.category && !NON_SPEND.has(t.category)).reduce((s, t) => s - t.amount, 0);
    const income = inMonth.filter(t => t.category && INCOME_CATS.has(t.category)).reduce((s, t) => s + t.amount, 0);
    return { month: m, spend: Math.round(spend), income: Math.round(income) };
  }), [transactions, months]);

  // Reads from dashboardTxns (period + category filtered) - this is one of the four dashboard
  // elements the filter bar is meant to narrow.
  const categoryBreakdown = useMemo(() => {
    const totals = freshTally();
    dashboardTxns.forEach(t => {
      if (!t.category || NON_SPEND.has(t.category)) return;
      totals[t.category] = (totals[t.category] || 0) - t.amount;
    });
    return Object.entries(totals).map(([category, total]) => ({ category, total: Math.round(total) })).sort((a, b) => b.total - a.total);
  }, [dashboardTxns]);

  const recurring = useMemo(() => detectRecurring(transactions.filter(t => t.category && !NON_SPEND.has(t.category)), recurringConfig), [transactions, recurringConfig]);

  const categoryShare = useMemo(() => {
    const sorted = [...categoryBreakdown].sort((a, b) => b.total - a.total);
    const top = sorted.slice(0, 6);
    const restTotal = sorted.slice(6).reduce((s, c) => s + c.total, 0);
    return restTotal > 0 ? [...top, { category: "Other", total: restTotal }] : top;
  }, [categoryBreakdown]);
  const PIE_COLORS = ["#D85A30", "#378ADD", "#1D9E75", "#BA7517", "#D4537E", "#7F77DD", "#888780"];

  const incomeBySource = useMemo(() => {
    const totals = freshTally();
    dashboardTxns.forEach(t => {
      if (!t.category || !INCOME_CATS.has(t.category)) return;
      totals[t.category] = (totals[t.category] || 0) + t.amount;
    });
    // fullCategory keeps the real "INCOME: X" category alongside the shortened display label, so a
    // bar click can drill down to the Log with the exact category the Log's own filter expects.
    return Object.entries(totals).map(([source, total]) => ({ source: source.replace("INCOME: ", ""), fullCategory: source, total: Math.round(total) })).sort((a, b) => b.total - a.total);
  }, [dashboardTxns]);

  const cumulativeNet = useMemo(() => {
    let running = 0;
    return monthlyTrend.map(m => { running += (m.income - m.spend); return { month: m.month, net: Math.round(running) }; });
  }, [monthlyTrend]);

  const totalSpend = categoryBreakdown.reduce((s, c) => s + c.total, 0);
  const totalIncome = dashboardTxns.filter(t => t.category && INCOME_CATS.has(t.category)).reduce((s, t) => s + t.amount, 0);

  // Income streams: each contributes a low/high monthly estimate (a fixed source just has low === high).
  const incLow = budget.incomeStreams.reduce((s, i) => s + (Number.isFinite(i.low) ? i.low : 0), 0);
  const incHigh = budget.incomeStreams.reduce((s, i) => s + (Number.isFinite(i.high) ? i.high : 0), 0);
  const committedCostsTotal = budget.committedCosts.reduce((s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0), 0);
  const commLow = incLow * budget.tithe + committedCostsTotal;
  const commHigh = incHigh * budget.tithe + committedCostsTotal;
  const surpLow = incLow - commLow - budget.discretionary;
  const surpHigh = incHigh - commHigh - budget.discretionary;
  // Net worth items: each is an asset or a liability - net position is assets minus liabilities.
  const netWorthAssets = budget.netWorthItems.filter(i => i.type !== "liability").reduce((s, i) => s + (Number.isFinite(i.amount) ? i.amount : 0), 0);
  const netWorthLiabilities = budget.netWorthItems.filter(i => i.type === "liability").reduce((s, i) => s + (Number.isFinite(i.amount) ? i.amount : 0), 0);
  const netPos = netWorthAssets - netWorthLiabilities;

  // --- Actual vs. plan: this calendar month's real spend (from the Log) against the committed +
  // discretionary plan. Deliberately compares totals only - committed-cost line items (e.g. "Gym
  // $173/mo") aren't linked to a specific spending category, so a per-line actual-vs-plan isn't a
  // number this data model can honestly produce yet.
  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const actualSpendThisMonth = transactions
    .filter(t => t.date.slice(0, 7) === currentMonthKey && t.category && !NON_SPEND.has(t.category))
    .reduce((s, t) => s - t.amount, 0);
  const plannedMonthlyTotal = committedCostsTotal + budget.discretionary;
  const monthVariance = plannedMonthlyTotal - actualSpendThisMonth;
  const monthPercentUsed = plannedMonthlyTotal > 0 ? (actualSpendThisMonth / plannedMonthlyTotal) * 100 : null;

  const targets = budget.targetScenarios.map(t => {
    const gap = Math.max(0, t.amount - netPos);
    const safeMonths = Number.isFinite(budget.monthsRemaining) && budget.monthsRemaining > 0 ? budget.monthsRemaining : null;
    const perMonth = safeMonths ? gap / safeMonths : null;
    const feasible = gap === 0 ? "Already there"
      : perMonth === null ? "Set months remaining above 0"
      : perMonth <= surpLow ? "Yes, fits low case" : perMonth <= surpHigh ? "Tight, needs high case" : "No";
    return { ...t, gap, perMonth, feasible };
  });

  // --- Log tab: sorting, date-range filtering, pagination ---
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [quickMonth, setQuickMonth] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // --- Row edit/delete: one transaction editable inline at a time. editDraft holds string/raw form
  // values (not yet parsed) so the inputs behave normally while typing; saveTxnEdit validates and
  // parses on commit, matching the same validity rules new transactions already have to pass.
  const [editingTxnId, setEditingTxnId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  function startTxnEdit(t) {
    setSplittingTxnId(null);
    setEditingTxnId(t.id);
    setEditDraft({ date: t.date, merchant: t.merchant, amount: String(t.amount), category: t.category || "" });
  }
  function cancelTxnEdit() {
    setEditingTxnId(null);
    setEditDraft(null);
  }
  function saveTxnEdit() {
    if (editDraft === null) return;
    const date = editDraft.date.trim();
    const merchant = editDraft.merchant.trim();
    const amount = parseFloat(editDraft.amount);
    if (!isValidDateString(date) || !merchant || !Number.isFinite(amount)) {
      alert("Enter a valid date, merchant, and numeric amount before saving.");
      return;
    }
    const id = editingTxnId;
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, date, merchant, amount, category: editDraft.category || null } : t));
    setEditingTxnId(null);
    setEditDraft(null);
  }
  // computeNextId is loop-based and derives the next id from whatever's actually left in the array,
  // so deleting a row (even the highest-id one) can never hand out a colliding id on a later add.
  function deleteTransaction(id) {
    const t = transactions.find(t => t.id === id);
    if (!t) return;
    const ok = confirm(`Delete this transaction?\n${t.date} - ${t.merchant} - ${t.amount < 0 ? "-" : "+"}$${Math.abs(t.amount).toFixed(2)}`);
    if (!ok) return;
    if (editingTxnId === id) { setEditingTxnId(null); setEditDraft(null); }
    if (splittingTxnId === id) setSplittingTxnId(null);
    setTransactions(prev => prev.filter(t => t.id !== id));
    setSelectedTxnIds(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
  }

  // --- Transaction splitting: divide one row's amount across two or more categories. A split
  // replaces the original row with N child rows (same date/merchant/description, one category and
  // partial amount each), each tagged with splitParentId = the original transaction's id. That id is
  // never reused (nextId only ever increases - see computeNextId), so it stays a stable, collision-free
  // link back to "the transaction these rows used to be" even after the original row is gone - which
  // is what lets mergeSplitGroup find every sibling and undo the split later.
  //
  // Deliberately NOT modeled as one parent row plus separate "split lines": every dashboard chart,
  // filter, and total already sums plain transactions by category/date/amount, so expanding a split
  // into ordinary rows means none of that math needs to know splits exist at all - a split row is
  // just a transaction, and the aggregates are correct by construction.
  const [splittingTxnId, setSplittingTxnId] = useState(null);

  // Groups every split-child transaction by its splitParentId, computed once per transactions change
  // rather than re-scanning the whole list from inside each row - used for both the "(split n/m)"
  // badge and to find every sibling for merging back.
  const splitGroups = useMemo(() => {
    const map = new Map();
    transactions.forEach(t => {
      if (!isSplitChild(t)) return;
      if (!map.has(t.splitParentId)) map.set(t.splitParentId, []);
      map.get(t.splitParentId).push(t);
    });
    return map;
  }, [transactions]);

  function startTxnSplit(id) {
    setEditingTxnId(null);
    setEditDraft(null);
    setSplittingTxnId(id);
  }
  function cancelTxnSplit() {
    setSplittingTxnId(null);
  }
  // parts: [{ category, amount }, ...], already parsed. Re-validates from scratch (rather than
  // trusting SplitEditor's own canSave gate) since this is the actual write path - the same "every
  // part categorized, cents sum to exactly the original amount" rule is enforced here regardless of
  // how it's called.
  function saveTxnSplit(parts) {
    const parentId = splittingTxnId;
    const parent = transactions.find(t => t.id === parentId);
    if (!parent) { setSplittingTxnId(null); return; }
    const targetCents = Math.round(parent.amount * 100);
    const sumCents = parts.reduce((s, p) => s + Math.round((Number.isFinite(p.amount) ? p.amount : NaN) * 100), 0);
    if (parts.length < 2 || parts.some(p => !p.category || !Number.isFinite(p.amount)) || !Number.isFinite(sumCents) || sumCents !== targetCents) {
      alert("Every split part needs a category, and the amounts must add up to exactly the original total before saving.");
      return;
    }
    const children = parts.map(p => ({
      id: nextId.current++,
      date: parent.date, description: parent.description, merchant: parent.merchant,
      amount: Math.round(p.amount * 100) / 100,
      category: p.category,
      splitParentId: parent.id,
    }));
    setTransactions(prev => [...prev.filter(t => t.id !== parentId), ...children]);
    setSelectedTxnIds(prev => { if (!prev.has(parentId)) return prev; const next = new Set(prev); next.delete(parentId); return next; });
    // The parent id no longer names a real row - if it was part of the just-committed import batch,
    // drop it from that set so "Undo last import" doesn't try to filter out an id that's already gone.
    setLastImportBatch(prev => {
      if (!prev || !prev.ids.has(parentId)) return prev;
      const ids = new Set(prev.ids);
      ids.delete(parentId);
      return { ...prev, ids };
    });
    setSplittingTxnId(null);
  }
  // Un-splits: collapses every row sharing this splitParentId back into one transaction (summed
  // amount, original date/merchant/description, category reset to null/"unmatched" since the whole
  // point of a split was to divide it across more than one category). Gets a fresh id via nextId
  // rather than trying to resurrect the original one - nothing in the app treats transaction ids as
  // meaningful beyond uniqueness, so there's no reason to special-case restoring the old value.
  function mergeSplitGroup(splitParentId) {
    const siblings = transactions.filter(t => t.splitParentId === splitParentId);
    if (siblings.length === 0) return;
    const first = siblings[0];
    const ok = confirm(`Merge ${siblings.length} split parts back into one transaction?\n${first.date} - ${first.merchant}\nIt will need to be re-categorized.`);
    if (!ok) return;
    const total = Math.round(siblings.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const merged = {
      id: nextId.current++,
      date: first.date, description: first.description, merchant: first.merchant,
      amount: total, category: null,
    };
    const siblingIds = new Set(siblings.map(t => t.id));
    setTransactions(prev => [...prev.filter(t => !siblingIds.has(t.id)), merged]);
    setSelectedTxnIds(prev => {
      if (![...siblingIds].some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      siblingIds.forEach(id => next.delete(id));
      return next;
    });
    if (editingTxnId !== null && siblingIds.has(editingTxnId)) { setEditingTxnId(null); setEditDraft(null); }
    if (splittingTxnId !== null && siblingIds.has(splittingTxnId)) setSplittingTxnId(null);
  }

  // --- Bulk re-categorization: select any number of rows (across pages/filters) and apply one
  // category to all of them at once. Selection is tracked by id, independent of what's currently
  // paged/filtered, so it survives paging through a large result set to build up a batch.
  const [selectedTxnIds, setSelectedTxnIds] = useState(() => new Set());
  const [bulkCategory, setBulkCategory] = useState("");

  function toggleTxnSelected(id) {
    setSelectedTxnIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // "Visible" = the rows on the current page, matching what the header checkbox can actually see -
  // toggles them all on if any are unselected, all off if the whole page is already selected.
  function toggleSelectAllVisible(visibleTxns) {
    setSelectedTxnIds(prev => {
      const allSelected = visibleTxns.length > 0 && visibleTxns.every(t => prev.has(t.id));
      const next = new Set(prev);
      visibleTxns.forEach(t => (allSelected ? next.delete(t.id) : next.add(t.id)));
      return next;
    });
  }
  function deselectAllTxns() {
    setSelectedTxnIds(new Set());
    setBulkCategory("");
  }
  // Applies bulkCategory to every selected transaction. If a merchant appears more than once in the
  // selected batch, that's treated as a "recurring" correction worth offering to save as a permanent
  // lookup rule (upserted the same way commitStaging's corrections are) - a one-off row doesn't imply
  // a durable rule, but a merchant hit several times in one bulk action probably should categorize
  // itself automatically on the next import.
  function applyBulkCategory() {
    if (!bulkCategory || selectedTxnIds.size === 0) return;
    const selected = transactions.filter(t => selectedTxnIds.has(t.id));
    const merchantCounts = new Map();
    selected.forEach(t => {
      const key = normalize(t.merchant);
      merchantCounts.set(key, (merchantCounts.get(key) || 0) + 1);
    });
    const recurringMerchants = [...merchantCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);

    setTransactions(prev => prev.map(t => selectedTxnIds.has(t.id) ? { ...t, category: bulkCategory } : t));

    if (recurringMerchants.length > 0) {
      const sample = recurringMerchants.slice(0, 5).join(", ") + (recurringMerchants.length > 5 ? ", ..." : "");
      const ok = confirm(`${recurringMerchants.length} merchant${recurringMerchants.length !== 1 ? "s" : ""} appear more than once in this selection (${sample}). Update your merchant lookup rules so future imports categorize ${recurringMerchants.length !== 1 ? "them" : "it"} as "${bulkCategory}" automatically?`);
      if (ok) {
        const updates = new Map(recurringMerchants.map(key => [key, bulkCategory]));
        setLookup(prev => sortLookup([...updates.entries(), ...prev.filter(([k]) => !updates.has(k))]));
      }
    }

    deselectAllTxns();
  }

  // Sets dateFrom/dateTo to the first/last day of the chosen YYYY-MM month in one step, as a
  // convenience on top of the two free-form date inputs.
  function applyQuickMonth(m) {
    setQuickMonth(m);
    if (!m) { setDateFrom(""); setDateTo(""); return; }
    const [y, mo] = m.split("-").map(Number);
    setDateFrom(`${m}-01`);
    setDateTo(`${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, "0")}`);
  }

  function handleHeaderSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "merchant" ? "asc" : "desc");
    }
  }
  function sortIndicator(key) {
    return sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  }

  // Recharts hands click handlers the datum for that segment, but Pie sectors nest the original data
  // under .payload while Bar entries usually carry it at the top level - checking both makes this
  // work the same way regardless of which chart triggered it.
  function getChartField(data, field) {
    if (!data) return null;
    return data.payload?.[field] ?? data[field] ?? null;
  }

  // Drill-down: reuses the Log tab's own filter controls (category + date range) instead of adding
  // parallel state, so clicking a chart segment does exactly what manually setting those filters
  // would do, then jumps to the Log tab to show the result.
  function drillDownToLog(category) {
    setFilterCat(category && category !== "Other" ? category : "all");
    if (dashPeriod === "custom") {
      setDateFrom(dashCustomFrom); setDateTo(dashCustomTo); setQuickMonth("");
    } else if (dashPeriod !== "all") {
      applyQuickMonth(dashPeriod);
    } else {
      setDateFrom(""); setDateTo(""); setQuickMonth("");
    }
    setTab("log");
  }

  // CSV export of the current Dashboard view: the (filter-scoped) category breakdown with each
  // category's share of total spend, plus the full-history monthly totals shown in the trend chart.
  function exportDashboardCSV() {
    const lines = [];
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const row = (...vals) => lines.push(vals.map(esc).join(","));
    const periodLabel = dashPeriod === "all" ? "All time" : dashPeriod === "custom" ? `${dashCustomFrom || "(open)"} to ${dashCustomTo || "(open)"}` : dashPeriod;

    row("Ledger summary export");
    row("Period", periodLabel);
    row("Generated", new Date().toISOString().slice(0, 10));
    row();
    row("Category breakdown");
    row("Category", "Total", "% of spend");
    categoryBreakdown.forEach(c => {
      const pct = totalSpend > 0 ? (c.total / totalSpend) * 100 : 0;
      row(c.category, c.total.toFixed(2), pct.toFixed(1) + "%");
    });
    row("Total spend", totalSpend.toFixed(2), "100.0%");
    row();
    row("Monthly totals (full history)");
    row("Month", "Spend", "Income");
    monthlyTrend.forEach(m => row(m.month, m.spend.toFixed(2), m.income.toFixed(2)));

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ledger-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  const filteredTxns = useMemo(() => {
    let rows = filterCat === "all" ? transactions : transactions.filter(t => t.category === filterCat);
    if (dateFrom) rows = rows.filter(t => t.date >= dateFrom);
    if (dateTo) rows = rows.filter(t => t.date <= dateTo);
    return rows;
  }, [transactions, filterCat, dateFrom, dateTo]);

  const sortedTxns = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return [...filteredTxns].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = compare(a.date, b.date);
      else if (sortKey === "merchant") cmp = compare((a.merchant || "").toLowerCase(), (b.merchant || "").toLowerCase());
      else if (sortKey === "amount") cmp = compare(a.amount, b.amount);
      if (cmp === 0) cmp = compare(a.id, b.id); // stable tiebreaker so equal-key rows don't jitter
      return cmp * dir;
    });
  }, [filteredTxns, sortKey, sortDir]);

  // Reset to page 1 whenever the filtered/sorted set or page size changes, so the pager never
  // silently strands the person on a now out-of-range page.
  useEffect(() => { setPage(1); }, [filterCat, dateFrom, dateTo, sortKey, sortDir, pageSize]);
  // Clear bulk selection when the underlying filtered set changes (not on sort/page-size, which
  // don't change what's included) - a selection built under one filter shouldn't silently carry
  // over and get applied to a different-looking result set.
  useEffect(() => { setSelectedTxnIds(new Set()); }, [filterCat, dateFrom, dateTo]);
  const totalPages = Math.max(1, Math.ceil(sortedTxns.length / pageSize));
  // Also clamp defensively if the set shrinks for some other reason (e.g. a backup restore) without
  // one of the deps above changing.
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages, page]);
  const pagedTxns = useMemo(() => {
    const start = (Math.min(page, totalPages) - 1) * pageSize;
    return sortedTxns.slice(start, start + pageSize);
  }, [sortedTxns, page, pageSize, totalPages]);

  // Dashboard section content, keyed by the same ids as DASHBOARD_SECTIONS/dashboardLayout - the
  // Dashboard tab below renders these in dashboardLayout's order, skipping any marked !visible. A
  // hidden section is never added to the DOM at all (not just visually hidden), so it's automatically
  // excluded from Print/PDF too (see PRINT_CSS) without any section-specific print styling needed.
  const dashboardSectionContent = {
    summaryCards: (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
        <div style={card}><div style={label}>Total spend</div><div style={{ ...statBig }}>${totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
        <div style={card}><div style={label}>Total income</div><div style={{ ...statBig, color: "var(--text-success)" }}>${totalIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
        <div style={card}>
          <div style={label}>Transactions in view</div>
          <div style={statBig}>{dashboardTxns.length}</div>
          {dashboardTxns.length !== transactions.length && <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>of {transactions.length} total</div>}
        </div>
        <div style={card}><div style={label}>Pending review</div><div style={{ ...statBig, color: staging.length ? "var(--text-warning)" : "var(--text-success)" }}>{staging.length}</div></div>
      </div>
    ),
    trendLine: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Monthly spend vs income</div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={monthlyTrend}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="spend" stroke="#D85A30" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="income" stroke="#1D9E75" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    ),
    cumulativeNet: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Cumulative net position (income minus spend, running total)</div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={cumulativeNet}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Area type="monotone" dataKey="net" stroke="#1D9E75" fill="#1D9E75" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    ),
    spendSharePie: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Spend share by category</div>
        <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "-6px 0 10px" }}>Click a slice to jump to those transactions in the Log.</p>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={categoryShare} dataKey="total" nameKey="category" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}
              cursor="pointer" onClick={(data) => drillDownToLog(getChartField(data, "category"))}>
              {categoryShare.map((entry, i) => <Cell key={entry.category} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    ),
    incomeBar: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Income by source</div>
        <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "-6px 0 10px" }}>Click a bar to jump to those transactions in the Log.</p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={incomeBySource}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="source" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
            <Bar dataKey="total" fill="#1D9E75" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(data) => drillDownToLog(getChartField(data, "fullCategory"))} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    ),
    categoryBar: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Spend by category</div>
        <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "-6px 0 10px" }}>Click a bar to jump to those transactions in the Log.</p>
        <ResponsiveContainer width="100%" height={Math.max(240, categoryBreakdown.length * 28)}>
          <BarChart data={categoryBreakdown} layout="vertical" margin={{ left: 100 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" tick={{ fontSize: 12 }} />
            <YAxis type="category" dataKey="category" tick={{ fontSize: 12 }} width={140} />
            <Tooltip />
            <Bar dataKey="total" fill="#D85A30" radius={[0, 4, 4, 0]} cursor="pointer" onClick={(data) => drillDownToLog(getChartField(data, "category"))} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    ),
    recurringBills: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Recurring bills detected</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Merchant</th><th style={th}>Occurrences</th><th style={{ ...th, textAlign: "right" }}>Avg amount</th><th style={th}>Interval</th></tr></thead>
          <tbody>
            {recurring.slice(0, 10).map(r => (
              <tr key={r.merchant}>
                <td style={td}>{r.merchant}</td>
                <td style={{ ...td, ...num }}>{r.count}</td>
                <td style={{ ...td, textAlign: "right", ...num }}>${r.avgAmt.toFixed(2)}</td>
                <td style={td}>{r.flag} (~{Math.round(r.avgInt)}d)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  };

  return (
    <div className="ledger-root" data-theme={theme} style={{ fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--surface-0)", maxWidth: "100%", padding: "4px" }}>
      <style>{THEME_CSS}</style>
      <style>{PRINT_CSS}</style>
      <div className="ledger-no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h1 style={{ fontSize: "26px", fontWeight: 650, letterSpacing: "-0.02em", margin: 0 }}>Ledger</h1>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "4px 0 0" }}>Autosaves to this browser. Export a backup file periodically for safekeeping.</p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {(hasUnsavedChanges || staging.length > 0) && (
            <span title="You have changes that haven't been exported to a backup file yet. They're still autosaved to this browser." style={{ fontSize: "12px", color: "var(--text-warning)", display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--text-warning)", display: "inline-block" }} />
              Not backed up to file
            </span>
          )}
          <button style={{ ...btn, padding: "8px" }} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button style={btn} onClick={() => fileInputRef.current.click()}><Upload size={14} /> Load backup</button>
          <input ref={fileInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ""; }} />
          <button style={btnPrimary} onClick={exportData}><Download size={14} /> Save backup</button>
        </div>
      </div>

      {storageWarning && (
        <div className="ledger-no-print" style={{ ...card, borderColor: "var(--border-warning)", background: "var(--bg-warning)", padding: "10px 16px", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "13px", color: "var(--text-warning)" }}><AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />{storageWarning}</span>
          <button style={{ ...btn, padding: "4px 10px" }} onClick={() => setStorageWarning("")}>Dismiss</button>
        </div>
      )}

      <div className="ledger-tabs ledger-no-print" style={{ display: "flex", gap: "4px", marginBottom: "18px", borderBottom: "1px solid var(--border)" }}>
        {["log", "dashboard", "budget", "settings"].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "9px 16px", background: "none", border: "none", borderBottom: tab === t ? "2px solid var(--text-accent)" : "2px solid transparent", color: tab === t ? "var(--text-primary)" : "var(--text-secondary)", fontSize: "13px", fontWeight: tab === t ? 600 : 500, cursor: "pointer" }}>
            {t === "log" ? "Transaction log" : t === "dashboard" ? "Dashboard" : t === "budget" ? "Budget plan" : "Settings"}
          </button>
        ))}
      </div>

      {tab === "log" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {lastImportBatch && (
            <div style={{ ...card, borderColor: "var(--border)", background: "var(--bg-accent)", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "13px", color: "var(--text-accent)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Check size={14} /> Added {lastImportBatch.count} transaction{lastImportBatch.count !== 1 ? "s" : ""} to your log.
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button style={{ ...btn, padding: "4px 10px" }} onClick={undoLastImport}><Undo2 size={13} /> Undo last import ({lastImportBatch.count})</button>
                <button style={{ ...btn, padding: "4px 10px" }} onClick={dismissImportBatch}>Dismiss</button>
              </div>
            </div>
          )}
          {importWarning && (
            <div style={{ ...card, borderColor: "var(--border-warning)", background: "var(--bg-warning)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "13px", color: "var(--text-warning)" }}><AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />{importWarning}</span>
              <button style={{ ...btn, padding: "4px 10px" }} onClick={() => setImportWarning("")}>Dismiss</button>
            </div>
          )}
          <div style={card}>
            <div style={{ ...label, marginBottom: "10px" }}>Add a new statement</div>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-start" }}>
              <label style={{ ...btn, cursor: "pointer" }}>
                <Upload size={14} /> Upload CSV
                <input type="file" accept=".csv" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (f) handleCSV(f); e.target.value = ""; }} />
              </label>
              <label style={{ ...btn, cursor: "pointer" }}>
                <FolderOpen size={14} /> Select folder
                <input ref={folderInputRef} type="file" webkitdirectory="" multiple style={{ display: "none" }}
                  onChange={e => { const files = e.target.files; if (files && files.length) handleFolderSelect(files); e.target.value = ""; }} />
              </label>
              <span style={{ fontSize: "12px", color: "var(--text-muted)", alignSelf: "center" }}>Columns: Date, Description, Merchant, Amount (negative = money out). "Select folder" grabs every CSV inside it and skips anything already in your log.</span>
            </div>
            <div style={{ marginTop: "12px" }}>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder={"Or paste rows, one per line: 2026-09-05\\tpos purchase\\tfizz\\t-23.73"} style={{ ...input, minHeight: "70px", fontFamily: "var(--font-mono)", fontSize: "12px" }} />
              <button style={{ ...btnPrimary, marginTop: "8px" }} onClick={handlePasteAdd}><Plus size={14} /> Add pasted rows</button>
            </div>
          </div>

          {pendingMapping && <CSVMappingPanel mapping={pendingMapping} onConfirm={confirmManualMapping} onCancel={() => setPendingMapping(null)} />}

          {staging.length > 0 && (
            <div style={{ ...card, borderColor: stagingUnmatchedCount ? "var(--border-warning)" : "var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 500 }}>
                  {stagingUnmatchedCount > 0 && <AlertCircle size={15} color="var(--text-warning)" />}
                  {staging.length} new transaction{staging.length !== 1 ? "s" : ""} ready to review
                  {stagingUnmatchedCount > 0 && ` - ${stagingUnmatchedCount} unmatched`}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {stagingUnmatchedCount > 0 && <button style={btn} onClick={() => navigator.clipboard?.writeText(copyStagingList())?.catch(() => alert("Couldn't copy automatically - your browser blocked clipboard access. Select the list manually instead."))}><Copy size={13} /> Copy unmatched for LLM</button>}
                  <button style={btn} onClick={discardStaging}>Discard all</button>
                  <button style={btnPrimary} onClick={commitStaging}><Check size={14} /> Confirm & add {staging.length}</button>
                </div>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>Every category below is auto-suggested from your merchant lookup table. Change any of them before confirming - nothing here touches your permanent log until you click Confirm.</p>
              <div style={{ overflowX: "auto", maxHeight: "420px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Date</th><th style={th}>Merchant</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Category</th><th style={th}></th></tr></thead>
                  <tbody>
                    {staging.map(r => (
                      <tr key={r.stageId}>
                        <td style={{ ...td, ...num, color: "var(--text-secondary)" }}>{r.date}</td>
                        <td style={{ ...td, ...num }}>{r.merchant}</td>
                        <td style={{ ...td, textAlign: "right", ...num }}>{r.amount < 0 ? "-" : "+"}${Math.abs(r.amount).toFixed(2)}</td>
                        <td style={td}>
                          <select value={r.category} onChange={e => updateStagingCategory(r.stageId, e.target.value)}
                            style={{ ...input, width: "210px", borderColor: !r.category ? "var(--border-warning)" : "var(--border)" }}>
                            <option value="">{r.matched ? "" : "No match - choose one"}</option>
                            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td style={td}><button style={{ ...btn, padding: "4px 8px" }} onClick={() => removeStagingRow(r.stageId)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "10px" }}>
              <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-secondary)" }}>{sortedTxns.length === transactions.length ? `${transactions.length} transactions` : `${sortedTxns.length} of ${transactions.length} transactions`}</div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...input, width: "180px" }}>
                  <option value="all">All categories</option>
                  {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={quickMonth} onChange={e => applyQuickMonth(e.target.value)} style={{ ...input, width: "130px" }}>
                  <option value="">Month...</option>
                  {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setQuickMonth(""); }} style={{ ...input, width: "140px" }} />
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>to</span>
                <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setQuickMonth(""); }} style={{ ...input, width: "140px" }} />
                {(dateFrom || dateTo) && <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { setDateFrom(""); setDateTo(""); setQuickMonth(""); }}>Clear dates</button>}
              </div>
            </div>
            {selectedTxnIds.size > 0 && (
              <div style={{ position: "sticky", top: 0, zIndex: 5, ...card, background: "var(--bg-accent)", borderColor: "var(--text-accent)", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-accent)" }}>{selectedTxnIds.size} selected</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)} style={{ ...input, width: "210px" }}>
                    <option value="">Choose category...</option>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button style={{ ...btnPrimary, opacity: bulkCategory ? 1 : 0.5 }} disabled={!bulkCategory} onClick={applyBulkCategory}><Check size={14} /> Apply to {selectedTxnIds.size}</button>
                  <button style={{ ...btn, padding: "6px 12px" }} onClick={deselectAllTxns}><X size={13} /> Deselect all</button>
                </div>
              </div>
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: "36px" }}>
                      <input type="checkbox" title="Select all visible"
                        checked={pagedTxns.length > 0 && pagedTxns.every(t => selectedTxnIds.has(t.id))}
                        onChange={() => toggleSelectAllVisible(pagedTxns)} />
                    </th>
                    <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("date")}>Date{sortIndicator("date")}</th>
                    <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("merchant")}>Merchant{sortIndicator("merchant")}</th>
                    <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("amount")}>Amount{sortIndicator("amount")}</th>
                    <th style={th}>Category</th>
                    <th style={{ ...th, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedTxns.map(t => {
                    if (splittingTxnId === t.id) {
                      return (
                        <tr key={t.id}>
                          <td style={{ ...td, ...card, border: "1px solid var(--border)" }} colSpan={6}>
                            <SplitEditor txn={t} categories={allCategories} onSave={saveTxnSplit} onCancel={cancelTxnSplit} />
                          </td>
                        </tr>
                      );
                    }
                    if (editingTxnId === t.id) {
                      return (
                        <tr key={t.id}>
                          <td style={td}><input type="checkbox" checked={selectedTxnIds.has(t.id)} disabled /></td>
                          <td style={td}><input type="date" value={editDraft.date} onChange={e => setEditDraft(d => ({ ...d, date: e.target.value }))} style={input} /></td>
                          <td style={td}><input value={editDraft.merchant} onChange={e => setEditDraft(d => ({ ...d, merchant: e.target.value }))} style={input} /></td>
                          <td style={{ ...td, textAlign: "right" }}>
                            <input type="number" step="0.01" value={editDraft.amount} onChange={e => setEditDraft(d => ({ ...d, amount: e.target.value }))} style={{ ...input, textAlign: "right" }} />
                          </td>
                          <td style={td}>
                            <select value={editDraft.category} onChange={e => setEditDraft(d => ({ ...d, category: e.target.value }))} style={input}>
                              <option value="">Unmatched</option>
                              {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </td>
                          <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                            <button style={{ ...btn, padding: "4px 8px" }} onClick={saveTxnEdit} title="Save"><Check size={13} /></button>
                            <button style={{ ...btn, padding: "4px 8px", marginLeft: "6px" }} onClick={cancelTxnEdit} title="Cancel"><X size={13} /></button>
                          </td>
                        </tr>
                      );
                    }
                    const splitChild = isSplitChild(t);
                    const siblingCount = splitChild ? (splitGroups.get(t.splitParentId)?.length || 1) : 0;
                    return (
                      <tr key={t.id}>
                        <td style={td}><input type="checkbox" checked={selectedTxnIds.has(t.id)} onChange={() => toggleTxnSelected(t.id)} /></td>
                        <td style={{ ...td, ...num, color: "var(--text-secondary)" }}>{t.date}</td>
                        <td style={td}>
                          {t.merchant}
                          {splitChild && <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "6px" }} title="One part of a split transaction">(split, {siblingCount} parts)</span>}
                        </td>
                        <td style={{ ...td, textAlign: "right", ...num, color: t.amount < 0 ? "var(--text-primary)" : "var(--text-success)" }}>{t.amount < 0 ? "-" : "+"}${Math.abs(t.amount).toFixed(2)}</td>
                        <td style={td}><CategoryBadge category={t.category} /></td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          <button style={{ ...btn, padding: "4px 8px" }} onClick={() => startTxnEdit(t)} title="Edit"><Pencil size={13} /></button>
                          {splitChild ? (
                            <button style={{ ...btn, padding: "4px 8px", marginLeft: "6px" }} onClick={() => mergeSplitGroup(t.splitParentId)} title="Merge split parts back into one transaction"><Merge size={13} /></button>
                          ) : (
                            <button style={{ ...btn, padding: "4px 8px", marginLeft: "6px" }} onClick={() => startTxnSplit(t.id)} title="Split into multiple categories"><Split size={13} /></button>
                          )}
                          <button style={{ ...btn, padding: "4px 8px", marginLeft: "6px" }} onClick={() => deleteTransaction(t.id)} title="Delete"><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    );
                  })}
                  {pagedTxns.length === 0 && (
                    <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>No transactions match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {sortedTxns.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", flexWrap: "wrap", gap: "8px" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  Showing {(Math.min(page, totalPages) - 1) * pageSize + 1}-{Math.min(Math.min(page, totalPages) * pageSize, sortedTxns.length)} of {sortedTxns.length}
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={{ ...input, width: "90px" }}>
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                  <button style={{ ...btn, opacity: page <= 1 ? 0.5 : 1 }} disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</button>
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Page {Math.min(page, totalPages)} of {totalPages}</span>
                  <button style={{ ...btn, opacity: page >= totalPages ? 0.5 : 1 }} disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "dashboard" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="ledger-print-only" style={{ marginBottom: "4px" }}>
            <h2 style={{ margin: 0, fontSize: "20px" }}>Ledger — Dashboard Summary</h2>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-secondary)" }}>
              Period: {dashPeriod === "all" ? "All time" : dashPeriod === "custom" ? `${dashCustomFrom || "(open)"} to ${dashCustomTo || "(open)"}` : dashPeriod} &nbsp;·&nbsp; Generated {new Date().toISOString().slice(0, 10)}
            </p>
          </div>
          <div className="ledger-no-print" style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <div style={label}>Period</div>
                  <select value={dashPeriod} onChange={e => setDashPeriod(e.target.value)} style={{ ...input, width: "170px" }}>
                    <option value="all">All time</option>
                    {months.map(m => <option key={m} value={m}>{m}</option>)}
                    <option value="custom">Custom range...</option>
                  </select>
                </div>
                {dashPeriod === "custom" && (
                  <>
                    <div>
                      <div style={label}>From</div>
                      <input type="date" value={dashCustomFrom} onChange={e => setDashCustomFrom(e.target.value)} style={{ ...input, width: "150px" }} />
                    </div>
                    <div>
                      <div style={label}>To</div>
                      <input type="date" value={dashCustomTo} onChange={e => setDashCustomTo(e.target.value)} style={{ ...input, width: "150px" }} />
                    </div>
                  </>
                )}
                <div>
                  <div style={label}>Categories</div>
                  <CategoryFilterMenu categories={dashboardFilterableCategories} excluded={excludedCategories} onToggle={toggleExcludedCategory}
                    onSelectAll={() => setExcludedCategories(new Set())} onClear={() => setExcludedCategories(new Set(dashboardFilterableCategories))} />
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {(dashPeriod !== "all" || excludedCategories.size > 0) && (
                  <button style={{ ...btn, padding: "6px 12px" }} onClick={resetDashboardFilters}><X size={13} /> Reset filters</button>
                )}
                <DashboardLayoutMenu sections={DASHBOARD_SECTIONS} layout={dashboardLayout}
                  onToggleVisible={toggleSectionVisible} onMoveUp={moveSectionUp} onMoveDown={moveSectionDown} onReset={resetDashboardLayout} />
                <ExportSummaryMenu onExportCSV={exportDashboardCSV} onPrint={() => window.print()} />
              </div>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "10px 0 0" }}>
              Summary cards, spend by category, spend share, and income by source reflect this filter. Trend, cumulative net position, and recurring bills always show full history. "Customize layout" controls which sections show (and in what order) both here and in Print/PDF; "Export summary" downloads a CSV of the category breakdown and monthly totals, or opens Print/Save PDF for a clean-margined summary page of your currently visible sections.
            </p>
          </div>

          {dashboardLayout.filter(s => s.visible).map(s => (
            <div key={s.id}>{dashboardSectionContent[s.id]}</div>
          ))}
        </div>
      )}

      {tab === "budget" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={card}>
            <div style={{ ...label, marginBottom: "12px" }}>Assumptions</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
              {[
                ["discretionary", "Discretionary pool ($/mo)"], ["monthsRemaining", "Months remaining"],
              ].map(([key, lab]) => (
                <div key={key}>
                  <div style={label}>{lab}</div>
                  <input type="number" value={budget[key]} onChange={e => setBudget(b => ({ ...b, [key]: parseFloat(e.target.value) || 0 }))} style={input} />
                </div>
              ))}
              <div>
                <div style={label}>Tithe rate (%)</div>
                <input type="number" step="0.5" min="0" max="100" value={Math.round(budget.tithe * 1000) / 10}
                  onChange={e => setBudget(b => ({ ...b, tithe: (parseFloat(e.target.value) || 0) / 100 }))} style={input} />
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={label}>Income streams</div>
              <button style={{ ...btn, padding: "4px 10px" }} onClick={() => addIncomeStream()}><Plus size={13} /> Add stream</button>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>A fixed, guaranteed source can use the same number for low and high. A variable one (e.g. irregular hours) can carry a real range.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {budget.incomeStreams.map(s => (
                <div key={s.id} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <input value={s.label} onChange={e => updateIncomeStream(s.id, "label", e.target.value)} style={{ ...input, flex: 1 }} />
                  <div style={{ width: "110px" }}>
                    <div style={{ ...label, marginBottom: "2px" }}>Low ($/mo)</div>
                    <input type="number" value={s.low} onChange={e => updateIncomeStream(s.id, "low", e.target.value)} style={input} />
                  </div>
                  <div style={{ width: "110px" }}>
                    <div style={{ ...label, marginBottom: "2px" }}>High ($/mo)</div>
                    <input type="number" value={s.high} onChange={e => updateIncomeStream(s.id, "high", e.target.value)} style={input} />
                  </div>
                  <button style={{ ...btn, padding: "6px", alignSelf: "flex-end" }} onClick={() => removeIncomeStream(s.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              {budget.incomeStreams.length === 0 && <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>No income streams yet - click Add stream.</div>}
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                Total: <b style={num}>${incLow.toFixed(2)}</b> - <b style={num}>${incHigh.toFixed(2)}</b>/mo
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={label}>Committed monthly costs</div>
              <button style={{ ...btn, padding: "4px 10px" }} onClick={addCommittedCost}><Plus size={13} /> Add item</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {budget.committedCosts.map(c => (
                <div key={c.id} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <input value={c.label} onChange={e => updateCommittedCost(c.id, "label", e.target.value)} style={{ ...input, flex: 1 }} />
                  <input type="number" value={c.amount} onChange={e => updateCommittedCost(c.id, "amount", e.target.value)} style={{ ...input, width: "120px" }} />
                  <button style={{ ...btn, padding: "6px" }} onClick={() => removeCommittedCost(c.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              {budget.committedCosts.length === 0 && <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>No committed costs yet - click Add item.</div>}
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>Total: <b style={num}>${committedCostsTotal.toFixed(2)}</b>/mo</div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={label}>Net worth items</div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button style={{ ...btn, padding: "4px 10px" }} onClick={() => addNetWorthItem("asset")}><Plus size={13} /> Add asset</button>
                <button style={{ ...btn, padding: "4px 10px" }} onClick={() => addNetWorthItem("liability")}><Plus size={13} /> Add liability</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {budget.netWorthItems.map(i => (
                <div key={i.id} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <select value={i.type} onChange={e => updateNetWorthItem(i.id, "type", e.target.value)} style={{ ...input, width: "110px" }}>
                    <option value="asset">Asset</option>
                    <option value="liability">Liability</option>
                  </select>
                  <input value={i.label} onChange={e => updateNetWorthItem(i.id, "label", e.target.value)} style={{ ...input, flex: 1 }} />
                  <input type="number" value={i.amount} onChange={e => updateNetWorthItem(i.id, "amount", e.target.value)} style={{ ...input, width: "120px" }} />
                  <button style={{ ...btn, padding: "6px" }} onClick={() => removeNetWorthItem(i.id)}><Trash2 size={14} /></button>
                </div>
              ))}
              {budget.netWorthItems.length === 0 && <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>No net worth items yet - add an asset or liability.</div>}
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                Assets: <b style={num}>${netWorthAssets.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> &nbsp;-&nbsp;
                Liabilities: <b style={num}>${netWorthLiabilities.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> &nbsp;=&nbsp;
                Net: <b style={num}>${netPos.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <div style={card}><div style={label}>Monthly surplus, low case</div><div style={statBig}>${surpLow.toFixed(0)}</div></div>
            <div style={card}><div style={label}>Monthly surplus, high case</div><div style={statBig}>${surpHigh.toFixed(0)}</div></div>
            <div style={{ ...card, background: "var(--bg-accent)" }}><div style={label}>Net position now</div><div style={statBig}>${netPos.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={label}>Actual vs. plan - {currentMonthKey}</div>
              {monthPercentUsed !== null && (
                <div style={{ fontSize: "13px", color: monthVariance < 0 ? "var(--text-danger)" : "var(--text-success)", fontWeight: 500 }}>
                  {monthPercentUsed.toFixed(0)}% of plan used
                </div>
              )}
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
              This month's real spend (excluding transfers, income, and unreviewed rows) from the Log, against your committed costs plus discretionary pool. Committed-cost line items aren't linked to individual categories, so this compares totals only, not item-by-item.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "12px" }}>
              <div><div style={label}>Actual spend</div><div style={statSmall}>${actualSpendThisMonth.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div><div style={label}>Committed costs</div><div style={statSmall}>${committedCostsTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div><div style={label}>Discretionary pool</div><div style={statSmall}>${budget.discretionary.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div><div style={label}>Planned total</div><div style={statSmall}>${plannedMonthlyTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div><div style={label}>{monthVariance < 0 ? "Over plan by" : "Remaining"}</div><div style={{ ...statSmall, color: monthVariance < 0 ? "var(--text-danger)" : "var(--text-success)" }}>${Math.abs(monthVariance).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
            </div>
            {plannedMonthlyTotal > 0 && (
              <div style={{ height: "8px", borderRadius: "999px", background: "var(--surface-0)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, monthPercentUsed)}%`, background: monthPercentUsed > 100 ? "var(--text-danger)" : "var(--text-accent)", borderRadius: "999px" }} />
              </div>
            )}
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={label}>Target scenarios</div>
              <button style={{ ...btn, padding: "4px 10px" }} onClick={addTargetScenario}><Plus size={13} /> Add scenario</button>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>Add as many net-position goals as you want - rename them, set an amount, and see the gap, monthly pace, and feasibility against your current surplus.</p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Target</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={{ ...th, textAlign: "right" }}>Gap</th><th style={{ ...th, textAlign: "right" }}>Per month</th><th style={th}>Feasible?</th><th style={th}></th></tr></thead>
                <tbody>
                  {targets.map(t => (
                    <tr key={t.id}>
                      <td style={td}><input value={t.label} onChange={e => updateTargetScenario(t.id, "label", e.target.value)} style={{ ...input, minWidth: "120px" }} /></td>
                      <td style={{ ...td, textAlign: "right" }}><input type="number" value={t.amount} onChange={e => updateTargetScenario(t.id, "amount", e.target.value)} style={{ ...input, textAlign: "right", width: "120px" }} /></td>
                      <td style={{ ...td, textAlign: "right", ...num }}>${t.gap.toFixed(0)}</td>
                      <td style={{ ...td, textAlign: "right", ...num }}>{t.perMonth !== null ? `$${t.perMonth.toFixed(0)}` : "-"}</td>
                      <td style={{ ...td, color: t.feasible.startsWith("Yes") || t.feasible === "Already there" ? "var(--text-success)" : t.feasible.startsWith("Tight") ? "var(--text-warning)" : "var(--text-danger)" }}>{t.feasible}</td>
                      <td style={td}><button style={{ ...btn, padding: "6px" }} onClick={() => removeTargetScenario(t.id)}><Trash2 size={14} /></button></td>
                    </tr>
                  ))}
                  {targets.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>No target scenarios yet - click Add scenario.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "settings" && <SettingsTab
        spendingCategories={spendingCategories} addCategory={addCategory} renameCategory={renameCategory} removeCategory={removeCategory}
        lookup={lookup} allCategories={allCategories} addLookupRule={addLookupRule} updateLookupRuleCategory={updateLookupRuleCategory} removeLookupRule={removeLookupRule}
        recurringConfig={recurringConfig} updateRecurringConfig={updateRecurringConfig} resetRecurringConfig={resetRecurringConfig}
      />}
    </div>
  );
}

// Settings > Merchant rules > "Test regex rule": try a /pattern/flags rule against a sample merchant
// string before committing it as a real rule above. Reuses isRegexRuleKey/parseRegexRule - the exact
// functions categorize() and addLookupRule run - so whatever this box shows is exactly how the rule
// would behave once saved, not a separate approximation of it.
function RegexRuleTester() {
  const [sample, setSample] = useState("");
  const [pattern, setPattern] = useState("");

  const trimmedPattern = pattern.trim();
  const shaped = trimmedPattern !== "" && isRegexRuleKey(trimmedPattern);
  const regex = shaped ? parseRegexRule(trimmedPattern) : null;
  const invalidSyntax = shaped && !regex;
  const match = regex ? regex.exec(sample) : null;

  return (
    <div style={{ ...card, background: "var(--surface-2)", marginBottom: "12px" }}>
      <div style={{ ...label, marginBottom: "8px" }}>Test regex rule</div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>
        Try a pattern like <code style={{ fontFamily: "var(--font-mono)" }}>/^uber\s*eats/i</code> against a sample merchant string before adding it as a rule above.
      </p>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
        <input value={sample} onChange={e => setSample(e.target.value)} placeholder="Sample merchant string (e.g. UBER   EATS TORONTO)" style={{ ...input, flex: 1, minWidth: "220px" }} />
        <input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="/pattern/flags" style={{ ...input, flex: 1, minWidth: "220px", fontFamily: "var(--font-mono)" }} />
      </div>
      {trimmedPattern === "" ? (
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Enter a pattern wrapped in slashes, e.g. /costco/i, to test it.</div>
      ) : !shaped ? (
        <div style={{ fontSize: "12px", color: "var(--text-warning)" }}>Wrap the pattern in slashes (e.g. /costco/i) - as typed, this would be saved as a plain-text rule instead of a regex.</div>
      ) : invalidSyntax ? (
        <div style={{ fontSize: "12px", color: "var(--text-danger)" }}><AlertCircle size={13} style={{ verticalAlign: "-2px", marginRight: "4px" }} />Invalid regex syntax - this rule would never match anything if saved as-is.</div>
      ) : (
        <div style={{ fontSize: "12px", color: match ? "var(--text-success)" : "var(--text-secondary)" }}>
          {match ? (
            <>
              <Check size={13} style={{ verticalAlign: "-2px", marginRight: "4px" }} />
              Matches{match.length > 1 && <> - capture groups: {match.slice(1).map((g, i) => `$${i + 1}="${g ?? ""}"`).join(", ")}</>}
            </>
          ) : "No match against the sample string."}
        </div>
      )}
    </div>
  );
}

function SettingsTab({ spendingCategories, addCategory, renameCategory, removeCategory, lookup, allCategories, addLookupRule, updateLookupRuleCategory, removeLookupRule, recurringConfig, updateRecurringConfig, resetRecurringConfig }) {
  const [newCat, setNewCat] = useState("");
  const [editingCat, setEditingCat] = useState(null);
  const [editingCatValue, setEditingCatValue] = useState("");
  const [ruleSearch, setRuleSearch] = useState("");
  const [newRuleKey, setNewRuleKey] = useState("");
  const [newRuleCat, setNewRuleCat] = useState("");

  // Plain keys are already stored lowercased (normalize()), but a regex-shaped key (v6.3+) is kept
  // exactly as typed so its pattern isn't corrupted - so the search itself needs to lowercase k here
  // instead of assuming it already is.
  const filteredLookup = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    return q ? lookup.filter(([k, c]) => k.toLowerCase().includes(q) || c.toLowerCase().includes(q)) : lookup;
  }, [lookup, ruleSearch]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Manage categories</div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>These are the spending categories offered in every dropdown. System categories (Income, Transfers, Review) aren't shown here since removing them would break the math elsewhere.</p>
        <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
          <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" style={{ ...input, flex: 1 }}
            onKeyDown={e => { if (e.key === "Enter" && addCategory(newCat)) setNewCat(""); }} />
          <button style={btnPrimary} onClick={() => { if (addCategory(newCat)) setNewCat(""); }}><Plus size={14} /> Add</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {spendingCategories.map(c => (
            <div key={c} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              {editingCat === c ? (
                <>
                  <input value={editingCatValue} onChange={e => setEditingCatValue(e.target.value)} style={{ ...input, flex: 1 }} autoFocus
                    onKeyDown={e => { if (e.key === "Enter" && renameCategory(c, editingCatValue)) setEditingCat(null); }} />
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { if (renameCategory(c, editingCatValue)) setEditingCat(null); }}><Check size={13} /></button>
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={() => setEditingCat(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1 }}>{c}</span>
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { setEditingCat(c); setEditingCatValue(c); }}>Rename</button>
                  <button style={{ ...btn, padding: "6px" }} onClick={() => removeCategory(c)}><Trash2 size={14} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Merchant rules ({lookup.length})</div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>Every merchant string the categorizer recognizes. Longer, more specific keys are always checked first automatically - you don't need to manage priority order. A key wrapped in slashes with optional flags (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>/^uber\s*eats/i</code>) is matched as a regular expression instead of plain text.</p>
        <RegexRuleTester />
        <input value={ruleSearch} onChange={e => setRuleSearch(e.target.value)} placeholder="Search rules..." style={{ ...input, marginBottom: "10px" }} />
        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
          <input value={newRuleKey} onChange={e => setNewRuleKey(e.target.value)} placeholder="Merchant text (e.g. costco) or /regex/flags" style={{ ...input, flex: 1 }} />
          <select value={newRuleCat} onChange={e => setNewRuleCat(e.target.value)} style={{ ...input, width: "200px" }}>
            <option value="">Category...</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button style={btnPrimary} onClick={() => { if (addLookupRule(newRuleKey, newRuleCat)) { setNewRuleKey(""); setNewRuleCat(""); } }}><Plus size={14} /> Add</button>
        </div>
        <div style={{ overflowY: "auto", maxHeight: "420px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Merchant text</th><th style={th}>Category</th><th style={th}></th></tr></thead>
            <tbody>
              {filteredLookup.map(([k, c]) => (
                <tr key={k}>
                  <td style={{ ...td, ...num }}>{k}</td>
                  <td style={td}>
                    <select value={c} onChange={e => updateLookupRuleCategory(k, e.target.value)} style={{ ...input, width: "200px" }}>
                      {allCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </td>
                  <td style={td}><button style={{ ...btn, padding: "4px 8px" }} onClick={() => removeLookupRule(k)}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <div style={label}>Recurring detection</div>
          <button style={{ ...btn, padding: "4px 10px" }} onClick={resetRecurringConfig}>Reset to defaults</button>
        </div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
          Controls which merchants the Dashboard's "Recurring bills detected" table flags, and whether each is labeled Biweekly or Monthly. A merchant needs at least this many charges, with the average gap between them landing inside one of the two day-range windows below (a gap between the two windows won't match either).
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
          <div>
            <div style={label}>Minimum occurrences</div>
            <input type="number" min="1" step="1" value={recurringConfig.minOccurrences} onChange={e => updateRecurringConfig("minOccurrences", e.target.value)} style={input} />
          </div>
          <div>
            <div style={label}>Biweekly window - min days</div>
            <input type="number" value={recurringConfig.biweeklyMin} onChange={e => updateRecurringConfig("biweeklyMin", e.target.value)} style={input} />
          </div>
          <div>
            <div style={label}>Biweekly window - max days</div>
            <input type="number" value={recurringConfig.biweeklyMax} onChange={e => updateRecurringConfig("biweeklyMax", e.target.value)} style={input} />
          </div>
          <div>
            <div style={label}>Monthly window - min days</div>
            <input type="number" value={recurringConfig.monthlyMin} onChange={e => updateRecurringConfig("monthlyMin", e.target.value)} style={input} />
          </div>
          <div>
            <div style={label}>Monthly window - max days</div>
            <input type="number" value={recurringConfig.monthlyMax} onChange={e => updateRecurringConfig("monthlyMax", e.target.value)} style={input} />
          </div>
        </div>
      </div>
    </div>
  );
}
