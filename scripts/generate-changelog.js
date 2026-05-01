#!/usr/bin/env node
/**
 * generate-changelog.js
 *
 * Pulls all "Done" issues from a Linear custom view and recent merged PRs from
 * GitHub, then writes combined context to LINEAR.mdx.
 *
 * Usage, run in terminal:
 *   node scripts/generate-changelog.js
 *   node scripts/generate-changelog.js --version v0.5.0
 *   node scripts/generate-changelog.js --version v0.5.0 --label "Apr 14, 2026"
 *   node scripts/generate-changelog.js --issues BRK-123,BRK-456 --version v0.5.0
 *   node scripts/generate-changelog.js --since "2026-04-20"
 *
 * Options:
 *   --version   Version label for the draft <Update> block (e.g. v0.5.0). Optional.
 *   --label     Date label for the draft <Update> block (e.g. "Apr 14, 2026"). Defaults to today.
 *   --issues    Comma-separated Linear identifiers (e.g. BRK-123,BRK-124) to pull specific
 *               issues instead of the configured view.
 *   --since     Only include GitHub PRs merged after this date (e.g. "2026-04-20"). Defaults to 14 days ago.
 *   --pr-limit  Max number of GitHub PRs to fetch (default: 30).
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

try {
  const envFile = readFileSync(envPath, "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch {
  // .env not found — rely on environment variables already set
}

const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error("Error: LINEAR_API_KEY not set. Add it to your .env file.");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const issueArg = get("--issues");
const version = get("--version");
const labelArg = get("--label");
const sinceArg = get("--since");
const prLimitArg = get("--pr-limit");

// Linear GraphQL helpers
async function linearQuery(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    console.error("Linear API error:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data;
}

const ISSUE_FIELDS = `
  identifier
  title
  description
  url
  completedAt
  state { name type }
  labels { nodes { name } }
  project { name }
  team { name key }
`;

// Fetch all issues from the configured custom view, filtered to "Done" state
async function fetchFromView() {
  const viewId = process.env.LINEAR_VIEW_ID;
  if (!viewId) {
    console.error(
      "Error: LINEAR_VIEW_ID not set. Add it to your .env file.\n" +
      "Find it in your Linear view URL: linear.app/breaknine/view/whats-new-and-improved-<ID>"
    );
    process.exit(1);
  }

  console.log(`Fetching issues from view: ${viewId}...`);

  let allIssues = [];
  let cursor = null;
  let page = 0;

  do {
    const query = `
      query($viewId: String!, $after: String) {
        customView(id: $viewId) {
          name
          issues(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }
    `;
    const data = await linearQuery(query, { viewId, after: cursor });
    const view = data.customView;

    if (page === 0) console.log(`View: "${view.name}"`);

    allIssues = allIssues.concat(view.issues.nodes);
    cursor = view.issues.pageInfo.hasNextPage ? view.issues.pageInfo.endCursor : null;
    page++;
  } while (cursor);

  const done = allIssues.filter(
    (i) =>
      i.state?.type === "completed" ||
      i.state?.name?.toLowerCase() === "done"
  );

  console.log(
    `${allIssues.length} total issue(s) in view → ${done.length} marked Done.`
  );
  return done;
}

// Fetch specific issues by identifier (e.g. BRK-123)
async function fetchByIdentifiers(identifiers) {
  const issues = [];
  for (const id of identifiers) {
    const query = `
      query($filter: IssueFilter!) {
        issues(filter: $filter, first: 1) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;
    const data = await linearQuery(query, {
      filter: { identifier: { eq: id.trim() } },
    });
    if (data.issues.nodes.length) {
      issues.push(data.issues.nodes[0]);
    } else {
      console.warn(`  Warning: issue ${id} not found in Linear.`);
    }
  }
  return issues;
}

// GitHub PR fetching
async function fetchMergedPRs() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    console.log("Skipping GitHub PRs (GITHUB_TOKEN or GITHUB_REPO not set).");
    return [];
  }

  const sinceDate = sinceArg
    ? new Date(sinceArg)
    : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const limit = parseInt(prLimitArg ?? "30", 10);

  console.log(`\nFetching merged PRs from ${repo} since ${sinceDate.toDateString()}...`);

  const [owner, repoName] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls?state=closed&sort=updated&direction=desc&per_page=${limit}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    console.warn(`  GitHub API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const prs = await res.json();
  const merged = prs.filter(
    (pr) => pr.merged_at && new Date(pr.merged_at) >= sinceDate
  );

  console.log(`${prs.length} closed PRs fetched → ${merged.length} merged since cutoff.`);
  return merged;
}

// Format helpers
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function todayLabel() {
  return formatDate(new Date());
}

function groupIssues(issues) {
  const groups = {};
  for (const issue of issues) {
    const groupName = issue.project?.name ?? issue.team?.name ?? "General";
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(issue);
  }
  return groups;
}

// Output builders
function buildDraftUpdate(issues, dateLabel, versionLabel) {
  const description = versionLabel ?? "vX.X.X";
  const groups = groupIssues(issues);

  const lines = [
    `<Update label="${dateLabel}" description="${description}">`,
    `  {/* DRAFT — review and edit before publishing */}`,
    "",
  ];

  for (const [group, groupIssues] of Object.entries(groups)) {
    lines.push(`  ### ${group}`);
    lines.push("");
    for (const issue of groupIssues) {
      lines.push(`  **${issue.title}**`);
      lines.push("");
      if (issue.description) {
        const firstPara = issue.description.split(/\n{2,}/)[0].trim();
        const cleaned = firstPara
          .replace(/\*\*/g, "")
          .replace(/#{1,6}\s/g, "")
          .trim();
        if (cleaned) {
          lines.push(`  ${cleaned}`);
          lines.push("");
        }
      } else {
        lines.push(`  {/* TODO: add description for ${issue.identifier} */}`);
        lines.push("");
      }
    }
  }

  lines.push(`</Update>`);
  return lines.join("\n");
}

function writeLinearMdx(issues, prs, draft, dateLabel) {
  const linearPath = resolve(__dirname, "../LINEAR.mdx");
  const groups = groupIssues(issues);

  const lines = [
    `# Linear + GitHub context for changelog — ${dateLabel}`,
    "",
    `_Generated ${new Date().toLocaleString()} · ${issues.length} Done issue(s) from Linear · ${prs.length} merged PR(s) from GitHub_`,
    "",
    "---",
    "",
    "## Linear Issues",
    "",
  ];

  for (const [group, groupIssues] of Object.entries(groups)) {
    lines.push(`### ${group}`);
    lines.push("");
    for (const issue of groupIssues) {
      const labels = issue.labels.nodes.map((l) => l.name).join(", ");
      lines.push(`**${issue.identifier}: ${issue.title}**`);
      lines.push(`State: ${issue.state?.name ?? "Unknown"}`);
      if (labels) lines.push(`Labels: ${labels}`);
      if (issue.completedAt) lines.push(`Completed: ${formatDate(issue.completedAt)}`);
      lines.push(`URL: ${issue.url}`);
      if (issue.description) {
        lines.push("");
        lines.push(
          issue.description.length > 800
            ? issue.description.slice(0, 800) + "…"
            : issue.description
        );
      }
      lines.push("");
    }
  }

  if (prs.length) {
    lines.push("---", "", "## GitHub PRs (merged)", "");
    for (const pr of prs) {
      lines.push(`**#${pr.number}: ${pr.title}**`);
      lines.push(`Branch: ${pr.head?.ref ?? "unknown"}`);
      lines.push(`Merged: ${formatDate(pr.merged_at)}`);
      lines.push(`Author: ${pr.user?.login ?? "unknown"}`);
      lines.push(`URL: ${pr.html_url}`);
      if (pr.body && pr.body.trim()) {
        lines.push("");
        const body = pr.body.trim();
        lines.push(body.length > 1000 ? body.slice(0, 1000) + "…" : body);
      }
      lines.push("");
    }
  }

  lines.push("---", "", "## Draft `<Update>` block", "", "```mdx", draft, "```", "");

  writeFileSync(linearPath, lines.join("\n"), "utf8");
}

// Main
async function main() {
  console.log("Connecting to Linear...\n");

  let issues;
  if (issueArg) {
    const ids = issueArg.split(",").map((s) => s.trim());
    console.log(`Fetching ${ids.length} specific issue(s): ${ids.join(", ")}`);
    issues = await fetchByIdentifiers(ids);
  } else {
    issues = await fetchFromView();
  }

  const prs = await fetchMergedPRs();

  if (!issues.length && !prs.length) {
    console.log('No "Done" issues or merged PRs found.');
    process.exit(0);
  }

  const dateLabel = labelArg ?? todayLabel();
  const draft = buildDraftUpdate(issues, dateLabel, version);
  writeLinearMdx(issues, prs, draft, dateLabel);

  console.log(`\nLINEAR.mdx updated with ${issues.length} Linear issue(s) and ${prs.length} GitHub PR(s).`);
  console.log(`Next step: ask the agent to "look at LINEAR.mdx and apply any context to changelog.mdx"`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
