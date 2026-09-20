import fs from "node:fs";
import path from "node:path";
import {
  listDestinationFiles,
  loadYaml,
  loadRuleset,
  loadFx,
  resolveDestination,
  resolveFeeAmount,
  ContradictionError,
  type Destination,
  type ResolvedDestination,
  type Fee,
  type FxData,
} from "./resolve.js";

/**
 * Runs on every merge to main. Writes docs/export/{fees.csv,
 * destinations.csv, guides.json} from the RESOLVED records -- nothing here
 * reads a raw destination/ruleset file directly, only resolveDestination()'s
 * output. Published via GitHub Pages so a Google Sheet (IMPORTDATA) and the
 * Framer site can pull the files; this script never writes back to either.
 */

const OUT_DIR = path.resolve(process.cwd(), "docs/export");

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join("; ");
  return String(v);
}

/** RFC 4180-style quoting: wrap in quotes if the field contains a comma, quote, or newline; double up internal quotes. */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? "";
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(",")
    )
    .join("\n");
}

const FEES_CSV_COLUMNS = [
  "iso_code", "destination", "corridor", "fee_id", "label", "category", "basis",
  "applies_to", "visa_subtype", "amount", "currency", "collection_basis",
  "inr_amount", "is_approximate", "is_stale", "family_cap_amount",
  "family_max_persons", "mandatory", "verified_on", "source_url",
] as const;

export function feeRow(resolved: ResolvedDestination, fee: Fee, fx: FxData | null): string[] {
  const { inr_amount, is_approximate, is_stale } = resolveFeeAmount(fee, fx);
  const values: Record<(typeof FEES_CSV_COLUMNS)[number], unknown> = {
    iso_code: resolved.identity.iso_code,
    destination: resolved.identity.name,
    corridor: resolved.identity.corridor,
    fee_id: fee.id,
    label: fee.label,
    category: fee.category,
    basis: fee.basis,
    applies_to: fee.applies_to,
    visa_subtype: fee.visa_subtype,
    amount: fee.amount,
    currency: fee.currency,
    collection_basis: fee.collection_basis,
    inr_amount,
    is_approximate,
    is_stale,
    family_cap_amount: fee.family_cap_amount,
    family_max_persons: fee.family_max_persons,
    mandatory: fee.mandatory,
    verified_on: fee.verified_on,
    source_url: fee.source_url,
  };
  return FEES_CSV_COLUMNS.map((c) => csvValue(values[c]));
}

const DESTINATIONS_CSV_COLUMNS = [
  "iso_code", "name", "corridor", "tier", "owner",
  "appointment_lead_days_min", "appointment_lead_days_max", "processing_days_min",
  "processing_days_max", "earliest_application_days_before_travel",
  "standard_runway_days", "floor_days", "peak_months",
  "insurance_required", "insurance_min_cover", "insurance_currency",
  "itinerary_required", "accommodation_required", "flight_reservation_required",
  "financial_statement_months", "itr_required", "translation_required",
  "apostille_required", "photo_spec",
  "refusal_rate_indian_applicants", "refusal_rate_source", "refusal_rate_as_at",
  "common_refusal_grounds", "appeal_available", "reapplication_wait_days",
  "last_reviewed", "reviewed_by",
] as const;

export function destinationRow(resolved: ResolvedDestination): string[] {
  const timing = resolved.timing as Record<string, unknown>;
  const requirements = resolved.requirements as Record<string, unknown>;
  const outcome = resolved.outcome as Record<string, unknown>;
  const values: Record<(typeof DESTINATIONS_CSV_COLUMNS)[number], unknown> = {
    iso_code: resolved.identity.iso_code,
    name: resolved.identity.name,
    corridor: resolved.identity.corridor,
    tier: resolved.identity.tier,
    owner: resolved.identity.owner,
    appointment_lead_days_min: timing.appointment_lead_days_min,
    appointment_lead_days_max: timing.appointment_lead_days_max,
    processing_days_min: timing.processing_days_min,
    processing_days_max: timing.processing_days_max,
    earliest_application_days_before_travel: timing.earliest_application_days_before_travel,
    standard_runway_days: timing.standard_runway_days,
    floor_days: timing.floor_days,
    peak_months: timing.peak_months,
    insurance_required: requirements.insurance_required,
    insurance_min_cover: requirements.insurance_min_cover,
    insurance_currency: requirements.insurance_currency,
    itinerary_required: requirements.itinerary_required,
    accommodation_required: requirements.accommodation_required,
    flight_reservation_required: requirements.flight_reservation_required,
    financial_statement_months: requirements.financial_statement_months,
    itr_required: requirements.itr_required,
    translation_required: requirements.translation_required,
    apostille_required: requirements.apostille_required,
    photo_spec: requirements.photo_spec,
    refusal_rate_indian_applicants: outcome.refusal_rate_indian_applicants,
    refusal_rate_source: outcome.refusal_rate_source,
    refusal_rate_as_at: outcome.refusal_rate_as_at,
    common_refusal_grounds: outcome.common_refusal_grounds,
    appeal_available: outcome.appeal_available,
    reapplication_wait_days: outcome.reapplication_wait_days,
    last_reviewed: resolved.meta.last_reviewed,
    reviewed_by: resolved.meta.reviewed_by,
  };
  return DESTINATIONS_CSV_COLUMNS.map((c) => csvValue(values[c]));
}

/**
 * The relevant "as at" clock for a fee's INR figure: collected_amount_verified_on
 * for official_inr (that's the figure actually used), otherwise verified_on.
 */
function feeAsAtDate(fee: Fee): string | null {
  return fee.collection_basis === "official_inr" ? fee.collected_amount_verified_on : fee.verified_on;
}

export function guideRecord(resolved: ResolvedDestination, fx: FxData | null) {
  const fees = [];
  for (const fee of resolved.fees) {
    try {
      const { inr_amount, is_approximate, is_stale } = resolveFeeAmount(fee, fx);
      fees.push({ ...fee, inr_amount, is_approximate, is_stale, fee_as_at_date: feeAsAtDate(fee) });
    } catch (e) {
      if (e instanceof ContradictionError) {
        console.error(`[export-csv] skipping ${resolved.identity.iso_code}/${fee.id} from guides.json: ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  return {
    iso_code: resolved.identity.iso_code,
    name: resolved.identity.name,
    corridor: resolved.identity.corridor,
    tier: resolved.identity.tier,
    application: resolved.application,
    fees,
    timing: resolved.timing,
    requirements: resolved.requirements,
    outcome: resolved.outcome,
    last_reviewed: resolved.meta.last_reviewed,
  };
}

function loadAllResolved(): ResolvedDestination[] {
  const resolved: ResolvedDestination[] = [];
  for (const file of listDestinationFiles()) {
    const destination = loadYaml<Destination>(file);
    const ruleset = destination.identity.ruleset ? loadRuleset(destination.identity.ruleset) : null;
    resolved.push(resolveDestination(destination, ruleset));
  }
  // Stable row order: iso_code, then fee_id within each destination.
  resolved.sort((a, b) => a.identity.iso_code.localeCompare(b.identity.iso_code));
  for (const d of resolved) d.fees.sort((a, b) => a.id.localeCompare(b.id));
  return resolved;
}

async function main() {
  const fx = loadFx();
  const destinations = loadAllResolved();

  const feeRows: string[][] = [[...FEES_CSV_COLUMNS]];
  const destinationRows: string[][] = [[...DESTINATIONS_CSV_COLUMNS]];
  const guides: unknown[] = [];

  for (const resolved of destinations) {
    destinationRows.push(destinationRow(resolved));
    guides.push(guideRecord(resolved, fx));
    for (const fee of resolved.fees) {
      try {
        feeRows.push(feeRow(resolved, fee, fx));
      } catch (e) {
        if (e instanceof ContradictionError) {
          console.error(`[export-csv] skipping ${resolved.identity.iso_code}/${fee.id}: ${e.message}`);
          continue;
        }
        throw e;
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "fees.csv"), toCsv(feeRows) + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "destinations.csv"), toCsv(destinationRows) + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "guides.json"), JSON.stringify(guides, null, 2) + "\n");

  console.log(
    `Wrote docs/export/: fees.csv (${feeRows.length - 1} rows), destinations.csv (${destinationRows.length - 1} rows), guides.json (${guides.length} records).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
