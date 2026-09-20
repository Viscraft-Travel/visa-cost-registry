import {
  listDestinationFiles,
  loadYaml,
  loadRuleset,
  loadSources,
  resolveDestination,
  daysSince,
  STALENESS_DAYS,
  type Destination,
  type ResolvedDestination,
  type Source,
} from "./resolve.js";
import { buildChecklist } from "./bootstrap-issues.js";
import { upsertIssue } from "./github-issues.js";

/** last_reviewed older than this on a destination file gets flagged. */
const REVIEW_STALENESS_DAYS = 90;
/** A human_only source not checked within this window is overdue. */
const MANUAL_CHECK_DAYS = 60;

export interface StaleFee {
  iso_code: string;
  corridor: string | null;
  owner: string;
  fee_id: string;
  field: "verified_on" | "collected_amount_verified_on";
  days: number;
}

/** Fees whose verified_on or collected_amount_verified_on is set but older than STALENESS_DAYS. A null timestamp means "not yet verified", not stale -- never flagged here. */
export function staleFeesFor(resolved: ResolvedDestination, now: Date): StaleFee[] {
  const flags: StaleFee[] = [];
  for (const fee of resolved.fees) {
    const verifiedAge = daysSince(fee.verified_on, now);
    if (verifiedAge !== null && verifiedAge > STALENESS_DAYS) {
      flags.push({
        iso_code: resolved.identity.iso_code,
        corridor: resolved.identity.corridor,
        owner: resolved.identity.owner,
        fee_id: fee.id,
        field: "verified_on",
        days: verifiedAge,
      });
    }
    const collectedAge = daysSince(fee.collected_amount_verified_on, now);
    if (collectedAge !== null && collectedAge > STALENESS_DAYS) {
      flags.push({
        iso_code: resolved.identity.iso_code,
        corridor: resolved.identity.corridor,
        owner: resolved.identity.owner,
        fee_id: fee.id,
        field: "collected_amount_verified_on",
        days: collectedAge,
      });
    }
  }
  return flags;
}

/** True when last_reviewed is set but older than REVIEW_STALENESS_DAYS. Never true for a destination that's never been reviewed at all (null) -- that's "not yet done", not "overdue". */
export function isDestinationOverdueForReview(resolved: ResolvedDestination, now: Date): boolean {
  const age = daysSince(resolved.meta.last_reviewed, now);
  return age !== null && age > REVIEW_STALENESS_DAYS;
}

/** A human_only source counts as overdue whether it's never been checked (null) or was checked too long ago -- unlike verified_on staleness, there's no automated check to fall back on here, so "never checked" is itself the thing to chase. */
export function isSourceOverdueForManualCheck(source: Source, now: Date): boolean {
  if (source.check_method !== "human_only") return false;
  const age = daysSince(source.last_checked, now);
  return age === null || age > MANUAL_CHECK_DAYS;
}

function nullFieldCount(resolved: ResolvedDestination): number {
  const checklist = buildChecklist(resolved);
  return checklist === "Nothing outstanding -- fully verified." ? 0 : checklist.split("\n").length;
}

interface DestinationSummary {
  iso_code: string;
  name: string;
  corridor: string | null;
  owner: string;
  staleFees: StaleFee[];
  overdueForReview: boolean;
  nullFields: number;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

function renderGroup(label: string, summaries: DestinationSummary[]): string {
  const lines = [`### ${label}`, ""];
  for (const s of summaries) {
    const notes: string[] = [];
    if (s.staleFees.length > 0) {
      notes.push(...s.staleFees.map((f) => `${f.fee_id}.${f.field} stale (${f.days}d)`));
    }
    if (s.overdueForReview) notes.push("last_reviewed overdue (>90d)");
    if (s.nullFields > 0) notes.push(`${s.nullFields} field(s) still null`);
    if (notes.length > 0) lines.push(`- **${s.iso_code}**: ${notes.join("; ")}`);
  }
  if (lines.length === 2) lines.push("- nothing to report");
  return lines.join("\n");
}

export function buildReportBody(summaries: DestinationSummary[], asOf: Date): string {
  const byCorridor = groupBy(summaries, (s) => s.corridor ?? "(none)");
  const byOwner = groupBy(summaries, (s) => s.owner);

  const corridorSections = [...byCorridor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([corridor, items]) => renderGroup(corridor, items));
  const ownerSections = [...byOwner.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, items]) => renderGroup(owner, items));

  return [
    `# Weekly staleness report`,
    "",
    `As of ${asOf.toISOString().slice(0, 10)}. Flags fees with an aged verification timestamp (never counts an unverified null as stale), destinations overdue for review, and a per-destination count of fields still null. See separate \`[MANUAL CHECK DUE]\` issues for overdue human_only sources.`,
    "",
    "## By corridor",
    "",
    ...corridorSections,
    "",
    "## By owner",
    "",
    ...ownerSections,
  ].join("\n");
}

async function main() {
  const now = new Date();
  const summaries: DestinationSummary[] = [];

  for (const file of listDestinationFiles()) {
    const destination = loadYaml<Destination>(file);
    const ruleset = destination.identity.ruleset ? loadRuleset(destination.identity.ruleset) : null;
    const resolved = resolveDestination(destination, ruleset);

    summaries.push({
      iso_code: resolved.identity.iso_code,
      name: resolved.identity.name,
      corridor: resolved.identity.corridor,
      owner: resolved.identity.owner,
      staleFees: staleFeesFor(resolved, now),
      overdueForReview: isDestinationOverdueForReview(resolved, now),
      nullFields: nullFieldCount(resolved),
    });
  }

  await upsertIssue("Weekly staleness report", buildReportBody(summaries, now), ["staleness-report"]);
  console.log("Upserted: Weekly staleness report");

  const sources = loadSources();
  if (sources) {
    for (const source of sources) {
      if (!isSourceOverdueForManualCheck(source, now)) continue;
      const title = `[MANUAL CHECK DUE] ${source.iso_code} — ${source.what_it_covers}`;
      const body = [
        `This human_only source hasn't been manually checked in over ${MANUAL_CHECK_DAYS} days (or ever).`,
        "",
        `URL: ${source.url}`,
        `Owner: ${source.owner}`,
        `Last checked: ${source.last_checked ?? "never"}`,
        "",
        "Open the URL, confirm the current value, and update this source's last_checked (and last_changed/last_seen_snippet if it changed) in data/sources.yaml via a PR.",
      ].join("\n");
      await upsertIssue(title, body, ["manual-check-due"]);
      console.log(`Upserted: ${title}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
