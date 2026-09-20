import { describe, it, expect } from "vitest";
import {
  mergeFee,
  mergeRequirements,
  resolveDestination,
  resolveFeeAmount,
  applyFamilyCap,
  ContradictionError,
  STALENESS_DAYS,
  FX_MAX_AGE_DAYS,
  type Fee,
  type Ruleset,
  type Destination,
  type FxData,
} from "../scripts/resolve.js";

const NOW = new Date("2026-09-20T00:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function baseFee(overrides: Partial<Fee> = {}): Fee {
  return {
    id: "test_fee",
    label: "Test fee",
    amount: null,
    currency: null,
    collection_basis: null,
    collected_currency: null,
    collected_amount: null,
    collected_amount_source_url: null,
    collected_amount_verified_on: null,
    basis: "per_person",
    family_cap_amount: null,
    family_max_persons: null,
    applies_to: "all",
    visa_subtype: null,
    mandatory: true,
    category: "consular",
    source_url: "https://example.gov/visa-fees",
    verified_on: null,
    verified_by: null,
    ...overrides,
  };
}

describe("resolveFeeAmount -- collection_basis handling", () => {
  it("native_inr: uses amount directly, no FX involved", () => {
    const fee = baseFee({
      collection_basis: "native_inr",
      amount: 2500,
      currency: "INR",
      verified_on: daysAgo(1),
    });
    const result = resolveFeeAmount(fee, null, NOW);
    expect(result).toEqual({ inr_amount: 2500, is_approximate: false, is_stale: false });
  });

  it("official_inr: uses collected_amount, never converts via FX", () => {
    const fee = baseFee({
      collection_basis: "official_inr",
      amount: 90,
      currency: "EUR",
      verified_on: daysAgo(1),
      collected_amount: 8300,
      collected_currency: "INR",
      collected_amount_verified_on: daysAgo(1),
    });
    // Deliberately wrong FX rate to prove it's never consulted for official_inr.
    const fx: FxData = { base: "INR", fetched_at: daysAgo(1), rates: { EUR: 999 } };
    const result = resolveFeeAmount(fee, fx, NOW);
    expect(result).toEqual({ inr_amount: 8300, is_approximate: false, is_stale: false });
  });

  it("fx_derived: converts via fx.yaml and flags approximate", () => {
    const fee = baseFee({
      collection_basis: "fx_derived",
      amount: 100,
      currency: "USD",
      verified_on: daysAgo(1),
    });
    const fx: FxData = { base: "INR", fetched_at: daysAgo(1), rates: { USD: 83 } };
    const result = resolveFeeAmount(fee, fx, NOW);
    expect(result).toEqual({ inr_amount: 8300, is_approximate: true, is_stale: false });
  });

  it("fx_derived: refused (not thrown) when fx.yaml is older than 7 days", () => {
    const fee = baseFee({
      collection_basis: "fx_derived",
      amount: 100,
      currency: "USD",
      verified_on: daysAgo(1),
    });
    const staleFx: FxData = { base: "INR", fetched_at: daysAgo(FX_MAX_AGE_DAYS + 1), rates: { USD: 83 } };
    expect(() => resolveFeeAmount(fee, staleFx, NOW)).not.toThrow();
    const result = resolveFeeAmount(fee, staleFx, NOW);
    expect(result).toEqual({ inr_amount: null, is_approximate: true, is_stale: true });
  });
});

describe("resolveFeeAmount -- staleness", () => {
  it("a record verified more than 60 days ago returns null, not the old value", () => {
    const fee = baseFee({
      collection_basis: "native_inr",
      amount: 2500,
      currency: "INR",
      verified_on: daysAgo(STALENESS_DAYS + 1),
    });
    const result = resolveFeeAmount(fee, null, NOW);
    expect(result.inr_amount).toBeNull();
    expect(result.is_stale).toBe(true);
  });

  it("official_inr staleness is driven by collected_amount_verified_on independently of verified_on", () => {
    const fee = baseFee({
      collection_basis: "official_inr",
      amount: 90,
      currency: "EUR",
      verified_on: daysAgo(1), // the EUR figure is fresh...
      collected_amount: 8300,
      collected_amount_verified_on: daysAgo(STALENESS_DAYS + 1), // ...but the INR rate is stale
    });
    const result = resolveFeeAmount(fee, null, NOW);
    expect(result.inr_amount).toBeNull();
    expect(result.is_stale).toBe(true);
  });
});

describe("resolveFeeAmount -- unresolved vs contradiction", () => {
  it("official_inr, both collected_amount and its verified_on null -> unresolved, no throw", () => {
    const fee = baseFee({
      collection_basis: "official_inr",
      amount: 90,
      currency: "EUR",
      collected_amount: null,
      collected_amount_verified_on: null,
    });
    expect(() => resolveFeeAmount(fee, null, NOW)).not.toThrow();
    const result = resolveFeeAmount(fee, null, NOW);
    expect(result).toEqual({ inr_amount: null, is_approximate: false, is_stale: false });
  });

  it("official_inr, collected_amount null but collected_amount_verified_on set -> throws", () => {
    const fee = baseFee({
      collection_basis: "official_inr",
      amount: 90,
      currency: "EUR",
      verified_on: daysAgo(1),
      collected_amount: null,
      collected_amount_verified_on: daysAgo(1),
    });
    expect(() => resolveFeeAmount(fee, null, NOW)).toThrow(ContradictionError);
  });

  it("any basis: amount null but verified_on set -> throws (a verification that found nothing)", () => {
    const fee = baseFee({
      collection_basis: "native_inr",
      amount: null,
      verified_on: daysAgo(1),
    });
    expect(() => resolveFeeAmount(fee, null, NOW)).toThrow(ContradictionError);
  });
});

describe("mergeRequirements", () => {
  it("a null destination field inherits the ruleset's value", () => {
    const merged = mergeRequirements(
      { insurance_required: null, insurance_min_cover: null, insurance_currency: null },
      { insurance_required: true, insurance_min_cover: 30000, insurance_currency: "EUR" }
    );
    expect(merged).toEqual({ insurance_required: true, insurance_min_cover: 30000, insurance_currency: "EUR" });
  });

  it("a non-null destination field overrides the ruleset's value", () => {
    const merged = mergeRequirements(
      { insurance_required: false },
      { insurance_required: true }
    );
    expect(merged.insurance_required).toBe(false);
  });

  it("with no ruleset requirements at all, the destination's own values pass through", () => {
    const merged = mergeRequirements({ insurance_required: null }, undefined);
    expect(merged).toEqual({ insurance_required: null });
  });
});

describe("mergeFee / resolveDestination -- ruleset inheritance", () => {
  const ruleset: Ruleset = {
    id: "test-ruleset",
    corridor: "test",
    meta: { last_reviewed: null, reviewed_by: null },
    requirements: { insurance_required: true, insurance_min_cover: 30000, insurance_currency: "EUR" },
    fees: [
      baseFee({ id: "consular_fee_adult", label: "Consular fee", amount: 90, currency: "EUR", collection_basis: "official_inr", collected_currency: "INR" }),
      baseFee({ id: "untouched_fee", label: "Untouched fee", amount: 10, currency: "EUR" }),
    ],
  };

  it("a destination fragment overrides only the fields it declares", () => {
    const merged = mergeFee(ruleset.fees[0], { id: "consular_fee_adult", collected_amount: 8300 });
    expect(merged.collected_amount).toBe(8300); // overridden
    expect(merged.amount).toBe(90); // inherited unchanged
    expect(merged.currency).toBe("EUR"); // inherited unchanged
  });

  it("a destination-only fee (no ruleset match) passes through unchanged", () => {
    const fragment = baseFee({ id: "vac_service_charge", collection_basis: "native_inr" });
    const merged = mergeFee(undefined, fragment);
    expect(merged).toEqual(fragment);
  });

  it("resolveDestination merges overridden fees and keeps ruleset fees the destination never mentions", () => {
    const destination: Destination = {
      identity: { iso_code: "xx", name: "Testland", corridor: "test", ruleset: "test-ruleset", tier: null, owner: "TBD" },
      application: {},
      fees: [{ id: "consular_fee_adult", collected_amount: 8300 }],
      timing: {},
      requirements: { insurance_required: null, insurance_min_cover: null, insurance_currency: null },
      outcome: {},
      meta: { last_reviewed: null, reviewed_by: null, change_log: [] },
    };

    const resolved = resolveDestination(destination, ruleset);
    const byId = new Map(resolved.fees.map((f: any) => [f.id, f]));

    expect(byId.get("consular_fee_adult").collected_amount).toBe(8300);
    expect(byId.get("consular_fee_adult").amount).toBe(90); // inherited
    expect(byId.get("untouched_fee")).toBeDefined(); // inherited wholesale, destination never mentioned it
    expect(byId.get("untouched_fee").amount).toBe(10);
    expect(resolved.requirements.insurance_required).toBe(true); // inherited from the ruleset
  });

  it("a destination with no ruleset (standalone) resolves to itself unchanged", () => {
    const destination: Destination = {
      identity: { iso_code: "jp", name: "Japan", corridor: "japan", ruleset: null, tier: "light", owner: "TBD" },
      application: {},
      fees: [baseFee({ id: "visa_fee" })],
      timing: {},
      requirements: {},
      outcome: {},
      meta: { last_reviewed: null, reviewed_by: null, change_log: [] },
    };
    const resolved = resolveDestination(destination, null);
    expect(resolved).toEqual(destination);
  });
});

describe("applyFamilyCap", () => {
  const familyFee = baseFee({
    basis: "per_family",
    family_cap_amount: 300,
    family_max_persons: 4,
  });

  it("multiplies per-person amount up to family_max_persons", () => {
    expect(applyFamilyCap(50, 3, familyFee)).toBe(150);
  });

  it("never multiplies beyond family_max_persons even with more travellers", () => {
    // 6 travellers, but capped at 4 persons * 50 = 200 (under the 300 cap)
    expect(applyFamilyCap(50, 6, familyFee)).toBe(200);
  });

  it("never exceeds family_cap_amount even within family_max_persons", () => {
    // 4 travellers * 100 = 400, but the family cap is 300
    expect(applyFamilyCap(100, 4, familyFee)).toBe(300);
  });

  it("non-per_family fees are simply multiplied by traveller count", () => {
    const perPersonFee = baseFee({ basis: "per_person" });
    expect(applyFamilyCap(50, 3, perPersonFee)).toBe(150);
  });
});
