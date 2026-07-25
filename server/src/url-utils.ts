/**
 * Shared base-URL helpers used by both server startup (index.ts) and worktree
 * config materialization (worktree-config.ts). Keeping a single source of truth
 * prevents the two production paths from drifting apart (BRO-1558).
 */

export function isLoopbackHost(host: string): boolean {
  // Strip surrounding brackets so a URL hostname form ("[::1]") matches too.
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Rewrite the port of a loopback base URL to `port`, leaving everything else intact.
 *
 * Only loopback hosts are rewritten. An explicit external base URL (e.g. a Tailscale
 * Serve listener on a non-default port like :8443) must survive untouched: rewriting
 * its port to the internal listen port yields an unreachable URL (scheme/port mismatch)
 * that then propagates to spawned agents as a dead PAPERCLIP_API_URL. (BRO-1558)
 */
export function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
    if (!parsed.port) return rawUrl;
    if (!isLoopbackHost(parsed.hostname)) return rawUrl;
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
