import { describe, expect, it } from "vitest";
import { extractPrUrls } from "../services/work-product-detection.ts";

describe("extractPrUrls", () => {
  it("extracts GitHub PR URL", () => {
    const text = "Created PR: https://github.com/paperclipai/paperclip/pull/47";
    const results = extractPrUrls(text);
    expect(results).toEqual([
      {
        url: "https://github.com/paperclipai/paperclip/pull/47",
        provider: "github",
        owner: "paperclipai",
        repo: "paperclip",
        number: "47",
      },
    ]);
  });

  it("extracts GitLab MR URL", () => {
    const text = "MR: https://gitlab.com/org/repo/-/merge_requests/123";
    const results = extractPrUrls(text);
    expect(results).toEqual([
      {
        url: "https://gitlab.com/org/repo/-/merge_requests/123",
        provider: "gitlab",
        owner: "org",
        repo: "repo",
        number: "123",
      },
    ]);
  });

  it("extracts multiple URLs from one chunk", () => {
    const text =
      "PR1: https://github.com/a/b/pull/1 and PR2: https://github.com/c/d/pull/2";
    expect(extractPrUrls(text)).toHaveLength(2);
  });

  it("returns empty array for text without PR URLs", () => {
    expect(extractPrUrls("just some log output")).toEqual([]);
  });

  it("handles URL embedded in JSON string", () => {
    const text = '{"content":"https://github.com/org/repo/pull/99"}';
    const results = extractPrUrls(text);
    expect(results).toHaveLength(1);
    expect(results[0].number).toBe("99");
  });

  it("deduplicates same URL appearing twice in one chunk", () => {
    const text =
      "https://github.com/a/b/pull/5 then again https://github.com/a/b/pull/5";
    expect(extractPrUrls(text)).toHaveLength(1);
  });

  it("handles nested GitHub org/repo paths", () => {
    const text = "https://github.com/my-org/my-repo/pull/100";
    const results = extractPrUrls(text);
    expect(results[0].owner).toBe("my-org");
    expect(results[0].repo).toBe("my-repo");
  });
});
