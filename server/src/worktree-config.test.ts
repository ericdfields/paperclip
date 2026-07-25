import { describe, expect, it } from "vitest";
import { isLoopbackHost, rewriteLocalUrlPort } from "./worktree-config.js";

describe("rewriteLocalUrlPort", () => {
  it("rewrites the port for loopback base URLs", () => {
    expect(rewriteLocalUrlPort("http://localhost:5678", 3101)).toBe("http://localhost:3101/");
    expect(rewriteLocalUrlPort("http://127.0.0.1:9999", 3101)).toBe("http://127.0.0.1:3101/");
    expect(rewriteLocalUrlPort("http://[::1]:9999", 3101)).toBe("http://[::1]:3101/");
  });

  it("leaves explicit external base URLs untouched (BRO-1558)", () => {
    // A Tailscale Serve listener on :8443 must survive; rewriting its port to the internal
    // listen port produced an unreachable URL that leaked to agents as a dead PAPERCLIP_API_URL.
    const serve = "https://erics-mac-studio-1.tailc54c7.ts.net:8443";
    expect(rewriteLocalUrlPort(serve, 3101)).toBe(serve);
  });

  it("leaves URLs without an explicit port stable", () => {
    expect(rewriteLocalUrlPort("https://paperclip.example.com", 3101)).toBe(
      "https://paperclip.example.com",
    );
    expect(rewriteLocalUrlPort("http://localhost", 3101)).toBe("http://localhost");
  });

  it("passes through empty and unparseable inputs", () => {
    expect(rewriteLocalUrlPort(undefined, 3101)).toBeUndefined();
    expect(rewriteLocalUrlPort("", 3101)).toBeUndefined();
    expect(rewriteLocalUrlPort("not a url", 3101)).toBe("not a url");
  });
});

describe("isLoopbackHost", () => {
  it("matches loopback hosts including bracketed IPv6", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("rejects external hosts", () => {
    expect(isLoopbackHost("erics-mac-studio-1.tailc54c7.ts.net")).toBe(false);
    expect(isLoopbackHost("paperclip.example.com")).toBe(false);
  });
});
