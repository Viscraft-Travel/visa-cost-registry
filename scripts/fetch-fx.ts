import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * The ONLY auto-commit in the repo. Pulls today's rate for each currency
 * against INR, compares it to the last committed data/fx.yaml, and refuses
 * to commit (opening a GitHub issue instead) if any currency moved more
 * than MOVE_THRESHOLD_PCT since yesterday. A fee's own collected_amount or
 * amount is never touched here or anywhere else automated -- this script
 * only ever writes data/fx.yaml.
 */

const CURRENCIES = ["EUR", "GBP", "USD", "CAD", "AUD", "NZD", "CNY", "JPY"] as const;
type Currency = (typeof CURRENCIES)[number];

const MOVE_THRESHOLD_PCT = 5;
const FX_PATH = path.resolve(process.cwd(), "data/fx.yaml");
// Frankfurter: free, keyless, ECB-sourced daily reference rates. Verified
// live (2026-09-20) at https://api.frankfurter.dev/v1/latest -- includes INR.
const API_URL = "https://api.frankfurter.dev/v1/latest";

export interface FxData {
  base: "INR";
  fetched_at: string;
  as_of: string;
  source: string;
  rates: Record<Currency, number>;
}

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

export async function fetchLiveRates(): Promise<{ asOf: string; rates: Record<Currency, number> }> {
  const url = `${API_URL}?base=INR&symbols=${CURRENCIES.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FX fetch failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as FrankfurterResponse;

  // The API gives "1 INR = X foreign" -- invert to "1 foreign unit = X INR",
  // which is the convention data/fx.yaml and resolve.ts's fx_derived case use.
  const rates = {} as Record<Currency, number>;
  for (const ccy of CURRENCIES) {
    const perInr = data.rates[ccy];
    if (!perInr) throw new Error(`FX response missing a rate for ${ccy}`);
    rates[ccy] = Math.round((1 / perInr) * 10000) / 10000;
  }
  return { asOf: data.date, rates };
}

export function loadPreviousFx(): FxData | null {
  if (!fs.existsSync(FX_PATH)) return null;
  return yaml.load(fs.readFileSync(FX_PATH, "utf8")) as FxData;
}

export function pctChange(oldVal: number, newVal: number): number {
  return (Math.abs(newVal - oldVal) / oldVal) * 100;
}

export interface RateMove {
  currency: Currency;
  old: number;
  new: number;
  pct: number;
}

export function findExcessiveMoves(previous: FxData | null, next: Record<Currency, number>): RateMove[] {
  if (!previous) return []; // nothing to compare against on the very first run
  return CURRENCIES.map((currency) => ({
    currency,
    old: previous.rates[currency],
    new: next[currency],
    pct: pctChange(previous.rates[currency], next[currency]),
  })).filter((m) => m.pct > MOVE_THRESHOLD_PCT);
}

async function openAlertIssue(moves: RateMove[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const title = `[FX ALERT] ${moves.map((m) => m.currency).join(", ")} moved more than ${MOVE_THRESHOLD_PCT}% -- fx.yaml NOT updated`;
  const body = [
    `The daily FX fetch found a move of more than ${MOVE_THRESHOLD_PCT}% since the last committed rate.`,
    "`data/fx.yaml` was left unchanged pending a human look -- this run did not commit anything.",
    "",
    "| Currency | Old (INR) | New (INR) | Change |",
    "|---|---|---|---|",
    ...moves.map((m) => `| ${m.currency} | ${m.old} | ${m.new} | ${m.pct.toFixed(2)}% |`),
    "",
    `Source: ${API_URL}`,
  ].join("\n");

  if (!token || !repo) {
    console.error("GITHUB_TOKEN/GITHUB_REPOSITORY not set -- printing the alert instead of opening an issue:\n");
    console.error(title);
    console.error(body);
    return;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["fx-alert"] }),
  });
  if (!res.ok) {
    console.error(`Failed to open GitHub issue: ${res.status} ${await res.text()}`);
  }
}

export function writeFx(fx: FxData): void {
  fs.writeFileSync(FX_PATH, yaml.dump(fx, { sortKeys: false }));
}

async function main() {
  const { asOf, rates } = await fetchLiveRates();
  const previous = loadPreviousFx();
  const moves = findExcessiveMoves(previous, rates);

  if (moves.length > 0) {
    console.error(`FX move(s) exceeding ${MOVE_THRESHOLD_PCT}% detected -- NOT writing data/fx.yaml.`);
    for (const m of moves) {
      console.error(`  ${m.currency}: ${m.old} -> ${m.new} INR (${m.pct.toFixed(2)}%)`);
    }
    await openAlertIssue(moves);
    process.exitCode = 1;
    return;
  }

  writeFx({
    base: "INR",
    fetched_at: new Date().toISOString(),
    as_of: asOf,
    source: API_URL,
    rates,
  });
  console.log(`data/fx.yaml written (as_of ${asOf}).`);
}

// Only run when executed directly (`tsx scripts/fetch-fx.ts`) -- importing
// this module's functions elsewhere must never trigger a live network call.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
