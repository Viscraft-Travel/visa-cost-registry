import { describe, it, expect } from "vitest";
import { toCsv, feeRow, destinationRow, guideRecord } from "../scripts/export-csv.js";
import { ContradictionError, type ResolvedDestination, type Fee } from "../scripts/resolve.js";

describe("toCsv", () => {
  it("joins rows and columns with commas and newlines", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\nc,d");
  });

  it("quotes fields containing a comma, quote, or newline, and escapes internal quotes", () => {
    expect(toCsv([["hello, world", 'say "hi"', "line1\nline2", "plain"]])).toBe(
      '"hello, world","say ""hi""","line1\nline2",plain'
    );
  });

  it("renders an empty cell for an empty string", () => {
    expect(toCsv([["", "x"]])).toBe(",x");
  });
});

function baseFee(overrides: Partial<Fee> = {}): Fee {
  return {
    id: "consular_fee_adult", label: "Consular fee", amount: 90, currency: "EUR",
    collection_basis: "official_inr", collected_currency: "INR", collected_amount: 8300,
    collected_amount_source_url: "https://example.gov", collected_amount_verified_on: "2026-09-01",
    basis: "per_person", family_cap_amount: null, family_max_persons: null, applies_to: "adult",
    visa_subtype: "short_stay", mandatory: true, category: "consular",
    source_url: "https://example.gov", verified_on: "2026-08-01", verified_by: "akhil",
    ...overrides,
  };
}

function baseDestination(overrides: Partial<ResolvedDestination> = {}): ResolvedDestination {
  return {
    identity: { iso_code: "fr", name: "France", corridor: "schengen", ruleset: "schengen", tier: "heavy", owner: "akhil" },
    application: { channel: "vac", vac_operator: "vfs" } as any,
    fees: [baseFee()],
    timing: {
      appointment_lead_days_min: 5, appointment_lead_days_max: 10, processing_days_min: 10,
      processing_days_max: 15, earliest_application_days_before_travel: 180,
      standard_runway_days: 30, floor_days: 10, peak_months: [6, 7],
    },
    requirements: {
      insurance_required: true, insurance_min_cover: 30000, insurance_currency: "EUR",
      itinerary_required: true, accommodation_required: true, flight_reservation_required: true,
      financial_statement_months: 3, itr_required: true, translation_required: false,
      apostille_required: false, photo_spec: "35x45mm",
    },
    outcome: {
      refusal_rate_indian_applicants: 5.2, refusal_rate_source: "MEA", refusal_rate_as_at: "2026-01-01",
      common_refusal_grounds: ["insufficient funds", "weak ties"], appeal_available: "no", reapplication_wait_days: 0,
    },
    meta: { last_reviewed: "2026-09-01", reviewed_by: "akhil", change_log: [] },
    ...overrides,
  };
}

describe("feeRow", () => {
  it("produces a row matching the resolved fee, with the computed INR figure", () => {
    const row = feeRow(baseDestination(), baseFee(), null);
    expect(row).toEqual([
      "fr", "France", "schengen", "consular_fee_adult", "Consular fee", "consular", "per_person",
      "adult", "short_stay", "90", "EUR", "official_inr",
      "8300", "false", "false", "", "", "true", "2026-08-01", "https://example.gov",
    ]);
  });

  it("leaves inr_amount empty and is_stale true for a fee gone stale, never the old number", () => {
    const staleFee = baseFee({ verified_on: "2020-01-01" });
    const row = feeRow(baseDestination(), staleFee, null);
    const inrAmountIdx = row.length - 8; // inr_amount column position
    expect(row).toContain(""); // inr_amount rendered empty somewhere in the row
    expect(row[row.length - 8]).toBe(""); // inr_amount
    expect(row[row.length - 7]).toBe("false"); // is_approximate
    expect(row[row.length - 6]).toBe("true"); // is_stale
  });

  it("propagates a ContradictionError so the caller can skip the row", () => {
    const contradictory = baseFee({ collected_amount: null, collected_amount_verified_on: "2026-09-01" });
    expect(() => feeRow(baseDestination(), contradictory, null)).toThrow(ContradictionError);
  });
});

describe("destinationRow", () => {
  it("flattens timing/requirements/outcome fields, joining arrays with '; '", () => {
    const row = destinationRow(baseDestination());
    expect(row[0]).toBe("fr");
    expect(row).toContain("6; 7"); // peak_months joined
    expect(row).toContain("insufficient funds; weak ties"); // common_refusal_grounds joined
  });
});

describe("guideRecord", () => {
  it("skips a contradictory fee rather than throwing and losing the whole record", () => {
    const contradictory = baseFee({ collected_amount: null, collected_amount_verified_on: "2026-09-01" });
    const dest = baseDestination({ fees: [contradictory, baseFee({ id: "other_fee" })] });
    const record = guideRecord(dest, null) as any;
    expect(record.fees).toHaveLength(1);
    expect(record.fees[0].id).toBe("other_fee");
  });

  it("includes fee_as_at_date and is_approximate on every fee", () => {
    const record = guideRecord(baseDestination(), null) as any;
    expect(record.fees[0].is_approximate).toBe(false);
    expect(record.fees[0].fee_as_at_date).toBe("2026-09-01"); // official_inr -> collected_amount_verified_on
  });

  it("uses verified_on as the as-at date for non-official_inr bases", () => {
    const dest = baseDestination({ fees: [baseFee({ collection_basis: "native_inr" })] });
    const record = guideRecord(dest, null) as any;
    expect(record.fees[0].fee_as_at_date).toBe("2026-08-01");
  });
});
