import { describe, it, expect } from "vitest";
import { collectNullPaths } from "../scripts/resolve.js";
import { buildChecklist } from "../scripts/bootstrap-issues.js";
import type { ResolvedDestination } from "../scripts/resolve.js";

describe("collectNullPaths", () => {
  it("finds top-level nulls", () => {
    expect(collectNullPaths({ a: null, b: 1 })).toEqual(["a"]);
  });

  it("recurses into nested objects", () => {
    expect(collectNullPaths({ a: { b: null, c: 1 } })).toEqual(["a.b"]);
  });

  it("does not recurse into arrays", () => {
    expect(collectNullPaths({ a: [null, { b: null }] })).toEqual([]);
  });

  it("returns nothing when everything is populated", () => {
    expect(collectNullPaths({ a: 1, b: { c: "x" } })).toEqual([]);
  });
});

describe("buildChecklist", () => {
  function emptyDestination(): ResolvedDestination {
    return {
      identity: { iso_code: "xx", name: "Testland", corridor: "test", ruleset: null, tier: null, owner: "TBD" },
      application: {
        channel: null, vac_operator: null, vac_cities: null, jurisdiction_rule: null,
        interview_required: null, biometrics_required: null, biometrics_validity_months: null, agency_can_file: null,
      },
      fees: [],
      timing: {
        appointment_lead_days_min: null, appointment_lead_days_max: null, processing_days_min: null,
        processing_days_max: null, earliest_application_days_before_travel: null,
        standard_runway_days: null, floor_days: null, peak_months: [],
      },
      requirements: {
        insurance_required: null, insurance_min_cover: null, insurance_currency: null, itinerary_required: null,
        accommodation_required: null, flight_reservation_required: null, financial_statement_months: null,
        itr_required: null, translation_required: null, apostille_required: null, photo_spec: null,
      },
      outcome: {
        refusal_rate_indian_applicants: null, refusal_rate_source: null, refusal_rate_as_at: null,
        common_refusal_grounds: [], appeal_available: null, reapplication_wait_days: null,
      },
      meta: { last_reviewed: null, reviewed_by: null, change_log: [] },
    };
  }

  it("flags the TBD owner placeholder", () => {
    const checklist = buildChecklist(emptyDestination());
    expect(checklist).toContain('identity.owner (currently placeholder "TBD")');
  });

  it("lists null fields across every section", () => {
    const checklist = buildChecklist(emptyDestination());
    expect(checklist).toContain("application.channel");
    expect(checklist).toContain("timing.floor_days");
    expect(checklist).toContain("requirements.insurance_required");
    expect(checklist).toContain("outcome.refusal_rate_indian_applicants");
    expect(checklist).toContain("meta.last_reviewed");
  });

  it("lists null fee fields grouped by fee id", () => {
    const destination = emptyDestination();
    destination.fees = [
      {
        id: "consular_fee_adult", label: "Consular fee", amount: null, currency: "EUR",
        collection_basis: "official_inr", collected_currency: "INR", collected_amount: null,
        collected_amount_source_url: null, collected_amount_verified_on: null, basis: "per_person",
        family_cap_amount: null, family_max_persons: null, applies_to: "adult", visa_subtype: null,
        mandatory: true, category: "consular", source_url: "https://example.gov", verified_on: null, verified_by: null,
      },
    ];
    const checklist = buildChecklist(destination);
    expect(checklist).toContain("fees[`consular_fee_adult`].amount");
    expect(checklist).toContain("fees[`consular_fee_adult`].collected_amount");
    expect(checklist).not.toContain("fees[`consular_fee_adult`].id");
  });

  it("reports nothing outstanding once every field is populated", () => {
    const destination = emptyDestination();
    destination.identity.owner = "akhil";
    for (const key of Object.keys(destination.application)) {
      (destination.application as Record<string, unknown>)[key] = "set";
    }
    for (const key of Object.keys(destination.timing)) {
      if (key !== "peak_months") (destination.timing as Record<string, unknown>)[key] = 1;
    }
    for (const key of Object.keys(destination.requirements)) {
      (destination.requirements as Record<string, unknown>)[key] = "set";
    }
    for (const key of Object.keys(destination.outcome)) {
      if (key !== "common_refusal_grounds") (destination.outcome as Record<string, unknown>)[key] = "set";
    }
    destination.meta.last_reviewed = "2026-01-01";
    destination.meta.reviewed_by = "akhil";

    expect(buildChecklist(destination)).toBe("Nothing outstanding -- fully verified.");
  });
});
