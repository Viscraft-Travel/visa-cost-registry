import {
  listDestinationFiles,
  loadYaml,
  loadRuleset,
  resolveDestination,
  collectNullPaths,
  type Destination,
  type ResolvedDestination,
} from "./resolve.js";
import { upsertIssue } from "./github-issues.js";
import path from "node:path";

/**
 * Run once (or safely re-run any time -- it upserts, so re-running just
 * refreshes each destination's checklist rather than spamming a duplicate)
 * to create one GitHub issue per destination: a checklist of every field
 * that still needs first verification.
 *
 * Owners aren't passed as GitHub assignees -- every destination's owner is
 * currently the placeholder "TBD", not a real GitHub username, and the
 * assignees API rejects unknown usernames. Owner is named in the issue
 * body instead; switch to real assignees once real owners are assigned.
 */

const SECTIONS: (keyof ResolvedDestination)[] = ["application", "timing", "requirements", "outcome", "meta"];

export function buildChecklist(resolved: ResolvedDestination): string {
  const lines: string[] = [];

  if (resolved.identity.owner === "TBD") {
    lines.push("- [ ] identity.owner (currently placeholder \"TBD\")");
  }

  for (const section of SECTIONS) {
    const value = resolved[section] as Record<string, unknown>;
    for (const fieldPath of collectNullPaths(value)) {
      lines.push(`- [ ] ${section}.${fieldPath}`);
    }
  }

  for (const fee of resolved.fees) {
    for (const fieldPath of collectNullPaths(fee as unknown as Record<string, unknown>)) {
      if (fieldPath === "id") continue;
      lines.push(`- [ ] fees[\`${fee.id}\`].${fieldPath}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "Nothing outstanding -- fully verified.";
}

export function buildIssueBody(resolved: ResolvedDestination): string {
  const { identity } = resolved;
  return [
    `First-verification checklist for **${identity.name}** (\`${identity.iso_code}\`).`,
    "",
    `Owner: ${identity.owner} | Corridor: ${identity.corridor ?? "none"} | Ruleset: ${identity.ruleset ?? "none (standalone)"} | Tier: ${identity.tier ?? "not set"}`,
    "",
    "## Fields needing first verification",
    "",
    buildChecklist(resolved),
    "",
    "See docs/VERIFYING.md for the verification process.",
  ].join("\n");
}

async function main() {
  for (const file of listDestinationFiles()) {
    const destination = loadYaml<Destination>(file);
    const ruleset = destination.identity.ruleset ? loadRuleset(destination.identity.ruleset) : null;
    const resolved = resolveDestination(destination, ruleset);

    const title = `[VERIFY] ${resolved.identity.iso_code} — ${resolved.identity.name}`;
    await upsertIssue(title, buildIssueBody(resolved), ["first-verification"]);
    console.log(`Upserted: ${title} (${path.basename(file)})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
