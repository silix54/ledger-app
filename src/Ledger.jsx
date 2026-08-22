// Version: 6.9.12 - Category spending now nets refunds against their original purchase instead of
// summing magnitudes (a $150 purchase + $150 return nets to $0, not $300) - fixed across
// txnExpenseAmount, the category ranking + top-merchants drill-down, the monthly cash flow chart's
// outflow bars, and the fixed-vs-discretionary breakdown. Added a first-class "Investment" category
// Behavior (Settings), defaulting "Investing"/"Investments" categories to it, which now excludes
// dedicated investment categories from lifestyle-spend analytics entirely and feeds a new dedicated
// "Investments & Wealth Accumulation" Dashboard widget (monthly contribution chart + top destinations)
// below the cash flow chart. The KPI grid is now Total Earned / Total Lifestyle Spend (net) / Total
// Invested / Net Cash Remaining (earned − spend − invested) / Investment Rate %, replacing the old
// Net Savings + Avg Daily Spend tiles
import { useState, useMemo, useRef, useEffect } from "react";
import Papa from "papaparse";
import { BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from "recharts";
import { Upload, Download, Plus, AlertCircle, Check, Copy, ChevronDown, ChevronUp, Trash2, Settings, FolderOpen, Sun, Moon, X, Pencil, Undo2, Printer, ArrowUp, ArrowDown, LayoutGrid, Split, Merge, Cloud, UploadCloud, DownloadCloud, LogOut, Loader2, Lock, Fingerprint, Delete, KeyRound, ScanSearch } from "lucide-react";

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
// "Utilities" and "Hardware" (v6.9) were added alongside the Master Seed Auto-Categorization Dataset -
// see ensureMasterSeedCategories below - since the dataset's Utilities/Hardware merchant buckets need
// somewhere real to land that isn't a misleading fit for the pre-existing "Household" catch-all.
const DEFAULT_SPENDING_CATEGORIES = ["Giving","Groceries","Dining","Health","Pharmacy","Subscriptions","Telecom","Gym",
  "Apparel & Gear","Online Marketplace","Transport","Shipping (US mailbox)","Education",
  WEALTHSIMPLE_CATEGORY, "Convenience","Household","Personal Care","Events & Hobbies","Military","Debt Repayment","General Retail",
  "Utilities","Hardware"];
const NON_SPEND = new Set(SYSTEM_CATEGORIES);
const INCOME_CATS = new Set(["INCOME: Employment","INCOME: Benefits","INCOME: Reimbursement","INCOME: Resale"]);

// --- Sign-resilient category classification (Dashboard Overhaul + Customizable Category Behaviors) --
// Classifies a transaction into "income" | "expense" | "investment" | "neutral" using each category's
// configured *behavior* (see the categoryBehaviors state below and Settings > Spending Categories >
// Behavior dropdown) rather than a fixed prefix rule or raw amount sign alone - a person can mark any
// category Income/Expense/Investment/Neutral (Excluded) regardless of what it's named, so an income
// row saved with the wrong sign, or a transfer that was never really spend to begin with, doesn't
// quietly distort the Dashboard's totals. A category with no explicit entry in categoryBehaviors -
// nothing set yet, a system category nobody's touched the dropdown for, or a payload saved before this
// feature existed - falls back to defaultCategoryBehavior's prefix-based guess, so this is fully
// backwards compatible with every browser's already-saved data. Amount sign only gets the final word
// for a genuinely uncategorized row, since "no category yet" isn't itself a category: a positive
// uncategorized amount reads as income, a negative one as spend.
const VALID_BEHAVIORS = new Set(["income", "expense", "investment", "neutral"]);
// Shared option list for every Behavior <select> in Settings (existing categories + the add-category
// form), so the four choices and their labels only need to be written once.
const BEHAVIOR_OPTIONS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "investment", label: "Investment" },
  { value: "neutral", label: "Neutral (Excluded)" },
];
function defaultCategoryBehavior(catName) {
  const cat = catName || "";
  if (cat.startsWith("INCOME:")) return "income";
  if (cat.startsWith("TRANSFER:") || cat.startsWith("EXCLUDE:") || cat.startsWith("REVIEW:")) return "neutral";
  // Plain (unprefixed) category names a person would recognize as "money going toward long-term
  // wealth building" - matched by name rather than prefix since these are ordinary, user-editable
  // spending categories (WEALTHSIMPLE_CATEGORY = "Investing" among them), not a system category.
  if (cat.toLowerCase() === "investing" || cat.toLowerCase() === "investments") return "investment";
  return "expense";
}
function classifyTxnKind(t, categoryBehaviors) {
  const cat = t.category || "";
  if (!cat) return t.amount > 0 ? "income" : "expense";
  const configured = categoryBehaviors && categoryBehaviors[cat];
  return VALID_BEHAVIORS.has(configured) ? configured : defaultCategoryBehavior(cat);
}
// Always non-negative magnitudes built on classifyTxnKind, so a caller summing them never needs to
// remember which raw sign convention a given category happens to use. txnExpenseAmount nets refunds
// against outflows within the "expense" kind (a refund lands as a positive amount on the same
// expense-behavior category, so subtracting the signed amount - rather than summing its magnitude -
// correctly cancels a return against its original purchase instead of double-counting it as more
// spend); txnIncomeAmount/txnInvestedAmount aren't given the same treatment since neither income nor
// investment categories carry the same "refund" semantics in this app's transaction model.
function txnIncomeAmount(t, categoryBehaviors) { return classifyTxnKind(t, categoryBehaviors) === "income" ? Math.abs(t.amount) : 0; }
function txnExpenseAmount(t, categoryBehaviors) { return classifyTxnKind(t, categoryBehaviors) === "expense" ? -t.amount : 0; }
function txnInvestedAmount(t, categoryBehaviors) { return classifyTxnKind(t, categoryBehaviors) === "investment" ? Math.abs(t.amount) : 0; }

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

// v6.9: same "additive, idempotent, safe on every load" pattern as ensureWealthsimpleCategory just
// above - appends "Utilities"/"Hardware" for any browser whose saved spendingCategories predate the
// Master Seed Auto-Categorization Dataset (see DEFAULT_LOOKUP below), so the dataset's built-in
// Utilities/Hardware suggestions land on a category that actually exists in Settings and the category
// filters, rather than a category string nothing else knows about. A no-op the moment both are already
// present, so it's safe to run unconditionally on every load path, same as its Wealthsimple counterpart.
const MASTER_SEED_CATEGORIES = ["Utilities", "Hardware"];
function ensureMasterSeedCategories(spendingCategories) {
  const missing = MASTER_SEED_CATEGORIES.filter(c => !spendingCategories.includes(c));
  return missing.length ? [...spendingCategories, ...missing] : spendingCategories;
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
    // account is optional and additive, same reasoning as splitParentId below - every pre-multi-
    // account transaction simply won't have one, and that's a perfectly valid "unassigned" state,
    // not something to migrate or backfill (see AccountBadge/the Log tab's Account filter, which
    // both already treat a missing account as its own "unassigned" bucket rather than an error).
    && (t.account === null || t.account === undefined || typeof t.account === "string")
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
  _persistedCache = { transactions: null, lookup: null, spendingCategories: null, budget: null, recurringConfig: null, dashboardLayout: null, categoryBehaviors: null };
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
      _persistedCache.spendingCategories = ensureMasterSeedCategories(ensureWealthsimpleCategory(parsed.spendingCategories));
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
    if (parsed.categoryBehaviors && isValidCategoryBehaviors(parsed.categoryBehaviors)) {
      _persistedCache.categoryBehaviors = parsed.categoryBehaviors;
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

// The part of a merchant string before its first " - " location/branch separator (e.g. "SPOTIFY
// P45BDF0ACD - Stockholm" -> "SPOTIFY P45BDF0ACD"), normalized. Split on the RAW string and only
// normalize what's left - not the other way around - because normalize() itself collapses every "-"
// to a space, which would destroy the very separator this is looking for before it ever got to look.
function baseMerchantName(text) {
  const raw = String(text || "");
  const idx = raw.indexOf(" - ");
  return normalize(idx === -1 ? raw : raw.slice(0, idx));
}

// Merchant-matching half of the duplicate test, shared by looksLikeDuplicateOf (staging, exact-date)
// and findDuplicateClusters (retroactive log scan, ±1 day) below - a match by exact normalized text,
// substring containment either direction, or a shared "base" name across a " - " location/branch
// suffix (see baseMerchantName).
function merchantsLikelyMatch(rawA, rawB) {
  const a = normalize(rawA);
  const b = normalize(rawB);
  if (!a || !b) return false;
  if (a === b) return true; // exact match
  if (a.includes(b) || b.includes(a)) return true; // substring match, either direction
  const baseA = baseMerchantName(rawA);
  return !!baseA && baseA === baseMerchantName(rawB); // split match on " - "
}

// Looser duplicate test than fingerprint()'s exact match, used by CSV/paste staging to FLAG (not
// silently exclude) a row that's likely already in the log: same date, same magnitude - Math.abs, so
// a row imported once normally and once with an inverted sign (see the Credit Card mode toggle)
// still gets caught - and a merchant match via merchantsLikelyMatch above. Deliberately more
// permissive than fingerprint's exact-string dedup, which stays strict enough to safely auto-exclude
// a row without a person ever seeing it; this one only ever suggests, via a badge the person can
// override by checking the row back in (see stageRows/commitStaging).
function looksLikeDuplicateOf(row, existing) {
  if (row.date !== existing.date) return false;
  if (!Number.isFinite(row.amount) || !Number.isFinite(existing.amount)) return false;
  if (Math.abs(row.amount).toFixed(2) !== Math.abs(existing.amount).toFixed(2)) return false;
  return merchantsLikelyMatch(row.merchant || row.description || "", existing.merchant || existing.description || "");
}

// --- Retroactive "Scan for Duplicates" (Transaction Log) ---------------------------------------
// Unlike looksLikeDuplicateOf above (exact date match, used while staging a fresh import against the
// already-committed log), a retroactive scan across the log itself allows a ±1 day date drift too - a
// duplicate that slipped in from two overlapping statement exports often lands one calendar day apart
// (a weekend posting delay, a timezone cutoff at the bank), and by the time it's already sitting in
// the log there's no "which one is the new import" asymmetry left to lean on the way staging has.
function daysBetween(dateA, dateB) {
  const a = Date.parse(`${dateA}T00:00:00Z`);
  const b = Date.parse(`${dateB}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / 86400000;
}
function looksLikeDuplicatePair(a, b) {
  if (!Number.isFinite(a.amount) || !Number.isFinite(b.amount)) return false;
  if (Math.abs(a.amount).toFixed(2) !== Math.abs(b.amount).toFixed(2)) return false;
  if (daysBetween(a.date, b.date) > 1) return false;
  return merchantsLikelyMatch(a.merchant || a.description || "", b.merchant || b.description || "");
}

// Groups the full transaction log into clusters of likely duplicates (2+ transactions each). Each
// transaction is compared only against the first (lowest-id, i.e. earliest-added) unclustered
// transaction it's checked against - the "anchor" - rather than computed as a full transitive
// closure, so a cluster's membership stays predictable and doesn't balloon through a long chain of
// loosely-related merchant strings. O(n^2) comparisons is fine at personal-finance-history scale
// (thousands of rows, not millions). Within a cluster, transactions are sorted lowest-id-first so the
// caller can treat index 0 as the original entry to keep by default.
function findDuplicateClusters(transactions) {
  const relevant = transactions
    .filter(t => Number.isFinite(t.amount) && (t.merchant || t.description))
    .sort((a, b) => a.id - b.id);
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < relevant.length; i++) {
    const anchor = relevant[i];
    if (used.has(anchor.id)) continue;
    const group = [anchor];
    for (let j = i + 1; j < relevant.length; j++) {
      const candidate = relevant[j];
      if (used.has(candidate.id)) continue;
      if (looksLikeDuplicatePair(anchor, candidate)) group.push(candidate);
    }
    if (group.length > 1) {
      group.forEach(g => used.add(g.id));
      clusters.push(group);
    }
  }
  return clusters;
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_ROWS = 200000;
const MAX_PASTE_LINES = 5000;

// --- Flexible CSV/paste date & amount parsing ------------------------------------------------
// Bank statements spell dates and amounts in a lot of different ways; these normalize whatever
// comes in to what the rest of the app actually understands (a YYYY-MM-DD string for date, a plain
// signed number for amount) so fewer real rows land in the "couldn't be parsed" pile.

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n) { return String(n).padStart(2, "0"); }

// Builds a YYYY-MM-DD string and only returns it if it survives a round-trip through Date - guards
// against e.g. year/month/day (2026, 2, 30) silently becoming March 2nd instead of being rejected.
// Interpreted as UTC (per the ISO 8601 date-only spec new Date() follows), so getUTC* is used for
// the round-trip check rather than the local getters, which would drift a day near a timezone edge.
function toISODate(year, month, day) {
  if (!(year >= 1000 && year <= 9999) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return iso;
}

// Accepts the date spellings a bank statement is likely to use - ISO (YYYY-MM-DD), numeric D/M/Y or
// M/D/Y with '/' or '-' separators (2 or 4-digit year), and a text month either side of the day
// ("22-AUG-2026", "Aug 22, 2026") - and normalizes to this app's canonical YYYY-MM-DD, or returns
// null if nothing recognizable was found. Numeric day/month order is genuinely ambiguous when both
// parts are <=12 (e.g. "05/06/2026"): this app is Canadian-first (see the built-in CIBC/BMO/Canadian-
// merchant dataset elsewhere in this file), so an ambiguous numeric date defaults to day-first
// (Canadian/UK convention) rather than month-first (US) - an unambiguous case (either part >12) is
// read correctly regardless of which convention the file actually uses.
function parseFlexibleDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return toISODate(+m[1], +m[2], +m[3]);

  // Unseparated compact dates some POS/legacy exports use, checked before the punctuated formats
  // below since those all require a separator or letters and can't otherwise collide with a bare
  // digit run. YYYYMMDD is unambiguous; YYMMDD's 2-digit year is always read as 20YY - a compact
  // 6-digit date is realistically never from last century, so there's no real ambiguity to pivot on.
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // YYYYMMDD
  if (m) return toISODate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})(\d{2})(\d{2})$/); // YYMMDD -> 20YY-MM-DD
  if (m) return toISODate(2000 + (+m[1]), +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\s\-/]+([A-Za-z]{3,9})[\s\-/,]+(\d{4})$/); // "22-AUG-2026", "22 Aug, 2026"
  if (m && MONTH_NAMES[m[2].toLowerCase()]) return toISODate(+m[3], MONTH_NAMES[m[2].toLowerCase()], +m[1]);

  m = s.match(/^([A-Za-z]{3,9})[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{4})$/); // "Aug 22 2026", "August 22, 2026"
  if (m && MONTH_NAMES[m[1].toLowerCase()]) return toISODate(+m[3], MONTH_NAMES[m[1].toLowerCase()], +m[2]);

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/); // numeric D/M/Y or M/D/Y, either separator
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900; // 2-digit year pivot: 00-69 -> 2000s, 70-99 -> 1900s
    if (a > 12 && b <= 12) return toISODate(y, b, a); // unambiguous day-first
    if (b > 12 && a <= 12) return toISODate(y, a, b); // unambiguous month-first
    if (a <= 12 && b <= 12) return toISODate(y, b, a); // ambiguous - default day-first, see comment above
    return null; // both >12: not a valid date under either convention
  }

  return null;
}

// Cleans common bank-statement amount spellings before parseFloat: currency symbols/codes ($, CAD,
// USD, CDN), thousands-separator commas, a trailing negative sign some exports use instead of a
// leading one ("50.00-"), and accounting-style parentheses for negatives ("(50.00)" -> "-50.00").
// Currency markers are stripped before sign detection so a leading "$-50.00" or "-CAD 50.00" doesn't
// hide its sign behind the symbol/code. Returns NaN (not 0) for anything that still isn't a number,
// so a genuinely unparseable amount stays distinguishable from a real zero-dollar transaction.
function parseFlexibleAmount(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return NaN;
  s = s.replace(/CAD|USD|CDN|\$/gi, "").trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1).trim(); }
  if (s.startsWith("+")) { s = s.slice(1).trim(); }
  s = s.replace(/,/g, "");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -Math.abs(n) : n;
}

// Header names for a file that splits money-out/money-in across two columns instead of one signed
// Amount column - "Debit"/"Credit" and "Withdrawal(s)"/"Deposit(s)" are the common spellings.
const DEBIT_NAMES = ["debit", "withdrawal", "withdrawals"];
const CREDIT_NAMES = ["credit", "deposit", "deposits"];

// Combines separate Debit/Credit (or Withdrawals/Deposits) column values into this app's single
// signed Amount (negative = money out, matching every other ingestion path). Each side is read as a
// plain magnitude via parseFlexibleAmount regardless of whether the source file already put its own
// sign on debit values, so a file that already writes debits as negative doesn't get double-negated.
// A blank/unparseable cell on one side contributes 0, not NaN, so a normal single-sided row (only
// Debit or only Credit populated, the usual case) still combines cleanly. Returns "" - not "0" - when
// both sides are blank/unparseable, so the row is correctly treated as missing an amount rather than
// a real $0 transaction.
function combineDebitCredit(debitRaw, creditRaw) {
  const debitVal = debitRaw && String(debitRaw).trim() ? parseFlexibleAmount(debitRaw) : NaN;
  const creditVal = creditRaw && String(creditRaw).trim() ? parseFlexibleAmount(creditRaw) : NaN;
  if (!Number.isFinite(debitVal) && !Number.isFinite(creditVal)) return "";
  const amount = (Number.isFinite(creditVal) ? Math.abs(creditVal) : 0) - (Number.isFinite(debitVal) ? Math.abs(debitVal) : 0);
  return String(amount);
}

// A credit card statement writes ordinary purchases as positive and payment-toward-the-balance rows
// as negative - the exact mirror image of this app's own negative=money-out convention. Keying off
// payment-keyword rows alone doesn't actually distinguish the two account types, though: a chequing
// account has "bill payment"/e-transfer rows too, and those are ALSO negative there (money still
// left the account). What's actually diagnostic is the polarity of the ORDINARY retail rows - dining,
// gas, groceries, shopping - once payment/deposit/payroll/transfer rows are excluded: a majority of
// positive amounts among those means credit card (invert=true); a majority of negative amounts means
// a normal debit/chequing statement (invert=false, the default when retail rows are tied or absent).
const NON_RETAIL_PATTERN = /payment|deposit|payroll|transfer|e-transfer|interac/i;
function looksLikeCreditCardFormat(rows) {
  const retail = rows
    .map(r => ({ amt: parseFlexibleAmount(r.amount), text: `${r.merchant || ""} ${r.description || ""}` }))
    .filter(r => Number.isFinite(r.amt) && r.amt !== 0 && !NON_RETAIL_PATTERN.test(r.text));
  if (retail.length === 0) return false;
  const positive = retail.filter(r => r.amt > 0).length;
  return positive > retail.length - positive;
}

// BMO Mastercard exports carry this exact quartet of column headers ("Item #", "Card #",
// "Transaction Date", "Transaction Amount") and no bank name anywhere in the file, so the generic
// CREDIT_ACCOUNT_HINT below never fires for them - this checks for the header quartet specifically,
// ahead of the generic checks, so those files still get a named-account guess instead of "".
function looksLikeBMOExport(text) {
  return /card\s*#/i.test(text) && /item\s*#/i.test(text)
    && /transaction\s*date/i.test(text) && /transaction\s*amount/i.test(text);
}

// Account auto-detect for a single uploaded CSV (handleCSV): checks the file's own name plus its
// first several lines - some bank exports carry an account-type line ("Account Type,Visa Infinite", a
// branch/product name, etc.) above the real column headers - for words that name a credit product
// vs a chequing/debit product. "scotiabank" in the same text upgrades the generic guess to a
// specifically-named account; without it, the generic name is returned so this doesn't invent a
// bank the file never mentioned. Returns "" when neither pattern matches, meaning "no guess" - the
// Account field is left for the person to fill in themselves rather than defaulting to something
// arbitrary. Not run for "Select folder" (many files, potentially many different accounts at once)
// or paste (no file to inspect at all). Scans 10 lines, not just the first couple, to stay ahead of
// preamble/metadata rows that can push the real header row (and any bank-name hints near it) further
// down the file - see findHeaderRowIndex's matching scan window.
const CREDIT_ACCOUNT_HINT = /visa|mastercard|amex|credit/i;
const CHEQUING_ACCOUNT_HINT = /chequing|checking|debit|savings/i;
function guessAccountFromFile(filename, rawText) {
  const topLines = (rawText || "").split("\n").slice(0, 10).join("\n");
  const haystack = `${filename || ""}\n${topLines}`;
  if (looksLikeBMOExport(haystack)) return "BMO Mastercard";
  const isScotiabank = /scotiabank/i.test(haystack);
  if (CREDIT_ACCOUNT_HINT.test(haystack)) return isScotiabank ? "Scotiabank Visa" : "Credit Card";
  if (CHEQUING_ACCOUNT_HINT.test(haystack)) return isScotiabank ? "Scotiabank Chequing" : "Chequing";
  return "";
}

// True when an account name or filename clearly names a chequing/debit/savings account rather than
// a credit product (reuses CHEQUING_ACCOUNT_HINT above). A chequing account is never plausibly a
// credit card statement no matter what its rows look like, so this guard overrides
// looksLikeCreditCardFormat's polarity heuristic outright rather than just weighing against it - see
// stageRowsWithSignDetection, the only caller.
function isChequingLikeAccount(text) {
  return CHEQUING_ACCOUNT_HINT.test(text || "");
}

// --- Dashboard Overhaul: pill-based timeframe/account filters --------------------------------
// Local YYYY-MM-DD (not toISODate's UTC round-trip) - these windows are anchored on the viewer's
// "today", so they need local calendar semantics, not UTC's.
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

const DASH_TIMEFRAMES = [
  { id: "thisMonth", label: "This Month" },
  { id: "last3", label: "Last 3M" },
  { id: "last6", label: "Last 6M" },
  { id: "ytd", label: "YTD" },
  { id: "last12", label: "12 Months" },
  { id: "all", label: "All Time" },
];

// Resolves a timeframe pill id to a concrete [from, to] date-string window, anchored on "today".
// "all" spans from the earliest transaction on record instead of an arbitrary fixed date, so the
// window is never wider than the data actually on hand.
function resolveTimeframeWindow(tf, transactions) {
  const now = new Date();
  const to = ymd(now);
  if (tf === "thisMonth") return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  if (tf === "ytd") return { from: ymd(new Date(now.getFullYear(), 0, 1)), to };
  if (tf === "last3") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate() + 1)), to };
  if (tf === "last6") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate() + 1)), to };
  if (tf === "last12") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 12, now.getDate() + 1)), to };
  const dates = transactions.map(t => t.date).filter(Boolean).sort();
  return { from: dates.length ? dates[0] : to, to };
}

// The immediately-preceding window of the same length, for the KPI grid's "vs previous period" trend -
// "This Month" compares to last month, "Last 3M" compares to the 3 months before that, and so on.
function resolvePreviousWindow({ from, to }) {
  const fromD = new Date(`${from}T00:00:00`);
  const toD = new Date(`${to}T00:00:00`);
  const spanDays = Math.round((toD - fromD) / 86400000) + 1;
  const prevTo = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
  return { from: ymd(prevFrom), to: ymd(prevTo) };
}

// "Credit Cards" / "Chequing/Debit" reuse the same name-sniffing regexes CSV import already uses to
// guess an account's type from its name, so the Dashboard's account buckets stay consistent with
// whatever the app already believes about each account.
function accountMatchesDashFilter(account, filter) {
  if (filter === "all") return true;
  if (filter === "credit") return CREDIT_ACCOUNT_HINT.test(account || "");
  if (filter === "chequing") return isChequingLikeAccount(account || "");
  return account === filter;
}

// Some exports (BMO among them) put an account summary, a disclaimer, or a blank spacer row above
// the real column header row, so Row 0 isn't reliably the header - these three functions locate the
// real one instead of assuming it. A row counts as "the header" once at least two of its cells
// contain one of these column-name keywords (a single hit is too weak a signal: a preamble line like
// "Statement Date,2026-08-01" would false-positive on "date" alone). Only the first 10 rows are
// scanned - a header buried deeper than that isn't a preamble anymore, it's a malformed file - and if
// nothing qualifies, row 0 is used as a safe fallback (unchanged behaviour for every normal file that
// already puts its header on row 0).
const HEADER_ROW_KEYWORDS = ["date", "description", "amount", "item #", "card #", "debit", "credit", "merchant"];
function looksLikeHeaderRow(fields) {
  const hits = (fields || []).filter(f => {
    const cell = String(f ?? "").trim().toLowerCase();
    return HEADER_ROW_KEYWORDS.some(kw => cell.includes(kw));
  });
  return hits.length >= 2;
}
function findHeaderRowIndex(rawRows) {
  const scanLimit = Math.min(rawRows.length, 10);
  for (let i = 0; i < scanLimit; i++) {
    if (looksLikeHeaderRow(rawRows[i])) return i;
  }
  return 0;
}

// Header-less (array-of-rows) parse of raw CSV text, followed by manual re-keying from whichever row
// findHeaderRowIndex identifies as the real header - the same shape Papa.parse's own header:true mode
// would have produced, but with any preamble/metadata rows above the header discarded instead of
// mis-read as data (or, worse, mistaken for the header itself). Ragged rows (fewer cells than the
// header) get "" for the missing trailing columns rather than undefined, so downstream `find()` calls
// (which call .toString() on every field) never throw.
function parseCSVWithHeaderDetection(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  const rawRows = parsed.data;
  if (!rawRows || rawRows.length === 0) return { data: [] };
  const headerIdx = findHeaderRowIndex(rawRows);
  const headerRow = rawRows[headerIdx].map(h => String(h ?? "").trim());
  const data = rawRows.slice(headerIdx + 1).map(cols => {
    const obj = {};
    headerRow.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  });
  return { data };
}

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
    // Strip "g"/"y" (global/sticky) before compiling - both make RegExp#test() stateful via
    // lastIndex, carrying a partial match position over between separate .test() calls on the same
    // object. That's harmless for a one-off test, but categorize() below now tests a regex-shaped
    // rule against both the raw and normalized merchant text in the same call, and Tier 2's
    // DEFAULT_LOOKUP_COMPILED regexes are compiled once and reused across every categorize() call for
    // every transaction - either "g" or "y" would silently corrupt matching (a match found on one
    // call/test can suppress or skew the very next one) rather than behaving like the same stateless
    // pattern every time. Any other flag (currently just "i") passes through unchanged.
    const flags = m[2].replace(/[gy]/g, "");
    return new RegExp(m[1], flags);
  } catch {
    // Invalid pattern syntax is routine, expected user input here (not an environment failure worth
    // logging like the other catches in this file) - silently treated as "never matches."
    return null;
  }
}

// --- Master Seed Auto-Categorization Dataset (v6.9) -------------------------------------------------
// A large built-in library of common North American merchant name substrings, grouped by category
// below and flattened into DEFAULT_LOOKUP - an array of [key, category] tuples, the exact same shape
// as a user's own `lookup` entries (see CONTEXT.md's Merchant Lookup section). This is Tier 2 of
// categorize() below: consulted only once no rule in the person's own `lookup` matches, so it can
// never override a user rule and never needs any precedence logic of its own. None of it is shown or
// editable in Settings > Merchant rules, and none of it is ever written into `lookup`/STORAGE_KEY/JSON
// export - it isn't the person's own data, just a built-in fallback categorize() consults. A merchant
// this dataset gets wrong (or misses entirely) is a one-time "no match" the person corrects exactly
// like any other suggestion - that correction becomes a real Tier 1 `lookup` rule and permanently wins
// over this dataset for that merchant from then on.
//
// seedRules() is a plain data-entry helper, not part of the matching logic - it just spreads one
// category label across many keys so the (large) lists below don't repeat the category string on every
// line. The category names used here are exact spendingCategories/SYSTEM_CATEGORIES strings (see
// DEFAULT_SPENDING_CATEGORIES/SYSTEM_CATEGORIES above) - "Utilities" and "Hardware" are new in v6.9
// (see ensureMasterSeedCategories) since neither had a real home in the pre-v6.9 category set.
function seedRules(category, keys) {
  return keys.map(key => [key, category]);
}

const DEFAULT_LOOKUP = [
  ...seedRules("Groceries", [
    "walmart", "walmart supercenter", "costco", "costco wholesale", "loblaws", "loblaw", "no frills",
    "real canadian superstore", "superstore", "atlantic superstore", "sobeys", "safeway", "metro",
    "metro plus", "food basics", "freshco", "longo's", "whole foods", "whole foods market",
    "trader joe's", "kroger", "publix", "albertsons", "vons", "ralphs", "wegmans", "giant eagle",
    "meijer", "h-e-b", "aldi", "save-on-foods", "iga", "provigo", "maxi", "zehrs",
    "your independent grocer", "fortinos", "farm boy", "t&t supermarket", "sprouts farmers market",
    "winco foods", "stop & shop", "shoprite", "hy-vee", "piggly wiggly", "harris teeter", "food lion",
    "winn-dixie", "market basket", "bj's wholesale", "sam's club", "thrifty foods", "buy-low foods",
    "choices market", "nations fresh foods", "adonis", "patel brothers", "foodland", "quality foods",
    "western family foods", "calgary co-op", "red apple grocery", "real canadian wholesale club",
    "giant food", "redner's", "weis markets", "price chopper", "festival foods", "lunds & byerlys",
    "king soopers", "fred meyer", "smith's food and drug", "qfc", "fry's food", "gristedes", "foodtown",
    "save mart", "vons pavilions", "jewel-osco", "star market", "acme markets", "tops friendly markets",
    "wegmans food markets", "brookshire's", "schnucks", "hannaford", "ingles markets", "county market",
    "sav-a-lot", "food city", "brookshire brothers", "lowes foods", "bi-lo", "marsh supermarkets",
    "dierbergs markets", "homeland stores", "buehler's fresh foods", "cub foods", "hen house market",
    "price rite marketplace", "market street", "tom thumb", "randalls", "carrs safeway",
    "haggen food and pharmacy", "lucky supermarkets", "grocery outlet", "food4less", "superior grocers",
    "northgate gonzalez markets", "cardenas markets",
  ]),
  ...seedRules("Dining", [
    "mcdonald's", "tim hortons", "starbucks", "subway", "wendy's", "burger king", "kfc", "taco bell",
    "pizza pizza", "domino's", "pizza hut", "panera bread", "chipotle", "a&w", "harvey's",
    "swiss chalet", "boston pizza", "east side mario's", "milestones grill", "cactus club cafe",
    "earls kitchen", "white spot", "denny's", "ihop", "applebee's", "chili's", "olive garden",
    "red lobster", "outback steakhouse", "five guys", "in-n-out burger", "shake shack", "popeyes",
    "dairy queen", "sonic drive-in", "jimmy john's", "panda express", "chick-fil-a", "wingstop",
    "buffalo wild wings", "freshii", "second cup", "booster juice", "jugo juice", "montana's bbq",
    "kelseys", "st-hubert", "uber eats", "doordash", "skipthedishes", "grubhub", "just eat",
    "papa john's", "little caesars", "jersey mike's", "firehouse subs", "culver's", "whataburger",
    "carl's jr", "hardee's", "arby's", "checkers drive-in", "rally's", "del taco", "el pollo loco",
    "qdoba", "moe's southwest grill", "noodles & company", "pei wei", "cava", "sweetgreen", "chopt",
    "boston market", "cracker barrel", "waffle house", "bob evans", "perkins restaurant",
    "village inn", "first watch", "black bear diner", "coffee time", "country style",
    "robin's donuts", "williams fresh cafe", "jamba juice", "tropical smoothie cafe", "smoothie king",
    "orange julius", "baskin robbins", "cold stone creamery", "menchie's", "yogen fruz",
    "marble slab creamery", "ben & jerry's", "haagen-dazs", "dunkin", "krispy kreme", "cinnabon",
    "auntie anne's", "wetzel's pretzels", "mrs fields", "mr sub", "quiznos", "extreme pita",
    "pita pit", "freshslice pizza", "pizza nova", "gino's pizza", "panago pizza", "mamma's pizza",
    "greco pizza", "sammy's pizza", "red robin", "tgi fridays", "ruby tuesday", "bonefish grill",
    "carrabba's", "longhorn steakhouse", "texas roadhouse", "logan's roadhouse", "golden corral",
    "sizzler", "the keg steakhouse", "moxies grill", "joey restaurant", "jack astor's",
    "original joe's", "browns socialhouse", "tap & barrel", "pizza 73", "pizza hotline",
    "boston market canada", "wienerschnitzel", "castle hamburgers", "white castle", "steak n shake",
    "bojangles", "church's chicken", "zaxby's", "raising cane's", "jack in the box",
    "del frisco's grill", "cheesecake factory", "p.f. chang's", "yard house", "bj's restaurant",
    "dave & buster's", "kernels popcorn", "treats bakery", "presse cafe", "pumpernickel's",
    "cobbs bread", "great canadian bagel", "bagel world", "manchu wok", "edo japan",
    "teriyaki experience", "thai express", "new york fries",
    // Regex-shaped catch-all (v6.9.2) for the handful of highest-volume chains whose merchant strings
    // routinely show up with no space at all ("timhortons", "timhorton") in addition to the spaced
    // plain-text keys above ("tim hortons") - a plain substring key can't bridge that gap, since
    // "tim hortons" is never a literal substring of "timhortons". `s?` on each covers the
    // singular/plural merchant-string variants some POS systems emit (e.g. "tims").
    "/timhortons?|tim\\s*hortons?|tims?|starbucks?|mcdonalds?/i",
  ]),
  ...seedRules("Transport", [
    "uber", "lyft", "go transit", "ttc", "oc transpo", "presto card", "metrolinx", "via rail",
    "amtrak", "greyhound", "megabus", "flixbus", "petro-canada", "shell", "esso", "chevron",
    "exxonmobil", "husky gas", "circle k", "impark", "green p parking", "indigo parking", "407 etr",
    "ez-pass", "air canada", "westjet", "porter airlines", "delta air lines", "united airlines",
    "american airlines", "southwest airlines", "alaska airlines", "jetblue", "spirit airlines",
    "frontier airlines", "communauto", "car2go", "zipcar", "evo car share", "modo car co-op",
    "hertz", "enterprise rent-a-car", "avis", "budget rent a car", "national car rental",
    "thrifty car rental", "bixi montreal", "mobi bike share", "citi bike", "translink", "bc transit",
    "stm montreal", "calgary transit", "edmonton transit", "winnipeg transit", "halifax transit",
    "skytrain", "west coast express", "sun country airlines", "allegiant air", "flair airlines",
    "sunwing airlines", "air transat", "mobil gas", "sunoco", "valero energy", "marathon petroleum",
    "76 gas station", "arco", "love's travel stop", "pilot flying j", "wawa fuel",
    "casey's general store", "speedway gas", "kwik trip", "parking panda", "spothero", "laz parking",
    "flair air", "wheeltrans", "muni san francisco", "bart bay area", "septa philadelphia",
    "mta new york", "cta chicago", "wmata washington", "marta atlanta", "sound transit seattle",
    "king county metro", "denver rtd", "dart dallas",
    // Two regex-shaped catch-alls (v6.9.1) layered on top of the plain-text keys above: each covers a
    // cluster of common spelling/spacing variants (with vs. without a space, "prestocard" vs. "presto
    // card", a hyphen vs. a space) a single plain substring key can't - see REGEX_RULE_SHAPE/
    // isRegexRuleKey/parseRegexRule above for how a "/pattern/flags" string is detected and compiled.
    // Transit systems/apps + micromobility/carshare:
    "/presto|prestocard|oc\\s*transpo|octranspo|ttc|translink|stm|go\\s*transit|gotransit|metrolinx|up\\s*express|upexpress|via\\s*rail|viarail|amtrak|calgary\\s*transit|edmonton\\s*transit|exo\\s*train|bixi|lime\\s*bike|bird\\s*scooter|communauto|zipcar|turo|evo\\s*car/i",
    // Fuel brands + parking operators:
    "/esso|petro\\s*canada|petro-canada|petrocan|shell|chevron|pioneer\\s*energy|canadian\\s*tire\\s*gas|husky\\s*oil|ultramar|green\\s*p|parkopedia|impark|precise\\s*parklink|honkmobile|paybyphone/i",
  ]),
  ...seedRules("Subscriptions", [
    "netflix", "spotify", "disney plus", "amazon prime", "apple.com/bill", "icloud storage",
    "google play", "google storage", "google one", "youtube premium", "youtube tv", "crave tv",
    "hulu", "hbo max", "paramount plus", "peacock tv", "audible", "xbox game pass", "xbox live",
    "playstation network", "nintendo eshop", "adobe creative cloud", "microsoft 365", "office 365",
    "dropbox plus", "patreon", "twitch", "amazon music", "tidal music", "deezer", "siriusxm",
    "new york times subscription", "globe and mail subscription", "wall street journal",
    "washington post subscription", "kindle unlimited", "scribd", "calm.com", "headspace",
    "duolingo plus", "notion labs", "canva", "linkedin premium", "skillshare", "masterclass",
    "blue apron", "hellofresh", "goodfood", "chefs plate", "fabletics membership", "stitch fix",
    "birchbox", "ipsy", "barkbox", "chewy autoship", "classpass", "peloton membership", "zwift",
    "strava subscription", "nordvpn", "expressvpn", "1password", "lastpass", "dashlane", "github",
    "gitlab", "atlassian", "slack", "zoom.us", "evernote", "todoist", "grammarly", "squarespace",
    "wix.com", "godaddy", "namecheap", "cloudflare", "mailchimp", "quickbooks online", "turbotax",
    "norton antivirus", "mcafee", "malwarebytes", "crunchyroll", "funimation", "vudu",
    "apple tv plus", "discovery plus", "britbox", "acorn tv", "shudder", "mubi", "curiositystream",
    "babbel", "rosetta stone", "coursera plus", "udemy", "masterclass annual", "wondery plus",
    "sirius satellite radio", "xm radio canada", "cbc gem", "tou.tv",
  ]),
  ...seedRules("Telecom", [
    "rogers communications", "rogers wireless", "bell canada", "bell mobility", "telus mobility",
    "freedom mobile", "fido solutions", "koodo mobile", "virgin plus", "public mobile",
    "chatr mobile", "videotron", "shaw communications", "cogeco", "eastlink", "at&t mobility",
    "verizon wireless", "t-mobile", "sprint corporation", "xfinity", "comcast", "spectrum",
    "charter communications", "centurylink", "frontier communications", "cricket wireless",
    "boost mobile", "metro by t-mobile", "straight talk wireless", "google fi", "mint mobile",
    "us cellular", "consumer cellular", "ting mobile", "red pocket mobile", "lucky mobile",
    "sasktel", "mts mobility", "bell aliant", "execulink telecom", "distributel", "teksavvy",
    "oxio internet", "novus entertainment", "bell fibe", "rogers ignite", "telus optik",
    "shaw direct", "wightman telecom", "cogeco connexion", "primus telecom", "ebox internet",
    "vmedia",
  ]),
  ...seedRules("Utilities", [
    "hydro one", "toronto hydro", "bc hydro", "hydro-quebec", "manitoba hydro", "nova scotia power",
    "newfoundland power", "saskpower", "direct energy", "enbridge gas", "enmax", "epcor",
    "fortisbc", "fortisalberta", "atco gas", "atco electric", "just energy", "national grid",
    "con edison", "pg&e", "duke energy", "georgia power", "dominion energy",
    "southern california edison", "xcel energy", "dte energy", "consumers energy",
    "national fuel gas", "peoples gas", "nicor gas", "ameren", "entergy", "pseg", "columbia gas",
    "spire energy", "we energies", "avista utilities", "puget sound energy",
    "portland general electric", "salt river project", "evergy", "oncor electric",
    "centerpoint energy", "austin energy", "san diego gas and electric", "city of calgary utilities",
    "city of edmonton utilities", "hamilton water", "ottawa hydro", "london hydro",
    "kitchener utilities", "waterloo north hydro", "veridian connections", "alectra utilities",
    "elexicon energy",
  ]),
  ...seedRules("Hardware", [
    "home depot", "lowe's", "rona", "canadian tire", "home hardware", "ace hardware", "menards",
    "tractor supply co", "princess auto", "kent building supplies", "timber mart",
    "castle building centres", "do it best hardware", "true value hardware",
    "orchard supply hardware", "harbor freight tools", "northern tool", "sherwin-williams",
    "benjamin moore paints", "ppg paints", "dulux paints", "ikea", "bed bath & beyond",
    "container store", "restoration hardware", "williams-sonoma", "crate and barrel", "reno-depot",
    "richelieu hardware", "brico depot", "lee valley tools", "patio drummond", "rona+",
    "revy home centre", "aikenhead's hardware", "beaver lumber",
  ]),
  ...seedRules("Apparel & Gear", [
    "old navy", "gap outlet", "gap factory", "h&m", "zara", "uniqlo", "lululemon athletica",
    "nike store", "adidas store", "under armour", "sport chek", "winners", "marshalls", "tj maxx",
    "ross dress for less", "reitmans", "aritzia", "american eagle outfitters", "hollister co",
    "abercrombie & fitch", "forever 21", "urban outfitters", "foot locker", "sporting life",
    "mountain equipment co-op", "columbia sportswear", "the north face", "roots canada",
    "banana republic", "j.crew", "express clothing", "ann taylor", "loft", "chico's", "talbots",
    "eddie bauer", "lands' end", "brooks brothers", "nordstrom rack", "saks fifth avenue",
    "holt renfrew", "hudson's bay", "la maison simons", "browns shoes", "aldo shoes",
    "dsw shoe warehouse", "journeys shoes", "vans store", "converse store", "skechers",
    "new balance", "puma store", "reebok store", "champion store", "gymshark",
    "victoria's secret", "bath & body works", "sephora", "ulta beauty", "zumiez", "pacsun",
    "tilly's", "hot topic", "spencer's", "claire's", "guess inc", "calvin klein",
    "tommy hilfiger", "levi's", "dockers", "kohl's", "jcpenney", "macy's", "dillard's", "belk",
    "burlington coat factory", "primark", "garage clothing", "dynamite clothing", "urban planet",
    "mark's work wearhouse", "kit and ace", "frank and oak", "sirens fashion", "urban behavior",
    "bluenotes", "suzy shier", "cleo clothing", "penningtons", "addition elle", "laura canada",
    "tristan clothing", "moores clothing", "harry rosen", "jack & jones", "moose knuckles",
    "canada goose", "arc'teryx", "mountain warehouse", "patagonia store", "helly hansen",
    "sail outdoors", "atmosphere sports",
  ]),
  ...seedRules("INCOME: Benefits", [
    "canada revenue agency", "canada child benefit", "gst hst credit",
    "employment and social development canada", "service canada", "employment insurance benefit",
    "canada pension plan", "old age security", "veterans affairs canada", "irs tax refund",
    "social security administration", "unemployment insurance payment", "snap benefits",
    "ontario works", "ontario disability support program", "workers compensation board",
    "wsib payment", "disability tax credit", "canada workers benefit", "canada dental benefit",
    "alberta child benefit", "bc affordability credit", "manitoba child benefit",
    "saskatchewan employment supplement", "nova scotia child benefit", "quebec family allowance",
    "yukon child benefit",
  ]),
  ...seedRules("INCOME: Employment", [
    "adp payroll", "ceridian payroll", "dayforce", "workday inc", "payworks", "wagepoint",
    "humi payroll", "rippling payroll", "gusto payroll", "quickbooks payroll", "paychex",
    "ultipro", "sap successfactors", "government of canada pay", "receiver general payroll",
    "direct deposit payroll", "payroll deposit", "salary deposit", "employer payroll deposit",
    "replicon payroll", "avanti software payroll", "nethris payroll", "employer direct deposit",
  ]),
  ...seedRules("TRANSFER: Internal/Other", [
    "interac e-transfer", "e-transfer", "email money transfer", "eft transfer", "wire transfer",
    "td canada trust transfer", "rbc royal bank transfer", "scotiabank transfer",
    "bmo bank of montreal transfer", "cibc transfer", "national bank of canada transfer",
    "tangerine transfer", "simplii financial transfer", "desjardins transfer",
    "hsbc bank canada transfer", "laurentian bank transfer", "paypal transfer", "venmo",
    "zelle payment", "wise transfer", "western union", "moneygram", "remitly",
    "xoom money transfer", "chase bank transfer", "bank of america transfer",
    "wells fargo transfer", "citibank transfer", "us bank transfer", "pnc bank transfer",
    "capital one transfer", "ally bank transfer", "discover bank transfer",
    "online banking payment", "bill payment transfer", "stripe payout", "square payout",
    "cash app transfer", "apple cash transfer", "google pay transfer",
    "brim financial payment", "neo financial transfer", "koho transfer",
    "wealthsimple cash transfer", "revolut transfer", "monzo transfer", "n26 transfer",
    "chime transfer", "varo bank transfer", "current bank transfer", "sofi money transfer",
    "robinhood transfer", "questrade transfer", "wealthsimple transfer",
  ]),
  ...seedRules("TRANSFER: Credit Card Payment", [
    "credit card payment thank you", "visa payment received", "mastercard payment received",
    "amex payment received", "american express payment", "credit card autopay",
    "online credit card payment", "scotiabank credit card payment", "td credit card payment",
    "rbc credit card payment",
  ]),
];

// Precompiles DEFAULT_LOOKUP once at module load, rather than re-parsing/re-sorting it on every single
// categorize() call: sortLookup() applies the same longest-key-first precedence rule user rules already
// get (so e.g. "the keg steakhouse" is checked before a hypothetical shorter overlapping key), a
// regex-shaped key is compiled once via parseRegexRule (an entry that doesn't compile is dropped here,
// never carried forward as dead weight - same "invalid regex = never matches" rule categorize() already
// applies to user rules), and a plain key is pre-normalized with normalize() so the runtime check against
// an already-normalized merchant string is a plain, cheap substring test.
function compileDefaultLookup(entries) {
  const compiled = [];
  for (const [key, cat] of sortLookup(entries)) {
    if (isRegexRuleKey(key)) {
      const regex = parseRegexRule(key);
      if (regex) compiled.push({ regex, cat });
      continue;
    }
    compiled.push({ text: normalize(key), cat });
  }
  return compiled;
}
const DEFAULT_LOOKUP_COMPILED = compileDefaultLookup(DEFAULT_LOOKUP);

// lookup is an array of [key, category] pairs, longest-key-first (see sortLookup). A transaction
// matches the FIRST key it hits, so more specific plain keys (e.g. "amazon.ca prime") must be listed
// before broader ones (e.g. "amazon.ca") or the broad key wins by accident.
//
// A regex-shaped key (see REGEX_RULE_SHAPE above) is tested against BOTH the RAW merchant text and the
// normalized/lowercased text a plain substring key matches against (v6.9.1) - raw first (so a pattern
// written with an explicit /i still controls case sensitivity the way a hand-written regex normally
// would), normalized text second, as a fallback for a pattern that assumes already-normalized input
// (e.g. a `\s*` meant to bridge a hyphen `normalize()` would have turned into a space, or a plain
// lowercase pattern intended to match regardless of the merchant string's actual casing). Either side
// matching is enough. `parseRegexRule` already strips the "g"/"y" flags before compiling specifically so
// this dual test - two separate `.test()` calls against the same compiled RegExp - can never behave
// inconsistently between the raw attempt and the normalized-text attempt. An invalid regex-shaped key
// just never matches (parseRegexRule already caught the construction error) and categorization moves on
// to the next rule, rather than falling back to a literal substring search for something like
// "/uber(/i" that could never usefully match anyway.
//
// Tier 2 fallback (v6.9): if no rule in the person's own lookupEntries matches, categorize() falls
// through to DEFAULT_LOOKUP_COMPILED - the built-in Master Seed Auto-Categorization Dataset above -
// using the identical regex-vs-plain matching rules just described (regex against raw-or-normalized,
// plain against normalized text). A user rule always wins outright: this loop only ever runs after the
// lookupEntries loop has already exhausted every entry with no match, so nothing here can ever override
// or race a person's own rule, however that rule was authored (a specific override the dataset also
// happens to contain a broader entry for still resolves correctly, since Tier 1 exits first). Every
// category string used in DEFAULT_LOOKUP is one of the exact strings in DEFAULT_SPENDING_CATEGORIES/
// SYSTEM_CATEGORIES above (e.g. "Transport") - not a new, ad hoc label - so a Tier 2 match always lands
// on a category that already exists in Settings, the category filters, and every chart that groups by
// category.
function categorize(merchant, lookupEntries) {
  const raw = String(merchant || "");
  const text = normalize(merchant);
  for (const [key, cat] of lookupEntries) {
    if (isRegexRuleKey(key)) {
      const regex = parseRegexRule(key);
      if (regex && (regex.test(raw) || regex.test(text))) return { category: cat, norm: key, matched: true };
      continue;
    }
    if (text.includes(key)) return { category: cat, norm: key, matched: true };
  }
  for (const entry of DEFAULT_LOOKUP_COMPILED) {
    if (entry.regex) {
      if (entry.regex.test(raw) || entry.regex.test(text)) return { category: entry.cat, norm: raw, matched: true };
    } else if (text.includes(entry.text)) {
      return { category: entry.cat, norm: entry.text, matched: true };
    }
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

// --- Runway & Target Projections (v6.4) -----------------------------------------------------------
// How many months of projected chart points to draw forward from "now" - the task calls for a
// 12-24 month horizon, so 24 is picked to show the longer end without needing a user-facing control.
const RUNWAY_PROJECTION_MONTHS = 24;

// Projects a constant monthly surplus rate forward from "now" to find the calendar month a target
// gap closes. A gap already <= 0 resolves immediately ("reached") with zero months needed. A
// non-positive rate can never close a positive gap no matter how many months pass - rather than
// producing an infinite or nonsensical month count, that's reported as "deficit" and left for the
// caller to render as a clean status message instead of a date. `fromDate` is passed in (rather than
// read internally) so every scenario in one render projects from the exact same "now" and a test can
// pass a fixed date instead of depending on the real clock.
function estimateMilestone(gap, monthlyRate, fromDate) {
  if (gap <= 0) return { status: "reached", monthsNeeded: 0 };
  if (!(monthlyRate > 0)) return { status: "deficit" };
  const monthsNeeded = Math.ceil(gap / monthlyRate);
  const date = new Date(fromDate.getFullYear(), fromDate.getMonth() + monthsNeeded, 1);
  return { status: "projected", monthsNeeded, date };
}
function formatMonthYear(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
// Renders an estimateMilestone() result as the short status text/color the runway table shows -
// kept as plain functions (not JSX) so the same mapping is trivially unit-testable.
function formatMilestone(m) {
  if (m.status === "reached") return "Already there";
  if (m.status === "deficit") return "Deficit / No projection available";
  return formatMonthYear(m.date);
}
function milestoneColor(m) {
  if (m.status === "reached") return "var(--text-success)";
  if (m.status === "deficit") return "var(--text-danger)";
  return "var(--text-secondary)";
}

// The Dashboard's customizable sections - fixed vocabulary of ids the app knows how to render, each
// with a stable id (persisted) and a display label (shown in the "Customize layout" panel and used
// to build the default order below). Adding a new dashboard section in a future version means adding
// one entry here; normalizeDashboardLayout (below) then folds it into any already-saved layout.
const DASHBOARD_SECTIONS = [
  { id: "summaryCards", label: "KPI summary grid (earned, lifestyle spend, invested, net cash, investment rate)" },
  { id: "trendLine", label: "Monthly cash flow trend (income vs. spending)" },
  { id: "investments", label: "Investments & wealth accumulation" },
  { id: "categoryBar", label: "Category spending breakdown & ranking" },
  { id: "fixedVsDiscretionary", label: "Fixed vs. discretionary cost breakdown" },
  { id: "cumulativeNet", label: "Cumulative net position area chart" },
  { id: "spendSharePie", label: "Spend share pie chart" },
  { id: "incomeBar", label: "Income by source bar chart" },
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

// categoryBehaviors (Customizable Category Behaviors, Settings > Spending Categories) is a plain
// { [categoryName]: "income" | "expense" | "investment" | "neutral" } map, sparse by design - only
// categories a person has actually touched the Behavior dropdown for get an entry (see classifyTxnKind's
// defaultCategoryBehavior fallback above for everything else). A key with an unrecognized value is
// enough to reject the whole map, same "validate before applying anything" rule every other saved-
// data shape in this file follows.
function isValidCategoryBehaviors(obj) {
  return !!obj && typeof obj === "object" && !Array.isArray(obj)
    && Object.values(obj).every(v => VALID_BEHAVIORS.has(v));
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

// --- Cloud Sync (Phase 4 Item 4, v6.5; dual-provider v6.6) -----------------------------------------
// Optional, off-by-default sync to a cloud storage app-folder the person connects themselves - Google
// Drive AppData (v6.5) or Dropbox (v6.6), picked via a provider toggle in Settings > Cloud Sync. This
// is the one deliberate departure from the "zero network calls" rule CONTEXT.md §1 otherwise holds
// the app to - see the CONTEXT.md v6.5/v6.6 entries for why it's still consistent with the no-backend
// rule: every call below goes straight from this browser to Google's or Dropbox's own APIs, never
// through anything this project runs or controls, and the payload either provider ever stores is
// opaque ciphertext this browser encrypted with a passphrase neither provider ever sees. There is no
// server-side component and never will be for this feature - if access to either provider is ever
// revoked, or the person never opts in, the rest of the app is unaffected, since nothing here is read
// by any other feature. The two providers share one encryption engine (encryptVaultPayload/
// decryptVaultPayload below) and one plaintext payload shape - only the transport (auth flow + REST
// calls to move the encrypted envelope) differs per provider.
const CLOUD_CLIENT_ID_KEY = "ledger:cloudsync:clientid:v1";
const CLOUD_LAST_SYNCED_KEY = "ledger:cloudsync:lastsynced:v1";
const CLOUD_PROVIDER_KEY = "ledger:cloudsync:provider:v1";
const GIS_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_VAULT_FILENAME = "ledger-vault.enc";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const PBKDF2_ITERATIONS = 100000;

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// PBKDF2-SHA256 (100,000 iterations) turns the person's passphrase into an AES-GCM 256-bit key. The
// passphrase itself is never stored (see cloudPassphrase in Ledger()) and never sent anywhere - only
// this derived key is used, and only in memory, for exactly one encrypt or decrypt call.
async function deriveAesKey(passphrase, saltBuf, iterations) {
  const enc = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypts a plain JS value into a self-describing envelope, encoded as one JSON string - a fresh
// random salt and IV every call, so re-syncing under the same passphrase never reuses key material.
// Everything needed to decrypt (salt, iv, iteration count) travels alongside the ciphertext, since
// this envelope is the only thing Drive ever sees - zero-knowledge means Google (or anyone with just
// the file) never sees the passphrase or the plaintext ledger data, only this opaque blob.
async function encryptVaultPayload(passphrase, value) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    v: 1, kdf: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS,
    salt: bufToBase64(salt), iv: bufToBase64(iv), ciphertext: bufToBase64(ciphertext),
  });
}

// Reverses encryptVaultPayload. Throws - AES-GCM's own authentication failure (wrong passphrase or a
// tampered/corrupted file), or a JSON parse error on something that isn't this envelope shape at all -
// on anything that isn't "this exact passphrase's own ciphertext, unmodified." Callers MUST catch this
// and alert safely rather than let it reach a state setter, so a wrong passphrase can never partially
// apply garbage data - the same "never corrupt local data" rule importData already follows for a bad
// JSON backup file.
async function decryptVaultPayload(passphrase, envelopeText) {
  const envelope = JSON.parse(envelopeText);
  if (!envelope || typeof envelope !== "object" || envelope.v !== 1
    || typeof envelope.salt !== "string" || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("That file isn't a recognizable ledger vault.");
  }
  const salt = base64ToBuf(envelope.salt);
  const iv = base64ToBuf(envelope.iv);
  const iterations = Number.isFinite(envelope.iterations) ? envelope.iterations : PBKDF2_ITERATIONS;
  const key = await deriveAesKey(passphrase, salt, iterations);
  const plaintextBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBuf(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintextBuf));
}

// Loads the Google Identity Services script on demand (never eagerly at module load, so a person who
// never opens Cloud Sync never fetches anything from Google) and caches the in-flight promise at
// module scope so multiple near-simultaneous callers (e.g. Connect clicked twice) share one script tag
// instead of racing to inject duplicates.
let _gisLoadPromise = null;
function loadGisScript() {
  if (typeof window !== "undefined" && window.google?.accounts?.oauth2) return Promise.resolve();
  if (_gisLoadPromise) return _gisLoadPromise;
  _gisLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Couldn't load Google's sign-in script - check your connection and try again.")));
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => { _gisLoadPromise = null; reject(new Error("Couldn't load Google's sign-in script - check your connection and try again.")); };
    document.head.appendChild(script);
  });
  return _gisLoadPromise;
}

// Drive REST v3, scoped strictly to the hidden appDataFolder (never a person's visible Drive) by both
// the OAuth scope requested (drive.appdata, see GIS_SCOPE) and every call below explicitly passing
// spaces:"appDataFolder" / parents:["appDataFolder"] - this app can never see, list, or touch any file
// outside the one it created for itself, and nothing it stores there is visible in the person's normal
// Drive UI.
async function driveFindVaultFileId(accessToken) {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${DRIVE_VAULT_FILENAME}' and trashed=false`,
    fields: "files(id,modifiedTime)",
    pageSize: "1",
  });
  const res = await fetch(`${DRIVE_FILES_URL}?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Couldn't reach Google Drive (${res.status}).`);
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

// Overwrites in place (PATCH .../fileId?uploadType=media) if a vault file already exists, else creates
// one via a multipart upload that sets both the file's metadata (name + appDataFolder parent) and its
// content in one request. Either way the content is envelopeText - already-encrypted ciphertext; Drive
// itself only ever receives opaque bytes, never plaintext ledger data.
async function driveUploadVault(accessToken, fileId, envelopeText) {
  if (fileId) {
    const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: envelopeText,
    });
    if (!res.ok) throw new Error(`Upload to Google Drive failed (${res.status}).`);
    return res.json();
  }
  const boundary = "ledgervaultboundary";
  const metadata = { name: DRIVE_VAULT_FILENAME, parents: ["appDataFolder"] };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${envelopeText}\r\n--${boundary}--`;
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Upload to Google Drive failed (${res.status}).`);
  return res.json();
}

async function driveDownloadVault(accessToken, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Download from Google Drive failed (${res.status}).`);
  return res.text();
}

// --- Dropbox provider (v6.6) ------------------------------------------------------------------------
// Dropbox OAuth 2.0 with PKCE - the standard flow for a public client with no backend to hold a
// secret. Unlike Google Identity Services (which can silently re-mint an access token in-page once a
// scope is granted), Dropbox's PKCE flow is a genuine full-page redirect: this app navigates away to
// dropbox.com and Dropbox navigates back with a one-time code in the URL (see the redirect-handling
// effect in Ledger()). That means there's no in-page "connect" moment to hold a token in memory across
// - so, unlike the Google access token, the Dropbox *refresh* token is persisted to localStorage
// (DROPBOX_REFRESH_TOKEN_KEY) so re-syncing later doesn't force a full-page redirect every time. This
// is a deliberate, documented trade-off (see CONTEXT.md's Cloud Sync subsection), not an oversight -
// the token is scoped by the Dropbox app's own console configuration to just that app's folder, never
// the person's whole Dropbox, and Disconnect both clears it locally and revokes it with Dropbox.
const DROPBOX_APP_KEY_KEY = "ledger:cloudsync:dropbox:appkey:v1";
const DROPBOX_REFRESH_TOKEN_KEY = "ledger:cloudsync:dropbox:refreshtoken:v1";
const DROPBOX_LAST_SYNCED_KEY = "ledger:cloudsync:dropbox:lastsynced:v1";
// sessionStorage, not localStorage - these only need to survive the single round-trip redirect to
// Dropbox and back in this same tab, and are deleted the moment that round-trip completes either way.
const DROPBOX_VERIFIER_SESSION_KEY = "ledger:cloudsync:dropbox:verifier";
const DROPBOX_STATE_SESSION_KEY = "ledger:cloudsync:dropbox:state";
const DROPBOX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_VAULT_PATH = "/ledger-vault.enc";

function base64UrlEncode(buf) {
  return bufToBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// RFC 7636 code_verifier: a random, URL-safe string 43-128 characters long. 64 random bytes
// base64url-encodes to 86 characters, comfortably inside that range.
function generatePkceVerifier() {
  return base64UrlEncode(window.crypto.getRandomValues(new Uint8Array(64)).buffer);
}
async function sha256Base64Url(str) {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return base64UrlEncode(digest);
}

// Kicks off the PKCE flow: stashes a fresh verifier + anti-CSRF state in sessionStorage (read back by
// the redirect-handling effect once Dropbox sends the person back), then navigates the whole page to
// Dropbox's consent screen. This function never "returns" in the normal sense - the resolved promise
// just means the redirect was issued, not that sign-in succeeded.
//
// Deliberately omits &scope= - the app's permissions come entirely from what's registered against
// this App Key in the Dropbox App Console (Permissions tab), not from a scope list requested here.
// Passing a scope param here would ask for exactly those scopes and fail if the console app wasn't
// registered with a superset of them; omitting it lets Dropbox grant whatever the console app is
// already configured for (expected to be files.content.write/files.content.read, scoped to the app's
// own app folder - see the module comment above), with no risk of this code's scope list drifting out
// of sync with the console's.
async function startDropboxAuth(appKey) {
  const verifier = generatePkceVerifier();
  const state = base64UrlEncode(window.crypto.getRandomValues(new Uint8Array(16)).buffer);
  const challenge = await sha256Base64Url(verifier);
  window.sessionStorage.setItem(DROPBOX_VERIFIER_SESSION_KEY, verifier);
  window.sessionStorage.setItem(DROPBOX_STATE_SESSION_KEY, state);
  const redirectUri = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    client_id: appKey, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    token_access_type: "offline", redirect_uri: redirectUri, state,
  });
  window.location.assign(`${DROPBOX_AUTH_URL}?${params}`);
}

// Trades the one-time authorization code (from the redirect back) for an access token + refresh token.
// Must be called with the exact same redirectUri that was sent to startDropboxAuth, and the verifier
// that produced the challenge sent there - Dropbox rejects the exchange otherwise.
async function exchangeDropboxCode(appKey, code, verifier, redirectUri) {
  const body = new URLSearchParams({ code, grant_type: "authorization_code", client_id: appKey, redirect_uri: redirectUri, code_verifier: verifier });
  const res = await fetch(DROPBOX_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Dropbox sign-in failed (${res.status}). Try connecting again.`);
  return res.json();
}
// Silently mints a new short-lived access token from the persisted refresh token - no redirect, no
// popup. Dropbox doesn't reliably return a new refresh token on this call, so the caller keeps using
// the one it already has.
async function refreshDropboxAccessToken(appKey, refreshToken) {
  const body = new URLSearchParams({ refresh_token: refreshToken, grant_type: "refresh_token", client_id: appKey });
  const res = await fetch(DROPBOX_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Couldn't refresh Dropbox access (${res.status}) - try disconnecting and reconnecting.`);
  return res.json();
}
async function dropboxRevokeToken(accessToken) {
  await fetch(DROPBOX_REVOKE_URL, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
}

// The Dropbox-API-Arg header carries the call's JSON arguments (path, write mode) alongside the raw
// ciphertext body - this app's Dropbox console entry is configured with "App folder" access, so this
// path is relative to that dedicated app folder and this app can never see or touch anything else in
// the person's Dropbox (see the module comment above). "mode: overwrite" makes Sync Now idempotent -
// no separate find-then-update step like Drive needs, since Dropbox paths are stable names, not ids.
async function dropboxUploadVault(accessToken, envelopeText) {
  const res = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: DROPBOX_VAULT_PATH, mode: "overwrite", mute: true }),
    },
    body: envelopeText,
  });
  if (!res.ok) throw new Error(`Upload to Dropbox failed (${res.status}).`);
  return res.json();
}
// Returns the envelope text, or null if no vault has been uploaded yet (Dropbox reports a missing path
// as 409, not 404) - callers treat that exactly like Drive's "no file found yet" case.
async function dropboxDownloadVault(accessToken) {
  const res = await fetch(DROPBOX_DOWNLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Dropbox-API-Arg": JSON.stringify({ path: DROPBOX_VAULT_PATH }) },
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`Download from Dropbox failed (${res.status}).`);
  return res.text();
}

// --- App Lock (Phase 5 Item 2, v6.8) ----------------------------------------------------------------
// Optional, off-by-default local lock screen: a 4-6 digit backup PIN plus an optional WebAuthn platform
// authenticator (Face/Fingerprint/Windows Hello). Like Cloud Sync's config, none of this lives in
// STORAGE_KEY or JSON export/import - it's per-browser device security config, not financial data (same
// reasoning as THEME_KEY and the Cloud Sync keys above), so a restored JSON backup never carries someone
// else's lock settings onto a new device, and this app's own no-backend rule is untouched: everything
// below runs against window.crypto.subtle and the browser's own WebAuthn implementation, never a server
// this project runs.
//
// Deliberately NOT a server-verified WebAuthn credential - a real relying party normally verifies the
// signed assertion against the public key it stored at registration, which needs a COSE-key signature
// verifier this app has no other reason to carry. What still makes the biometric option meaningful
// without one: navigator.credentials.get() is a browser/OS-mediated API this page's own JS cannot forge
// or script around - the platform authenticator refuses to produce ANY assertion unless the real
// biometric or device-PIN check the OS itself owns succeeds. A successful resolve is still genuine local
// proof-of-presence; this app just can't additionally confirm it was signed by the exact key it
// registered. The PIN is the one fully self-contained check (PBKDF2-hashed, verified entirely in this
// browser), which is why App Lock requires a PIN before it can be turned on at all - see
// handleToggleLockEnabled in Ledger() - rather than ever leaving someone with only a biometric option
// that could stop being offered (a browser update, a different device) with no fallback.
const LOCK_ENABLED_KEY = "ledger:applock:enabled:v1";
const LOCK_PIN_RECORD_KEY = "ledger:applock:pin:v1";
const LOCK_WEBAUTHN_KEY = "ledger:applock:webauthn:v1";
// Per-browser UI preference, same non-financial-data reasoning as THEME_KEY - which ingestion mode
// (Manual Form vs Bulk Paste) the Log tab shows once the person has picked one explicitly.
const INGESTION_MODE_KEY = "ledger:ingestionmode:v1";
// Remembers the Manual Transaction Form's last-used Account across sessions - most manual entries in
// a row tend to be for the same account, so this saves re-typing it every time (see
// ManualTransactionForm's `account` state).
const LAST_ACCOUNT_KEY = "ledger:lastaccount:v1";

// Mirrors base64UrlEncode above, in reverse - restores the standard base64 alphabet and re-pads with
// "=" (base64url per RFC 4648 §5 omits padding) before handing off to the existing base64ToBuf. Needed
// to turn a stored WebAuthn credential.id (already base64url, per the Credential Management spec) back
// into the raw bytes navigator.credentials.get's allowCredentials list expects.
function base64UrlToBuf(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64ToBuf(b64);
}

// PBKDF2-SHA256, reusing the exact same iteration count Cloud Sync's passphrase derivation uses
// (PBKDF2_ITERATIONS) - this is a hash to verify against, not a key to encrypt with, so deriveBits
// rather than deriveKey, but otherwise the identical primitive.
async function derivePinHash(pin, saltBytes, iterations) {
  const enc = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await window.crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, baseKey, 256);
  return bufToBase64(bits);
}
// `length` is stored alongside the hash purely so the lock screen's keypad knows how many digits to
// expect before attempting a verify - it's metadata about the PIN, not part of the secret, the same way
// a login form showing "PIN is 6 digits" wouldn't weaken it.
async function createPinRecord(pin) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PBKDF2_ITERATIONS);
  return { salt: bufToBase64(salt), hash, iterations: PBKDF2_ITERATIONS, length: pin.length };
}
async function verifyPinRecord(pin, record) {
  if (!record) return false;
  const salt = base64ToBuf(record.salt);
  const iterations = Number.isFinite(record.iterations) ? record.iterations : PBKDF2_ITERATIONS;
  const hash = await derivePinHash(pin, salt, iterations);
  return hash === record.hash;
}

function isWebAuthnAvailable() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}
// Feature-detects an actual usable platform authenticator (not just WebAuthn support in general) before
// the Settings panel offers "Enable biometrics" - avoids offering a control that would just fail on a
// device with no Face/Fingerprint/Windows Hello sensor available to this browser.
async function platformAuthenticatorAvailable() {
  if (!isWebAuthnAvailable() || !window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
// Registers a brand new platform-authenticator credential (triggers the OS's native Face/Fingerprint/
// Windows Hello prompt). attestation:"none" - this app has no server to send an attestation statement
// to, so there's nothing to gain from asking the authenticator to produce one. Only credential.id (a
// base64url string, never a secret - see the module comment above) is kept; the private key itself
// never leaves the authenticator hardware, which is the whole point of WebAuthn.
async function registerBiometricCredential() {
  const challenge = window.crypto.getRandomValues(new Uint8Array(32));
  const userId = window.crypto.getRandomValues(new Uint8Array(16));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Ledger" },
      user: { id: userId, name: "ledger-local-user", displayName: "Ledger" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: 60000,
    },
  });
  if (!credential) throw new Error("Biometric setup didn't complete.");
  return { id: credential.id };
}
// Asks the platform authenticator to confirm the person's presence again on unlock. Resolves (truthy)
// only if the OS's own biometric/device-PIN check succeeded; throws (NotAllowedError, a timeout, the
// person cancelling) otherwise - callers treat any rejection as "fall back to the PIN keypad," never as
// an error worth surfacing, since cancelling a biometric prompt to type a PIN instead is routine, not a
// failure.
async function verifyBiometricCredential(credentialId) {
  const challenge = window.crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: credentialId ? [{ id: base64UrlToBuf(credentialId), type: "public-key" }] : [],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return !!assertion;
}

const card = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "14px", padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" };
const label = { fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: "4px" };
const num = { fontVariantNumeric: "tabular-nums" };
const statBig = { fontSize: "26px", fontWeight: 600, letterSpacing: "-0.01em", ...num };
const statSmall = { fontSize: "18px", fontWeight: 600, letterSpacing: "-0.005em", ...num };
const btn = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "var(--radius)", border: "1px solid var(--border-strong)", background: "var(--surface-1)", color: "var(--text-primary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" };
const btnPrimary = { ...btn, background: "var(--text-accent)", color: "#fff", border: "1px solid var(--text-accent)" };
const btnDanger = { ...btn, background: "var(--text-danger)", color: "#fff", border: "1px solid var(--text-danger)" };
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
  --border: #e6e3dc; --border-strong: #d3cfc4; --border-warning: #e3b756; --border-danger: #e2a08f;
  --text-primary: #23211d; --text-secondary: #6f6b61; --text-muted: #969184;
  --text-accent: #b8502d; --text-success: #17805f; --text-warning: #96691a; --text-danger: #b8402b;
  --bg-accent: #f7e7de; --bg-success: #e1f2ea; --bg-warning: #faf0d8; --bg-danger: #fae4de;
  --radius: 10px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.ledger-root[data-theme="dark"] {
  --surface-0: #161513; --surface-1: #1e1c19; --surface-2: #27241f;
  --border: #38352e; --border-strong: #4a453b; --border-warning: #6b5423; --border-danger: #7a4232;
  --text-primary: #f2efe9; --text-secondary: #ada89d; --text-muted: #79756a;
  --text-accent: #e58156; --text-success: #4fc498; --text-warning: #dcae52; --text-danger: #e37360;
  --bg-accent: #3a2a20; --bg-success: #1b3129; --bg-warning: #392c14; --bg-danger: #3a221c;
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
@keyframes ledger-spin { to { transform: rotate(360deg); } }
.ledger-root .ledger-spin { animation: ledger-spin 0.9s linear infinite; }

/* Mobile touch & viewport polishing (v6.7; extended v6.8 for the manual entry form and lock keypad) -
   scoped to touch/narrow contexts only, so the dense desktop mouse UI (small icon buttons, tight table
   rows) is untouched. Applies a 44px minimum hit target (the WCAG/Apple/Material baseline for a
   reliably tappable control) to every button, text input/select, and table row, and keeps wide content
   (tables, the split editor) scrollable within its own container instead of clipping or forcing the
   page itself to scroll horizontally. */
@media (max-width: 780px), (pointer: coarse) {
  .ledger-root button { min-height: 44px; }
  .ledger-root .ledger-tabs button { min-height: 44px; padding: 12px 16px; }
  .ledger-root table td, .ledger-root table th { padding: 10px 8px; }
  .ledger-root table td button, .ledger-root table th button { min-width: 44px; }
  .ledger-root input[type="checkbox"] { width: 20px; height: 20px; }
  .ledger-root input:not([type="checkbox"]), .ledger-root select { min-height: 44px; }
}
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

// Full-screen confirmation for "Delete all transactions" (Log tab header). Everything else
// destructive in this app (row delete, category removal, merchant-rule deletion) uses a plain
// window.confirm() - see CONTEXT.md - but wiping every transaction in one click is enough more
// consequential that it gets its own visibly red modal instead, matching what was asked for here.
function DeleteAllConfirmModal({ count, onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ ...card, borderColor: "var(--border-danger)", maxWidth: "420px", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
          <AlertCircle size={18} color="var(--text-danger)" />
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-danger)" }}>Delete all transactions?</div>
        </div>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "0 0 18px" }}>
          Are you sure you want to delete all transactions? This cannot be undone unless you have a backup.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button style={btn} onClick={onCancel}>Cancel</button>
          <button style={btnDanger} onClick={onConfirm}><Trash2 size={14} /> Delete all {count}</button>
        </div>
      </div>
    </div>
  );
}

// Retroactive "Scan Duplicates" (Transaction Log action bar) - review UI for findDuplicateClusters'
// output. Each cluster renders as its own side-by-side comparison card; every row in a cluster
// defaults to a Keep/Delete state (the earliest-added transaction - clusters are pre-sorted lowest-id-
// first by findDuplicateClusters - keeps by default, everything else after it in the cluster is
// pre-selected for deletion) that a person can flip per row before committing. `selected` tracks ids
// marked for DELETION, not ids kept, so the common case (accept the defaults) needs zero clicks.
function DuplicateCleanerModal({ clusters, onConfirm, onCancel }) {
  const [selected, setSelected] = useState(() => {
    const s = new Set();
    clusters.forEach(group => group.slice(1).forEach(t => s.add(t.id)));
    return s;
  });
  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const totalFlagged = clusters.reduce((sum, group) => sum + group.length, 0);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ ...card, maxWidth: "720px", width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
          <ScanSearch size={18} color="var(--text-accent)" />
          <div style={{ fontSize: "15px", fontWeight: 600 }}>Duplicate Cleaner</div>
        </div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Found {clusters.length} cluster{clusters.length !== 1 ? "s" : ""} ({totalFlagged} transactions) with a matching amount, a date within a day of each other, and matching or overlapping merchant text. The earliest entry in each cluster is kept by default - toggle any row to change what gets deleted.
        </p>
        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "12px", marginBottom: "14px" }}>
          {clusters.map((group, i) => (
            <div key={group[0].id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "6px" }}>Cluster {i + 1} - {group.length} transactions</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {group.map(t => {
                  const markedForDelete = selected.has(t.id);
                  return (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12.5px", padding: "6px 8px", borderRadius: "6px", background: markedForDelete ? "var(--bg-danger)" : "var(--bg-success)" }}>
                      <span style={{ width: "80px", flexShrink: 0, color: "var(--text-muted)" }}>{t.date}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.merchant || t.description || "(no merchant)"}</span>
                      <span style={{ width: "70px", textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t.amount < 0 ? "-" : "+"}${Math.abs(t.amount).toFixed(2)}</span>
                      <AccountBadge account={t.account} />
                      <button
                        style={{ ...btn, padding: "4px 10px", width: "64px", flexShrink: 0, justifyContent: "center", color: markedForDelete ? "var(--text-danger)" : "var(--text-success)", borderColor: markedForDelete ? "var(--border-danger)" : "var(--text-success)" }}
                        onClick={() => toggle(t.id)}
                      >
                        {markedForDelete ? "Delete" : "Keep"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{selected.size} of {totalFlagged} selected for deletion</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button style={btn} onClick={onCancel}>Cancel</button>
            <button style={{ ...btnDanger, opacity: selected.size ? 1 : 0.5 }} disabled={selected.size === 0} onClick={() => onConfirm([...selected])}>
              <Trash2 size={14} /> Delete {selected.size} selected duplicate{selected.size !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryBadge({ category }) {
  let bg = "var(--bg-accent)", fg = "var(--text-accent)";
  if (INCOME_CATS.has(category)) { bg = "var(--bg-success)"; fg = "var(--text-success)"; }
  else if (category && category.startsWith("TRANSFER")) { bg = "var(--surface-0)"; fg = "var(--text-muted)"; }
  else if (category === "REVIEW: Ambiguous" || !category) { bg = "var(--bg-warning)"; fg = "var(--text-warning)"; }
  return <span style={{ background: bg, color: fg, fontSize: "11px", padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap" }}>{category || "unmatched"}</span>;
}

// A transaction with no account is a normal, valid state (see isValidTransaction) - most existing
// data predates multi-account tracking entirely - so this renders a plain dash rather than an
// "unmatched"-style warning badge the way CategoryBadge does for a missing category.
function AccountBadge({ account }) {
  if (!account) return <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>—</span>;
  return <span style={{ background: "var(--surface-2)", color: "var(--text-secondary)", fontSize: "11px", padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap", border: "1px solid var(--border)" }}>{account}</span>;
}

// KPI grid's "vs. previous period" trend indicator. Which direction counts as "good" is passed in
// rather than assumed from the sign of pct, since a rising trend is good for earnings but bad for
// spend - goodDirection === "up" flips that reading between the two.
function TrendBadge({ pct, goodDirection }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const isUp = pct >= 0;
  const isGood = goodDirection === "up" ? isUp : !isUp;
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", color: isGood ? "var(--text-success)" : "var(--text-danger)", marginTop: "4px" }}>
      <Icon size={11} /> {Math.abs(pct).toFixed(1)}% vs previous period
    </div>
  );
}

// Custom Recharts tooltip for the Monthly Cash Flow Trends chart - shows the exact Income, Outflow,
// Net, and Savings Rate for the hovered month, rather than relying on the default tooltip's per-series
// rows (which wouldn't have room for a derived value like Savings Rate).
function CashFlowTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "8px", padding: "8px 10px", fontSize: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>
      <div style={{ fontWeight: 600, marginBottom: "4px" }}>{label}</div>
      <div style={{ color: "var(--text-success)" }}>Income: ${d.income.toLocaleString()}</div>
      <div>Outflow: ${d.expense.toLocaleString()}</div>
      <div>Net: ${d.net.toLocaleString()}</div>
      <div style={{ color: "var(--text-secondary)" }}>Savings rate: {d.savingsRate === null ? "n/a" : `${d.savingsRate}%`}</div>
    </div>
  );
}

// Shown when a CSV's headers don't obviously map to Date/Description/Merchant/Amount - lets the
// person point at the actual columns instead of the upload silently failing or guessing wrong. The
// "split Debit/Credit" toggle covers files that spread money-out/money-in across two columns
// instead of one signed Amount column - see combineDebitCredit for how those two get merged.
function CSVMappingPanel({ mapping, onConfirm, onCancel }) {
  const [picks, setPicks] = useState({ date: "", description: "", merchant: "", amount: "", debit: "", credit: "" });
  const [splitAmount, setSplitAmount] = useState(false);
  const ready = picks.date && (splitAmount ? (picks.debit || picks.credit) : picks.amount);
  return (
    <div style={{ ...card, borderColor: "var(--border-warning)" }}>
      <div style={{ fontSize: "13px", fontWeight: 500, marginBottom: "6px" }}>
        <AlertCircle size={15} color="var(--text-warning)" style={{ verticalAlign: "-2px", marginRight: "6px" }} />
        Couldn't auto-detect columns in "{mapping.filename}"
      </div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>Match each field to a column from this file. Date and Amount are required.</p>
      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "12px", cursor: "pointer" }}>
        <input type="checkbox" checked={splitAmount} onChange={e => setSplitAmount(e.target.checked)} />
        This file has separate Debit/Credit (or Withdrawals/Deposits) columns instead of one Amount column
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", marginBottom: "12px" }}>
        {["date", "description", "merchant"].map(field => (
          <div key={field}>
            <div style={label}>{field[0].toUpperCase() + field.slice(1)}{field === "date" ? " *" : ""}</div>
            <select value={picks[field]} onChange={e => setPicks(p => ({ ...p, [field]: e.target.value }))} style={input}>
              <option value="">-- choose column --</option>
              {mapping.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
        {(splitAmount ? ["debit", "credit"] : ["amount"]).map(field => (
          <div key={field}>
            <div style={label}>{field[0].toUpperCase() + field.slice(1)}{!splitAmount ? " *" : ""}</div>
            <select value={picks[field]} onChange={e => setPicks(p => ({ ...p, [field]: e.target.value }))} style={input}>
              <option value="">-- choose column --</option>
              {mapping.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button style={btn} onClick={onCancel}>Cancel</button>
        <button style={{ ...btnPrimary, opacity: ready ? 1 : 0.5 }} disabled={!ready} onClick={() => onConfirm({ ...picks, splitAmount })}>Use this mapping</button>
      </div>
    </div>
  );
}

// Shown when one or more CSV/paste rows failed automatic parsing (an unreadable date, a currency-
// symbol'd amount, a blank merchant) instead of silently discarding them - each gets its own
// editable Date/Merchant/Category/Amount row so a quick fix can be recovered into staging without
// retyping the whole line by hand. Edits are kept in local `drafts` state keyed by skipId rather than
// writing back into the row itself, so the raw original values (shown as placeholders/defaults) stay
// visible as a reference while editing.
function SkippedRowsDrawer({ rows, categories, onRecover, onDismissRow, onDismissAll }) {
  const [drafts, setDrafts] = useState({});
  const draftOf = r => drafts[r.skipId] || { date: r.raw.date, merchant: r.raw.merchant, amount: r.raw.amount, category: "" };
  // Reads/writes off `prev` (the updater's own snapshot) rather than the `drafts` closure above, so
  // this can't lose an edit to a stale read if two field changes land in the same batched update.
  const setField = (skipId, field, value) => setDrafts(prev => {
    const raw = rows.find(x => x.skipId === skipId)?.raw || {};
    const current = prev[skipId] || { date: raw.date, merchant: raw.merchant, amount: raw.amount, category: "" };
    return { ...prev, [skipId]: { ...current, [field]: value } };
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>Fix each row below and click "Add to import" to recover it into the staging list above - or discard rows you don't need.</p>
        <button style={{ ...btn, padding: "4px 10px" }} onClick={onDismissAll}>Discard all</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Why it was skipped</th><th style={th}>Date</th><th style={th}>Merchant</th><th style={th}>Amount</th><th style={th}>Category</th><th style={th}></th></tr></thead>
          <tbody>
            {rows.map(r => {
              const draft = draftOf(r);
              const parsedDate = parseFlexibleDate(draft.date);
              const parsedAmount = parseFlexibleAmount(draft.amount);
              const merchant = draft.merchant.trim();
              const canRecover = parsedDate && Number.isFinite(parsedAmount) && merchant && draft.category;
              return (
                <tr key={r.skipId}>
                  <td style={{ ...td, fontSize: "11px", color: "var(--text-warning)", maxWidth: "180px" }}>{r.reason}</td>
                  <td style={td}><input value={draft.date} onChange={e => setField(r.skipId, "date", e.target.value)} style={{ ...input, width: "120px", borderColor: draft.date && !parsedDate ? "var(--border-warning)" : "var(--border)" }} /></td>
                  <td style={td}><input value={draft.merchant} onChange={e => setField(r.skipId, "merchant", e.target.value)} style={{ ...input, width: "160px", borderColor: draft.merchant && !merchant ? "var(--border-warning)" : "var(--border)" }} /></td>
                  <td style={td}><input value={draft.amount} onChange={e => setField(r.skipId, "amount", e.target.value)} style={{ ...input, width: "100px", borderColor: draft.amount && !Number.isFinite(parsedAmount) ? "var(--border-warning)" : "var(--border)" }} /></td>
                  <td style={td}>
                    <select value={draft.category} onChange={e => setField(r.skipId, "category", e.target.value)} style={{ ...input, width: "170px", borderColor: !draft.category ? "var(--border-warning)" : "var(--border)" }}>
                      <option value="">Choose a category...</option>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button style={{ ...btnPrimary, padding: "4px 8px", opacity: canRecover ? 1 : 0.5, marginRight: "6px" }} disabled={!canRecover}
                      onClick={() => { onRecover(r.skipId, { date: parsedDate, merchant, amount: parsedAmount, category: draft.category }); setDrafts(prev => { const next = { ...prev }; delete next[r.skipId]; return next; }); }}>
                      Add to import
                    </button>
                    <button style={{ ...btn, padding: "4px 8px" }} onClick={() => onDismissRow(r.skipId)}>Discard</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
          <div key={p.key} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
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

// Today's date as "YYYY-MM-DD" in the local timezone (not toISOString, which is UTC and can land on
// the wrong calendar day depending on the person's timezone/time of day) - matches isValidDateString's
// expected shape exactly, so it's a valid default the moment the manual entry form mounts.
function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Manual single-transaction entry (Phase 5 Item 2, v6.8) - the mobile-optimized alternative to the
// bulk CSV/paste flow, toggled via the Ingestion Mode Selector above the "Add a new transaction" card
// in Ledger(). Every field commits through the same onStage/onAddDirect callbacks Ledger() defines
// (stageManualTransaction / addManualTransactionDirect), which share dedup + validation with the bulk
// staging pipeline rather than duplicating it - see those functions' own comments for why a single
// manual entry confirms a likely duplicate instead of silently skipping it the way a batch import does.
function ManualTransactionForm({ categories, lookup, addCategory, onStage, onAddDirect }) {
  const [date, setDate] = useState(() => todayDateString());
  const [description, setDescription] = useState("");
  // Sticky across entries (not reset by resetForm below) and seeded from LAST_ACCOUNT_KEY, since
  // manually entering several transactions in a row is usually for the same account - see the
  // persist call in handleStage/handleAddDirect for when this actually gets saved.
  const [account, setAccount] = useState(() => {
    try { return window.localStorage.getItem(LAST_ACCOUNT_KEY) || ""; } catch { return ""; }
  });
  // Tracks whether the person has picked a category themselves for the CURRENT description text - see
  // handleDescriptionChange below, which resets this back to false the moment description itself
  // changes (v6.9.2), so a manual pick never keeps pinning a category chosen for different words once
  // the description no longer matches what it was picked for; live suggestion resumes immediately.
  // Modeled as a derived value (useMemo) rather than synced into its own state via an effect, so
  // there's no setState-in-effect render cascade - category is just suggestedCategory until
  // categoryTouched flips.
  const [manualCategory, setManualCategory] = useState("");
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [txnType, setTxnType] = useState("expense"); // "expense" | "income" - drives the amount's sign
  const [amountText, setAmountText] = useState("");

  // Live categorization: the exact same regex/substring rules engine every keystroke that staging's
  // "suggested" column already uses (see categorize()/stageRows above).
  const suggestedCategory = useMemo(() => categorize(description, lookup).category || "", [description, lookup]);
  // v6.9.1: only a genuine manual pick (categoryTouched AND a real, non-blank manualCategory) locks the
  // field - selecting the select's own blank "No match/Choose one" option still sets categoryTouched
  // but leaves manualCategory empty, and that shouldn't freeze the field against further live
  // suggestions as the description keeps changing. This is still a derived value, not state synced via
  // an effect, so there's no render-cascade risk either way.
  const hasManualCategory = categoryTouched && manualCategory !== "";
  const category = hasManualCategory ? manualCategory : suggestedCategory;

  function resetForm() {
    setDate(todayDateString());
    setDescription("");
    setManualCategory("");
    setCategoryTouched(false);
    setAddingCategory(false);
    setNewCategoryName("");
    setTxnType("expense");
    setAmountText("");
  }

  // Lets the person undo a manual category pick and go back to live auto-detection without touching
  // the rest of the form (date/description/amount/type all stay exactly as entered) or reloading.
  function resetToSuggested() {
    setManualCategory("");
    setCategoryTouched(false);
  }

  // v6.9.2: any edit to the description re-engages live auto-suggestion. A manual pick was made
  // against a specific description text; once that text changes, the pick hasn't actually been
  // re-confirmed against the new words, so it's cleared rather than silently kept pinned to text that
  // no longer matches it. Handled in the onChange itself (not a useEffect keyed on `description`) so
  // there's no extra render-cascade risk and no new entry in the pre-existing set-state-in-effect lint
  // debt tracked in CONTEXT.md §5.
  function handleDescriptionChange(value) {
    setDescription(value);
    setCategoryTouched(false);
    setManualCategory("");
  }

  function buildRow() {
    const magnitude = parseFloat(amountText);
    const amount = Number.isFinite(magnitude) ? (txnType === "expense" ? -Math.abs(magnitude) : Math.abs(magnitude)) : NaN;
    const desc = description.trim();
    return { date, description: desc, merchant: desc, amount, category, account: account.trim() || null };
  }

  // Persists whatever account was actually used on a successful save, not on every keystroke - "last
  // used" means the one that made it into a real transaction.
  function rememberAccount() {
    try { window.localStorage.setItem(LAST_ACCOUNT_KEY, account.trim()); } catch { /* non-critical UI pref - safe to lose */ }
  }

  function handleCategorySelect(value) {
    if (value === "__new__") { setAddingCategory(true); return; }
    setManualCategory(value);
    setCategoryTouched(true);
  }
  function confirmNewCategory() {
    const trimmed = newCategoryName.trim();
    if (addCategory(trimmed)) {
      setManualCategory(trimmed);
      setCategoryTouched(true);
      setAddingCategory(false);
      setNewCategoryName("");
    }
  }

  function handleStage() {
    if (onStage(buildRow())) { rememberAccount(); resetForm(); }
  }
  function handleAddDirect() {
    if (onAddDirect(buildRow())) { rememberAccount(); resetForm(); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
        <div>
          <div style={label}>Date</div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={input} />
        </div>
        <div style={{ gridColumn: "span 2" }}>
          <div style={label}>Description</div>
          <input type="text" value={description} onChange={e => handleDescriptionChange(e.target.value)} placeholder="e.g. Uber Eats" style={input} />
        </div>
        <div>
          <div style={label}>Account (optional)</div>
          <input type="text" list="known-account-list" value={account} onChange={e => setAccount(e.target.value)} placeholder="e.g. Scotiabank Chequing" style={input} />
        </div>
      </div>

      <div>
        <div style={label}>Category</div>
        {!addingCategory ? (
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <select value={category} onChange={e => handleCategorySelect(e.target.value)}
              style={{ ...input, flex: 1, borderColor: !category ? "var(--border-warning)" : "var(--border)" }}>
              <option value="">{description ? "No match - choose one" : "Choose a category..."}</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__new__">+ Add new category...</option>
            </select>
            {hasManualCategory && (
              <button type="button" style={{ ...btn, padding: "8px" }} onClick={resetToSuggested}
                title="Reset to suggested category" aria-label="Reset to suggested category">
                <Undo2 size={14} />
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder="New category name" style={{ ...input, flex: 1, minWidth: "160px" }} autoFocus
              onKeyDown={e => { if (e.key === "Enter") confirmNewCategory(); }} />
            <button type="button" style={{ ...btn, padding: "8px 14px" }} onClick={confirmNewCategory}><Check size={14} /> Add</button>
            <button type="button" style={{ ...btn, padding: "8px 14px" }} onClick={() => { setAddingCategory(false); setNewCategoryName(""); }}>Cancel</button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <div style={label}>Type</div>
          <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            <button type="button" onClick={() => setTxnType("expense")}
              style={{ ...btn, border: "none", borderRadius: 0, background: txnType === "expense" ? "var(--text-danger)" : "var(--surface-1)", color: txnType === "expense" ? "#fff" : "var(--text-primary)" }}>
              Expense
            </button>
            <button type="button" onClick={() => setTxnType("income")}
              style={{ ...btn, border: "none", borderRadius: 0, background: txnType === "income" ? "var(--text-success)" : "var(--surface-1)", color: txnType === "income" ? "#fff" : "var(--text-primary)" }}>
              Income
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: "140px" }}>
          <div style={label}>Amount</div>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={amountText} onChange={e => setAmountText(e.target.value)} placeholder="0.00" style={input} />
        </div>
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button type="button" style={btn} onClick={handleStage}><Plus size={14} /> Stage transaction</button>
        <button type="button" style={btnPrimary} onClick={handleAddDirect}><Check size={14} /> Add directly</button>
      </div>
    </div>
  );
}

// Full-screen App Lock overlay (Phase 5 Item 2, v6.8) - rendered by Ledger() in place of the entire app
// while locked, so the ledger data is never in the DOM at all until authentication succeeds (not just
// visually covered). See the module-level "App Lock" comment above for why the biometric path is a
// meaningful local gate despite having no server to verify the signed assertion against.
function LockOverlay({ pinRecord, webauthnCredential, onUnlock }) {
  const [entered, setEntered] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  // A ref, not state - this only guards "attempt once per mount" and is never itself rendered, so
  // there's no need for a re-render (or a setState-in-effect) just to flip it.
  const biometricTriedRef = useRef(false);
  const verifyingRef = useRef(false);

  const pinLength = pinRecord && Number.isFinite(pinRecord.length) ? pinRecord.length : 6;

  async function tryBiometric() {
    if (!webauthnCredential || checking) return;
    setChecking(true);
    setError("");
    try {
      const ok = await verifyBiometricCredential(webauthnCredential.id);
      if (ok) { onUnlock(); return; }
    } catch {
      // Cancelled, timed out, or unavailable right now - fall back to the PIN keypad silently, matching
      // this app's general "safe fallback over a scary error" posture. Tapping away from a biometric
      // prompt to use the PIN instead is routine, not a failure worth alerting on.
    }
    setChecking(false);
  }

  // Prompts for biometrics automatically, once, as soon as the overlay mounts - the PIN keypad below
  // renders unconditionally at the same time, so there's always an immediate fallback visible rather
  // than one gated behind the biometric attempt failing first.
  useEffect(() => {
    if (webauthnCredential && !biometricTriedRef.current) {
      biometricTriedRef.current = true;
      tryBiometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webauthnCredential]);

  useEffect(() => {
    if (!pinRecord || entered.length !== pinLength || verifyingRef.current) return;
    verifyingRef.current = true;
    verifyPinRecord(entered, pinRecord).then(ok => {
      verifyingRef.current = false;
      if (ok) { onUnlock(); return; }
      setError("Incorrect PIN");
      setEntered("");
    });
  }, [entered, pinRecord, pinLength, onUnlock]);

  function tapDigit(d) {
    if (checking) return;
    setError("");
    setEntered(prev => (prev.length >= pinLength ? prev : prev + d));
  }
  function tapBackspace() {
    setError("");
    setEntered(prev => prev.slice(0, -1));
  }

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--surface-0)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "20px", padding: "24px", boxSizing: "border-box" }}>
      <Lock size={36} color="var(--text-accent)" />
      <div style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)" }}>Ledger is locked</div>

      {webauthnCredential && (
        <button type="button" style={{ ...btn, minHeight: "48px", padding: "10px 20px" }} disabled={checking} onClick={tryBiometric}>
          {checking ? <Loader2 size={16} className="ledger-spin" /> : <Fingerprint size={16} />}
          {checking ? "Checking..." : "Use Face / Fingerprint"}
        </button>
      )}

      {pinRecord ? (
        <>
          <div style={{ display: "flex", gap: "10px" }}>
            {Array.from({ length: pinLength }).map((_, i) => (
              <span key={i} style={{
                width: "14px", height: "14px", borderRadius: "50%",
                background: i < entered.length ? "var(--text-accent)" : "var(--surface-2)",
                border: "1px solid var(--border-strong)", display: "inline-block",
              }} />
            ))}
          </div>
          {error && <div style={{ fontSize: "13px", color: "var(--text-danger)" }}>{error}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 64px)", gap: "12px" }}>
            {keys.map((k, i) => k === "" ? <div key={i} /> : k === "back" ? (
              <button key={i} type="button" style={{ ...btn, width: "64px", height: "64px", minHeight: "64px", borderRadius: "50%", justifyContent: "center" }} onClick={tapBackspace} title="Backspace">
                <Delete size={18} />
              </button>
            ) : (
              <button key={i} type="button" style={{ ...btn, width: "64px", height: "64px", minHeight: "64px", borderRadius: "50%", fontSize: "20px", justifyContent: "center" }} onClick={() => tapDigit(k)}>
                {k}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p style={{ fontSize: "13px", color: "var(--text-muted)", maxWidth: "320px", textAlign: "center" }}>
          No PIN is set - this shouldn't normally happen, since App Lock requires one to be enabled.
          Reload once unlocked and set a PIN from Settings.
        </p>
      )}
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
  // Per-category income/expense/neutral override (Settings > Spending Categories > Behavior dropdown).
  // Sparse map - see isValidCategoryBehaviors/defaultCategoryBehavior above for how an absent entry
  // resolves. Persisted, exported/imported, and cloud-synced alongside spendingCategories.
  const [categoryBehaviors, setCategoryBehaviors] = useState(() => persisted.categoryBehaviors || {});
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
  // Ingestion Mode Selector (v6.8): which entry method the Log tab's "Add a new transaction" card
  // shows. A saved choice always wins; otherwise defaults to Manual Form on a narrow (<780px) viewport
  // at first load, matching the same 780px breakpoint the mobile touch CSS already uses, and to Bulk
  // Paste everywhere else - a one-time default, not something that re-switches on resize afterward.
  const [ingestionMode, setIngestionModeState] = useState(() => {
    try {
      const saved = window.localStorage.getItem(INGESTION_MODE_KEY);
      if (saved === "manual" || saved === "bulk") return saved;
      if (typeof window !== "undefined" && window.innerWidth && window.innerWidth < 780) return "manual";
    } catch { /* localStorage/window unavailable - fall through to the desktop default */ }
    return "bulk";
  });
  function setIngestionMode(mode) {
    setIngestionModeState(mode);
    try { window.localStorage.setItem(INGESTION_MODE_KEY, mode); } catch { /* non-critical UI pref - safe to lose */ }
  }
  const [filterCat, setFilterCat] = useState("all");
  const [filterAccount, setFilterAccount] = useState("all");
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
  // Every distinct account name actually in use, for the Account filter dropdown and the
  // autosuggest datalists on the staging toolbar / Manual Transaction Form - there's no separate
  // "list of accounts" to manage in Settings, an account exists purely by having been typed onto at
  // least one transaction.
  const knownAccounts = useMemo(() => [...new Set(transactions.map(t => t.account).filter(Boolean))].sort(), [transactions]);

  const nextStageId = useRef(0);
  const nextSkipId = useRef(0);

  // Every new statement lands in staging first - nothing reaches the permanent log until confirmed.
  const [staging, setStaging] = useState([]);
  // Declutters the staging table by default - a row flagged isDuplicate (see looksLikeDuplicateOf)
  // is already excluded from commitStaging regardless of this toggle, so hiding it here is purely a
  // display choice, not a second inclusion gate. Switching it off doesn't touch `included` on any
  // row, so a duplicate someone had already checked back in stays checked once it's visible again.
  const [hideDuplicates, setHideDuplicates] = useState(true);
  // Rows a CSV/paste import couldn't parse automatically (bad date, unreadable amount, blank
  // merchant) - kept around with their raw values and a human-readable reason instead of being
  // silently dropped, so the Log tab's "review & fix" drawer can offer them back for a quick manual
  // correction. See stageRows for what lands here and SkippedRowsDrawer for the recovery UI.
  const [skippedRows, setSkippedRows] = useState([]);
  const [skippedDrawerOpen, setSkippedDrawerOpen] = useState(false);
  // "Credit Card mode": some card issuers export purchases as positive and payments-toward-the-
  // balance as negative - the mirror image of this app's own negative=money-out convention. When on,
  // every amount staged from a CSV/paste import is multiplied by -1 before it reaches staging. See
  // stageRowsWithSignDetection for the auto-detect heuristic (looksLikeCreditCardFormat, guarded by
  // isChequingLikeAccount) that decides this fresh on every new ingest - both this toggle and
  // ccFormatDetected (which drives the "detected" badge) reset and re-derive from scratch each time,
  // rather than carrying over from whatever a previous, possibly different-account import left them at.
  const [invertSigns, setInvertSigns] = useState(false);
  const [ccFormatDetected, setCcFormatDetected] = useState(false);
  // The account every currently-staged row will be tagged with once committed (see commitStaging) -
  // one field for the whole staging batch, not per-row, since a CSV/paste import is normally one
  // statement from one account at a time. Plain in-session state, not persisted like
  // ManualTransactionForm's account (a fresh import is more likely to be a different statement than
  // a fresh manual entry is to be a different account).
  const [stagingAccount, setStagingAccount] = useState("");
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

  // --- App Lock (Phase 5 Item 2, v6.8): see the module-level "App Lock" comment above for the
  // crypto/WebAuthn helpers and why none of this is part of STORAGE_KEY. `locked` starts true whenever
  // App Lock was already on at the last save, so a fresh page load (or PWA resume - see the
  // visibilitychange effect below) never shows ledger data before authentication resolves.
  const [lockEnabled, setLockEnabledState] = useState(() => {
    try { return window.localStorage.getItem(LOCK_ENABLED_KEY) === "1"; } catch { return false; }
  });
  const [pinRecord, setPinRecordState] = useState(() => {
    try { const raw = window.localStorage.getItem(LOCK_PIN_RECORD_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  const [webauthnCredential, setWebauthnCredentialState] = useState(() => {
    try { const raw = window.localStorage.getItem(LOCK_WEBAUTHN_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  const [locked, setLocked] = useState(() => {
    try { return window.localStorage.getItem(LOCK_ENABLED_KEY) === "1"; } catch { return false; }
  });

  function setLockEnabled(enabled) {
    setLockEnabledState(enabled);
    try { window.localStorage.setItem(LOCK_ENABLED_KEY, enabled ? "1" : "0"); } catch { /* non-critical config - safe to lose */ }
  }
  function savePinRecord(record) {
    setPinRecordState(record);
    try {
      if (record) window.localStorage.setItem(LOCK_PIN_RECORD_KEY, JSON.stringify(record));
      else window.localStorage.removeItem(LOCK_PIN_RECORD_KEY);
    } catch { /* non-critical config - safe to lose */ }
  }
  function saveWebauthnCredential(cred) {
    setWebauthnCredentialState(cred);
    try {
      if (cred) window.localStorage.setItem(LOCK_WEBAUTHN_KEY, JSON.stringify(cred));
      else window.localStorage.removeItem(LOCK_WEBAUTHN_KEY);
    } catch { /* non-critical config - safe to lose */ }
  }
  // A PIN is the one fully self-contained unlock method (see the module comment above), so App Lock
  // can't be turned on without one already set - otherwise losing/never-getting biometric access on a
  // later visit (a browser update, a different device) would lock the person out with no way back in.
  function handleToggleLockEnabled(next) {
    if (next && !pinRecord) {
      alert("Set a backup PIN first - App Lock needs at least one way to unlock before it can be turned on.");
      return;
    }
    setLockEnabled(next);
  }
  async function handleSetPin(pin) {
    const record = await createPinRecord(pin);
    savePinRecord(record);
  }
  function handleRemovePin() {
    if (lockEnabled && !webauthnCredential) {
      alert("App Lock is on and this is your only unlock method - disable App Lock first, or enable biometrics before removing your PIN.");
      return;
    }
    const ok = confirm("Remove your backup PIN? You'll need to set a new one to use App Lock's PIN fallback again.");
    if (!ok) return;
    savePinRecord(null);
  }
  async function handleEnableBiometrics() {
    try {
      const cred = await registerBiometricCredential();
      saveWebauthnCredential(cred);
    } catch (err) {
      alert("Couldn't set up biometrics: " + (err && err.message ? err.message : "the request was cancelled or isn't supported here."));
    }
  }
  function handleRemoveBiometrics() {
    if (lockEnabled && !pinRecord) {
      alert("App Lock is on and this is your only unlock method - disable App Lock first, or set a PIN before removing biometrics.");
      return;
    }
    saveWebauthnCredential(null);
  }
  function handleUnlock() {
    setLocked(false);
  }
  // Re-locks the instant the tab/PWA is backgrounded, so the overlay is already showing by the time it
  // becomes visible again - covers both "closed and reopened" and "switched away and back" without
  // needing to distinguish the two.
  useEffect(() => {
    if (!lockEnabled) return;
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") setLocked(true);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [lockEnabled]);

  // --- Cloud Sync (Phase 4 Item 4, v6.5; dual-provider v6.6): see the module-level "Cloud Sync" block
  // above for the crypto/GIS/Drive/Dropbox helper functions. Only per-browser config (Client ID/App
  // Key, which provider is selected, last-synced timestamps) is persisted - same pattern as THEME_KEY,
  // never part of STORAGE_KEY or JSON export/import, since none of it is financial data. The
  // passphrase is always memory-only for both providers. The Google access token is memory-only too
  // (GIS can silently re-mint it); the Dropbox refresh token is the one exception, persisted because
  // Dropbox's redirect-based flow has no in-page equivalent - see the module-level Dropbox comment.
  const [cloudProvider, setCloudProviderState] = useState(() => {
    try { const saved = window.localStorage.getItem(CLOUD_PROVIDER_KEY); return saved === "dropbox" ? "dropbox" : "google"; } catch { return "google"; }
  });
  const [cloudClientId, setCloudClientId] = useState(() => {
    try { return window.localStorage.getItem(CLOUD_CLIENT_ID_KEY) || ""; } catch { return ""; }
  });
  const [cloudPassphrase, setCloudPassphrase] = useState("");
  const [cloudAccessToken, setCloudAccessToken] = useState(null); // { token, expiresAt } | null - memory-only
  const [cloudStatus, setCloudStatus] = useState("idle"); // "idle" | "encrypting" | "syncing" | "error" | "success"
  const [cloudStatusMessage, setCloudStatusMessage] = useState("");
  const [cloudLastSynced, setCloudLastSynced] = useState(() => {
    try { return window.localStorage.getItem(CLOUD_LAST_SYNCED_KEY) || ""; } catch { return ""; }
  });
  // Holds the GIS token client instance once created, keyed by which Client ID it was built for, so
  // editing the Client ID field transparently rebuilds it on the next connect rather than silently
  // reusing a token client tied to a stale/wrong id.
  const cloudTokenClientRef = useRef(null);

  // --- Dropbox provider state (v6.6) - see the module-level Dropbox comment for why the refresh token
  // is persisted while the Google access token above isn't.
  const [dropboxAppKey, setDropboxAppKey] = useState(() => {
    try { return window.localStorage.getItem(DROPBOX_APP_KEY_KEY) || ""; } catch { return ""; }
  });
  const [dropboxAccessToken, setDropboxAccessToken] = useState(null); // { token, expiresAt } | null - memory-only
  const [dropboxRefreshToken, setDropboxRefreshToken] = useState(() => {
    try { return window.localStorage.getItem(DROPBOX_REFRESH_TOKEN_KEY) || ""; } catch { return ""; }
  });
  const [dropboxLastSynced, setDropboxLastSynced] = useState(() => {
    try { return window.localStorage.getItem(DROPBOX_LAST_SYNCED_KEY) || ""; } catch { return ""; }
  });

  function setCloudProvider(provider) {
    setCloudProviderState(provider);
    setCloudStatus("idle");
    setCloudStatusMessage("");
  }

  useEffect(() => {
    try { window.localStorage.setItem(CLOUD_PROVIDER_KEY, cloudProvider); } catch { /* non-critical config - safe to lose */ }
  }, [cloudProvider]);
  useEffect(() => {
    try { window.localStorage.setItem(CLOUD_CLIENT_ID_KEY, cloudClientId); } catch { /* non-critical config - safe to lose */ }
  }, [cloudClientId]);
  useEffect(() => {
    try { window.localStorage.setItem(DROPBOX_APP_KEY_KEY, dropboxAppKey); } catch { /* non-critical config - safe to lose */ }
  }, [dropboxAppKey]);
  useEffect(() => {
    try {
      if (dropboxRefreshToken) window.localStorage.setItem(DROPBOX_REFRESH_TOKEN_KEY, dropboxRefreshToken);
      else window.localStorage.removeItem(DROPBOX_REFRESH_TOKEN_KEY);
    } catch { /* non-critical - worst case, reconnecting to Dropbox is one redirect away */ }
  }, [dropboxRefreshToken]);

  // Completes the Dropbox PKCE round trip: if this load's URL carries ?code=&state= (Dropbox sending
  // the person back after startDropboxAuth navigated away), exchanges the code for tokens, switches to
  // the Dropbox provider, and scrubs the URL so a refresh can't replay the one-time code. A normal load
  // (no code/error present) is a no-op. Runs once on mount - this is a one-time consumption of
  // whatever the browser's URL happened to be on arrival, not a subscription to anything that should
  // re-run as component state changes later.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const authError = params.get("error");
    if (!code && !authError) return;
    const returnedState = params.get("state");
    const redirectUri = window.location.origin + window.location.pathname;
    (async () => {
      try {
        if (authError) throw new Error(params.get("error_description") || "Dropbox sign-in was cancelled.");
        const expectedState = window.sessionStorage.getItem(DROPBOX_STATE_SESSION_KEY);
        const verifier = window.sessionStorage.getItem(DROPBOX_VERIFIER_SESSION_KEY);
        if (!verifier || !returnedState || returnedState !== expectedState) {
          throw new Error("Dropbox sign-in couldn't be verified - try connecting again.");
        }
        setCloudStatus("syncing"); setCloudStatusMessage("Finishing Dropbox sign-in...");
        // Reads the persisted App Key straight from localStorage rather than the dropboxAppKey state
        // variable - this effect intentionally runs exactly once, on whatever URL the page happened to
        // load with, so it deliberately doesn't take dropboxAppKey as a reactive dependency. By the
        // time Dropbox redirects back here, startDropboxAuth's caller already persisted it (see the
        // dropboxAppKey persist effect above), so this reads the same value either way.
        let persistedAppKey = "";
        try { persistedAppKey = window.localStorage.getItem(DROPBOX_APP_KEY_KEY) || ""; } catch { /* falls through to the empty-key error below */ }
        const resp = await exchangeDropboxCode(persistedAppKey.trim(), code, verifier, redirectUri);
        setDropboxAccessToken({ token: resp.access_token, expiresAt: new Date().getTime() + (Number(resp.expires_in) || 14400) * 1000 });
        if (resp.refresh_token) setDropboxRefreshToken(resp.refresh_token);
        setCloudProviderState("dropbox");
        setTab("settings");
        setCloudStatus("success"); setCloudStatusMessage("Connected to Dropbox. Enter a passphrase, then Sync now or Pull from cloud.");
      } catch (err) {
        setCloudStatus("error"); setCloudStatusMessage(err.message || "Dropbox sign-in failed.");
      } finally {
        window.sessionStorage.removeItem(DROPBOX_VERIFIER_SESSION_KEY);
        window.sessionStorage.removeItem(DROPBOX_STATE_SESSION_KEY);
        window.history.replaceState(null, "", redirectUri);
      }
    })();
  }, []);

  function isCloudTokenValid() {
    return !!(cloudAccessToken && cloudAccessToken.expiresAt > new Date().getTime() + 30000);
  }

  // Lazily creates (or rebuilds, if the Client ID changed) the GIS token client, then requests an
  // access token. GIS's initTokenClient callback is fixed at creation time but requestAccessToken has
  // no per-call return value, so - the documented GIS pattern - the callback is reassigned on the
  // token client instance immediately before each request, and this promise resolves/rejects from
  // inside that reassigned callback.
  function requestCloudAccessToken() {
    return new Promise((resolve, reject) => {
      const clientId = cloudClientId.trim();
      if (!clientId) { reject(new Error("Enter your Google Client ID above first.")); return; }
      loadGisScript().then(() => {
        if (!cloudTokenClientRef.current || cloudTokenClientRef.current.clientId !== clientId) {
          cloudTokenClientRef.current = {
            clientId,
            client: window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: GIS_SCOPE, callback: () => {} }),
          };
        }
        cloudTokenClientRef.current.client.callback = (resp) => {
          if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
          const token = { token: resp.access_token, expiresAt: new Date().getTime() + (Number(resp.expires_in) || 3600) * 1000 };
          setCloudAccessToken(token);
          resolve(token.token);
        };
        cloudTokenClientRef.current.client.requestAccessToken();
      }).catch(reject);
    });
  }
  // Reuses the current token while it still has headroom; otherwise requests a fresh one. Since the
  // scope was already granted, GIS typically issues this silently (no popup) rather than re-prompting.
  async function getCloudAccessToken() {
    if (isCloudTokenValid()) return cloudAccessToken.token;
    return requestCloudAccessToken();
  }

  async function connectGoogle() {
    try {
      setCloudStatus("syncing"); setCloudStatusMessage("Connecting to your Google account...");
      await requestCloudAccessToken();
      setCloudStatus("success"); setCloudStatusMessage("Connected. Enter a passphrase, then Sync now or Pull from cloud.");
    } catch (err) {
      setCloudStatus("error"); setCloudStatusMessage(err.message || "Couldn't connect to Google.");
    }
  }
  // Revokes the OAuth grant (best-effort - local state is cleared either way) and drops every
  // in-memory credential. The passphrase is cleared too, on the same reasoning it was never persisted
  // in the first place: once "disconnected" means disconnected, not "still holding secrets in memory."
  function disconnectGoogle() {
    const token = cloudAccessToken?.token;
    setCloudAccessToken(null);
    setCloudPassphrase("");
    cloudTokenClientRef.current = null;
    setCloudStatus("idle"); setCloudStatusMessage("Disconnected.");
    try {
      if (token && window.google?.accounts?.oauth2?.revoke) window.google.accounts.oauth2.revoke(token, () => {});
    } catch { /* best-effort revoke - local state is already cleared regardless */ }
  }

  // Reuses the current Dropbox access token while it still has headroom; otherwise silently mints a
  // fresh one from the persisted refresh token - no redirect needed for this part.
  async function getDropboxAccessToken() {
    if (dropboxAccessToken && dropboxAccessToken.expiresAt > new Date().getTime() + 30000) return dropboxAccessToken.token;
    if (!dropboxRefreshToken) throw new Error("Connect your Dropbox account first.");
    const resp = await refreshDropboxAccessToken(dropboxAppKey.trim(), dropboxRefreshToken);
    const token = { token: resp.access_token, expiresAt: new Date().getTime() + (Number(resp.expires_in) || 14400) * 1000 };
    setDropboxAccessToken(token);
    return token.token;
  }
  // Connecting to Dropbox is a full-page redirect (see the module-level Dropbox comment), which would
  // silently discard any not-yet-committed staged import rows (staging is transient, never persisted -
  // see CONTEXT.md's Staging rows subsection) - so this warns and lets the person cancel first, the
  // same way other destructive-ish actions in this app confirm() before proceeding.
  async function connectDropbox() {
    const appKey = dropboxAppKey.trim();
    if (!appKey) { setCloudStatus("error"); setCloudStatusMessage("Enter your Dropbox App Key above first."); return; }
    if (staging.length > 0) {
      const ok = confirm(`You have ${staging.length} staged transaction${staging.length !== 1 ? "s" : ""} not yet added to your log. Connecting to Dropbox reloads this page, which would lose them. Continue anyway?`);
      if (!ok) return;
    }
    try {
      setCloudStatus("syncing"); setCloudStatusMessage("Redirecting to Dropbox...");
      await startDropboxAuth(appKey);
    } catch (err) {
      setCloudStatus("error"); setCloudStatusMessage(err.message || "Couldn't start Dropbox sign-in.");
    }
  }
  // Drops the persisted refresh token (so this browser can no longer mint new Dropbox access tokens
  // without a fresh redirect) and best-effort revokes it with Dropbox if a live access token happens
  // to be in memory - unlike Google, there's no in-memory token to revoke on a fresh page load, so
  // local removal (the part that actually matters - see the module-level Dropbox comment) always
  // happens regardless of whether the network revoke call succeeds.
  function disconnectDropbox() {
    const token = dropboxAccessToken?.token;
    setDropboxAccessToken(null);
    setDropboxRefreshToken("");
    setCloudPassphrase("");
    setCloudStatus("idle"); setCloudStatusMessage("Disconnected from Dropbox.");
    if (token) dropboxRevokeToken(token).catch(() => { /* best-effort - local state is already cleared regardless */ });
  }

  function markCloudSynced(provider) {
    const now = new Date().toISOString();
    if (provider === "dropbox") {
      setDropboxLastSynced(now);
      try { window.localStorage.setItem(DROPBOX_LAST_SYNCED_KEY, now); } catch { /* non-critical */ }
    } else {
      setCloudLastSynced(now);
      try { window.localStorage.setItem(CLOUD_LAST_SYNCED_KEY, now); } catch { /* non-critical */ }
    }
  }

  // Sync Now: encrypts the exact same payload shape exportData/importData use (one shared encryption
  // engine for both providers - see encryptVaultPayload), then uploads it to whichever provider is
  // currently selected. Encryption happens before any network call, so a slow or failed upload can
  // never leave plaintext in flight.
  async function syncNowToCloud() {
    if (!cloudPassphrase) { alert("Enter a passphrase first - it's needed to encrypt your data before upload."); return; }
    const providerLabel = cloudProvider === "dropbox" ? "Dropbox" : "Google Drive";
    try {
      setCloudStatus("encrypting"); setCloudStatusMessage("Encrypting your data...");
      const payload = { transactions, lookup, spendingCategories, categoryBehaviors, budget, recurringConfig, dashboardLayout, exportedAt: new Date().toISOString() };
      const envelopeText = await encryptVaultPayload(cloudPassphrase, payload);
      setCloudStatus("syncing"); setCloudStatusMessage(`Uploading to ${providerLabel}...`);
      if (cloudProvider === "dropbox") {
        const accessToken = await getDropboxAccessToken();
        await dropboxUploadVault(accessToken, envelopeText);
      } else {
        const accessToken = await getCloudAccessToken();
        const existingFileId = await driveFindVaultFileId(accessToken);
        await driveUploadVault(accessToken, existingFileId, envelopeText);
      }
      markCloudSynced(cloudProvider);
      setCloudStatus("success"); setCloudStatusMessage(`Synced to ${providerLabel}.`);
    } catch (err) {
      setCloudStatus("error"); setCloudStatusMessage(err.message || "Sync failed.");
    }
  }

  // Pull from Cloud: downloads ledger-vault.enc from whichever provider is selected, decrypts it in
  // memory via the same shared engine Sync Now uses, then applies it with exactly the same "validate
  // every section before applying anything" rule importData follows for a JSON backup file - a
  // malformed or wrong-passphrase cloud payload can no more partially corrupt local data than a
  // malformed backup file can. A decrypt failure in particular (almost always a wrong passphrase) is
  // caught on its own and alerted safely, before any validation or state update runs.
  async function pullFromCloud() {
    if (!cloudPassphrase) { alert("Enter your passphrase first - it's needed to decrypt the cloud backup."); return; }
    const providerLabel = cloudProvider === "dropbox" ? "Dropbox" : "Google Drive";
    const ok = confirm(`Pulling from the cloud will overwrite this browser's current ledger data with whatever's stored in ${providerLabel}. Continue?`);
    if (!ok) return;
    try {
      setCloudStatus("syncing"); setCloudStatusMessage(`Connecting to ${providerLabel}...`);
      let envelopeText;
      if (cloudProvider === "dropbox") {
        const accessToken = await getDropboxAccessToken();
        envelopeText = await dropboxDownloadVault(accessToken);
      } else {
        const accessToken = await getCloudAccessToken();
        const fileId = await driveFindVaultFileId(accessToken);
        envelopeText = fileId ? await driveDownloadVault(accessToken, fileId) : null;
      }
      if (!envelopeText) { setCloudStatus("error"); setCloudStatusMessage(`No cloud backup found yet on ${providerLabel} - use Sync now first.`); return; }

      setCloudStatus("encrypting"); setCloudStatusMessage("Decrypting...");
      let payload;
      try {
        payload = await decryptVaultPayload(cloudPassphrase, envelopeText);
      } catch {
        // Wrong passphrase, or a corrupted/foreign file - alert safely and stop here. Nothing local
        // has been touched, matching importData's "validate before applying anything" rule.
        setCloudStatus("error"); setCloudStatusMessage("Decryption failed - check your passphrase.");
        alert("Couldn't decrypt the cloud backup. Check your passphrase and try again. Your local data hasn't been changed.");
        return;
      }
      if (!payload || typeof payload !== "object") {
        setCloudStatus("error"); setCloudStatusMessage("The decrypted cloud backup was empty or malformed.");
        alert("The decrypted cloud backup doesn't look like a ledger backup. Nothing was imported - your local data is unchanged.");
        return;
      }

      const hasT = "transactions" in payload, hasL = "lookup" in payload, hasB = "budget" in payload;
      const hasC = "spendingCategories" in payload, hasRC = "recurringConfig" in payload, hasDL = "dashboardLayout" in payload;
      const hasCB = "categoryBehaviors" in payload;
      if (hasT && (!Array.isArray(payload.transactions) || payload.transactions.length > MAX_IMPORT_ROWS || !payload.transactions.every(isValidTransaction))) {
        throw new Error("The transactions in the cloud backup look malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasL && (!Array.isArray(payload.lookup) || !payload.lookup.every(isValidLookupEntry))) {
        throw new Error("The merchant lookup table in the cloud backup looks malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasB && !isValidBudget(payload.budget)) {
        throw new Error("The budget assumptions in the cloud backup look malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasC && (!Array.isArray(payload.spendingCategories) || !payload.spendingCategories.every(c => typeof c === "string"))) {
        throw new Error("The category list in the cloud backup looks malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasRC && !isValidRecurringConfig(payload.recurringConfig)) {
        throw new Error("The recurring-detection settings in the cloud backup look malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasDL && !isValidDashboardLayout(payload.dashboardLayout)) {
        throw new Error("The dashboard layout settings in the cloud backup look malformed. Nothing was imported - your local data is unchanged.");
      }
      if (hasCB && !isValidCategoryBehaviors(payload.categoryBehaviors)) {
        throw new Error("The category behavior settings in the cloud backup look malformed. Nothing was imported - your local data is unchanged.");
      }

      // All validated - apply as one batch, same as importData.
      if (hasT || hasL || hasB || hasC || hasRC || hasDL || hasCB) suppressDirtyCheck.current = true;
      if (hasT) {
        const reindexed = migrateWealthsimpleTransactions(payload.transactions.map((t, i) => ({ ...t, id: i })));
        setTransactions(reindexed);
        nextId.current = computeNextId(reindexed);
        setLastImportBatch(null);
        setSelectedTxnIds(new Set());
      }
      if (hasL) setLookup(sortLookup(migrateWealthsimpleLookup(payload.lookup)));
      if (hasB) setBudget(prev => ({ ...prev, ...migrateBudget(payload.budget) }));
      if (hasC) setSpendingCategories(ensureMasterSeedCategories(ensureWealthsimpleCategory(payload.spendingCategories)));
      if (hasRC) setRecurringConfig(payload.recurringConfig);
      if (hasDL) setDashboardLayout(normalizeDashboardLayout(payload.dashboardLayout));
      if (hasCB) setCategoryBehaviors(payload.categoryBehaviors);
      setHasUnsavedChanges(false);

      markCloudSynced(cloudProvider);
      setCloudStatus("success"); setCloudStatusMessage(`Restored from ${providerLabel}.`);
    } catch (err) {
      setCloudStatus("error"); setCloudStatusMessage(err.message || "Pull failed.");
      alert(err.message || "Couldn't pull from the cloud. Your local data hasn't been changed.");
    }
  }

  // Autosave: mirrors transactions/lookup/spendingCategories/budget into localStorage on every
  // change, in the same shape a manual JSON export uses. This is separate from hasUnsavedChanges -
  // that still tracks "backed up to a file since the last edit", which the autosave doesn't replace
  // (the browser's storage can still be cleared, e.g. a private window, so a real file backup matters).
  useEffect(() => {
    try {
      if (typeof window === "undefined" || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ transactions, lookup, spendingCategories, categoryBehaviors, budget, recurringConfig, dashboardLayout }));
      setStorageWarning("");
    } catch (err) {
      console.warn("Ledger: couldn't save to this browser's storage.", err);
      setStorageWarning("Changes aren't saving to this browser right now (storage may be full or blocked). Use Save backup below so nothing is lost.");
    }
  }, [transactions, lookup, spendingCategories, categoryBehaviors, budget, recurringConfig, dashboardLayout]);

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

  // `invert` flips a successfully-parsed amount's sign before it reaches staging - used by the
  // "Invert Signs (Credit Card mode)" toggle. Applied after the finite-number check below, so it
  // can't turn an unparseable amount into a spuriously "valid" one.
  function stageRows(rows, { invertSigns: invert = false, account: accountOverride } = {}) {
    // accountOverride lets a caller pass a just-computed value (see handleCSV, which detects and
    // stages in the same call before the setStagingAccount() it also fires has actually committed
    // to state) instead of always reading the stagingAccount closure, which would still be stale in
    // that specific case.
    const account = (accountOverride !== undefined ? accountOverride : stagingAccount).trim() || null;
    const cleaned = [];
    const failed = [];
    rows.forEach(r => {
      const rawDate = (r.date ?? "").toString().trim();
      const rawAmount = (r.amount ?? "").toString().trim();
      const merchant = (r.merchant || r.description || "").toString().trim();
      const date = parseFlexibleDate(rawDate);
      const amount = parseFlexibleAmount(rawAmount);

      const issues = [];
      if (!rawDate) issues.push("Missing date");
      else if (!date) issues.push(`Unparseable date: "${rawDate}"`);
      if (!rawAmount) issues.push("Missing amount");
      else if (!Number.isFinite(amount)) issues.push(`Unparseable amount: "${rawAmount}"`);
      if (!merchant) issues.push("Missing merchant/description");

      if (issues.length === 0) {
        const { category, matched } = categorize(merchant, lookup);
        cleaned.push({
          stageId: nextStageId.current++, date, description: r.description,
          merchant, amount: invert ? -amount : amount, suggested: category, category: category || "", matched,
          account, // see commitStaging - tagged here, not at commit time
        });
      } else {
        failed.push({ skipId: nextSkipId.current++, reason: issues.join("; "),
          raw: { date: rawDate, description: (r.description ?? "").toString(), merchant, amount: rawAmount } });
      }
    });

    // Flag (not silently exclude) rows that look like they're already in the log - see
    // looksLikeDuplicateOf for the fuzzy match criteria. Checked against both the permanent log and
    // anything already sitting in staging from an earlier import this session, so re-selecting the
    // same file twice in a row still gets caught. A flagged row starts unchecked (excluded from
    // commitStaging) but stays visible with a "Duplicate (already in log)" badge so a person can
    // still check it back in if it turns out to be a genuine repeat charge.
    const existingPool = [...transactions, ...staging];
    const kept = cleaned.map(r => {
      const isDuplicate = existingPool.some(existing => looksLikeDuplicateOf(r, existing));
      return { ...r, isDuplicate, included: !isDuplicate };
    });
    const duplicateCount = kept.filter(r => r.isDuplicate).length;

    const parts = [];
    if (failed.length > 0) parts.push(`${failed.length} row${failed.length !== 1 ? "s" : ""} could not be parsed automatically`);
    if (duplicateCount > 0) parts.push(`${duplicateCount} possible duplicate${duplicateCount !== 1 ? "s" : ""} flagged below - unchecked by default, review before confirming`);
    setImportWarning(parts.join(". "));
    if (failed.length) setSkippedRows(prev => [...prev, ...failed]);

    setStaging(prev => [...prev, ...kept]);
  }

  // Every stageRows call site funnels through here instead of calling it directly, so the credit-
  // card-format auto-detect (see looksLikeCreditCardFormat) runs once, in one place, on the actual
  // rows about to be staged. Every new ingest decides its own polarity fresh - `invertSigns` is
  // fully reset to whatever this batch's own detection concludes, rather than inheriting or ORing in
  // whatever the toggle was left at by a previous, possibly different-account import (that "state
  // leakage" was the bug: importing a credit card statement then a chequing one right after could
  // silently double-invert the second file). A chequing/debit/savings account - by name (detected or
  // currently selected) or by filename - overrides the polarity check outright and always forces the
  // toggle off, since no chequing account is plausibly a credit card statement regardless of what its
  // rows look like. `accountOverride`/`filenameForGuard` are optional; see handleCSV, the one caller
  // that has a just-detected account (staged before its own setStagingAccount() call has actually
  // committed to state) and an actual filename to check.
  function stageRowsWithSignDetection(rows, accountOverride, filenameForGuard) {
    const effectiveAccount = accountOverride !== undefined ? accountOverride : stagingAccount;
    const isChequing = isChequingLikeAccount(effectiveAccount) || isChequingLikeAccount(filenameForGuard);
    const detected = isChequing ? false : looksLikeCreditCardFormat(rows);

    setCcFormatDetected(detected);
    setInvertSigns(detected);
    stageRows(rows, { invertSigns: detected, account: accountOverride });
  }

  // Called from SkippedRowsDrawer once a skipped row's Date/Merchant/Amount/Category have all been
  // fixed and are ready to recover into staging. Reuses confirmIfDuplicate rather than the bulk
  // path's silent skip-and-report, since recovering one row here is a single deliberate action -
  // same reasoning ManualTransactionForm's single-row entry already follows (see confirmIfDuplicate).
  function recoverSkippedRow(skipId, fixed) {
    if (!confirmIfDuplicate({ date: fixed.date, merchant: fixed.merchant, description: fixed.merchant, amount: fixed.amount })) return;
    const { category: suggested } = categorize(fixed.merchant, lookup);
    setStaging(prev => [...prev, {
      stageId: nextStageId.current++, date: fixed.date, description: fixed.merchant,
      merchant: fixed.merchant, amount: fixed.amount, suggested, category: fixed.category, matched: fixed.category === suggested,
      account: stagingAccount.trim() || null, // recovered rows came from the same CSV/paste batch
      isDuplicate: false, included: true, // already confirmed via confirmIfDuplicate above
    }]);
    setSkippedRows(prev => prev.filter(r => r.skipId !== skipId));
  }
  function dismissSkippedRow(skipId) { setSkippedRows(prev => prev.filter(r => r.skipId !== skipId)); }
  function dismissAllSkippedRows() { setSkippedRows([]); }

  // Ordered by how confidently a header names the transaction's actual merchant/description text,
  // most confident first. "Description 1"/"Transaction Description"/"Merchant"/"Payee"/"Main
  // Description"/"Name" all name the column a bank puts the real payee/merchant string in;
  // "Sub-Description"/"Description 2"/"Memo"/"Location"/"City"/"Address" are companion columns some
  // banks export alongside a primary one (usually a branch/location suffix), never a substitute for
  // it. PRIMARY_TEXT_NAMES is checked in full before SECONDARY_TEXT_NAMES is ever consulted, so a
  // CSV whose secondary column happens to appear earlier in the file's own column order can't steal
  // the merchant slot away from the real primary column.
  const PRIMARY_TEXT_NAMES = ["description 1", "transaction description", "merchant", "payee", "main description", "name", "description", "desc"];
  const SECONDARY_TEXT_NAMES = ["sub-description", "sub description", "description 2", "memo", "location", "city", "address", "merchant/sub-description"];
  // Same priority-list treatment as PRIMARY_TEXT_NAMES above, for the Date and Amount columns - a
  // plain "Date"/"Amount" header is still the most common case (checked first), but "Transaction
  // Date"/"Transaction Amount" (BMO and others) need to match too, or the file falls through to
  // manual mapping despite being fully auto-readable. Order matters here as much as it does for
  // PRIMARY_TEXT_NAMES: on a file with both a plain "Amount" and something like a "Transaction
  // Amount" running total column, the exact "amount" match must win regardless of column order.
  const DATE_NAMES = ["date", "transaction date", "posted date", "trans date"];
  const AMOUNT_NAMES = ["amount", "transaction amount"];

  function extractRowsFromParsedCSV(res, filename) {
    const keys = res.data.length ? Object.keys(res.data[0]) : [];
    // Matches `names` against the file's headers in priority order (the order names are listed
    // in), not the file's own column order - so a lower-priority column appearing earlier in the
    // CSV never wins over a higher-priority one appearing later.
    const find = (row, names) => {
      for (const name of names) {
        const k = keys.find(k => k.toLowerCase().trim() === name);
        if (k) return (row[k] ?? "").toString();
      }
      return "";
    };
    const hasDate = DATE_NAMES.some(name => keys.some(k => k.toLowerCase().trim() === name));
    const hasAmount = AMOUNT_NAMES.some(name => keys.some(k => k.toLowerCase().trim() === name));
    // No single Amount column - fall back to a Debit/Credit (or Withdrawals/Deposits) pair, if the
    // file has one, before giving up and asking the person to map columns by hand.
    const hasDebitCredit = !hasAmount && (keys.some(k => DEBIT_NAMES.includes(k.toLowerCase().trim()))
      || keys.some(k => CREDIT_NAMES.includes(k.toLowerCase().trim())));
    if (!hasDate || (!hasAmount && !hasDebitCredit)) {
      return { needsMapping: true, headers: keys, rawRows: res.data, filename };
    }
    return {
      needsMapping: false,
      rows: res.data.map(row => {
        const primaryText = find(row, PRIMARY_TEXT_NAMES).trim();
        const secondaryText = find(row, SECONDARY_TEXT_NAMES).trim();
        // Prefer the primary column outright; only fold the secondary one in when it adds real
        // information (non-empty and not just a repeat of the primary text), so a merchant string
        // never ends up as "Costco - Costco" or a trailing "Costco - " for rows where the
        // secondary column is blank.
        const merchant = primaryText && secondaryText && secondaryText !== primaryText
          ? `${primaryText} - ${secondaryText}` : (primaryText || secondaryText);
        const amount = hasAmount ? find(row, AMOUNT_NAMES) : combineDebitCredit(find(row, DEBIT_NAMES), find(row, CREDIT_NAMES));
        return { date: find(row, DATE_NAMES), description: primaryText, merchant, amount };
      }),
    };
  }

  // Reads the file's raw text once via file.text() and reuses it for both account auto-detect (see
  // guessAccountFromFile) and header-detection-aware parsing (see parseCSVWithHeaderDetection) -
  // Papa.parse's own File-mode result doesn't expose the raw text at all, so a single text() read
  // now serves both needs instead of reading the file twice through two different APIs. The account
  // guess is computed synchronously from that text, *then* handed straight to this same call's
  // stageRowsWithSignDetection instead of racing its own setStagingAccount() (which wouldn't commit
  // to state until a later render, and so would still read as empty if stageRows read it eagerly).
  // Only guesses when stagingAccount is still empty, so re-uploading a second statement right after
  // the first never silently overwrites whatever account the person already chose for this batch.
  async function handleCSV(file) {
    let text;
    try {
      text = await file.text();
    } catch (err) {
      alert("Could not read that CSV file: " + err.message);
      return;
    }
    let guessedAccount = stagingAccount;
    if (!stagingAccount) {
      guessedAccount = guessAccountFromFile(file.name, text);
      if (guessedAccount) setStagingAccount(guessedAccount);
    }
    const res = parseCSVWithHeaderDetection(text);
    if (!res.data || res.data.length === 0) {
      alert("That CSV didn't contain any rows Claude could read. Check it has Date, Description, Merchant, and Amount columns.");
      return;
    }
    const result = extractRowsFromParsedCSV(res, file.name);
    if (result.needsMapping) {
      setPendingMapping(result);
    } else {
      stageRowsWithSignDetection(result.rows, guessedAccount, file.name);
    }
  }

  // Selecting a whole folder (<input webkitdirectory>) hands back every file inside it. Filter to
  // CSVs, parse each, combine, and run through the same staging + dedup pipeline as a single upload -
  // re-selecting the same folder later just re-runs this and dedup silently skips what's unchanged.
  // Async (Promise.all over each file's own text() + parse) rather than the old Papa.parse(file,...)
  // + remaining-- counter, so every file gets the same header-detection-aware parsing handleCSV uses.
  async function handleFolderSelect(fileList) {
    const csvFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) {
      alert("No .csv files found in that folder.");
      return;
    }
    const allRows = [];
    const mappingNeeded = [];
    await Promise.all(csvFiles.map(async file => {
      let text;
      try {
        text = await file.text();
      } catch {
        return; // unreadable file - silently skipped, matching the old Papa.parse error: handler
      }
      const res = parseCSVWithHeaderDetection(text);
      if (res.data && res.data.length > 0) {
        const result = extractRowsFromParsedCSV(res, file.name);
        if (result.needsMapping) mappingNeeded.push(result);
        else allRows.push(...result.rows);
      }
    }));
    if (allRows.length) stageRowsWithSignDetection(allRows);
    if (mappingNeeded.length) {
      alert(`${mappingNeeded.length} file(s) couldn't be auto-read (no recognizable Date/Amount columns): ${mappingNeeded.map(m => m.filename).join(", ")}. Everything else was staged - you can add those separately.`);
    }
  }

  function handlePasteAdd() {
    let lines = pasteText.trim().split("\n").filter(Boolean);
    const truncated = lines.length > MAX_PASTE_LINES;
    if (truncated) lines = lines.slice(0, MAX_PASTE_LINES);
    const rows = lines.map(line => {
      const parts = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.trim());
      return { date: parts[0], description: parts[1], merchant: parts[2] || parts[1], amount: parts[3] };
    });
    stageRowsWithSignDetection(rows);
    if (truncated) setImportWarning(prev => `Pasted content was capped at ${MAX_PASTE_LINES.toLocaleString()} lines. ${prev}`.trim());
    setPasteText("");
  }

  // Called once the person has manually matched CSV headers to fields, for a file auto-detection failed on.
  function confirmManualMapping(mapping) {
    if (!pendingMapping) return;
    const rows = pendingMapping.rawRows.map(row => ({
      date: row[mapping.date] || "", description: row[mapping.description] || "",
      merchant: (row[mapping.merchant] || row[mapping.description] || ""),
      amount: mapping.splitAmount ? combineDebitCredit(row[mapping.debit], row[mapping.credit]) : (row[mapping.amount] || ""),
    }));
    stageRowsWithSignDetection(rows);
    setPendingMapping(null);
  }


  function updateStagingCategory(stageId, category) {
    setStaging(prev => prev.map(r => r.stageId === stageId ? { ...r, category } : r));
  }

  // Toggles a staged row's inclusion in the next commitStaging - the checkbox a person uses to
  // override a "Duplicate (already in log)" flag they've decided was wrong, or to exclude a row
  // they'd rather leave for later without fully discarding it (see removeStagingRow for that).
  function toggleStagingIncluded(stageId) {
    setStaging(prev => prev.map(r => r.stageId === stageId ? { ...r, included: !r.included } : r));
  }

  function removeStagingRow(stageId) {
    setStaging(prev => prev.filter(r => r.stageId !== stageId));
  }

  // Only checked ("included") rows are committed - an unchecked duplicate flag is left behind in
  // staging rather than discarded, so a person who decides one really was new after all can still
  // check it back in and commit again without re-importing the whole file.
  function commitStaging() {
    const toCommit = staging.filter(r => r.included);
    // Upsert: the newest correction for a merchant replaces any older entry for the same key,
    // rather than piling a duplicate on top of it every time it's corrected again.
    const corrections = new Map();
    toCommit.forEach(r => {
      if (r.category && r.category !== r.suggested) {
        corrections.set(normalize(r.merchant), r.category);
      }
    });
    const committed = toCommit.map(r => ({
      id: nextId.current++, date: r.date, description: r.description,
      merchant: r.merchant, amount: r.amount, category: r.category || null, account: r.account ?? null,
    }));
    if (corrections.size) {
      setLookup(prev => sortLookup([...corrections.entries(), ...prev.filter(([k]) => !corrections.has(k))]));
    }
    setTransactions(prev => [...prev, ...committed]);
    // Replaces any previous batch - "last import" always means the one just committed, and any
    // row an earlier undo would have touched has either already been undone or is now moot.
    setLastImportBatch({ ids: new Set(committed.map(c => c.id)), count: committed.length });
    setStaging(prev => prev.filter(r => !r.included));
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

  // --- Manual single-transaction entry (Phase 5 Item 2, v6.8) -------------------------------------
  // ManualTransactionForm's two action buttons ("Stage transaction" / "Add directly") both funnel
  // through here. Shares dedup (dedupeAgainstCommitted) and shape validation (isValidDateString) with
  // the bulk staging pipeline rather than inventing a parallel one - the one deliberate difference is
  // that a single deliberate manual entry asks via confirm() before proceeding on a likely duplicate
  // instead of silently skipping it the way a multi-row CSV/paste batch does, matching this app's
  // existing "confirm() for consequential single actions" pattern (row delete, category removal) rather
  // than the bulk path's silent skip-and-report.
  function validateManualRow(row) {
    if (!isValidDateString(row.date) || !row.merchant || !Number.isFinite(row.amount)) {
      alert("Enter a valid date, description, and numeric amount first.");
      return false;
    }
    if (!row.category) {
      alert("Choose a category (or add a new one) before saving.");
      return false;
    }
    return true;
  }
  function confirmIfDuplicate(row) {
    const { duplicateCount } = dedupeAgainstCommitted([row], [...transactions, ...staging]);
    if (duplicateCount === 0) return true;
    return confirm("A transaction with the same date, description, and amount is already in your log. Add it anyway?");
  }
  function stageManualTransaction(row) {
    if (!validateManualRow(row)) return false;
    if (!confirmIfDuplicate(row)) return false;
    const suggested = categorize(row.merchant, lookup).category;
    setStaging(prev => [...prev, {
      stageId: nextStageId.current++, date: row.date, description: row.description,
      merchant: row.merchant, amount: row.amount, suggested, category: row.category, matched: true,
      account: row.account ?? null,
      isDuplicate: false, included: true, // already confirmed via confirmIfDuplicate above
    }]);
    return true;
  }
  // Upserts a merchant lookup correction exactly like commitStaging does when the chosen category
  // differs from what the rules engine would have suggested - so a manual entry teaches the rules
  // engine the same way correcting a staged row already does, rather than only bulk imports doing so.
  function addManualTransactionDirect(row) {
    if (!validateManualRow(row)) return false;
    if (!confirmIfDuplicate(row)) return false;
    const suggested = categorize(row.merchant, lookup).category;
    if (row.category !== suggested) {
      const norm = normalize(row.merchant);
      setLookup(prev => sortLookup([[norm, row.category], ...prev.filter(([k]) => k !== norm)]));
    }
    setTransactions(prev => [...prev, {
      id: nextId.current++, date: row.date, description: row.description, merchant: row.merchant,
      amount: row.amount, category: row.category, account: row.account ?? null,
    }]);
    return true;
  }

  // --- Category management ---
  // A missing/invalid `behavior` falls back to defaultCategoryBehavior(trimmed) - not a hardcoded
  // "expense" - so a category added without ever touching the Behavior dropdown (e.g. programmatically,
  // or from a form that predates this feature) still lands on exactly what defaultCategoryBehavior
  // would guess for its name (e.g. "Investing"/"Investments" -> investment), explicit rather than
  // relying on the sparse-map fallback, so what's shown in Settings always matches what's stored.
  function addCategory(name, behavior) {
    const trimmed = name.trim();
    if (!trimmed || allCategories.includes(trimmed)) return false;
    setSpendingCategories(prev => [...prev, trimmed]);
    setCategoryBehaviors(prev => ({ ...prev, [trimmed]: VALID_BEHAVIORS.has(behavior) ? behavior : defaultCategoryBehavior(trimmed) }));
    return true;
  }
  function renameCategory(oldName, newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName || allCategories.includes(trimmed)) return false;
    setSpendingCategories(prev => prev.map(c => c === oldName ? trimmed : c));
    setTransactions(prev => prev.map(t => t.category === oldName ? { ...t, category: trimmed } : t));
    setLookup(prev => prev.map(([k, c]) => c === oldName ? [k, trimmed] : [k, c]));
    // Carries the old name's configured behavior forward under the new name, rather than losing it
    // back to defaultCategoryBehavior's guess for whatever the new name happens to look like.
    setCategoryBehaviors(prev => {
      if (!(oldName in prev)) return prev;
      const { [oldName]: behavior, ...rest } = prev;
      return { ...rest, [trimmed]: behavior };
    });
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
    setCategoryBehaviors(prev => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }
  // Sets (or clears back to the default guess by passing an invalid value) one category's configured
  // behavior - the Behavior dropdown's onChange handler, for both existing categories and any category
  // whose name doesn't match the INCOME:/TRANSFER:/EXCLUDE: convention defaultCategoryBehavior expects.
  function setCategoryBehavior(name, behavior) {
    if (!VALID_BEHAVIORS.has(behavior)) return;
    setCategoryBehaviors(prev => ({ ...prev, [name]: behavior }));
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

  // Only rows actually headed for commitStaging need a category before confirming - an unchecked
  // duplicate flag sitting in staging with no category yet isn't something to warn about.
  const stagingUnmatchedCount = staging.filter(r => r.included && !r.category).length;
  const stagingIncludedCount = staging.filter(r => r.included).length;
  const stagingDuplicateCount = staging.filter(r => r.isDuplicate).length;
  // What the table actually renders - "Hide duplicates" (default on) is a pure display filter, not
  // a second inclusion gate, so a hidden row's `included` flag is untouched and still counts toward
  // stagingIncludedCount/commitStaging above.
  const visibleStaging = hideDuplicates ? staging.filter(r => !r.isDuplicate) : staging;

  function copyStagingList() {
    const list = [...new Set(staging.filter(r => r.included && !r.category).map(r => normalize(r.merchant)))];
    return `Categorize each of these merchant strings into exactly one of these categories:\n${allCategories.join(", ")}\n\nMerchants:\n${list.join("\n")}\n\nReturn as "merchant: category" one per line.`;
  }

  function exportData() {
    const payload = { transactions, lookup, budget, spendingCategories, categoryBehaviors, recurringConfig, dashboardLayout, exportedAt: new Date().toISOString() };
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
      const hasCB = "categoryBehaviors" in payload;

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
      if (hasCB && !isValidCategoryBehaviors(payload.categoryBehaviors)) {
        alert("The category behavior settings in that file look malformed. Nothing was imported - your current data is unchanged.");
        return;
      }

      // All validated - apply as one batch, and suppress the dirty-tracking effect for the render
      // this causes, so a freshly loaded backup doesn't immediately show as "unsaved changes."
      // Only arm the suppression if something will actually change - an empty-but-valid payload
      // (e.g. {}) would otherwise leave the flag stuck and incorrectly swallow the NEXT real edit.
      if (hasT || hasL || hasB || hasC || hasRC || hasDL || hasCB) suppressDirtyCheck.current = true;
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
      if (hasC) setSpendingCategories(ensureMasterSeedCategories(ensureWealthsimpleCategory(payload.spendingCategories)));
      if (hasRC) setRecurringConfig(payload.recurringConfig);
      if (hasDL) setDashboardLayout(normalizeDashboardLayout(payload.dashboardLayout));
      if (hasCB) setCategoryBehaviors(payload.categoryBehaviors);
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

  // --- Dashboard Overhaul: pill-based timeframe + account controls -----------------------------
  // Deliberately independent of dashPeriod/excludedCategories above - those still drive the legacy
  // cumulativeNet/spendSharePie/incomeBar/recurringBills sections unchanged. These two feed only the
  // four widgets below (KPI grid, cash flow trend, category ranking, fixed vs. discretionary), which
  // read sign-resilient totals via classifyTxnKind rather than raw category/sign filtering.
  const [dashTimeframe, setDashTimeframe] = useState("last6");
  const [dashAccountFilter, setDashAccountFilter] = useState("all");

  const dashWindow = useMemo(() => resolveTimeframeWindow(dashTimeframe, transactions), [dashTimeframe, transactions]);
  const dashPrevWindow = useMemo(() => resolvePreviousWindow(dashWindow), [dashWindow]);

  const dashAccountTxns = useMemo(
    () => transactions.filter(t => accountMatchesDashFilter(t.account, dashAccountFilter)),
    [transactions, dashAccountFilter]
  );
  const dashWindowTxns = useMemo(
    () => dashAccountTxns.filter(t => t.date >= dashWindow.from && t.date <= dashWindow.to),
    [dashAccountTxns, dashWindow]
  );
  const dashPrevWindowTxns = useMemo(
    () => dashAccountTxns.filter(t => t.date >= dashPrevWindow.from && t.date <= dashPrevWindow.to),
    [dashAccountTxns, dashPrevWindow]
  );

  // --- Widget 1: High-level KPI summary grid -----------------------------------------------------
  // dashTotalSpent is already net of refunds (see txnExpenseAmount) - a $150 purchase and its $150
  // return in the same category/window sum to $0, not $300, since a refund lands as a positive amount
  // on the same expense-behavior category as the original purchase.
  const dashTotalEarned = useMemo(() => dashWindowTxns.reduce((s, t) => s + txnIncomeAmount(t, categoryBehaviors), 0), [dashWindowTxns, categoryBehaviors]);
  const dashTotalSpent = useMemo(() => dashWindowTxns.reduce((s, t) => s + txnExpenseAmount(t, categoryBehaviors), 0), [dashWindowTxns, categoryBehaviors]);
  const dashTotalInvested = useMemo(() => dashWindowTxns.reduce((s, t) => s + txnInvestedAmount(t, categoryBehaviors), 0), [dashWindowTxns, categoryBehaviors]);
  // Net Cash Remaining subtracts invested dollars from the older Income-minus-Spend "net savings"
  // figure - money moved into an investment category left the checking/spending picture just as
  // surely as an expense did, it just went somewhere trackable instead of disappearing into "spend".
  const dashNetSavings = dashTotalEarned - dashTotalSpent;
  const dashNetCashRemaining = dashNetSavings - dashTotalInvested;
  const dashInvestmentRatePct = dashTotalEarned > 0 ? (dashTotalInvested / dashTotalEarned) * 100 : null;

  const dashPrevTotalEarned = useMemo(() => dashPrevWindowTxns.reduce((s, t) => s + txnIncomeAmount(t, categoryBehaviors), 0), [dashPrevWindowTxns, categoryBehaviors]);
  const dashPrevTotalSpent = useMemo(() => dashPrevWindowTxns.reduce((s, t) => s + txnExpenseAmount(t, categoryBehaviors), 0), [dashPrevWindowTxns, categoryBehaviors]);
  const dashPrevTotalInvested = useMemo(() => dashPrevWindowTxns.reduce((s, t) => s + txnInvestedAmount(t, categoryBehaviors), 0), [dashPrevWindowTxns, categoryBehaviors]);

  // Percent change vs. the prior equivalent window - null (rendered as "n/a") when there's nothing in
  // the prior window to compare against, rather than a misleading "+Infinity%"/"0%".
  function pctChange(current, previous) {
    if (!(previous > 0)) return null;
    return ((current - previous) / previous) * 100;
  }
  const dashEarnedTrendPct = dashTimeframe === "all" ? null : pctChange(dashTotalEarned, dashPrevTotalEarned);
  const dashSpentTrendPct = dashTimeframe === "all" ? null : pctChange(dashTotalSpent, dashPrevTotalSpent);
  const dashInvestedTrendPct = dashTimeframe === "all" ? null : pctChange(dashTotalInvested, dashPrevTotalInvested);

  // --- Widget 2: Monthly cash flow trend -----------------------------------------------------------
  const dashMonthlyCashFlow = useMemo(() => {
    const byMonth = new Map();
    dashWindowTxns.forEach(t => {
      const m = t.date.slice(0, 7);
      const kind = classifyTxnKind(t, categoryBehaviors);
      if (kind !== "income" && kind !== "expense") return;
      const bucket = byMonth.get(m) || { month: m, income: 0, expense: 0 };
      // Outflow nets refunds the same way txnExpenseAmount does (-t.amount, not Math.abs(t.amount)) -
      // otherwise this chart's own bars wouldn't sum to the "Total outflow" stat shown right above it.
      if (kind === "income") bucket.income += Math.abs(t.amount); else bucket.expense -= t.amount;
      byMonth.set(m, bucket);
    });
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
      ...m,
      income: Math.round(m.income),
      expense: Math.round(m.expense),
      net: Math.round(m.income - m.expense),
      savingsRate: m.income > 0 ? Math.round(((m.income - m.expense) / m.income) * 1000) / 10 : null,
    }));
  }, [dashWindowTxns, categoryBehaviors]);

  // --- Widget: Investments & wealth accumulation -------------------------------------------------
  // Excluded entirely from dashMonthlyCashFlow above (classifyTxnKind now returns "investment", not
  // "expense", for these rows) so contributions don't get counted as lifestyle spend AND investment at
  // once - this widget is their one dedicated home. Summed as a plain magnitude (not netted like
  // txnExpenseAmount) since a contribution/withdrawal pair isn't the same "purchase vs. return of that
  // exact purchase" relationship a refund has to its expense.
  const dashMonthlyInvestments = useMemo(() => {
    const byMonth = new Map();
    dashWindowTxns.forEach(t => {
      if (classifyTxnKind(t, categoryBehaviors) !== "investment") return;
      const m = t.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + Math.abs(t.amount));
    });
    return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, total]) => ({ month, total: Math.round(total) }));
  }, [dashWindowTxns, categoryBehaviors]);
  const dashTopInvestmentDestinations = useMemo(() => {
    const totals = freshTally();
    dashWindowTxns.forEach(t => {
      if (classifyTxnKind(t, categoryBehaviors) !== "investment") return;
      const m = t.merchant || "(no merchant)";
      totals[m] = (totals[m] || 0) + Math.abs(t.amount);
    });
    return Object.entries(totals).map(([merchant, total]) => ({ merchant, total: Math.round(total) }))
      .filter(m => m.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
  }, [dashWindowTxns, categoryBehaviors]);

  // --- Widget 3: Category spending breakdown & ranking -----------------------------------------
  // classifyTxnKind's "investment" kind (distinct from "expense" as of the Investments pillar) already
  // keeps dedicated investment categories like "Investing" out of this consumer/lifestyle ranking
  // without any extra filtering here - excluding them was the whole point of giving investment
  // contributions their own behavior instead of leaving them tagged as an ordinary expense category.
  const dashCategoryRanking = useMemo(() => {
    const totals = freshTally();
    dashWindowTxns.forEach(t => {
      if (classifyTxnKind(t, categoryBehaviors) !== "expense") return;
      const cat = t.category || "Uncategorized";
      // Net a refund (positive amount, same expense-behavior category as the original purchase)
      // against its outflows instead of summing magnitudes - see txnExpenseAmount's comment. A
      // category that's fully refunded nets to (rounds to) $0 and is dropped by the total > 0 filter
      // below, exactly like a category with no spend in this window at all.
      totals[cat] = (totals[cat] || 0) - t.amount;
    });
    const entries = Object.entries(totals).filter(([, total]) => total > 0);
    const sum = entries.reduce((s, [, total]) => s + total, 0);
    return entries.map(([category, total]) => ({
      category, total: Math.round(total), pct: sum > 0 ? (total / sum) * 100 : 0,
    })).sort((a, b) => b.total - a.total);
  }, [dashWindowTxns, categoryBehaviors]);
  const dashCategoryRankingTotal = dashCategoryRanking.reduce((s, c) => s + c.total, 0);

  // Top-5 merchant contributors for one category, computed on demand when a ranking bar is expanded
  // rather than pre-computed for every category up front. Nets refunds the same way the ranking above
  // does, so a fully-refunded merchant doesn't show up in its category's top-5 at a phantom $150.
  function dashCategoryTopMerchants(category) {
    const totals = freshTally();
    dashWindowTxns.forEach(t => {
      if (classifyTxnKind(t, categoryBehaviors) !== "expense") return;
      if ((t.category || "Uncategorized") !== category) return;
      const m = t.merchant || "(no merchant)";
      totals[m] = (totals[m] || 0) - t.amount;
    });
    return Object.entries(totals).map(([merchant, total]) => ({ merchant, total: Math.round(total) }))
      .filter(m => m.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
  }
  const [expandedRankingCategory, setExpandedRankingCategory] = useState(null);

  // --- Widget 4: Fixed vs. discretionary cost breakdown -----------------------------------------
  // "Fixed" = merchants detectRecurring already flags as recurring across full history (reused as-is,
  // see `recurring` below) - a bill/subscription is fixed by how regularly it repeats, not by which
  // category it happens to be filed under. Everything else that's an expense in the current window is
  // discretionary. Investment contributions are excluded automatically (classifyTxnKind returns
  // "investment", not "expense", for them) same as in the category ranking above.
  const recurring = useMemo(() => detectRecurring(transactions.filter(t => t.category && !NON_SPEND.has(t.category)), recurringConfig), [transactions, recurringConfig]);
  const dashFixedMerchants = useMemo(() => new Set(recurring.map(r => r.merchant)), [recurring]);
  const dashFixedVsDiscretionary = useMemo(() => {
    let fixed = 0, discretionary = 0;
    const fixedByMerchant = freshTally(), discByCategory = freshTally();
    dashWindowTxns.forEach(t => {
      if (classifyTxnKind(t, categoryBehaviors) !== "expense") return;
      // Net (not Math.abs) - same refund-cancels-purchase reasoning as dashCategoryRanking above, so
      // a refunded fixed bill or discretionary purchase doesn't inflate either side's total.
      const amt = -t.amount;
      if (dashFixedMerchants.has(t.merchant)) {
        fixed += amt;
        fixedByMerchant[t.merchant] = (fixedByMerchant[t.merchant] || 0) + amt;
      } else {
        discretionary += amt;
        const cat = t.category || "Uncategorized";
        discByCategory[cat] = (discByCategory[cat] || 0) + amt;
      }
    });
    // Filtered to total > 0 for the same reason dashCategoryRanking's entries are - now that amounts
    // net instead of summing as magnitudes, a fully (or over-)refunded merchant/category can land at
    // zero or negative, and doesn't belong in a "top spend" list.
    const topFixed = Object.entries(fixedByMerchant).map(([merchant, total]) => ({ merchant, total: Math.round(total) })).filter(m => m.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
    const topDiscretionary = Object.entries(discByCategory).map(([category, total]) => ({ category, total: Math.round(total) })).filter(c => c.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
    return { fixed: Math.round(fixed), discretionary: Math.round(discretionary), topFixed, topDiscretionary };
  }, [dashWindowTxns, dashFixedMerchants, categoryBehaviors]);

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

  // --- Goal Runway & Projections (v6.4): historical monthly net surplus projected forward toward
  // each target scenario. Deliberately reads monthlyTrend (already full-history, income - spend per
  // calendar month present in the Log) rather than dashboardTxns, so this section's numbers don't
  // quietly change if the Dashboard tab's own period/category filter happens to be narrowed - a
  // budgeting projection should reflect the same "whole history" months as the trend line/cumulative
  // net chart, not whatever slice is currently selected elsewhere.
  const surplusHistory = useMemo(
    () => monthlyTrend.map(m => ({ month: m.month, surplus: m.income - m.spend })),
    [monthlyTrend]
  );
  // Averages over however many recent months actually exist (0 if there's no history yet) rather than
  // requiring a full 3 or 6 months of data before showing anything.
  const avgSurplus3mo = useMemo(() => {
    const recent = surplusHistory.slice(-3);
    return recent.length ? recent.reduce((s, m) => s + m.surplus, 0) / recent.length : 0;
  }, [surplusHistory]);
  const avgSurplus6mo = useMemo(() => {
    const recent = surplusHistory.slice(-6);
    return recent.length ? recent.reduce((s, m) => s + m.surplus, 0) / recent.length : 0;
  }, [surplusHistory]);
  // Which average rate drives the chart trajectory and the "primary" milestone column - the table
  // below shows both rates' milestones regardless, so switching this never hides the other one.
  const [runwayRateBasis, setRunwayRateBasis] = useState("6");
  const runwayMonthlyRate = runwayRateBasis === "3" ? avgSurplus3mo : avgSurplus6mo;

  // Per-scenario milestone estimates under both rates, all projected from the same "now" so they're
  // directly comparable to each other and to the chart below.
  const runwayProjections = useMemo(() => {
    const now = new Date();
    return budget.targetScenarios.map(t => {
      const gap = t.amount - netPos;
      return { ...t, gap, milestone3: estimateMilestone(gap, avgSurplus3mo, now), milestone6: estimateMilestone(gap, avgSurplus6mo, now) };
    });
  }, [budget.targetScenarios, netPos, avgSurplus3mo, avgSurplus6mo]);

  // Month-by-month chart trajectory: current net position at month 0, then the selected rate applied
  // linearly forward. A negative or zero rate still produces a perfectly valid (flat or declining)
  // curve here - only the milestone *dates* above need the explicit deficit guard, since a linear
  // projection itself never breaks or goes infinite.
  const runwayChartData = useMemo(() => {
    const now = new Date();
    const points = [];
    for (let i = 0; i <= RUNWAY_PROJECTION_MONTHS; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      points.push({ month: d.toISOString().slice(0, 7), netWorth: Math.round(netPos + runwayMonthlyRate * i) });
    }
    return points;
  }, [netPos, runwayMonthlyRate]);

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
    setEditDraft({ date: t.date, merchant: t.merchant, amount: String(t.amount), category: t.category || "", account: t.account || "" });
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
    setTransactions(prev => prev.map(t => t.id === id ? { ...t, date, merchant, amount, category: editDraft.category || null, account: editDraft.account.trim() || null } : t));
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
      category: p.category, account: parent.account,
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
      amount: total, category: null, account: first.account,
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
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  // Retroactive "Scan Duplicates" (see findDuplicateClusters) - null/closed until a scan is run,
  // then holds the cluster list DuplicateCleanerModal reviews. Recomputed fresh from `transactions`
  // each time the button is clicked rather than kept live via useMemo, since this is an on-demand
  // audit action, not something that needs to track every edit while the modal is closed.
  const [duplicateClusters, setDuplicateClusters] = useState(null);
  // Lightweight self-dismissing toast for non-blocking confirmations (e.g. "3 duplicates deleted") -
  // every other piece of feedback in this app is either a blocking alert()/confirm() or an inline
  // status message, so this is a small, self-contained addition rather than a shared library.
  const [toastMessage, setToastMessage] = useState("");
  const toastTimer = useRef(null);
  function showToast(message) {
    setToastMessage(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(""), 3200);
  }

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

  // Flips the sign of every selected transaction's amount in place - the fix for a batch that was
  // imported with the wrong polarity (a credit card file staged without the Invert Signs toggle, or
  // caught before it, see stageRowsWithSignDetection) after it's already in the permanent log.
  // Symmetric with applyBulkCategory: no confirm() (running it twice on the same selection is its
  // own undo), and clears the selection afterward so a stale selection can't be double-flipped by
  // an accidental second click.
  function invertSelectedSigns() {
    if (selectedTxnIds.size === 0) return;
    setTransactions(prev => prev.map(t => selectedTxnIds.has(t.id) ? { ...t, amount: -t.amount } : t));
    deselectAllTxns();
  }

  // Bulk delete - same confirm() pattern as the single-row deleteTransaction, gated on the current
  // selection regardless of which page(s) it spans (selectedTxnIds isn't paged).
  function deleteSelectedTxns() {
    const count = selectedTxnIds.size;
    if (count === 0) return;
    const ok = confirm(`Delete ${count} selected transaction${count !== 1 ? "s" : ""}? This can't be undone.`);
    if (!ok) return;
    if (editingTxnId !== null && selectedTxnIds.has(editingTxnId)) { setEditingTxnId(null); setEditDraft(null); }
    if (splittingTxnId !== null && selectedTxnIds.has(splittingTxnId)) setSplittingTxnId(null);
    setTransactions(prev => prev.filter(t => !selectedTxnIds.has(t.id)));
    deselectAllTxns();
  }

  // Empties the entire transaction log, gated behind DeleteAllConfirmModal rather than this app's
  // usual window.confirm() (see that component's comment). The autosave effect below mirrors
  // `transactions` into localStorage on every change, so an empty array here persists on its own -
  // no separate localStorage.setItem needed. Also clears the current selection and any pending
  // "Undo last import" batch, since both would otherwise point at ids that no longer exist.
  function deleteAllTransactions() {
    setTransactions([]);
    setSelectedTxnIds(new Set());
    setLastImportBatch(null);
    setShowDeleteAllModal(false);
  }

  // "Scan Duplicates" button - runs findDuplicateClusters against the full log and opens
  // DuplicateCleanerModal with the result, or tells the person nothing was found rather than opening
  // an empty modal.
  function openDuplicateScanner() {
    const clusters = findDuplicateClusters(transactions);
    if (clusters.length === 0) {
      alert("No likely duplicates found - every transaction's amount, date, and merchant combination looks unique.");
      return;
    }
    setDuplicateClusters(clusters);
  }
  // Applies DuplicateCleanerModal's confirmed selection: removes the chosen ids from the permanent
  // log (same shape as deleteSelectedTxns), keeps the bulk-selection/editing/splitting state
  // consistent with whatever just got deleted, closes the modal, and surfaces a toast rather than
  // another blocking alert() on top of the confirm() the modal's own delete button already required.
  function deleteDuplicates(idsToDelete) {
    const count = idsToDelete.length;
    if (count === 0) return;
    const ok = confirm(`Delete ${count} duplicate transaction${count !== 1 ? "s" : ""}? This can't be undone.`);
    if (!ok) return;
    const idSet = new Set(idsToDelete);
    if (editingTxnId !== null && idSet.has(editingTxnId)) { setEditingTxnId(null); setEditDraft(null); }
    if (splittingTxnId !== null && idSet.has(splittingTxnId)) setSplittingTxnId(null);
    setTransactions(prev => prev.filter(t => !idSet.has(t.id)));
    setSelectedTxnIds(prev => {
      if (![...idSet].some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      idSet.forEach(id => next.delete(id));
      return next;
    });
    setDuplicateClusters(null);
    showToast(`${count} duplicate${count !== 1 ? "s" : ""} deleted.`);
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

  // Same idea as drillDownToLog above, but for the four Dashboard Overhaul widgets - those are scoped
  // by dashWindow/dashTimeframe (the pill controls), not dashPeriod, so the Log's date range is set to
  // match dashWindow's actual [from, to] instead.
  function drillDownToLogWindow(category) {
    setFilterCat(category && category !== "Uncategorized" ? category : "all");
    setDateFrom(dashWindow.from); setDateTo(dashWindow.to); setQuickMonth("");
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
    if (filterAccount !== "all") rows = rows.filter(t => t.account === filterAccount);
    if (dateFrom) rows = rows.filter(t => t.date >= dateFrom);
    if (dateTo) rows = rows.filter(t => t.date <= dateTo);
    return rows;
  }, [transactions, filterCat, filterAccount, dateFrom, dateTo]);

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

  // Gmail-style "select all matching" - the header checkbox only ever selects what's on the current
  // page (toggleSelectAllVisible above), so this is the escape hatch for a filtered result set that
  // spans more than one page: selects every id in sortedTxns (already filtered + sorted, just not
  // paginated), independent of which page happens to be showing.
  function selectAllMatchingTxns() {
    setSelectedTxnIds(new Set(sortedTxns.map(t => t.id)));
  }

  // Reset to page 1 whenever the filtered/sorted set or page size changes, so the pager never
  // silently strands the person on a now out-of-range page.
  useEffect(() => { setPage(1); }, [filterCat, filterAccount, dateFrom, dateTo, sortKey, sortDir, pageSize]);
  // Clear bulk selection when the underlying filtered set changes (not on sort/page-size, which
  // don't change what's included) - a selection built under one filter shouldn't silently carry
  // over and get applied to a different-looking result set.
  useEffect(() => { setSelectedTxnIds(new Set()); }, [filterCat, filterAccount, dateFrom, dateTo]);
  const totalPages = Math.max(1, Math.ceil(sortedTxns.length / pageSize));
  // Also clamp defensively if the set shrinks for some other reason (e.g. a backup restore) without
  // one of the deps above changing.
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages, page]);
  const pagedTxns = useMemo(() => {
    const start = (Math.min(page, totalPages) - 1) * pageSize;
    return sortedTxns.slice(start, start + pageSize);
  }, [sortedTxns, page, pageSize, totalPages]);

  // Fixed/discretionary split as a percent of the two combined, for the proportion bar in the
  // fixedVsDiscretionary widget below - 0% (an empty bar) rather than NaN when there's no spend yet.
  const dashFixedDiscTotal = dashFixedVsDiscretionary.fixed + dashFixedVsDiscretionary.discretionary;
  const dashFixedPct = dashFixedDiscTotal > 0 ? (dashFixedVsDiscretionary.fixed / dashFixedDiscTotal) * 100 : 0;

  // Dashboard section content, keyed by the same ids as DASHBOARD_SECTIONS/dashboardLayout - the
  // Dashboard tab below renders these in dashboardLayout's order, skipping any marked !visible. A
  // hidden section is never added to the DOM at all (not just visually hidden), so it's automatically
  // excluded from Print/PDF too (see PRINT_CSS) without any section-specific print styling needed.
  const dashboardSectionContent = {
    summaryCards: (
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
          <div>
            <div style={label}>High-level KPI summary</div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "4px 0 0", maxWidth: "560px" }}>
              Earned vs. spent vs. invested for the selected timeframe and account(s), computed from each transaction's category behavior (income/expense/investment/neutral) rather than raw amount sign - so a mis-signed row can't quietly skew the numbers. Lifestyle spend nets refunds against their original purchase instead of counting both as outflow.
            </p>
          </div>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{dashWindow.from} to {dashWindow.to}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px" }}>
          <div style={card}>
            <div style={label}>Total earned</div>
            <div style={{ ...statBig, color: "var(--text-success)" }}>${dashTotalEarned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <TrendBadge pct={dashEarnedTrendPct} goodDirection="up" />
          </div>
          <div style={card}>
            <div style={label}>Total lifestyle spend</div>
            <div style={statBig}>${dashTotalSpent.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>Net expenses (refunds netted out)</div>
            <TrendBadge pct={dashSpentTrendPct} goodDirection="down" />
          </div>
          <div style={card}>
            <div style={label}>Total invested</div>
            <div style={{ ...statBig, color: "var(--text-accent)" }}>${dashTotalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <TrendBadge pct={dashInvestedTrendPct} goodDirection="up" />
          </div>
          <div style={card}>
            <div style={label}>Net cash remaining</div>
            <div style={{ ...statBig, color: dashNetCashRemaining >= 0 ? "var(--text-success)" : "var(--text-danger)" }}>${dashNetCashRemaining.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>Earned − spend − invested</div>
          </div>
          <div style={card}>
            <div style={label}>Investment rate</div>
            <div style={statBig}>{dashInvestmentRatePct === null ? "n/a" : `${dashInvestmentRatePct.toFixed(1)}%`}</div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>Invested ÷ total earned</div>
          </div>
        </div>
      </div>
    ),
    trendLine: (
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "10px" }}>
          <div>
            <div style={label}>Monthly cash flow trends</div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "4px 0 0", maxWidth: "480px" }}>
              Compares money earned vs. money spent month-by-month to track your net surplus or deficit. Hover a bar for the exact income, outflow, net, and savings rate.
            </p>
          </div>
          <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
            <div style={{ textAlign: "right" }}><div style={label}>Total inflow</div><div style={{ ...statBig, fontSize: "18px", color: "var(--text-success)" }}>${dashTotalEarned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
            <div style={{ textAlign: "right" }}><div style={label}>Total outflow</div><div style={{ ...statBig, fontSize: "18px" }}>${dashTotalSpent.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
            <div style={{ textAlign: "right" }}><div style={label}>Net cash flow</div><div style={{ ...statBig, fontSize: "18px", color: dashNetSavings >= 0 ? "var(--text-success)" : "var(--text-danger)" }}>${dashNetSavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
          </div>
        </div>
        {dashMonthlyCashFlow.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>No transactions in this window.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dashMonthlyCashFlow}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip content={<CashFlowTooltip />} />
              <Legend />
              <Bar dataKey="income" name="Income" fill="#1D9E75" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" name="Outflow" fill="#D85A30" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    ),
    investments: (
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
          <div>
            <div style={label}>Investments & Wealth Accumulation</div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "4px 0 0", maxWidth: "480px" }}>
              Tracks money moved into investment accounts, wealth building, and long-term assets.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={label}>Total invested</div>
            <div style={{ ...statBig, fontSize: "18px", color: "var(--text-accent)" }}>${dashTotalInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{dashInvestmentRatePct === null ? "n/a" : `${dashInvestmentRatePct.toFixed(1)}%`} investment rate</div>
          </div>
        </div>
        {dashMonthlyInvestments.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>No investment contributions in this window.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dashMonthlyInvestments}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
              <Bar dataKey="total" name="Contributions" fill="#378ADD" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
        <div style={{ marginTop: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Top investment destinations</div>
          {dashTopInvestmentDestinations.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>None in this window.</div>}
          {dashTopInvestmentDestinations.map(m => (
            <div key={m.merchant} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", padding: "3px 0" }}><span>{m.merchant}</span><span style={num}>${m.total.toLocaleString()}</span></div>
          ))}
        </div>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <div style={label}>Category spending breakdown & ranking</div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "4px 0 0", maxWidth: "480px" }}>
              Ranks your spending by category. Shows each category's total amount and percentage of overall spend. Click a category to see its top 5 merchant contributors.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={label}>Total category spend</div>
            <div style={statBig}>${dashCategoryRankingTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>across {dashCategoryRanking.length} active categor{dashCategoryRanking.length === 1 ? "y" : "ies"}</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" }}>
          {dashCategoryRanking.length === 0 && <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>No expenses in this window.</div>}
          {dashCategoryRanking.map(c => {
            const expanded = expandedRankingCategory === c.category;
            return (
              <div key={c.category}>
                <button type="button" onClick={() => setExpandedRankingCategory(expanded ? null : c.category)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                  title="Click to see top merchants in this category">
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px", color: "var(--text-primary)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 500 }}>
                      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {c.category}
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}><b style={num}>${c.total.toLocaleString()}</b> &nbsp;{c.pct.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: "8px", borderRadius: "999px", background: "var(--surface-2)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, c.pct)}%`, height: "100%", background: "#D85A30" }} />
                  </div>
                </button>
                {expanded && (
                  <div style={{ margin: "6px 0 0 18px", padding: "10px 12px", background: "var(--surface-2)", borderRadius: "8px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Top merchants</div>
                    {dashCategoryTopMerchants(c.category).map(m => (
                      <div key={m.merchant} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", padding: "3px 0" }}>
                        <span>{m.merchant}</span><span style={num}>${m.total.toLocaleString()}</span>
                      </div>
                    ))}
                    <button type="button" style={{ ...btn, padding: "3px 10px", marginTop: "8px", fontSize: "11px" }} onClick={() => drillDownToLogWindow(c.category)}>View in Log</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    ),
    fixedVsDiscretionary: (
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
          <div>
            <div style={label}>Fixed vs. discretionary cost breakdown</div>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "4px 0 0", maxWidth: "480px" }}>
              Separates regular recurring expenses and subscriptions from variable lifestyle purchases. "Fixed" merchants are the same ones detected as recurring bills below.
            </p>
          </div>
          <div style={{ display: "flex", gap: "18px" }}>
            <div style={{ textAlign: "right" }}><div style={label}>Fixed costs</div><div style={{ ...statBig, fontSize: "18px" }}>${dashFixedVsDiscretionary.fixed.toLocaleString()}</div></div>
            <div style={{ textAlign: "right" }}><div style={label}>Discretionary</div><div style={{ ...statBig, fontSize: "18px" }}>${dashFixedVsDiscretionary.discretionary.toLocaleString()}</div></div>
          </div>
        </div>
        {dashFixedDiscTotal > 0 && (
          <div style={{ display: "flex", height: "14px", borderRadius: "999px", overflow: "hidden", marginBottom: "16px" }}>
            <div style={{ width: `${dashFixedPct}%`, background: "#378ADD" }} title={`Fixed ${dashFixedPct.toFixed(0)}%`} />
            <div style={{ width: `${100 - dashFixedPct}%`, background: "#BA7517" }} title={`Discretionary ${(100 - dashFixedPct).toFixed(0)}%`} />
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Top fixed merchants</div>
            {dashFixedVsDiscretionary.topFixed.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>None detected in this window.</div>}
            {dashFixedVsDiscretionary.topFixed.map(m => (
              <div key={m.merchant} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", padding: "3px 0" }}><span>{m.merchant}</span><span style={num}>${m.total.toLocaleString()}</span></div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "6px" }}>Top discretionary categories</div>
            {dashFixedVsDiscretionary.topDiscretionary.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>None in this window.</div>}
            {dashFixedVsDiscretionary.topDiscretionary.map(c => (
              <div key={c.category} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", padding: "3px 0" }}><span>{c.category}</span><span style={num}>${c.total.toLocaleString()}</span></div>
            ))}
          </div>
        </div>
      </div>
    ),
    recurringBills: (
      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Recurring bills detected</div>
        <div style={{ overflowX: "auto" }}>
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
      </div>
    ),
  };

  // App Lock (v6.8): while locked, the ledger data is never rendered into the DOM at all - not just
  // covered by an overlay - so nothing below this point (transactions, budget, everything else derived
  // above) reaches the page until LockOverlay's onUnlock fires. Every hook this component uses is
  // already declared above this point, so branching the returned JSX here doesn't touch the rules of
  // hooks - it's still the same unconditional call order every render, just a different tree returned.
  if (lockEnabled && locked) {
    return (
      <div className="ledger-root" data-theme={theme} style={{ fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--surface-0)", maxWidth: "100%" }}>
        <style>{THEME_CSS}</style>
        <LockOverlay pinRecord={pinRecord} webauthnCredential={webauthnCredential} onUnlock={handleUnlock} />
      </div>
    );
  }

  return (
    <div className="ledger-root" data-theme={theme} style={{ fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--surface-0)", maxWidth: "100%", padding: "4px" }}>
      <style>{THEME_CSS}</style>
      <style>{PRINT_CSS}</style>
      {/* Shared account-name autosuggest, referenced by input[list] on the Manual Transaction Form,
          the staging toolbar, and the Log tab's inline row editor - one always-mounted datalist
          rather than three tab/mode-gated copies, so none of those inputs lose suggestions just
          because the component that would've rendered their own local datalist isn't mounted right now. */}
      <datalist id="known-account-list">
        {knownAccounts.map(a => <option key={a} value={a} />)}
      </datalist>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
              <div style={label}>Add a new transaction</div>
              {/* Ingestion Mode Selector (v6.8) - a saved choice always wins; see ingestionMode's
                  useState initializer above for the mobile-viewport-width first-run default. */}
              <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: "var(--radius)", overflow: "hidden" }}>
                <button type="button" onClick={() => setIngestionMode("manual")}
                  style={{ ...btn, border: "none", borderRadius: 0, background: ingestionMode === "manual" ? "var(--text-accent)" : "var(--surface-1)", color: ingestionMode === "manual" ? "#fff" : "var(--text-primary)" }}>
                  Manual Form
                </button>
                <button type="button" onClick={() => setIngestionMode("bulk")}
                  style={{ ...btn, border: "none", borderRadius: 0, background: ingestionMode === "bulk" ? "var(--text-accent)" : "var(--surface-1)", color: ingestionMode === "bulk" ? "#fff" : "var(--text-primary)" }}>
                  Bulk Paste (CSV/TSV)
                </button>
              </div>
            </div>

            {ingestionMode === "manual" ? (
              <ManualTransactionForm categories={allCategories} lookup={lookup} addCategory={addCategory}
                onStage={stageManualTransaction} onAddDirect={addManualTransactionDirect} />
            ) : (
              <>
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
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", alignSelf: "center" }}>Columns: Date, Description, Merchant, Amount (negative = money out) - or separate Debit/Credit columns. Dates and currency-formatted amounts ($, CAD, parentheses) are read flexibly. "Select folder" grabs every CSV inside it and skips anything already in your log.</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "10px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer" }}>
                    <input type="checkbox" checked={invertSigns} onChange={e => setInvertSigns(e.target.checked)} />
                    Invert amount signs (Credit Card mode)
                  </label>
                  {ccFormatDetected && (
                    <span style={{ fontSize: "11px", color: "var(--text-accent)", background: "var(--bg-accent)", padding: "3px 8px", borderRadius: "999px" }}>
                      Credit card format detected: amounts inverted to match standard expense accounting.
                    </span>
                  )}
                </div>
                <div style={{ marginTop: "10px", maxWidth: "260px" }}>
                  <div style={label}>Account (applied to everything staged below)</div>
                  <input type="text" list="known-account-list" value={stagingAccount} onChange={e => setStagingAccount(e.target.value)}
                    placeholder="e.g. Scotiabank Visa" style={input} />
                </div>
                <div style={{ marginTop: "12px" }}>
                  <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder={"Or paste rows, one per line: 2026-09-05\\tpos purchase\\tfizz\\t-23.73"} style={{ ...input, minHeight: "70px", fontFamily: "var(--font-mono)", fontSize: "12px" }} />
                  <button style={{ ...btnPrimary, marginTop: "8px" }} onClick={handlePasteAdd}><Plus size={14} /> Add pasted rows</button>
                </div>
              </>
            )}
          </div>

          {pendingMapping && <CSVMappingPanel mapping={pendingMapping} onConfirm={confirmManualMapping} onCancel={() => setPendingMapping(null)} />}

          {skippedRows.length > 0 && (
            <div style={{ ...card, borderColor: "var(--border-warning)", padding: 0, overflow: "hidden" }}>
              <button type="button" onClick={() => setSkippedDrawerOpen(o => !o)}
                style={{ width: "100%", textAlign: "left", background: "var(--bg-warning)", border: "none", cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "13px", color: "var(--text-warning)" }}>
                  <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />
                  ⚠️ {skippedRows.length} row{skippedRows.length !== 1 ? "s" : ""} could not be parsed automatically — click to review & fix
                </span>
                {skippedDrawerOpen ? <ChevronUp size={16} color="var(--text-warning)" /> : <ChevronDown size={16} color="var(--text-warning)" />}
              </button>
              {skippedDrawerOpen && (
                <div style={{ padding: "12px 16px" }}>
                  <SkippedRowsDrawer rows={skippedRows} categories={allCategories}
                    onRecover={recoverSkippedRow} onDismissRow={dismissSkippedRow} onDismissAll={dismissAllSkippedRows} />
                </div>
              )}
            </div>
          )}

          {staging.length > 0 && (
            <div style={{ ...card, borderColor: stagingUnmatchedCount ? "var(--border-warning)" : "var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 500 }}>
                  {stagingUnmatchedCount > 0 && <AlertCircle size={15} color="var(--text-warning)" />}
                  {staging.length} new transaction{staging.length !== 1 ? "s" : ""} ready to review
                  {stagingIncludedCount !== staging.length && ` - ${stagingIncludedCount} checked to add`}
                  {stagingDuplicateCount > 0 && ` - ${stagingDuplicateCount} duplicate${stagingDuplicateCount !== 1 ? "s" : ""} flagged`}
                  {stagingUnmatchedCount > 0 && ` - ${stagingUnmatchedCount} unmatched`}
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  {stagingDuplicateCount > 0 && (
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer" }}>
                      <input type="checkbox" checked={hideDuplicates} onChange={e => setHideDuplicates(e.target.checked)} />
                      Hide duplicates
                    </label>
                  )}
                  {stagingUnmatchedCount > 0 && <button style={btn} onClick={() => navigator.clipboard?.writeText(copyStagingList())?.catch(() => alert("Couldn't copy automatically - your browser blocked clipboard access. Select the list manually instead."))}><Copy size={13} /> Copy unmatched for LLM</button>}
                  <button style={btn} onClick={discardStaging}>Discard all</button>
                  <button style={{ ...btnPrimary, opacity: stagingIncludedCount ? 1 : 0.5 }} disabled={!stagingIncludedCount} onClick={commitStaging}><Check size={14} /> Confirm & add {stagingIncludedCount}</button>
                </div>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>Every category below is auto-suggested from your merchant lookup table. Change any of them before confirming - nothing here touches your permanent log until you click Confirm. Rows flagged as possible duplicates start unchecked and are excluded from "Confirm & add"; check one back in if it's actually new.</p>
              <div style={{ overflowX: "auto", maxHeight: "420px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}></th><th style={th}>Date</th><th style={th}>Merchant</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Category</th><th style={th}></th></tr></thead>
                  <tbody>
                    {visibleStaging.length === 0 && (
                      <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>
                        All {staging.length} staged row{staging.length !== 1 ? "s are" : " is"} flagged as a duplicate and hidden - uncheck "Hide duplicates" above to review.
                      </td></tr>
                    )}
                    {visibleStaging.map(r => (
                      <tr key={r.stageId} style={r.isDuplicate ? { opacity: r.included ? 1 : 0.65 } : undefined}>
                        <td style={td}><input type="checkbox" checked={!!r.included} onChange={() => toggleStagingIncluded(r.stageId)}
                          aria-label={`Include ${r.merchant} in this import`} /></td>
                        <td style={{ ...td, ...num, color: "var(--text-secondary)" }}>{r.date}</td>
                        <td style={{ ...td, ...num }}>
                          {r.merchant}
                          {r.isDuplicate && (
                            <span style={{ display: "inline-block", marginLeft: "8px", fontSize: "10px", color: "var(--text-danger)", background: "var(--bg-danger)", border: "1px solid var(--border-danger)", padding: "2px 7px", borderRadius: "999px", whiteSpace: "nowrap" }}>
                              Duplicate (already in log)
                            </span>
                          )}
                        </td>
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
                <select value={filterAccount} onChange={e => setFilterAccount(e.target.value)} style={{ ...input, width: "180px" }}>
                  <option value="all">All accounts</option>
                  {knownAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <select value={quickMonth} onChange={e => applyQuickMonth(e.target.value)} style={{ ...input, width: "130px" }}>
                  <option value="">Month...</option>
                  {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setQuickMonth(""); }} style={{ ...input, width: "140px" }} />
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>to</span>
                <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setQuickMonth(""); }} style={{ ...input, width: "140px" }} />
                {(dateFrom || dateTo) && <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { setDateFrom(""); setDateTo(""); setQuickMonth(""); }}>Clear dates</button>}
                {transactions.length > 0 && (
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={openDuplicateScanner}>
                    <ScanSearch size={13} /> Scan Duplicates
                  </button>
                )}
                {transactions.length > 0 && (
                  <button style={{ ...btn, padding: "4px 10px", color: "var(--text-danger)", borderColor: "var(--border-danger)" }}
                    onClick={() => setShowDeleteAllModal(true)}>
                    <Trash2 size={13} /> Delete all ({transactions.length})
                  </button>
                )}
              </div>
            </div>
            {showDeleteAllModal && (
              <DeleteAllConfirmModal count={transactions.length} onConfirm={deleteAllTransactions} onCancel={() => setShowDeleteAllModal(false)} />
            )}
            {duplicateClusters && (
              <DuplicateCleanerModal clusters={duplicateClusters} onConfirm={deleteDuplicates} onCancel={() => setDuplicateClusters(null)} />
            )}
            {selectedTxnIds.size > 0 && (
              <div style={{ position: "sticky", top: 0, zIndex: 5, ...card, background: "var(--bg-accent)", borderColor: "var(--text-accent)", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
                <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-accent)" }}>{selectedTxnIds.size} selected</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)} style={{ ...input, width: "210px" }}>
                    <option value="">Choose category...</option>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button style={{ ...btnPrimary, opacity: bulkCategory ? 1 : 0.5 }} disabled={!bulkCategory} onClick={applyBulkCategory}><Check size={14} /> Apply to {selectedTxnIds.size}</button>
                  <button style={{ ...btn, padding: "6px 12px" }} onClick={invertSelectedSigns}>Invert Sign (+/-)</button>
                  <button style={{ ...btn, padding: "6px 12px", color: "var(--text-danger)", borderColor: "var(--border-danger)" }} onClick={deleteSelectedTxns}><Trash2 size={13} /> Delete {selectedTxnIds.size}</button>
                  <button style={{ ...btn, padding: "6px 12px" }} onClick={deselectAllTxns}><X size={13} /> Deselect all</button>
                </div>
              </div>
            )}
            {/* Gmail-style multi-page selection banner: the header checkbox below only ever reaches
                the current page (toggleSelectAllVisible), so once every row on this page is checked
                and more matching rows exist on other pages, offer the one-click escalation to every
                id in sortedTxns. Swaps to a confirmation once that escalation has been taken, so the
                banner never claims there's more to select when there isn't. */}
            {pagedTxns.length > 0 && pagedTxns.every(t => selectedTxnIds.has(t.id)) && sortedTxns.length > pagedTxns.length && (
              sortedTxns.every(t => selectedTxnIds.has(t.id)) ? (
                <div style={{ ...card, background: "var(--bg-accent)", borderColor: "var(--text-accent)", padding: "8px 16px", marginBottom: "10px", fontSize: "13px", color: "var(--text-accent)", textAlign: "center" }}>
                  All {sortedTxns.length} matching transactions are selected.{" "}
                  <button type="button" onClick={deselectAllTxns} style={{ background: "none", border: "none", color: "var(--text-accent)", fontWeight: 600, textDecoration: "underline", cursor: "pointer", padding: 0, font: "inherit" }}>Clear selection</button>
                </div>
              ) : (
                <div style={{ ...card, background: "var(--bg-accent)", borderColor: "var(--text-accent)", padding: "8px 16px", marginBottom: "10px", fontSize: "13px", color: "var(--text-accent)", textAlign: "center" }}>
                  All {pagedTxns.length} transactions on this page are selected.{" "}
                  <button type="button" onClick={selectAllMatchingTxns} style={{ background: "none", border: "none", color: "var(--text-accent)", fontWeight: 600, textDecoration: "underline", cursor: "pointer", padding: 0, font: "inherit" }}>Select all {sortedTxns.length} matching transactions</button>
                </div>
              )
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: "36px" }}>
                      <input type="checkbox" title="Select all on this page"
                        checked={pagedTxns.length > 0 && pagedTxns.every(t => selectedTxnIds.has(t.id))}
                        onChange={() => toggleSelectAllVisible(pagedTxns)} />
                    </th>
                    <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("date")}>Date{sortIndicator("date")}</th>
                    <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("merchant")}>Merchant{sortIndicator("merchant")}</th>
                    <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleHeaderSort("amount")}>Amount{sortIndicator("amount")}</th>
                    <th style={th}>Category</th>
                    <th style={th}>Account</th>
                    <th style={{ ...th, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedTxns.map(t => {
                    if (splittingTxnId === t.id) {
                      return (
                        <tr key={t.id}>
                          <td style={{ ...td, ...card, border: "1px solid var(--border)" }} colSpan={7}>
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
                          <td style={td}>
                            <input type="text" list="known-account-list" value={editDraft.account} onChange={e => setEditDraft(d => ({ ...d, account: e.target.value }))} style={input} />
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
                        <td style={td}><AccountBadge account={t.account} /></td>
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
                    <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>No transactions match these filters.</td></tr>
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
            <div style={label}>Timeframe</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px", marginBottom: "14px" }}>
              {DASH_TIMEFRAMES.map(tf => (
                <button key={tf.id} type="button" onClick={() => setDashTimeframe(tf.id)}
                  style={{ ...btn, padding: "6px 14px", borderRadius: "999px",
                    background: dashTimeframe === tf.id ? "var(--text-accent)" : "var(--surface-1)",
                    color: dashTimeframe === tf.id ? "#fff" : "var(--text-primary)",
                    border: dashTimeframe === tf.id ? "1px solid var(--text-accent)" : "1px solid var(--border-strong)" }}>
                  {tf.label}
                </button>
              ))}
            </div>
            <div style={label}>Account</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
              {[{ id: "all", label: "All Accounts" }, { id: "credit", label: "Credit Cards" }, { id: "chequing", label: "Chequing/Debit" },
                ...knownAccounts.map(a => ({ id: a, label: a }))].map(opt => (
                <button key={opt.id} type="button" onClick={() => setDashAccountFilter(opt.id)}
                  style={{ ...btn, padding: "6px 14px", borderRadius: "999px",
                    background: dashAccountFilter === opt.id ? "var(--text-accent)" : "var(--surface-1)",
                    color: dashAccountFilter === opt.id ? "#fff" : "var(--text-primary)",
                    border: dashAccountFilter === opt.id ? "1px solid var(--text-accent)" : "1px solid var(--border-strong)" }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "12px 0 0" }}>
              Drives the KPI summary, monthly cash flow trend, category ranking, and fixed vs. discretionary breakdown below - showing {dashWindow.from} to {dashWindow.to}.
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
              Spend share and income by source reflect this Period/Categories filter; cumulative net position and recurring bills always show full history. (KPI summary, cash flow trend, category ranking, and fixed vs. discretionary use the Timeframe/Account pills above instead.) "Customize layout" controls which sections show (and in what order) both here and in Print/PDF; "Export summary" downloads a CSV of the category breakdown and monthly totals, or opens Print/Save PDF for a clean-margined summary page of your currently visible sections.
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
                <div key={s.id} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <input value={s.label} onChange={e => updateIncomeStream(s.id, "label", e.target.value)} style={{ ...input, flex: 1, minWidth: "140px" }} />
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
                <div key={c.id} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <input value={c.label} onChange={e => updateCommittedCost(c.id, "label", e.target.value)} style={{ ...input, flex: 1, minWidth: "140px" }} />
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
                <div key={i.id} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
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

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
              <div style={label}>Goal runway & projections</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Chart pace</span>
                <select value={runwayRateBasis} onChange={e => setRunwayRateBasis(e.target.value)} style={{ ...input, width: "170px" }}>
                  <option value="3">3-month average</option>
                  <option value="6">6-month average</option>
                </select>
              </div>
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
              Historical net monthly surplus (total income minus total spend, from logged transactions) projected forward from your current net position toward each target scenario above.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px", marginBottom: "16px" }}>
              <div>
                <div style={label}>3-month avg surplus</div>
                <div style={{ ...statSmall, color: avgSurplus3mo >= 0 ? "var(--text-success)" : "var(--text-danger)" }}>${avgSurplus3mo.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo</div>
              </div>
              <div>
                <div style={label}>6-month avg surplus</div>
                <div style={{ ...statSmall, color: avgSurplus6mo >= 0 ? "var(--text-success)" : "var(--text-danger)" }}>${avgSurplus6mo.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo</div>
              </div>
              <div>
                <div style={label}>Current net position</div>
                <div style={statSmall}>${netPos.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              </div>
            </div>

            {surplusHistory.length === 0 ? (
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>No transaction history yet - log some income and spend to unlock runway projections.</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={runwayChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v) => `$${v.toLocaleString()}`} />
                    <Area type="monotone" dataKey="netWorth" name="Projected net worth" stroke="#378ADD" fill="#378ADD" fillOpacity={0.15} strokeWidth={2} />
                    {budget.targetScenarios.map((t, i) => (
                      <ReferenceLine key={t.id} y={t.amount} stroke={PIE_COLORS[i % PIE_COLORS.length]} strokeDasharray="4 4"
                        label={{ value: t.label, position: "insideTopRight", fontSize: 11, fill: PIE_COLORS[i % PIE_COLORS.length] }} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>

                <div style={{ overflowX: "auto", marginTop: "16px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th}>Target</th>
                        <th style={{ ...th, textAlign: "right" }}>Amount</th>
                        <th style={{ ...th, textAlign: "right" }}>Gap</th>
                        <th style={th}>Milestone (3-mo pace)</th>
                        <th style={th}>Milestone (6-mo pace)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runwayProjections.map(t => (
                        <tr key={t.id}>
                          <td style={td}>{t.label}</td>
                          <td style={{ ...td, textAlign: "right", ...num }}>${t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td style={{ ...td, textAlign: "right", ...num }}>${Math.max(0, t.gap).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td style={{ ...td, color: milestoneColor(t.milestone3) }}>{formatMilestone(t.milestone3)}</td>
                          <td style={{ ...td, color: milestoneColor(t.milestone6) }}>{formatMilestone(t.milestone6)}</td>
                        </tr>
                      ))}
                      {runwayProjections.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>No target scenarios yet - add one above to see a projected milestone date.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "settings" && <SettingsTab
        spendingCategories={spendingCategories} addCategory={addCategory} renameCategory={renameCategory} removeCategory={removeCategory}
        categoryBehaviors={categoryBehaviors} setCategoryBehavior={setCategoryBehavior}
        lookup={lookup} allCategories={allCategories} addLookupRule={addLookupRule} updateLookupRuleCategory={updateLookupRuleCategory} removeLookupRule={removeLookupRule}
        recurringConfig={recurringConfig} updateRecurringConfig={updateRecurringConfig} resetRecurringConfig={resetRecurringConfig}
        lockEnabled={lockEnabled} onToggleLockEnabled={handleToggleLockEnabled}
        hasPin={!!pinRecord} onSetPin={handleSetPin} onRemovePin={handleRemovePin}
        hasBiometrics={!!webauthnCredential} onEnableBiometrics={handleEnableBiometrics} onRemoveBiometrics={handleRemoveBiometrics}
        cloudProvider={cloudProvider} setCloudProvider={setCloudProvider}
        cloudClientId={cloudClientId} setCloudClientId={setCloudClientId}
        dropboxAppKey={dropboxAppKey} setDropboxAppKey={setDropboxAppKey}
        cloudPassphrase={cloudPassphrase} setCloudPassphrase={setCloudPassphrase}
        googleConnected={!!cloudAccessToken} dropboxConnected={!!dropboxRefreshToken}
        cloudStatus={cloudStatus} cloudStatusMessage={cloudStatusMessage}
        cloudLastSynced={cloudLastSynced} dropboxLastSynced={dropboxLastSynced}
        onConnectGoogle={connectGoogle} onDisconnectGoogle={disconnectGoogle}
        onConnectDropbox={connectDropbox} onDisconnectDropbox={disconnectDropbox}
        onSyncNowToCloud={syncNowToCloud} onPullFromCloud={pullFromCloud}
      />}
      {toastMessage && (
        <div className="ledger-no-print" style={{ position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: 10000, background: "var(--text-primary)", color: "var(--surface-1)", fontSize: "13px", fontWeight: 500, padding: "10px 18px", borderRadius: "var(--radius)", boxShadow: "0 6px 20px rgba(0,0,0,0.25)" }}>
          {toastMessage}
        </div>
      )}
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
  // Mirrors categorize()'s own dual raw-then-normalized-text test (v6.9.1) so this preview stays
  // exactly what the rule would do once saved, not a narrower approximation of it.
  const match = regex ? (regex.exec(sample) || regex.exec(normalize(sample))) : null;

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

// "Clear Cache & Hard Reset" (Settings > Storage & Cache Management). Unregisters every service
// worker this origin has registered and empties everything in the Cache Storage API - the two places
// a stale PWA build can hide behind - then forces a reload so the browser has to fetch fresh files.
// `location.reload(true)`'s boolean argument is a long-deprecated, now-ignored hint in every current
// browser; the unregister+cache-clear above is what actually does the work here, the reload just
// picks up whatever's left once that's done. Deliberately doesn't touch localStorage/STORAGE_KEY -
// this is a "get the latest code" tool, not a "wipe my data" one (see deleteAllTransactions above /
// "Delete all" in the Log tab, or Load backup, for that).
async function clearCacheAndHardReset() {
  const ok = confirm("This will unregister service workers, clear cached application files, and reload the latest version from GitHub Pages. (Your local data will be preserved unless you choose to wipe it separately.)");
  if (!ok) return;
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (err) {
    console.warn("Ledger: couldn't fully clear the service worker/cache state before reloading - reloading anyway.", err);
  }
  window.location.reload(true);
}

function SettingsTab({
  spendingCategories, addCategory, renameCategory, removeCategory, categoryBehaviors, setCategoryBehavior, lookup, allCategories, addLookupRule, updateLookupRuleCategory, removeLookupRule,
  recurringConfig, updateRecurringConfig, resetRecurringConfig,
  lockEnabled, onToggleLockEnabled, hasPin, onSetPin, onRemovePin, hasBiometrics, onEnableBiometrics, onRemoveBiometrics,
  cloudProvider, setCloudProvider, cloudClientId, setCloudClientId, dropboxAppKey, setDropboxAppKey,
  cloudPassphrase, setCloudPassphrase, googleConnected, dropboxConnected, cloudStatus, cloudStatusMessage, cloudLastSynced, dropboxLastSynced,
  onConnectGoogle, onDisconnectGoogle, onConnectDropbox, onDisconnectDropbox, onSyncNowToCloud, onPullFromCloud,
}) {
  const [newCat, setNewCat] = useState("");
  const [newCatBehavior, setNewCatBehavior] = useState("expense");
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
      <LockSettingsPanel
        lockEnabled={lockEnabled} onToggleLockEnabled={onToggleLockEnabled}
        hasPin={hasPin} onSetPin={onSetPin} onRemovePin={onRemovePin}
        hasBiometrics={hasBiometrics} onEnableBiometrics={onEnableBiometrics} onRemoveBiometrics={onRemoveBiometrics}
      />

      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Manage categories</div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>These are the spending categories offered in every dropdown. System categories (Income, Transfers, Review) aren't shown here since removing them would break the math elsewhere. Behavior controls how the Dashboard's totals treat each category - Expense counts toward lifestyle spend (net of refunds), Income counts toward earnings, Investment counts toward the dedicated Investments & Wealth Accumulation tracking instead of ordinary spend, and Neutral (Excluded) counts toward none of them (for internal transfers, refunds you don't want to double count, etc.).</p>
        <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
          <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" style={{ ...input, flex: 1, minWidth: "160px" }}
            onKeyDown={e => { if (e.key === "Enter" && addCategory(newCat, newCatBehavior)) setNewCat(""); }} />
          <select value={newCatBehavior} onChange={e => setNewCatBehavior(e.target.value)} style={{ ...input, width: "170px" }}>
            {BEHAVIOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button style={btnPrimary} onClick={() => { if (addCategory(newCat, newCatBehavior)) setNewCat(""); }}><Plus size={14} /> Add</button>
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
                  <select value={categoryBehaviors[c] ?? defaultCategoryBehavior(c)} onChange={e => setCategoryBehavior(c, e.target.value)} style={{ ...input, width: "170px" }}>
                    {BEHAVIOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
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
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>Every merchant string the categorizer recognizes. Longer, more specific keys are always checked first automatically - you don't need to manage priority order. A key wrapped in slashes with optional flags (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>/^uber\s*eats/i</code>) is matched as a regular expression instead of plain text. Your rules always take priority - when nothing here matches, Ledger falls back to a built-in dataset of 800+ common North American merchants (groceries, dining, transit, subscriptions, telecom, utilities, hardware, apparel, benefits, payroll, and bank transfers) before giving up and leaving a transaction uncategorized.</p>
        <RegexRuleTester />
        <input value={ruleSearch} onChange={e => setRuleSearch(e.target.value)} placeholder="Search rules..." style={{ ...input, marginBottom: "10px" }} />
        <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
          <input value={newRuleKey} onChange={e => setNewRuleKey(e.target.value)} placeholder="Merchant text (e.g. costco) or /regex/flags" style={{ ...input, flex: 1, minWidth: "180px" }} />
          <select value={newRuleCat} onChange={e => setNewRuleCat(e.target.value)} style={{ ...input, width: "200px" }}>
            <option value="">Category...</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button style={btnPrimary} onClick={() => { if (addLookupRule(newRuleKey, newRuleCat)) { setNewRuleKey(""); setNewRuleCat(""); } }}><Plus size={14} /> Add</button>
        </div>
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "420px" }}>
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

      <CloudSyncPanel
        cloudProvider={cloudProvider} setCloudProvider={setCloudProvider}
        cloudClientId={cloudClientId} setCloudClientId={setCloudClientId}
        dropboxAppKey={dropboxAppKey} setDropboxAppKey={setDropboxAppKey}
        cloudPassphrase={cloudPassphrase} setCloudPassphrase={setCloudPassphrase}
        googleConnected={googleConnected} dropboxConnected={dropboxConnected}
        cloudStatus={cloudStatus} cloudStatusMessage={cloudStatusMessage}
        cloudLastSynced={cloudLastSynced} dropboxLastSynced={dropboxLastSynced}
        onConnectGoogle={onConnectGoogle} onDisconnectGoogle={onDisconnectGoogle}
        onConnectDropbox={onConnectDropbox} onDisconnectDropbox={onDisconnectDropbox}
        onSyncNow={onSyncNowToCloud} onPullFromCloud={onPullFromCloud}
      />

      <div style={card}>
        <div style={{ ...label, marginBottom: "10px" }}>Storage & Cache Management</div>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
          If the app looks stuck on an old version - a stale PWA install, a service worker still
          serving cached files - unregister it and pull the latest build. This does not touch your
          saved transactions, categories, or merchant rules; use "Delete all" on the Log tab or Load
          backup for that.
        </p>
        <button style={btn} onClick={clearCacheAndHardReset}>Clear Cache & Hard Reset</button>
      </div>
    </div>
  );
}

// Settings > App security & lock (Phase 5 Item 2, v6.8). Purely a controlled view, same pattern as
// CloudSyncPanel below - every field is a prop owned by Ledger(), so this component holds no secret of
// its own beyond the in-progress "new PIN" text fields and whether a platform authenticator is actually
// available on this device (checked once on mount, since offering "Enable biometrics" on a device with
// no Face/Fingerprint/Windows Hello sensor would just fail).
function LockSettingsPanel({ lockEnabled, onToggleLockEnabled, hasPin, onSetPin, onRemovePin, hasBiometrics, onEnableBiometrics, onRemoveBiometrics }) {
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    platformAuthenticatorAvailable().then(ok => { if (!cancelled) setBiometricsAvailable(ok); });
    return () => { cancelled = true; };
  }, []);

  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinError, setPinError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSavePin() {
    setPinError("");
    if (!/^\d{4,6}$/.test(pin1)) { setPinError("PIN must be 4-6 digits."); return; }
    if (pin1 !== pin2) { setPinError("PINs don't match."); return; }
    setBusy(true);
    try {
      await onSetPin(pin1);
      setPin1(""); setPin2("");
    } finally {
      setBusy(false);
    }
  }
  async function handleEnableBiometrics() {
    setBusy(true);
    try { await onEnableBiometrics(); } finally { setBusy(false); }
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
        <div style={label}>App security & lock</div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", minHeight: "44px" }}>
          <input type="checkbox" checked={lockEnabled} onChange={e => onToggleLockEnabled(e.target.checked)} style={{ width: "20px", height: "20px" }} />
          Enable App Lock
        </label>
      </div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
        When on, a full-screen lock covers your ledger every time this tab or installed app is opened or
        resumed, until you unlock it with your PIN or biometrics. This is a local, on-device lock only -
        it can't protect a JSON backup file or a cloud sync copy, and it isn't a server-verified
        credential the way logging into a website would be, since this app has no server at all (see the
        biometric option below).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            Backup PIN {hasPin && <Check size={13} color="var(--text-success)" />}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 8px" }}>
            {hasPin ? "A PIN is set. Enter a new one below to replace it." : "Set a 4-6 digit PIN - this is required before App Lock can be turned on, as the one fallback that can never stop working on you."}
          </p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
            <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={pin1} onChange={e => setPin1(e.target.value.replace(/\D/g, ""))} placeholder="New PIN" style={{ ...input, width: "120px" }} />
            <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ""))} placeholder="Confirm PIN" style={{ ...input, width: "120px" }} />
          </div>
          {pinError && <div style={{ fontSize: "12px", color: "var(--text-danger)", marginBottom: "6px" }}>{pinError}</div>}
          <div style={{ display: "flex", gap: "8px" }}>
            <button style={btnPrimary} disabled={busy} onClick={handleSavePin}><KeyRound size={14} /> Save PIN</button>
            {hasPin && <button style={btn} onClick={onRemovePin}><Trash2 size={14} /> Remove PIN</button>}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            Biometrics {hasBiometrics && <Check size={13} color="var(--text-success)" />}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 8px" }}>
            {biometricsAvailable
              ? "Uses this device's own Face/Fingerprint/Windows Hello unlock (a WebAuthn platform authenticator). Your PIN above still works as a fallback."
              : "This browser/device doesn't offer a platform biometric authenticator right now - the PIN is your only unlock method here."}
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            {!hasBiometrics ? (
              <button style={btn} disabled={busy || !biometricsAvailable} onClick={handleEnableBiometrics}><Fingerprint size={14} /> Enable biometrics</button>
            ) : (
              <button style={btn} onClick={onRemoveBiometrics}><Trash2 size={14} /> Remove biometrics</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Settings > Cloud sync: the dual-provider (Google Drive v6.5 / Dropbox v6.6) panel. Purely a
// controlled view over state owned by Ledger() - every field here is a prop, so this component holds
// no secrets of its own beyond the local "which provider tab is showing" and "show/hide passphrase"
// UI state, and unmounting it (switching tabs) can never lose in-progress state the way an
// uncontrolled input would. Sync Now / Pull from Cloud are one shared pair of buttons - Ledger()'s
// syncNowToCloud/pullFromCloud already branch on cloudProvider internally, so this panel only needs to
// pick which provider's config/connect fields to show, not which action to wire up.
function CloudSyncPanel({
  cloudProvider, setCloudProvider, cloudClientId, setCloudClientId, dropboxAppKey, setDropboxAppKey,
  cloudPassphrase, setCloudPassphrase, googleConnected, dropboxConnected,
  cloudStatus, cloudStatusMessage, cloudLastSynced, dropboxLastSynced,
  onConnectGoogle, onDisconnectGoogle, onConnectDropbox, onDisconnectDropbox, onSyncNow, onPullFromCloud,
}) {
  const [showPassphrase, setShowPassphrase] = useState(false);
  const busy = cloudStatus === "encrypting" || cloudStatus === "syncing";
  const statusColor = cloudStatus === "error" ? "var(--text-danger)" : cloudStatus === "success" ? "var(--text-success)" : cloudStatus === "idle" ? "var(--text-secondary)" : "var(--text-accent)";
  const statusLabel = { idle: "Idle", encrypting: "Encrypting", syncing: "Syncing", error: "Error", success: "Success" }[cloudStatus] || cloudStatus;

  const isDropbox = cloudProvider === "dropbox";
  const connected = isDropbox ? dropboxConnected : googleConnected;
  const lastSynced = isDropbox ? dropboxLastSynced : cloudLastSynced;
  const providerConfigReady = (isDropbox ? dropboxAppKey : cloudClientId).trim().length > 0;
  const onConnect = isDropbox ? onConnectDropbox : onConnectGoogle;
  const onDisconnect = isDropbox ? onDisconnectDropbox : onDisconnectGoogle;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
        <div style={label}>Cloud sync</div>
        <span style={{ fontSize: "12px", fontWeight: 600, color: statusColor, display: "flex", alignItems: "center", gap: "5px" }}>
          {busy && <Loader2 size={13} className="ledger-spin" />}
          {statusLabel}
        </span>
      </div>
      <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 12px" }}>
        Optional. Backs your ledger up to your own Google Drive or Dropbox app storage - invisible in
        your normal Drive/Dropbox, and never readable by this app or the provider as plaintext. Your
        data is encrypted with your passphrase in this browser before it's ever uploaded (AES-GCM, key
        derived via PBKDF2) - the same encryption either way, so switching providers doesn't change
        what's protecting your data, only where the encrypted file goes. There's still no backend
        server here: every request below goes straight from this browser to the selected provider's
        own APIs. There is no password recovery - if you lose the passphrase, a cloud backup on either
        provider can't be decrypted, by anyone.
      </p>

      <div className="ledger-tabs" style={{ display: "flex", gap: "4px", marginBottom: "12px", borderBottom: "1px solid var(--border)" }}>
        {[{ id: "google", label: "Google Drive" }, { id: "dropbox", label: "Dropbox" }].map(p => (
          <button key={p.id} type="button" onClick={() => setCloudProvider(p.id)}
            style={{ padding: "7px 14px", background: "none", border: "none", borderBottom: cloudProvider === p.id ? "2px solid var(--text-accent)" : "2px solid transparent", color: cloudProvider === p.id ? "var(--text-primary)" : "var(--text-secondary)", fontSize: "13px", fontWeight: cloudProvider === p.id ? 600 : 500 }}>
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gap: "10px", marginBottom: "12px" }}>
        {isDropbox ? (
          <div>
            <div style={label}>Dropbox App Key</div>
            <input value={dropboxAppKey} onChange={e => setDropboxAppKey(e.target.value)} placeholder="Dropbox App Key" style={{ ...input, fontFamily: "var(--font-mono)" }} disabled={connected} />
            <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "4px 0 0" }}>From your own app in the Dropbox App Console, created with "App folder" access. Saved only to this browser - never hardcoded or bundled with the app. Connecting redirects this whole page to Dropbox and back - save any staged (not-yet-confirmed) import rows first.</p>
          </div>
        ) : (
          <div>
            <div style={label}>Google Client ID</div>
            <input value={cloudClientId} onChange={e => setCloudClientId(e.target.value)} placeholder="xxxxxxxxxxxx.apps.googleusercontent.com" style={{ ...input, fontFamily: "var(--font-mono)" }} disabled={connected} />
            <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "4px 0 0" }}>From an OAuth client (type "Web application") in your own Google Cloud project. Saved only to this browser - never hardcoded or bundled with the app.</p>
          </div>
        )}
        <div>
          <div style={label}>Encryption passphrase</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <input type={showPassphrase ? "text" : "password"} value={cloudPassphrase} onChange={e => setCloudPassphrase(e.target.value)} placeholder="Never saved - re-enter each session" style={{ ...input, flex: 1 }} autoComplete="off" />
            <button type="button" style={{ ...btn, padding: "8px 10px" }} onClick={() => setShowPassphrase(s => !s)}>{showPassphrase ? "Hide" : "Show"}</button>
          </div>
          <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "4px 0 0" }}>Shared across both providers - it's only ever used locally to derive an encryption key, never sent to either one.</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
        {!connected ? (
          <button type="button" style={{ ...btnPrimary, opacity: providerConfigReady && !busy ? 1 : 0.5 }} disabled={!providerConfigReady || busy} onClick={onConnect}>
            <Cloud size={14} /> Connect {isDropbox ? "Dropbox" : "Google"} account
          </button>
        ) : (
          <>
            <button type="button" style={{ ...btnPrimary, opacity: !busy && cloudPassphrase ? 1 : 0.5 }} disabled={busy || !cloudPassphrase} onClick={onSyncNow}>
              <UploadCloud size={14} /> Sync now (upload)
            </button>
            <button type="button" style={{ ...btn, opacity: !busy && cloudPassphrase ? 1 : 0.5 }} disabled={busy || !cloudPassphrase} onClick={onPullFromCloud}>
              <DownloadCloud size={14} /> Pull from cloud (restore)
            </button>
            <button type="button" style={btn} disabled={busy} onClick={onDisconnect}><LogOut size={14} /> Disconnect</button>
          </>
        )}
      </div>

      {cloudStatusMessage && (
        <div style={{ fontSize: "12px", color: statusColor, marginBottom: "8px" }}>
          {cloudStatus === "error" && <AlertCircle size={13} style={{ verticalAlign: "-2px", marginRight: "4px" }} />}
          {cloudStatusMessage}
        </div>
      )}
      <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>Last synced ({isDropbox ? "Dropbox" : "Google Drive"}): {lastSynced ? new Date(lastSynced).toLocaleString() : "Never"}</div>
    </div>
  );
}
