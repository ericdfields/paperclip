import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLiveConnectedForTests,
  isLiveConnected,
  liveRefetchInterval,
  setLiveConnected,
} from "./liveConnection";

afterEach(() => {
  __resetLiveConnectedForTests();
});

describe("liveConnection store", () => {
  it("defaults to disconnected", () => {
    expect(isLiveConnected()).toBe(false);
  });

  it("tracks connection transitions", () => {
    setLiveConnected(true);
    expect(isLiveConnected()).toBe(true);
    setLiveConnected(false);
    expect(isLiveConnected()).toBe(false);
  });
});

describe("liveRefetchInterval", () => {
  it("polls at the base cadence while the socket is disconnected", () => {
    const interval = liveRefetchInterval(3000);
    expect(interval()).toBe(3000);
  });

  it("backs off to the fallback cadence while the socket is connected", () => {
    const interval = liveRefetchInterval(3000);
    setLiveConnected(true);
    expect(interval()).toBe(30_000);
  });

  it("re-evaluates on each call so connection changes are picked up", () => {
    const interval = liveRefetchInterval(5000);
    expect(interval()).toBe(5000);
    setLiveConnected(true);
    expect(interval()).toBe(30_000);
    setLiveConnected(false);
    expect(interval()).toBe(5000);
  });

  it("never polls faster than the base interval", () => {
    const interval = liveRefetchInterval(60_000);
    setLiveConnected(true);
    expect(interval()).toBe(60_000);
  });

  it("honors a false base to keep a query opted out of polling", () => {
    const interval = liveRefetchInterval(false);
    expect(interval()).toBe(false);
    setLiveConnected(true);
    expect(interval()).toBe(false);
  });

  it("accepts a custom fallback window", () => {
    const interval = liveRefetchInterval(2000, 15_000);
    setLiveConnected(true);
    expect(interval()).toBe(15_000);
  });
});
