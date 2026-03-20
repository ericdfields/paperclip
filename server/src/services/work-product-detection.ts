import { logger } from "../middleware/logger.js";
import type { IssueWorkProduct } from "@paperclipai/shared";

export interface ExtractedPr {
  url: string;
  provider: "github" | "gitlab";
  owner: string;
  repo: string;
  number: string;
}

const PR_URL_PATTERNS = [
  // GitHub: https://github.com/{owner}/{repo}/pull/{number}
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g,
  // GitLab: https://gitlab.com/{owner}/{repo}/-/merge_requests/{number}
  /https:\/\/gitlab\.com\/([\w.-]+)\/([\w.-]+)\/-\/merge_requests\/(\d+)/g,
];

export function extractPrUrls(text: string): ExtractedPr[] {
  const seen = new Set<string>();
  const results: ExtractedPr[] = [];

  for (const pattern of PR_URL_PATTERNS) {
    // Reset lastIndex since we reuse the regex with /g flag
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[0];
      if (seen.has(url)) continue;
      seen.add(url);
      const provider = url.includes("github.com") ? "github" : "gitlab";
      results.push({
        url,
        provider,
        owner: match[1],
        repo: match[2],
        number: match[3],
      });
    }
  }

  return results;
}
