# visa-cost-registry

Version-controlled registry of visa fees, processing times, document
requirements, and appointment mechanics for Indian applicants. Robots
detect change; humans verify it. Publishes CSV and JSON for downstream use.

This is a **data registry, not a scraper**. Nothing automated ever writes a
fee, a processing time, or a document requirement. The only thing that
auto-updates is the FX rate file (`data/fx.yaml`), and only when it moves
less than 5% day-over-day since the last committed rate.

## Core assumption — every applicant is in India

**All data in this repo describes what an applicant holding an Indian
passport, applying from India, actually pays and experiences.**

This matters because official visa sites serve different content by
applicant nationality. VFS Global URLs, for example, look like
`/{applicant}/{lang}/{destination}/` — change `/ind/` to `/gbr/` and you get
a different fee, a different visa application centre, a different
processing time, on the exact same domain. Every source in
`data/sources.yaml` must resolve to the version an applicant in India sees,
and `validate.ts` enforces this (fails on a VFS source URL missing `/ind/`,
a BLS URL not on an India subdomain/path, or `applicant_country` anything
other than `IN`).

**Known limitation:** if a second applicant nationality is ever added,
`applicant_country` needs to become a dimension on the data itself (per
fee, not just per source URL) — the schema does not support that today.

## How it's organized

The unit of data is the **country, not the corridor**: France and Germany
are both Schengen but can have different VAC operators, service charges,
and processing times, so each destination is its own file
(`data/destinations/<iso_code>.yaml`, lowercase ISO 3166-1 alpha-2).
A corridor's genuinely shared rules — for Schengen: the €90 adult consular
fee and child bands, the €30,000 insurance minimum, the main-destination
rule, the 90-in-180 limit — live in `data/rulesets/<id>.yaml` instead.

**Ruleset inheritance**: a destination file may omit any field its ruleset
already supplies. `resolveDestination()` in `scripts/resolve.ts` merges
`fees` and `requirements` field-by-field: a field the destination doesn't
declare inherits the ruleset's value; a field it does declare (even
explicitly `null`) overrides it. See `data/destinations/at.yaml` for a
minimal example (empty `fees: []`, still resolves to all three Schengen
consular fees) and `data/destinations/fr.yaml` for one that overrides a
ruleset fee and adds destination-only ones. Standalone destinations
(`ruleset: null` — UK, Ireland, US, Canada, Australia, NZ, China, Japan)
declare everything themselves; there's nothing to inherit from.

## The three currency bases

A fee is never assumed to convert cleanly from its legal currency to what
an applicant actually pays. Every fee declares `collection_basis`:

- **`native_inr`** — the operator (almost always the VAC) prices it
  directly in INR. Use `amount` as-is. FX is never consulted.
- **`official_inr`** — the fee is set in a foreign currency, but the
  embassy/VAC publishes a periodically-fixed INR amount collected at the
  counter (`collected_amount`). This is authoritative and is **not** a
  currency conversion — official consular rates are fixed administratively
  and can differ meaningfully from market FX. Use `collected_amount`
  as-is; FX is never consulted here either.
- **`fx_derived`** — no official INR figure exists. Convert `amount` via
  `data/fx.yaml` and mark the result `is_approximate: true`.

**The null-vs-contradiction principle**, applied everywhere a value is
paired with its own verification timestamp (`fee.amount`/`verified_on`,
`fee.collected_amount`/`collected_amount_verified_on`,
`outcome.refusal_rate_indian_applicants`/`refusal_rate_as_at`): a null
value with no verification timestamp set means **not yet known** — valid,
resolves to an empty export figure, chased by the weekly staleness report.
A null value with its verification timestamp *set* means **contradiction**
— a verification that produced no number — and fails validation. Staleness
works the same way: a fee verified (or an official INR figure collected)
more than 60 days ago resolves to an empty figure with `is_stale: true`,
never the old number. An `fx_derived` fee also refuses to resolve (same
treatment — empty, `is_stale: true`, not a crash) if `data/fx.yaml` itself
is older than 7 days.

## How data flows out

Nothing downstream ever reads a raw destination or ruleset file directly —
everything goes through `resolveDestination()` first. On every merge to
`main`, `export-csv.ts` writes three files to `docs/export/`, published via
GitHub Pages at `https://viscraft-travel.github.io/visa-cost-registry/`:

- **`fees.csv`** — one row per destination-fee (`iso_code`, `destination`,
  `corridor`, `fee_id`, `label`, `category`, `basis`, `applies_to`,
  `visa_subtype`, `amount`, `currency`, `collection_basis`, `inr_amount`,
  `is_approximate`, `is_stale`, `family_cap_amount`, `family_max_persons`,
  `mandatory`, `verified_on`, `source_url`). Fees with `category: optional`
  are included but flagged — a Quote Builder should never sum them into a
  total; the client pays those at the counter.
- **`destinations.csv`** — one row per destination, covering the timing,
  requirements, and outcome fields.
- **`guides.json`** — resolved records shaped for the Framer Visa Guides
  CMS, with `fee_as_at_date` (`collected_amount_verified_on` for
  `official_inr` fees, `verified_on` otherwise) and `is_approximate` on
  every fee.

Row order is stable (`iso_code`, then `fee_id`) so downstream lookups don't
shift between runs.

**Google Sheets** pulls the CSVs directly:

```
=IMPORTDATA("https://viscraft-travel.github.io/visa-cost-registry/fees.csv")
=IMPORTDATA("https://viscraft-travel.github.io/visa-cost-registry/destinations.csv")
```

**Framer**: investigated directly against Framer's plugin API — there's no
native "fetch this JSON URL" primitive for CMS collections. The practical
path today is the Google Sheets route above, synced into a Framer Managed
Collection via Framer's official Google Sheets CMS plugin. A custom Framer
plugin syncing `guides.json` straight into a Managed Collection is possible
(Framer's own Airtable/Notion/Sheets integrations work exactly that way)
but is a later upgrade, not the initial path.

## Automation

| Script | Workflow | Schedule | Does |
|---|---|---|---|
| `fetch-fx.ts` | `fx-daily.yml` | 06:00 IST daily | Pulls INR rates from Frankfurter (free, keyless, ECB-sourced). The *only* script that auto-commits — and refuses to if any currency moved >5% since yesterday, opening a `[FX ALERT]` issue instead. |
| `check-sources.ts` | `source-check-daily.yml` | 07:00 IST daily | For `check_method: hash` sources only (VFS/BLS/anything unreachable are `human_only` and never fetched): opens `[WRONG PAGE]` on a canary mismatch, `[CHANGE]` on a real content change. Never writes to any file under `data/` — its own hash/snippet cache lives in `actions/cache`, not a commit. |
| `validate.ts` | `validate-on-pr.yml` | every PR | Schema-validates every resolved record plus checks a schema can't express alone: ruleset references, duplicate `iso_code`s, future-dated verifications, `floor_days < standard_runway_days`, and `sources.yaml`'s rules. |
| `staleness-report.ts` | `staleness-weekly.yml` | Mondays | Upserts one summary issue (stale fees, overdue reviews, null-field counts) grouped by corridor and by owner, plus a separate upserted `[MANUAL CHECK DUE]` issue per `human_only` source not checked in 60+ days. |
| `export-csv.ts` | `export-on-merge.yml` | every push to `main` | Regenerates `docs/export/` from resolved records and commits it. |
| `bootstrap-issues.ts` | — (run manually: `npm run bootstrap-issues`) | once | Upserts one `[VERIFY]` issue per destination with a checklist of every field still null. |

No branch protection on `main` — the user is currently the only
contributor, so changes push straight to `main` rather than going through
PRs. Revisit if a second contributor joins.

## Running it locally

```
npm install
npm run validate        # schema + cross-file checks
npm test                 # unit tests (resolve/fetch-fx/check-sources/export logic)
npm run typecheck
npm run fetch-fx          # writes data/fx.yaml from live rates
npm run check-sources     # checks hash-method sources.yaml entries
npm run export-csv        # regenerates docs/export/
npm run bootstrap-issues  # upserts a [VERIFY] issue per destination
npm run staleness-report  # upserts the weekly summary + manual-check issues
```

`GITHUB_TOKEN`/`GITHUB_REPOSITORY` aren't set locally, so anything that
would open or update a GitHub issue prints to stderr instead.

## Verifying a fee, requirement, or timing field

See `docs/VERIFYING.md`.
