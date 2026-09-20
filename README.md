# visa-cost-registry

Version-controlled registry of visa fees, processing times, and requirements for Indian applicants.

Robots detect change; humans verify. Publishes CSV and JSON for downstream use.

## What this is

A single source of truth for visa data: fees, processing times, document
requirements, appointment mechanics. One file per destination country. Data
lives in version-controlled files. Robots detect change; humans verify it.
The repo publishes CSV and JSON that a Google Sheet and the Viscraft Framer
site **pull** — this repo never writes to either of them.

This is a **data registry, not a scraper**. Nothing automated ever writes a
fee, a processing time, or a document requirement. The only thing that
auto-updates is the FX rate file (`data/fx.yaml`), and only when it moves
less than 5% day-over-day.

## Core assumption — every applicant is in India

**All data in this repo describes what an applicant holding an Indian
passport, applying from India, actually pays and experiences.**

This matters because official visa sites serve different content by
applicant nationality. VFS Global URLs, for example, look like
`/{applicant}/{lang}/{destination}/` — change `/ind/` to `/gbr/` and you get
a different fee, a different visa application centre, a different
processing time, on the exact same domain. Every source in
`data/sources.yaml` must resolve to the version an applicant in India sees,
and `validate.ts` enforces this (fails the build if a VFS source URL is
missing `/ind/`, or `applicant_country` is anything other than `IN`).

**Known limitation:** if a second applicant nationality is ever added,
`applicant_country` needs to become a dimension on the data itself (per
fee, not just per source URL) — the schema does not support that today.

## Concept (high level)

- **Country, not corridor.** France and Germany are both Schengen but can
  have different VAC operators, service charges and processing times —
  each destination is its own file. A corridor's genuinely shared rules
  (e.g. the Schengen €90 consular fee) live in `data/rulesets/`; a
  destination file inherits from its ruleset and overrides anything that
  differs.
- **Detect**: automated checks watch official government/consular/VAC
  sources for changes and open a GitHub issue — they never write to a data
  file.
- **Verify**: a human reads the source page and commits the change
  themselves. See `docs/VERIFYING.md`.
- **Publish**: `resolve.ts` merges each destination against its ruleset,
  applies currency rules, and nulls anything stale; `export-csv.ts` writes
  the resolved records to `docs/export/` (`fees.csv`, `destinations.csv`,
  `guides.json`) on every merge to `main`, published via GitHub Pages.

## Status

Schemas and two reference destination files (`fr.yaml`, `jp.yaml`) plus
`data/rulesets/schengen.yaml`) are in place — see those files for the exact
data shape, including how ruleset inheritance/override works at the
individual-field level. Everything past that (`resolve.ts`, `validate.ts`,
the remaining 35 destination files, `sources.yaml`, the check/staleness
scripts, and the CSV/JSON export) is still to be built.

## TBD (to be filled in as later build steps land)

- The exact `IMPORTDATA` formula for the Google Sheet
- How the three currency bases (`native_inr` / `official_inr` /
  `fx_derived`) resolve, in full, once `resolve.ts` exists
- GitHub Pages URL (will be the default `https://viscraft-travel.github.io/visa-cost-registry/`)
- How this feeds the Framer Visa Guides CMS — investigated: Framer has no
  native "fetch this JSON URL" primitive for CMS collections. The practical
  near-term path is the Google Sheets route this README already assumes
  (Sheet via `IMPORTDATA`, synced into Framer via its official Google
  Sheets CMS plugin). A custom Framer plugin syncing `guides.json` directly
  into a Managed Collection is possible but is a later upgrade, not the
  initial path.
