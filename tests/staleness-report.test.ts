import { describe, it, expect } from "vitest";
import { staleFeesFor, isDestinationOverdueForReview, isSourceOverdueForManualCheck } from "../scripts/staleness-report.js";
import { STALENESS_DAYS, type ResolvedDestination, type Source } from "../scripts/resolve.js";

const NOW = new Date("2026-09-20T00:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function destinationWithFee(overrides: Partial<ResolvedDestination["fees"][number]> = {}): ResolvedDestination {
  return {
    identity: { iso_code: "fr", name: "France", corridor: "schengen", ruleset: "schengen", tier: "heavy", owner: "akhil" },
    application: {} as any,
    fees: [
      {
        id: "consular_fee_adult", label: "Consular fee", amount: 90, currency: "EUR",
        collection_basis: "official_inr", collected_currency: "INR", collected_amount: 8300,
        collected_amount_source_url: "https://example.gov", collected_amount_verified_on: null,
        basis: "per_person", family_cap_amount: null, family_max_persons: null, applies_to: "adult",
        visa_subtype: null, mandatory: true, category: "consular", source_url: "https://example.gov",
        verified_on: null, verified_by: null,
        ...overrides,
      },
    ],
    timing: {} as any,
    requirements: {} as any,
    outcome: {} as any,
    meta: { last_reviewed: null, reviewed_by: null, change_log: [] },
  };
}

describe("staleFeesFor", () => {
  it("flags nothing when verification timestamps are null (never verified, not stale)", () => {
    const dest = destinationWithFee();
    expect(staleFeesFor(dest, NOW)).toEqual([]);
  });

  it("flags nothing when verified recently", () => {
    const dest = destinationWithFee({ verified_on: daysAgo(1) });
    expect(staleFeesFor(dest, NOW)).toEqual([]);
  });

  it("flags a fee verified more than the staleness window ago", () => {
    const dest = destinationWithFee({ verified_on: daysAgo(STALENESS_DAYS + 1) });
    const flags = staleFeesFor(dest, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ iso_code: "fr", fee_id: "consular_fee_adult", field: "verified_on" });
  });

  it("flags collected_amount_verified_on independently of verified_on", () => {
    const dest = destinationWithFee({
      verified_on: daysAgo(1),
      collected_amount_verified_on: daysAgo(STALENESS_DAYS + 1),
    });
    const flags = staleFeesFor(dest, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0].field).toBe("collected_amount_verified_on");
  });

  it("can flag both clocks on the same fee", () => {
    const dest = destinationWithFee({
      verified_on: daysAgo(STALENESS_DAYS + 1),
      collected_amount_verified_on: daysAgo(STALENESS_DAYS + 5),
    });
    expect(staleFeesFor(dest, NOW)).toHaveLength(2);
  });
});

describe("isDestinationOverdueForReview", () => {
  function destination(lastReviewed: string | null): ResolvedDestination {
    return {
      identity: { iso_code: "fr", name: "France", corridor: "schengen", ruleset: "schengen", tier: "heavy", owner: "akhil" },
      application: {} as any,
      fees: [],
      timing: {} as any,
      requirements: {} as any,
      outcome: {} as any,
      meta: { last_reviewed: lastReviewed, reviewed_by: null, change_log: [] },
    };
  }

  it("is not overdue when never reviewed (null, not stale)", () => {
    expect(isDestinationOverdueForReview(destination(null), NOW)).toBe(false);
  });

  it("is not overdue when reviewed recently", () => {
    expect(isDestinationOverdueForReview(destination(daysAgo(10)), NOW)).toBe(false);
  });

  it("is overdue when reviewed more than 90 days ago", () => {
    expect(isDestinationOverdueForReview(destination(daysAgo(91)), NOW)).toBe(true);
  });
});

describe("isSourceOverdueForManualCheck", () => {
  function source(overrides: Partial<Source>): Source {
    return {
      iso_code: "fr", url: "https://example.com", applicant_country: "IN", language: "en",
      what_it_covers: "fees", check_method: "human_only", canary: ["France"],
      last_checked: null, last_changed: null, last_seen_snippet: null, owner: "akhil",
      ...overrides,
    };
  }

  it("is never overdue for a hash-checked source (that's check-sources.ts's job)", () => {
    expect(isSourceOverdueForManualCheck(source({ check_method: "hash", last_checked: null }), NOW)).toBe(false);
  });

  it("is overdue for a human_only source that has never been checked", () => {
    expect(isSourceOverdueForManualCheck(source({ last_checked: null }), NOW)).toBe(true);
  });

  it("is not overdue for a human_only source checked recently", () => {
    expect(isSourceOverdueForManualCheck(source({ last_checked: daysAgo(5) }), NOW)).toBe(false);
  });

  it("is overdue for a human_only source not checked in over 60 days", () => {
    expect(isSourceOverdueForManualCheck(source({ last_checked: daysAgo(61) }), NOW)).toBe(true);
  });
});
