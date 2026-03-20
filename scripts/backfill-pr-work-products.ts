import { createDb } from "../packages/db/src/client.js";
import { issues } from "../packages/db/src/schema/issues.js";
import { issueComments } from "../packages/db/src/schema/issue_comments.js";
import { issueWorkProducts } from "../packages/db/src/schema/issue_work_products.js";
import { extractPrUrls } from "../server/src/services/work-product-detection.js";
import { workProductService } from "../server/src/services/work-products.js";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const wpSvc = workProductService(db);

  // Load all issues
  const allIssues = await db.select().from(issues);
  console.log(`Scanning ${allIssues.length} issues...`);

  // Load all comments
  const allComments = await db.select().from(issueComments);
  console.log(`Scanning ${allComments.length} comments...`);

  // Load all existing PR work products for dedup
  const allWps = await db.select().from(issueWorkProducts);
  const existingUrlsByIssue = new Map<string, Set<string>>();
  const issuesWithPr = new Set<string>();
  for (const wp of allWps) {
    if (wp.type === "pull_request") issuesWithPr.add(wp.issueId);
    if (!wp.url) continue;
    let set = existingUrlsByIssue.get(wp.issueId);
    if (!set) {
      set = new Set();
      existingUrlsByIssue.set(wp.issueId, set);
    }
    set.add(wp.url);
  }

  // Build per-issue seen URLs (starts with existing)
  const seenPerIssue = new Map<string, Set<string>>();
  function getSeen(issueId: string): Set<string> {
    let set = seenPerIssue.get(issueId);
    if (!set) {
      set = new Set(existingUrlsByIssue.get(issueId) ?? []);
      seenPerIssue.set(issueId, set);
    }
    return set;
  }

  // Collect what to create
  const toCreate: Array<{
    issueId: string;
    companyId: string;
    url: string;
    provider: string;
    number: string;
    owner: string;
    repo: string;
    source: string;
  }> = [];

  // Scan comments
  for (const comment of allComments) {
    const prs = extractPrUrls(comment.body);
    const seen = getSeen(comment.issueId);
    for (const pr of prs) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      toCreate.push({
        issueId: comment.issueId,
        companyId: comment.companyId,
        ...pr,
        source: `comment ${comment.id.slice(0, 8)}`,
      });
    }
  }

  // Scan issue descriptions
  for (const issue of allIssues) {
    if (!issue.description) continue;
    const prs = extractPrUrls(issue.description);
    const seen = getSeen(issue.id);
    for (const pr of prs) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      toCreate.push({
        issueId: issue.id,
        companyId: issue.companyId,
        ...pr,
        source: "description",
      });
    }
  }

  if (toCreate.length === 0) {
    console.log("No PR URLs found to backfill.");
    process.exit(0);
  }

  console.log(`\nFound ${toCreate.length} PR work products to create:\n`);

  for (const item of toCreate) {
    const isPrimary = !issuesWithPr.has(item.issueId);
    console.log(
      `  ${isPrimary ? "[primary]" : "         "} ${item.issueId.slice(0, 8)} <- ${item.provider} PR #${item.number} (${item.owner}/${item.repo}) from ${item.source}`,
    );

    if (apply) {
      await wpSvc.createForIssue(item.issueId, item.companyId, {
        type: "pull_request" as const,
        provider: item.provider,
        externalId: item.number,
        title: `${item.owner}/${item.repo}#${item.number}`,
        url: item.url,
        status: "active",
        isPrimary,
        healthStatus: "unknown" as const,
        reviewState: "none" as const,
      });
    }

    issuesWithPr.add(item.issueId);
  }

  if (!apply) {
    console.log(`\nDry run: ${toCreate.length} work products would be created`);
    console.log("Re-run with --apply to persist changes");
    process.exit(0);
  }

  console.log(`\nCreated ${toCreate.length} work products`);
  process.exit(0);
}

void main();
