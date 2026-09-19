# visa-cost-registry

Version-controlled registry of visa fees, processing times, and requirements for Indian applicants.

Robots detect change; humans verify. Publishes CSV and JSON for downstream use.

## Status

Early scaffold — the detection/verification pipeline, source list, and data schema are not yet designed. This README will be filled in as those decisions land.

## Concept (high level)

- **Detect**: automated checks watch official government/consular/VAC sources for changes (fees, processing times, requirements).
- **Verify**: a human confirms a detected change before it's accepted — no automated publish of unverified data.
- **Publish**: verified data is exported as CSV and JSON for downstream consumers (e.g. the Viscraft site).

## TBD

- Source list and per-source check strategy
- Change-detection mechanism and staleness/failure handling
- Data schema (fields, versioning)
- Verification workflow (who verifies, how, audit trail)
- Publish/consumption format details and cadence
- Tech stack and hosting/scheduling
