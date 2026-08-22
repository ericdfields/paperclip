import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  unblockDescriptorFingerprint,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const otherAgentId = "00000000-0000-4000-8000-000000000003";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  owner?: { agentId: string } | { userId: string } | "board";
  action?: string;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: {
      owner: input.owner ?? { agentId },
      action: input.action ?? "Review the finding",
    },
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}:${
        unblockDescriptorFingerprint(issue.unblockDescriptor)
      }`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });

  // BRO-2453: BRO-2377 was already blocked when an agent attached its
  // descriptor. The transition timestamp does not move on a re-point, so the
  // descriptor itself has to discriminate the key or the wakeup is deduped
  // against the previous owner's and the new owner is never told.
  it("gives a re-pointed descriptor a distinct idempotency key on the same transition", async () => {
    const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const first = blockedIssue({ transitionAt });
    const repointed = blockedIssue({ transitionAt, owner: { agentId: otherAgentId } });

    const firstWakeup = vi.fn(async () => undefined);
    const repointedWakeup = vi.fn(async () => undefined);
    await deliverAgentUnblockNotification({
      issue: first,
      wakeup: firstWakeup,
      markNotified: async () => undefined,
    });
    await deliverAgentUnblockNotification({
      issue: repointed,
      wakeup: repointedWakeup,
      markNotified: async () => undefined,
    });

    expect(repointedWakeup).toHaveBeenCalledWith(otherAgentId, expect.anything());
    const firstKey = (firstWakeup.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    const repointedKey = (repointedWakeup.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(firstKey).toContain(transitionAt.toISOString());
    expect(repointedKey).toContain(transitionAt.toISOString());
    expect(repointedKey).not.toBe(firstKey);
  });

  it("separates keys when only the action text changes", () => {
    const owner = { agentId } as const;
    expect(unblockDescriptorFingerprint({ owner, action: "Do A" }))
      .not.toBe(unblockDescriptorFingerprint({ owner, action: "Do B" }));
    expect(unblockDescriptorFingerprint({ owner, action: "Do A" }))
      .toBe(unblockDescriptorFingerprint({ owner, action: "Do A" }));
  });
});
