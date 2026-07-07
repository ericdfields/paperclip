import { useSyncExternalStore } from "react";

/**
 * Module-level store tracking whether the live-updates WebSocket
 * (see {@link ../context/LiveUpdatesProvider}) is currently connected.
 *
 * The socket pushes TanStack Query cache invalidations for the same data most
 * `refetchInterval` polls target, so those polls are redundant while it is up.
 * Keeping the flag in a module-level store (rather than React context) lets it
 * be read synchronously from inside `refetchInterval` functions without
 * threading a hook through dozens of call sites.
 */
let connected = false;
const listeners = new Set<() => void>();

export function setLiveConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) listener();
}

export function isLiveConnected(): boolean {
  return connected;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook mirror of {@link isLiveConnected}, re-rendering on change. */
export function useLiveConnected(): boolean {
  return useSyncExternalStore(subscribe, isLiveConnected, () => false);
}

/** Test-only: reset the store between cases. */
export function __resetLiveConnectedForTests(): void {
  connected = false;
  listeners.clear();
}

const DEFAULT_FALLBACK_MS = 30_000;

/**
 * Builds a TanStack Query `refetchInterval` value that backs off to a slow
 * safety-net cadence (`fallbackMs`) while the live-updates WebSocket is
 * connected, and polls at `baseMs` when the socket is down.
 *
 * Passing `false` as `baseMs` keeps a query opted out of polling entirely, so
 * existing conditional intervals can be wrapped directly, e.g.
 * `refetchInterval: liveRefetchInterval(hasLiveRuns ? 5000 : false)`.
 *
 * Returning a function means TanStack re-evaluates the interval as connection
 * state changes; the safety net still fires every `fallbackMs` so a dropped or
 * missed socket event self-heals within one fallback window. The result is
 * never faster than `baseMs`.
 */
export function liveRefetchInterval(
  baseMs: number | false,
  fallbackMs: number = DEFAULT_FALLBACK_MS,
): () => number | false {
  return () => {
    if (baseMs === false) return false;
    return isLiveConnected() ? Math.max(baseMs, fallbackMs) : baseMs;
  };
}
