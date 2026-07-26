// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IssueExecutionDecisionCard,
  getPendingExecutionDecision,
} from "./IssueExecutionDecisionCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = "user-viewer";

function stateWith(
  overrides: Partial<IssueExecutionState>,
): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId: VIEWER },
    returnAssignee: { type: "agent", agentId: "agent-eng" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

function issueWith(state: IssueExecutionState | null, id = "issue-1"): Issue {
  return { id, executionState: state } as unknown as Issue;
}

describe("getPendingExecutionDecision", () => {
  it("returns null without an execution state", () => {
    expect(getPendingExecutionDecision(issueWith(null), VIEWER)).toBeNull();
  });

  it("returns null unless the stage is pending", () => {
    expect(
      getPendingExecutionDecision(
        issueWith(stateWith({ status: "idle" })),
        VIEWER,
      ),
    ).toBeNull();
    expect(
      getPendingExecutionDecision(
        issueWith(stateWith({ status: "changes_requested" })),
        VIEWER,
      ),
    ).toBeNull();
  });

  it("returns null for an agent participant", () => {
    expect(
      getPendingExecutionDecision(
        issueWith(
          stateWith({
            currentParticipant: { type: "agent", agentId: "agent-x" },
          }),
        ),
        VIEWER,
      ),
    ).toBeNull();
  });

  it("returns null when the participant is a different user", () => {
    expect(
      getPendingExecutionDecision(
        issueWith(
          stateWith({
            currentParticipant: { type: "user", userId: "someone-else" },
          }),
        ),
        VIEWER,
      ),
    ).toBeNull();
    // Anonymous viewer never matches.
    expect(
      getPendingExecutionDecision(issueWith(stateWith({})), null),
    ).toBeNull();
  });

  it("returns the decision when the viewer is the pending participant", () => {
    const review = getPendingExecutionDecision(
      issueWith(stateWith({})),
      VIEWER,
    );
    expect(review).toEqual({ stageType: "review", instructions: null });

    const approval = getPendingExecutionDecision(
      issueWith(
        stateWith({
          currentStageType: "approval",
          reviewRequest: { instructions: "  Ship after the smoke test  " },
        }),
      ),
      VIEWER,
    );
    expect(approval).toEqual({
      stageType: "approval",
      instructions: "Ship after the smoke test",
    });
  });
});

describe("IssueExecutionDecisionCard rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function typeComment(text: string) {
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, text);
    flushSync(() =>
      textarea!.dispatchEvent(new Event("input", { bubbles: true })),
    );
  }

  function findButton(label: string) {
    return Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(label),
    );
  }

  it("hides entirely when the viewer is not the pending participant", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueExecutionDecisionCard
          issue={issueWith(
            stateWith({ currentParticipant: { type: "agent", agentId: "a" } }),
          )}
          currentUserId={VIEWER}
          onApprove={vi.fn()}
          onRequestChanges={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toBe("");
    flushSync(() => root.unmount());
  });

  it("gates both actions behind a required comment, then approves with the trimmed comment", () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueExecutionDecisionCard
          issue={issueWith(stateWith({}))}
          currentUserId={VIEWER}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
        />,
      );
    });

    expect(
      container.querySelector("[data-testid='issue-execution-decision-card']"),
    ).toBeTruthy();
    expect(container.textContent).toContain("Review — your decision is needed");

    // Empty comment → both actions disabled, clicking Approve is a no-op.
    const approve = findButton("Approve");
    expect(approve).toBeTruthy();
    expect(approve!.disabled).toBe(true);
    flushSync(() =>
      approve!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onApprove).not.toHaveBeenCalled();

    typeComment("  Looks correct, approving.  ");
    expect(findButton("Approve")!.disabled).toBe(false);
    flushSync(() =>
      findButton("Approve")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("Looks correct, approving.");
    expect(onRequestChanges).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });

  it("requests changes with the comment and surfaces the review request", () => {
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueExecutionDecisionCard
          issue={issueWith(
            stateWith({
              currentStageType: "approval",
              reviewRequest: { instructions: "Confirm the migration ran" },
            }),
          )}
          currentUserId={VIEWER}
          onApprove={vi.fn()}
          onRequestChanges={onRequestChanges}
        />,
      );
    });

    expect(container.textContent).toContain(
      "Approval — your decision is needed",
    );
    expect(container.textContent).toContain("Confirm the migration ran");

    typeComment("Needs a rollback plan first.");
    const requestChanges = findButton("Request changes");
    expect(requestChanges).toBeTruthy();
    flushSync(() =>
      requestChanges!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onRequestChanges).toHaveBeenCalledWith(
      "Needs a rollback plan first.",
    );

    flushSync(() => root.unmount());
  });

  it("clears the comment when the decision target changes without a remount", () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);

    // Reviewer starts a decision on issue-1 / stage-1 and types a comment.
    flushSync(() => {
      root.render(
        <IssueExecutionDecisionCard
          issue={issueWith(stateWith({}), "issue-1")}
          currentUserId={VIEWER}
          onApprove={onApprove}
          onRequestChanges={vi.fn()}
        />,
      );
    });
    typeComment("Comment intended only for issue one.");
    expect(findButton("Approve")!.disabled).toBe(false);

    // Same tree position reused for a different issue + pending stage (SPA nav
    // or realtime advance). The card must NOT carry the prior comment over, and
    // both actions must fall back to disabled until a fresh comment is entered.
    flushSync(() => {
      root.render(
        <IssueExecutionDecisionCard
          issue={issueWith(
            stateWith({
              currentStageId: "stage-2",
              currentStageType: "approval",
            }),
            "issue-2",
          )}
          currentUserId={VIEWER}
          onApprove={onApprove}
          onRequestChanges={vi.fn()}
        />,
      );
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(textarea!.value).toBe("");
    expect(container.textContent).toContain(
      "Approval — your decision is needed",
    );

    // Clicking Approve now is a no-op — no stale comment can be submitted.
    flushSync(() =>
      findButton("Approve")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    expect(onApprove).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });
});
