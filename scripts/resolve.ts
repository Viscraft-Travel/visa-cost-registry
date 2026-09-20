import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const STALENESS_DAYS = 60;
export const FX_MAX_AGE_DAYS = 7;

export interface Fee {
  id: string;
  label: string | null;
  amount: number | null;
  currency: string | null;
  collection_basis: "native_inr" | "official_inr" | "fx_derived" | null;
  collected_currency: string | null;
  collected_amount: number | null;
  collected_amount_source_url: string | null;
  collected_amount_verified_on: string | null;
  basis: "per_person" | "per_family" | "per_file" | null;
  family_cap_amount: number | null;
  family_max_persons: number | null;
  applies_to: string | null;
  visa_subtype: string | null;
  mandatory: boolean | null;
  category: string | null;
  source_url: string | null;
  verified_on: string | null;
  verified_by: string | null;
}

/** A destination file's fee entry, as it appears on disk. When the fee's id
 * matches a ruleset fee, only the fields that differ need to be present --
 * everything else inherits from the ruleset at resolve time. */
export type FeeFragment = Partial<Fee> & { id: string };

export interface Ruleset {
  id: string;
  corridor: string;
  description?: string;
  fees: Fee[];
  requirements?: Record<string, unknown>;
  rules?: Record<string, unknown>;
  meta: { last_reviewed: string | null; reviewed_by: string | null };
}

export interface Destination {
  identity: {
    iso_code: string;
    name: string;
    corridor: string | null;
    ruleset: string | null;
    tier: "light" | "standard" | "heavy" | null;
    owner: string;
  };
  application: Record<string, unknown>;
  fees: FeeFragment[];
  timing: Record<string, unknown>;
  requirements: Record<string, unknown>;
  outcome: Record<string, unknown>;
  meta: { last_reviewed: string | null; reviewed_by: string | null; change_log: unknown[] };
}

/** A destination after merging against its ruleset (or itself, if standalone) -- every fee is a fully-populated Fee, never a fragment. */
export interface ResolvedDestination extends Omit<Destination, "fees"> {
  fees: Fee[];
}

export interface FxData {
  base: string;
  fetched_at: string;
  source?: string;
  rates: Record<string, number>;
}

const DATA_DIR = path.resolve(process.cwd(), "data");

export function loadYaml<T>(filePath: string): T {
  return yaml.load(fs.readFileSync(filePath, "utf8")) as T;
}

export function listDestinationFiles(): string[] {
  const dir = path.join(DATA_DIR, "destinations");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(dir, f));
}

export function listRulesetFiles(): string[] {
  const dir = path.join(DATA_DIR, "rulesets");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.join(dir, f));
}

export function loadRuleset(id: string): Ruleset {
  return loadYaml<Ruleset>(path.join(DATA_DIR, "rulesets", `${id}.yaml`));
}

export function loadDestination(isoCode: string): Destination {
  return loadYaml<Destination>(path.join(DATA_DIR, "destinations", `${isoCode}.yaml`));
}

export function loadFx(): FxData | null {
  const fxPath = path.join(DATA_DIR, "fx.yaml");
  if (!fs.existsSync(fxPath)) return null;
  return loadYaml<FxData>(fxPath);
}

/**
 * Merges a destination's fee fragment onto its matching ruleset fee, field
 * by field. A field present in the fragment (even if explicitly null)
 * overrides the ruleset's value; a field the fragment omits entirely
 * inherits the ruleset's value unchanged. A fragment with no ruleset match
 * (a destination-only fee) is returned as-is.
 */
export function mergeFee(rulesetFee: Fee | undefined, destinationFee: FeeFragment): Fee {
  if (!rulesetFee) return destinationFee as Fee;
  return { ...rulesetFee, ...destinationFee };
}

/**
 * Merges a destination record against its ruleset (if any). Returns a
 * record shaped like schema/destination.schema.json: destination-only fees
 * pass through unchanged, ruleset fees the destination never mentions still
 * appear (inherited wholesale), and fees present in both are merged field
 * by field with the destination's fields winning.
 */
/**
 * Merges a destination's requirements against its ruleset's, field by
 * field: a null in the destination means "not specified here, inherit the
 * ruleset's value"; a non-null value is an explicit override. This lets a
 * destination declare requirements: { insurance_required: null, ... } and
 * still resolve to the ruleset's shared insurance rule, instead of every
 * destination file having to restate it.
 */
export function mergeRequirements(
  destinationRequirements: Record<string, unknown>,
  rulesetRequirements: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!rulesetRequirements) return destinationRequirements;
  const merged = { ...destinationRequirements };
  for (const [key, value] of Object.entries(rulesetRequirements)) {
    if (merged[key] === null || merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

export function resolveDestination(destination: Destination, ruleset: Ruleset | null): ResolvedDestination {
  if (!ruleset) {
    // Standalone destinations have no ruleset to inherit from, so their
    // fee fragments must already be fully-specified Fee objects.
    return { ...destination, fees: destination.fees as Fee[] };
  }

  const rulesetFeesById = new Map(ruleset.fees.map((f) => [f.id, f]));
  const destinationFeeIds = new Set(destination.fees.map((f) => f.id));

  const mergedFees: Fee[] = destination.fees.map((fee) => mergeFee(rulesetFeesById.get(fee.id), fee));

  for (const [id, fee] of rulesetFeesById) {
    if (!destinationFeeIds.has(id)) mergedFees.push(fee);
  }

  return {
    ...destination,
    fees: mergedFees,
    requirements: mergeRequirements(destination.requirements, ruleset.requirements),
  };
}

function daysSince(dateStr: string | null | undefined, now: Date): number | null {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/** A value/verification-timestamp contradiction: a verification that produced no number. */
export class ContradictionError extends Error {}

export interface ResolvedFeeAmount {
  inr_amount: number | null;
  is_approximate: boolean;
  is_stale: boolean;
}

/**
 * Computes the export-ready INR figure for one resolved fee.
 *
 * General principle: null + no verification timestamp = NOT YET KNOWN,
 * valid, returns { inr_amount: null }. null + a verification timestamp SET
 * = CONTRADICTION, throws. This function never throws for a plain
 * unverified null -- only for the contradiction case -- so that resolving
 * the deliberately all-null seed data never crashes the pipeline.
 */
export function resolveFeeAmount(fee: Fee, fx: FxData | null, now: Date = new Date()): ResolvedFeeAmount {
  if (fee.verified_on && fee.amount === null) {
    throw new ContradictionError(`${fee.id}: verified_on is set but amount is null`);
  }

  const ageVerified = daysSince(fee.verified_on, now);
  const staleByVerifiedOn = ageVerified !== null && ageVerified > STALENESS_DAYS;

  switch (fee.collection_basis) {
    case "native_inr": {
      if (fee.amount === null) {
        // verified_on is guaranteed null here too (the contradiction check
        // above already threw otherwise), so this is unverified, not stale.
        return { inr_amount: null, is_approximate: false, is_stale: false };
      }
      if (staleByVerifiedOn) return { inr_amount: null, is_approximate: false, is_stale: true };
      return { inr_amount: fee.amount, is_approximate: false, is_stale: false };
    }

    case "official_inr": {
      if (fee.collected_amount_verified_on && fee.collected_amount === null) {
        throw new ContradictionError(
          `${fee.id}: collected_amount_verified_on is set but collected_amount is null`
        );
      }
      if (fee.collected_amount === null) {
        // Not yet verified -- unresolved, not an error.
        return { inr_amount: null, is_approximate: false, is_stale: false };
      }
      const ageCollected = daysSince(fee.collected_amount_verified_on, now);
      const staleByCollected = ageCollected !== null && ageCollected > STALENESS_DAYS;
      if (staleByCollected || staleByVerifiedOn) {
        return { inr_amount: null, is_approximate: false, is_stale: true };
      }
      return { inr_amount: fee.collected_amount, is_approximate: false, is_stale: false };
    }

    case "fx_derived": {
      if (fee.amount === null || fee.currency === null) {
        return { inr_amount: null, is_approximate: true, is_stale: false };
      }
      if (staleByVerifiedOn) return { inr_amount: null, is_approximate: true, is_stale: true };
      if (!fx) return { inr_amount: null, is_approximate: true, is_stale: true };
      const fxAgeDays = daysSince(fx.fetched_at, now);
      if (fxAgeDays === null || fxAgeDays > FX_MAX_AGE_DAYS) {
        // "Refuse to derive... from an fx.yaml older than 7 days" refuses
        // the derivation, not the whole pipeline: export empty, flag stale.
        return { inr_amount: null, is_approximate: true, is_stale: true };
      }
      const rate = fx.rates[fee.currency];
      if (rate === undefined) {
        return { inr_amount: null, is_approximate: true, is_stale: true };
      }
      return { inr_amount: Math.round(fee.amount * rate), is_approximate: true, is_stale: false };
    }

    default:
      // collection_basis not yet known.
      return { inr_amount: null, is_approximate: false, is_stale: false };
  }
}

/**
 * Applies the family cap for a per_family fee: the total never multiplies
 * the per-person amount beyond family_max_persons travellers, and never
 * exceeds family_cap_amount regardless of party size. Fees on any other
 * basis are simply multiplied by traveller count.
 */
export function applyFamilyCap(perPersonAmount: number, travellerCount: number, fee: Fee): number {
  if (fee.basis !== "per_family") return perPersonAmount * travellerCount;
  const cappedCount = Math.min(travellerCount, fee.family_max_persons ?? travellerCount);
  const raw = perPersonAmount * cappedCount;
  return fee.family_cap_amount !== null ? Math.min(raw, fee.family_cap_amount) : raw;
}
