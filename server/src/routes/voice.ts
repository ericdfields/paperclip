import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentService, issueService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  CEO_VOICE_ACTION_PROTOCOL,
  CEO_VOICE_SYSTEM_PROMPT,
} from "./voice-ceo-system-prompt.js";

/**
 * Voice chat backend routes (BRO-1411, parent BRO-1402).
 *
 * Two company-scoped endpoints powering the Paperclip voice chat surface:
 *
 *   POST /api/companies/:companyId/voice/query
 *     Transcript in → CEO-persona Claude answer out, with optional
 *     voice-triggered board actions (create issue / update status / add
 *     comment). The model gates execution conversationally ("Should I do
 *     that now?") and only emits a machine %%ACTION%% block once the Founder
 *     has confirmed; the backend executes that block and reports back.
 *
 *   POST /api/companies/:companyId/voice/tts
 *     Text in → audio/mpeg out, via the OpenAI TTS API.
 *
 * Both call external HTTP APIs with server-held keys (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY) and are safe on any deployment mode — unlike board-chat,
 * nothing here lends the operator's shell to the requester. Access is scoped
 * to the requesting actor's company via assertCompanyAccess.
 */

// Anthropic Messages API. Model is overridable via env for cheap iteration;
// Haiku is the cost-efficient default called for on the issue.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_VOICE_QUERY_MODEL = "claude-haiku-4-5-20251001";
const VOICE_QUERY_MAX_TOKENS = 1024;

// OpenAI TTS. onyx = deep, confident (issue default).
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_TTS_MODEL = "tts-1";
const DEFAULT_TTS_VOICE = "onyx";
const OPENAI_TTS_VOICES = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);
// OpenAI TTS rejects inputs over 4096 characters.
const TTS_MAX_CHARS = 4096;

// Bounds on request-supplied history to cap token cost / abuse.
const MAX_HISTORY_TURNS = 20;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_HISTORY_TURN_CHARS = 4000;

// Action-payload bounds (defensive — the model is ours, but the block is
// re-parsed as untrusted structured data before it drives a mutation).
const MAX_ACTION_TITLE_CHARS = 200;
const MAX_ACTION_TEXT_CHARS = 5000;
const ALLOWED_ACTION_STATUSES = new Set([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
]);

type ChatTurn = { role: "user" | "assistant"; content: string };

type VoiceAction =
  | {
      action: "create_issue";
      title?: unknown;
      description?: unknown;
      assigneeRole?: unknown;
    }
  | { action: "update_status"; identifier?: unknown; status?: unknown }
  | { action: "add_comment"; identifier?: unknown; body?: unknown };

type ActionResult = {
  type: string;
  executed: boolean;
  issueId?: string;
  // DB identifiers are `string | null`; a null is treated as "absent" by the
  // truthiness guards in the response builder, so it never reaches the client.
  identifier?: string | null;
  error?: string;
};

/** Normalize a role/title token for fuzzy roster matching. */
function normalizeRoleToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Build the live board-context block injected at the `{{CONTEXT}}` marker:
 * open issues, recent comments, and the real team roster.
 *
 * Comments are harvested from the loaded open issues (an issue with recent
 * activity is the practical carrier of recent comments); this is an
 * approximation of a true company-wide comment feed, kept bounded for voice
 * latency. Returns the roster (for downstream action assignee resolution)
 * alongside the formatted block so callers avoid a second roster query.
 */
async function buildVoiceContext(
  db: Db,
  companyId: string,
): Promise<{
  block: string;
  roster: Array<{ id: string; name: string; role: string; title: string }>;
}> {
  const issueSvc = issueService(db);
  const agentSvc = agentService(db);

  const [issues, agents] = await Promise.all([
    issueSvc.list(companyId, {
      status: ["todo", "in_progress", "in_review", "blocked"],
      sortField: "updated",
      sortDir: "desc",
      limit: 30,
    }),
    agentSvc.list(companyId),
  ]);

  const roster = agents.map((a: any) => ({
    id: String(a.id),
    name: String(a.name ?? ""),
    role: String(a.role ?? ""),
    title: String(a.title ?? ""),
  }));
  const agentNameById = new Map<string, string>(
    roster.map((a) => [a.id, a.title || a.name || a.role || "agent"]),
  );

  // Issue list section.
  const issueLines = issues.map((i: any) => {
    const assignee = i.assigneeAgentId
      ? (agentNameById.get(i.assigneeAgentId) ?? "an agent")
      : i.assigneeUserId
        ? "Founder"
        : "unassigned";
    return `${i.identifier} ${i.title} — ${i.status} — assignee: ${assignee}`;
  });

  // Recent comments across the loaded issues, past 7 days, newest first.
  const sevenDaysAgoMs = nowMs() - 7 * 24 * 60 * 60 * 1000;
  const commentBatches = await Promise.all(
    issues.map(async (i: any) => {
      const comments = await issueSvc.listComments(i.id, {
        order: "desc",
        limit: 20,
      });
      return comments.map((c: any) => ({ issue: i, comment: c }));
    }),
  );
  const recentComments = commentBatches
    .flat()
    .filter(({ comment }) => {
      const t = new Date(comment.createdAt).getTime();
      return Number.isFinite(t) && t >= sevenDaysAgoMs;
    })
    .sort(
      (a, b) =>
        new Date(b.comment.createdAt).getTime() -
        new Date(a.comment.createdAt).getTime(),
    )
    .slice(0, 50);

  const commentLines = recentComments.map(({ issue, comment }) => {
    const author = comment.authorAgentId
      ? (agentNameById.get(comment.authorAgentId) ?? "an agent")
      : "Founder";
    const excerpt = String(comment.body ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const date = new Date(comment.createdAt).toISOString().slice(0, 10);
    return `${issue.identifier}: "${excerpt}" — ${author} at ${date}`;
  });

  const rosterLines = roster.map(
    (a) => `- ${a.title || a.name} (${a.role || "general"})`,
  );

  const block = [
    "### Open issues (last 30)",
    issueLines.length ? issueLines.join("\n") : "(none)",
    "",
    "### Recent comments (last 50, past 7 days)",
    commentLines.length ? commentLines.join("\n") : "(none)",
    "",
    "### Team roster",
    rosterLines.length ? rosterLines.join("\n") : "(none)",
  ].join("\n");

  return { block, roster };
}

/** Wall-clock helper (isolated so tests can reason about it if needed). */
function nowMs(): number {
  return Date.now();
}

/**
 * Extract a single `%%ACTION%%{...}%%/ACTION%%` block from the model output.
 * Returns the parsed action (or null) plus the spoken text with the block
 * stripped out.
 */
export function parseVoiceAction(raw: string): {
  spoken: string;
  action: VoiceAction | null;
} {
  const re = /%%ACTION%%\s*([\s\S]*?)\s*%%\/ACTION%%/;
  const match = raw.match(re);
  const spoken = raw.replace(/%%ACTION%%[\s\S]*?%%\/ACTION%%/g, "").trim();
  if (!match) return { spoken, action: null };
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return { spoken, action: parsed as VoiceAction };
    }
  } catch {
    /* malformed block — ignore, treat as text-only */
  }
  return { spoken, action: null };
}

/**
 * Execute a confirmed voice action, company-scoped. Every issue resolved by
 * identifier is re-checked against the requesting company before it is
 * mutated, so a crafted identifier can never reach across tenants.
 */
async function executeVoiceAction(
  db: Db,
  companyId: string,
  actor: ReturnType<typeof getActorInfo>,
  roster: Array<{ id: string; name: string; role: string; title: string }>,
  action: VoiceAction,
): Promise<ActionResult> {
  const issueSvc = issueService(db);
  const authorRef = {
    agentId: actor.agentId ?? undefined,
    userId: actor.agentId ? undefined : actor.actorId,
    runId: actor.runId,
  };

  if (action.action === "create_issue") {
    const title = String((action as any).title ?? "").trim();
    if (!title) return { type: action.action, executed: false, error: "missing title" };
    const description = String((action as any).description ?? "").slice(
      0,
      MAX_ACTION_TEXT_CHARS,
    );

    // Resolve assigneeRole against the live roster (role, then title/name).
    let assigneeAgentId: string | undefined;
    const roleReq = String((action as any).assigneeRole ?? "").trim();
    if (roleReq) {
      const target = normalizeRoleToken(roleReq);
      const hit =
        roster.find((a) => normalizeRoleToken(a.role) === target) ??
        roster.find((a) => normalizeRoleToken(a.title) === target) ??
        roster.find((a) => normalizeRoleToken(a.name) === target);
      if (hit) assigneeAgentId = hit.id;
    }

    const created = await issueSvc.create(companyId, {
      title: title.slice(0, MAX_ACTION_TITLE_CHARS),
      description,
      status: "todo",
      priority: "medium",
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      responsibleUserId: actor.actorType === "user" ? actor.actorId : null,
      trustExplicitResponsibleUserId: actor.actorType === "user",
    });
    return {
      type: action.action,
      executed: true,
      issueId: created.id,
      identifier: created.identifier,
    };
  }

  if (action.action === "update_status") {
    const identifier = String((action as any).identifier ?? "").trim();
    const status = String((action as any).status ?? "").trim();
    if (!identifier) return { type: action.action, executed: false, error: "missing identifier" };
    if (!ALLOWED_ACTION_STATUSES.has(status)) {
      return { type: action.action, executed: false, error: `unsupported status: ${status}` };
    }
    const issue = await issueSvc.getById(identifier);
    if (!issue || issue.companyId !== companyId) {
      return { type: action.action, executed: false, identifier, error: "issue not found" };
    }
    try {
      await issueSvc.update(issue.id, {
        status,
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.agentId ? null : actor.actorId,
      });
    } catch (err) {
      return {
        type: action.action,
        executed: false,
        issueId: issue.id,
        identifier: issue.identifier,
        error: err instanceof Error ? err.message : "update failed",
      };
    }
    return { type: action.action, executed: true, issueId: issue.id, identifier: issue.identifier };
  }

  if (action.action === "add_comment") {
    const identifier = String((action as any).identifier ?? "").trim();
    const body = String((action as any).body ?? "").trim();
    if (!identifier) return { type: action.action, executed: false, error: "missing identifier" };
    if (!body) return { type: action.action, executed: false, error: "missing body" };
    const issue = await issueSvc.getById(identifier);
    if (!issue || issue.companyId !== companyId) {
      return { type: action.action, executed: false, identifier, error: "issue not found" };
    }
    await issueSvc.addComment(issue.id, body.slice(0, MAX_ACTION_TEXT_CHARS), authorRef);
    return { type: action.action, executed: true, issueId: issue.id, identifier: issue.identifier };
  }

  return { type: String((action as any).action ?? "unknown"), executed: false, error: "unsupported action" };
}

/** Normalize request-supplied history into a valid alternating message list. */
export function buildMessages(history: unknown, transcript: string): ChatTurn[] {
  const msgs: ChatTurn[] = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-MAX_HISTORY_TURNS)) {
      const role = (h as any)?.role === "assistant" ? "assistant" : "user";
      const content = String((h as any)?.content ?? "").slice(0, MAX_HISTORY_TURN_CHARS);
      if (!content) continue;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += "\n\n" + content;
      else msgs.push({ role, content });
    }
  }
  const last = msgs[msgs.length - 1];
  if (last && last.role === "user") last.content += "\n\n" + transcript;
  else msgs.push({ role: "user", content: transcript });
  // Anthropic requires the first message to be a user turn.
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

/** Call the Anthropic Messages API and return the concatenated text. */
async function callAnthropic(
  apiKey: string,
  system: string,
  messages: ChatTurn[],
): Promise<string> {
  const model = process.env.VOICE_QUERY_MODEL || DEFAULT_VOICE_QUERY_MODEL;
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, max_tokens: VOICE_QUERY_MAX_TOKENS, system, messages }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`anthropic ${resp.status}: ${detail.slice(0, 500)}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

export function voiceRoutes(db: Db) {
  const router = Router();

  router.post("/companies/:companyId/voice/query", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { transcript, history } = (req.body ?? {}) as {
      transcript?: unknown;
      history?: unknown;
    };
    const text = typeof transcript === "string" ? transcript.trim() : "";
    if (!text) {
      res.status(400).json({ error: "transcript is required" });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: "Voice query is not configured (ANTHROPIC_API_KEY unset)",
        code: "VOICE_QUERY_NOT_CONFIGURED",
      });
      return;
    }

    const actor = getActorInfo(req);

    try {
      const { block, roster } = await buildVoiceContext(db, companyId);
      const system =
        CEO_VOICE_SYSTEM_PROMPT.replace(/^\{\{CONTEXT\}\}$/m, block) +
        CEO_VOICE_ACTION_PROTOCOL;
      const messages = buildMessages(history, text.slice(0, MAX_TRANSCRIPT_CHARS));

      const rawResponse = await callAnthropic(apiKey, system, messages);
      const { spoken, action } = parseVoiceAction(rawResponse);

      let actionResult: ActionResult | undefined;
      if (action) {
        actionResult = await executeVoiceAction(db, companyId, actor, roster, action);
      }

      res.json({
        response: spoken,
        ...(actionResult
          ? {
              action: {
                type: actionResult.type,
                executed: actionResult.executed,
                ...(actionResult.issueId ? { issueId: actionResult.issueId } : {}),
                ...(actionResult.identifier ? { identifier: actionResult.identifier } : {}),
                ...(actionResult.error ? { error: actionResult.error } : {}),
              },
            }
          : {}),
      });
    } catch (err) {
      console.error("[voice/query]", err);
      res.status(502).json({
        error: "Voice assistant is unavailable right now",
        code: "VOICE_QUERY_FAILED",
      });
    }
  });

  router.post("/companies/:companyId/voice/tts", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { text, voice } = (req.body ?? {}) as { text?: unknown; voice?: unknown };
    const input = typeof text === "string" ? text.trim() : "";
    if (!input) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (input.length > TTS_MAX_CHARS) {
      res.status(400).json({ error: `text exceeds ${TTS_MAX_CHARS} characters` });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: "Text-to-speech is not configured (OPENAI_API_KEY unset)",
        code: "TTS_NOT_CONFIGURED",
      });
      return;
    }

    const selectedVoice =
      typeof voice === "string" && OPENAI_TTS_VOICES.has(voice)
        ? voice
        : DEFAULT_TTS_VOICE;
    const model = process.env.VOICE_TTS_MODEL || DEFAULT_TTS_MODEL;

    try {
      const resp = await fetch(OPENAI_TTS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, voice: selectedVoice, input, response_format: "mp3" }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.error("[voice/tts] openai", resp.status, detail.slice(0, 300));
        res.status(502).json({ error: "Text-to-speech failed", code: "TTS_FAILED" });
        return;
      }
      const audio = Buffer.from(await resp.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", String(audio.length));
      res.setHeader("Cache-Control", "no-store");
      res.send(audio);
    } catch (err) {
      console.error("[voice/tts]", err);
      res.status(502).json({ error: "Text-to-speech failed", code: "TTS_FAILED" });
    }
  });

  return router;
}
