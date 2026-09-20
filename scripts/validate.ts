import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  loadYaml,
  listDestinationFiles,
  listRulesetFiles,
  loadFx,
  resolveDestination,
  type Destination,
  type ResolvedDestination,
  type Ruleset,
  type Fee,
} from "./resolve.js";

// ajv and ajv-formats ship CJS with no ESM default export, which trips up
// `moduleResolution: NodeNext`. createRequire is the standard workaround.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const SCHEMA_DIR = path.resolve(process.cwd(), "schema");

interface ValidationError {
  file: string;
  message: string;
}

function loadSchema(name: string) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
}

function isFutureDate(dateStr: string | null | undefined, today: Date): boolean {
  if (!dateStr) return false;
  return new Date(dateStr).getTime() > today.getTime();
}

function checkFeeDatesNotInFuture(fees: Fee[], fileLabel: string, today: Date, errors: ValidationError[]) {
  for (const fee of fees) {
    if (isFutureDate(fee.verified_on, today)) {
      errors.push({ file: fileLabel, message: `fee '${fee.id}': verified_on (${fee.verified_on}) is in the future` });
    }
    if (isFutureDate(fee.collected_amount_verified_on, today)) {
      errors.push({
        file: fileLabel,
        message: `fee '${fee.id}': collected_amount_verified_on (${fee.collected_amount_verified_on}) is in the future`,
      });
    }
  }
}

async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  const destinationSchema = loadSchema("destination.schema.json");
  const rulesetSchema = loadSchema("ruleset.schema.json");
  const validateDestination = ajv.compile(destinationSchema);
  const validateRuleset = ajv.compile(rulesetSchema);

  const errors: ValidationError[] = [];
  const today = new Date();
  const fx = loadFx();
  if (!fx) {
    console.warn("[validate] data/fx.yaml not found yet -- skipping currency-in-fx.yaml checks.");
  }

  // 1. Load and schema-validate every ruleset.
  const rulesets = new Map<string, Ruleset>();
  for (const file of listRulesetFiles()) {
    const label = path.relative(process.cwd(), file);
    const ruleset = loadYaml<Ruleset>(file);
    if (!validateRuleset(ruleset)) {
      for (const e of validateRuleset.errors ?? []) {
        errors.push({ file: label, message: `${e.instancePath || "/"} ${e.message}` });
      }
    }
    if (ruleset.id !== path.basename(file, ".yaml")) {
      errors.push({ file: label, message: `id '${ruleset.id}' does not match filename` });
    }
    if (rulesets.has(ruleset.id)) {
      errors.push({ file: label, message: `duplicate ruleset id '${ruleset.id}'` });
    }
    rulesets.set(ruleset.id, ruleset);
  }

  // 2. Load every destination, check identity, resolve against its ruleset,
  //    then schema-validate the RESOLVED record (never the raw file).
  const seenIsoCodes = new Set<string>();
  for (const file of listDestinationFiles()) {
    const label = path.relative(process.cwd(), file);
    const destination = loadYaml<Destination>(file);
    const isoCode = destination.identity?.iso_code;

    if (isoCode !== path.basename(file, ".yaml")) {
      errors.push({ file: label, message: `identity.iso_code '${isoCode}' does not match filename` });
    }
    if (isoCode) {
      if (seenIsoCodes.has(isoCode)) {
        errors.push({ file: label, message: `duplicate iso_code '${isoCode}'` });
      }
      seenIsoCodes.add(isoCode);
    }

    const rulesetId = destination.identity?.ruleset ?? null;
    let ruleset: Ruleset | null = null;
    if (rulesetId !== null) {
      ruleset = rulesets.get(rulesetId) ?? null;
      if (!ruleset) {
        errors.push({ file: label, message: `ruleset '${rulesetId}' referenced but not found` });
      }
    }

    let resolved: ResolvedDestination;
    try {
      resolved = resolveDestination(destination, ruleset);
    } catch (e) {
      errors.push({ file: label, message: `resolve failed: ${(e as Error).message}` });
      continue;
    }

    if (!validateDestination(resolved)) {
      for (const e of validateDestination.errors ?? []) {
        errors.push({ file: label, message: `${e.instancePath || "/"} ${e.message}` });
      }
    }

    // Checks a JSON Schema can't express on its own:
    checkFeeDatesNotInFuture(resolved.fees, label, today, errors);

    if (isFutureDate(resolved.meta?.last_reviewed, today)) {
      errors.push({ file: label, message: `meta.last_reviewed (${resolved.meta.last_reviewed}) is in the future` });
    }
    const asAt = (resolved.outcome as { refusal_rate_as_at?: string | null })?.refusal_rate_as_at;
    if (isFutureDate(asAt, today)) {
      errors.push({ file: label, message: `outcome.refusal_rate_as_at (${asAt}) is in the future` });
    }

    const timing = resolved.timing as { floor_days?: number | null; standard_runway_days?: number | null };
    if (
      timing?.floor_days != null &&
      timing?.standard_runway_days != null &&
      timing.floor_days >= timing.standard_runway_days
    ) {
      errors.push({
        file: label,
        message: `timing.floor_days (${timing.floor_days}) must be less than standard_runway_days (${timing.standard_runway_days})`,
      });
    }

    if (fx) {
      for (const fee of resolved.fees) {
        if (fee.collection_basis === "fx_derived" && fee.currency && !(fee.currency in fx.rates)) {
          errors.push({
            file: label,
            message: `fee '${fee.id}': currency '${fee.currency}' not found in data/fx.yaml`,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} validation error(s):\n`);
    for (const e of errors) console.error(`  [${e.file}] ${e.message}`);
    process.exitCode = 1;
  } else {
    console.log("All ruleset and destination files are valid.");
  }
}

main();
