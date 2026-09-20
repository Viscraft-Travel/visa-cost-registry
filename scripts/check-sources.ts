import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseHtml } from "node-html-parser";
import { loadSources, type Source } from "./resolve.js";

/**
 * For each check_method: "hash" source, fetches the India-facing version of
 * the page, normalises it to visible text, and either:
 *   - opens a "[WRONG PAGE]" issue if the expected canary text is missing or
 *     a forbidden one is present (a different failure from a content change
 *     -- e.g. geolocation silently served the wrong country's page),
 *   - opens a "[CHANGE]" issue if the canary passes but the hash differs
 *     from what was cached last run, or
 *   - does nothing if the hash is unchanged.
 *
 * Never writes to sources.yaml or any file under data/ -- last_checked/
 * last_changed/last_seen_snippet in sources.yaml are human-updated, the
 * same way verified_on is, as part of resolving the issue this script
 * opens (see docs/VERIFYING.md). The hash/snippet this script needs to
 * detect a *repeat* of an already-flagged change (so it doesn't reopen the
 * same issue every day while a human is still working on it) lives in a
 * local cache file instead, which the workflow persists via actions/cache
 * -- not a git commit. fetch-fx.ts remains the only auto-commit in the repo.
 *
 * check_method: "human_only" sources (VFS, BLS, and anything unreachable)
 * are skipped entirely -- never fetched, per the no-bypassing-bot-
 * protection rule.
 */

const CACHE_PATH = path.resolve(process.cwd(), ".cache/check-sources.json");
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_COUNT = 3;
const DELAY_BETWEEN_REQUESTS_MS = 3_000;
const USER_AGENT = "ViscraftVisaRegistryBot/1.0 (+https://github.com/Viscraft-Travel/visa-cost-registry)";

export interface CacheEntry {
  hash: string;
  snippet: string;
  checked_at: string;
}
export type Cache = Record<string, CacheEntry>;

export function cacheKey(source: Source): string {
  return `${source.iso_code}:${source.what_it_covers}`;
}

export function loadCache(): Cache {
  if (!fs.existsSync(CACHE_PATH)) return {};
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
}

export function saveCache(cache: Cache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Strips script/style/nav/header/footer and common cookie-banner elements,
 * extracts visible text, collapses whitespace, and strips date-like
 * substrings so a page's own "last updated: <date>" footer doesn't cause a
 * spurious hash change every single day.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

export function normalizeHtml(html: string): string {
  const root = parseHtml(html);
  for (const selector of ["script", "style", "nav", "header", "footer", "noscript"]) {
    root.querySelectorAll(selector).forEach((el) => el.remove());
  }
  root.querySelectorAll("[class],[id]").forEach((el) => {
    const marker = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`.toLowerCase();
    if (marker.includes("cookie") || marker.includes("banner") || marker.includes("consent")) {
      el.remove();
    }
  });

  // Strip remaining tags by replacing them with a space, not by reading
  // .textContent -- textContent concatenates adjacent block elements with
  // no separator (e.g. "2026Fee"), which breaks word-boundary regexes like
  // the date stripper below.
  let text = decodeEntities(root.innerHTML.replace(/<[^>]*>/g, " "));
  text = text.replace(/\s+/g, " ").trim();
  // Strip common date formats (e.g. "10 September 2026", "2026-09-10", "09/10/2026").
  text = text.replace(
    /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
    "[DATE]"
  );
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[DATE]");
  text = text.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[DATE]");
  return text;
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface CanaryResult {
  ok: boolean;
  missing: string[];
  forbidden: string[];
}

export function checkCanaries(text: string, canary: string[], mustNotContain: string[] = []): CanaryResult {
  const haystack = text.toLowerCase();
  const missing = canary.filter((c) => !haystack.includes(c.toLowerCase()));
  const forbidden = mustNotContain.filter((c) => haystack.includes(c.toLowerCase()));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/** Minimal robots.txt check: Disallow rules under "User-agent: *" only. */
export function isAllowedByRobots(robotsTxt: string, urlPath: string): boolean {
  const lines = robotsTxt.split("\n").map((l) => l.trim());
  let inWildcardBlock = false;
  const disallows: string[] = [];
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      inWildcardBlock = value === "*";
    } else if (key === "disallow" && inWildcardBlock && value) {
      disallows.push(value);
    }
  }
  return !disallows.some((rule) => urlPath.startsWith(rule));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = RETRY_COUNT): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "Accept-Language": "en-IN,en;q=0.9",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      clearTimeout(timeout);
      if (attempt === retries) throw e;
      await sleep(2 ** attempt * 1000); // 1s, 2s, 4s
    }
  }
  throw new Error("unreachable");
}

async function openIssue(title: string, body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error(`GITHUB_TOKEN/GITHUB_REPOSITORY not set -- printing instead of opening an issue:\n${title}\n${body}`);
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) console.error(`Failed to open issue: ${res.status} ${await res.text()}`);
}

async function checkOneSource(source: Source, cache: Cache): Promise<void> {
  const url = new URL(source.url);

  let robotsAllowed = true;
  try {
    const robotsRes = await fetchWithRetry(`${url.origin}/robots.txt`, 1);
    if (robotsRes.ok) robotsAllowed = isAllowedByRobots(await robotsRes.text(), url.pathname);
  } catch {
    // No robots.txt or it failed to load -- proceed, most sites have none.
  }
  if (!robotsAllowed) {
    console.warn(`[check-sources] ${source.iso_code}: disallowed by robots.txt, skipping.`);
    return;
  }

  let res: Response;
  try {
    res = await fetchWithRetry(source.url);
  } catch (e) {
    console.error(`[check-sources] ${source.iso_code}: fetch failed after retries: ${(e as Error).message}`);
    return;
  }
  if (!res.ok) {
    console.error(`[check-sources] ${source.iso_code}: HTTP ${res.status}`);
    return;
  }

  const text = normalizeHtml(await res.text());
  const canaryResult = checkCanaries(text, source.canary, source.canary_must_not_contain ?? []);

  if (!canaryResult.ok) {
    await openIssue(
      `[WRONG PAGE] ${source.iso_code} — ${source.what_it_covers}`,
      [
        `The fetched page did not match the expected canary text for ${source.iso_code} (${source.what_it_covers}).`,
        "This is a different failure from a content change -- it likely means geolocation served the wrong country's version, or the page structure changed entirely.",
        "",
        canaryResult.missing.length ? `Missing expected canary text: ${canaryResult.missing.join(", ")}` : "",
        canaryResult.forbidden.length ? `Found forbidden canary text: ${canaryResult.forbidden.join(", ")}` : "",
        "",
        `URL: ${source.url}`,
        "",
        "If this keeps happening, consider marking this source `check_method: human_only` in data/sources.yaml, or investigate an India-based fetch egress.",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return;
  }

  const hash = hashText(text);
  const key = cacheKey(source);
  const previous = cache[key];
  const snippet = text.slice(0, 300);

  if (previous && previous.hash !== hash) {
    await openIssue(
      `[CHANGE] ${source.iso_code} — ${source.what_it_covers}`,
      [
        `The content at this source appears to have changed since it was last checked.`,
        "",
        `URL: ${source.url}`,
        "",
        "**Previously seen (snippet):**",
        previous.snippet,
        "",
        "**Now seen (snippet):**",
        snippet,
        "",
        "**Verifier checklist:**",
        "- [ ] Open the URL above and read the current value yourself",
        "- [ ] Update the relevant destination file's fee/timing/requirement fields",
        "- [ ] Set verified_on (and collected_amount_verified_on if applicable) and verified_by",
        "- [ ] Add a change_log entry",
        "- [ ] Update this source's last_checked/last_changed/last_seen_snippet in data/sources.yaml",
        "- [ ] Open a PR",
      ].join("\n")
    );
  }

  cache[key] = { hash, snippet, checked_at: new Date().toISOString() };
}

async function main() {
  const sources = loadSources();
  if (!sources) {
    console.log("[check-sources] data/sources.yaml not found -- nothing to check.");
    return;
  }

  const hashSources = sources.filter((s) => s.check_method === "hash");
  console.log(`[check-sources] ${hashSources.length} source(s) with check_method: hash (of ${sources.length} total).`);

  const cache = loadCache();
  for (const source of hashSources) {
    await checkOneSource(source, cache);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }
  saveCache(cache);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
