/**
 * Shared GitHub Issues helper for every automation in this repo. Reads
 * GITHUB_TOKEN/GITHUB_REPOSITORY from the environment (both set
 * automatically inside a GitHub Actions job); falls back to printing to
 * stderr when run locally without them, rather than failing.
 */

interface IssueClient {
  token: string;
  repo: string;
}

function getClient(): IssueClient | null {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  return { token, repo };
}

async function githubRequest(client: IssueClient, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Opens a new issue unconditionally. Use upsertIssue instead when the caller shouldn't spam a duplicate on every run. */
export async function openIssue(title: string, body: string, labels: string[] = []): Promise<void> {
  const client = getClient();
  if (!client) {
    console.error(`GITHUB_TOKEN/GITHUB_REPOSITORY not set -- printing instead of opening an issue:\n${title}\n${body}`);
    return;
  }
  const res = await githubRequest(client, `/repos/${client.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) console.error(`Failed to open issue "${title}": ${res.status} ${await res.text()}`);
}

/** Returns the number of an open (non-PR) issue with this exact title, or null if none exists. */
export async function findOpenIssueNumberByTitle(title: string): Promise<number | null> {
  const client = getClient();
  if (!client) return null;
  const res = await githubRequest(client, `/repos/${client.repo}/issues?state=open&per_page=100`);
  if (!res.ok) {
    console.error(`Failed to list issues: ${res.status} ${await res.text()}`);
    return null;
  }
  const issues = (await res.json()) as { number: number; title: string; pull_request?: unknown }[];
  const match = issues.find((i) => !i.pull_request && i.title === title);
  return match ? match.number : null;
}

/** Updates the body of the existing open issue with this title, or creates one if none exists. Use for anything that recurs (a weekly report, a per-source check-due notice) so re-running never spams duplicates. */
export async function upsertIssue(title: string, body: string, labels: string[] = []): Promise<void> {
  const client = getClient();
  if (!client) {
    console.error(`GITHUB_TOKEN/GITHUB_REPOSITORY not set -- printing instead of upserting an issue:\n${title}\n${body}`);
    return;
  }
  const existing = await findOpenIssueNumberByTitle(title);
  if (existing) {
    const res = await githubRequest(client, `/repos/${client.repo}/issues/${existing}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) console.error(`Failed to update issue #${existing}: ${res.status} ${await res.text()}`);
  } else {
    await openIssue(title, body, labels);
  }
}
