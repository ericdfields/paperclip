# Surface PR Numbers in Issue UI

## Summary

When an agent creates a pull request work product on an issue, the PR number should be visible throughout the app -- in issue list views, issue detail headers, and the properties panel. Currently, `workProducts` are only fetched on the detail endpoint and never rendered in the UI.

## Context

- Issues have a `workProducts` relationship containing items of type `pull_request`, `branch`, `commit`, etc.
- The `IssueWorkProduct` type carries `type`, `externalId` (PR number), `url`, `title`, `status`, `isPrimary`.
- The detail GET endpoint already includes `workProducts`. The list endpoint does not.
- The DB table `issue_work_products` has an index on `(companyId, issueId, type)` which supports efficient filtered queries.

## Approach

Include PR work products in the issue list response (server change), then surface them in the UI via a shared badge component.

## Server Changes

### File: `server/src/services/work-products.ts`

Add a batch method `listPrWorkProductsForIssues(issueIds, companyId)` to the existing `workProductService`:
- Queries `issue_work_products` WHERE `companyId = ?` AND `issueId IN (...)` AND `type = 'pull_request'`
- Including `companyId` in the WHERE clause ensures the composite index `(companyId, issueId, type)` is fully utilized
- Orders by `isPrimary DESC, updatedAt DESC`
- Returns a `Map<string, IssueWorkProduct[]>` keyed by issueId
- Reuses the existing `toIssueWorkProduct` row mapper

### File: `server/src/routes/issues.ts`

In the list route handler (after `svc.list()` returns), call `workProductsSvc.listPrWorkProductsForIssues()` to enrich the results with `workProducts` before sending the response. This mirrors how the detail endpoint already calls `workProductsSvc.listForIssue()`.

This adds one additional query to the list endpoint, using the existing composite index and only fetching `pull_request` type rows.

### Type compatibility

The `Issue` type in `packages/shared/src/types/issue.ts` already declares `workProducts?: IssueWorkProduct[]` as optional. No type changes are needed -- the list endpoint will simply start populating this field.

## UI Changes

### New Component: `ui/src/components/PrBadge.tsx`

A small pill component that displays PR information:

- **Content**: `PR #N` where N is extracted from `externalId`, or falls back to parsing the PR number from `url` or `title`
- **Link**: Wraps in an `<a>` tag linking to `url` (opens in new tab) when available
- **Styling**: Muted violet/purple tone pill, similar to the existing "Live" badge pattern. Uses status-aware styling:
  - `merged`: solid purple background
  - `active`/`ready_for_review`/`draft`/`approved`: outline style
  - `closed`/`failed`/`changes_requested`/`archived`: muted/dimmed
- **Overflow**: When multiple PRs exist, show the primary one (or first) plus a `+N` count
- **Click handling**: `e.stopPropagation()` to prevent navigating to the issue when clicking the PR link in list rows

### File: `ui/src/pages/IssueDetail.tsx`

In the header area, after the "Live" badge conditional block and before the project link, render `PrBadge` using `issue.workProducts` filtered to `type === "pull_request"`.

### File: `ui/src/components/IssuesList.tsx`

In the `desktopMetaLeading` JSX passed to `IssueRow`, after the "Live" badge conditional block, render `PrBadge` using `issue.workProducts`. The data is available because the list endpoint now includes PR work products. Note: `IssueRow.tsx` itself is not modified -- the badge is added in the JSX that `IssuesList` passes as the `desktopMetaLeading` prop.

### File: `ui/src/components/IssueProperties.tsx`

Add a new `PropertyRow` labeled "PR" after the existing "Project" property. Shows:
- PR title as a link to the URL
- Status badge (e.g., "merged", "open")
- If multiple PRs, list them vertically

Only render the row if the issue has PR work products.

### File: `ui/src/components/KanbanBoard.tsx`

In the kanban card rendering, add `PrBadge` after the identifier in the card header div, keeping cards compact by showing only the badge (no full title).

### Inbox / MyIssues

These pages use `IssueRow` which receives `desktopMetaLeading` from the parent. For pages that pass custom `desktopMetaLeading`, add `PrBadge` there. For pages that use `IssueRow`'s default rendering, consider whether to add it to the default or leave it for a follow-up.

## Data Flow

```
issue_work_products table
  --> server list endpoint (new batch query, type='pull_request')
  --> Issue[] response now includes workProducts
  --> PrBadge component reads issue.workProducts
  --> Renders in IssueRow, IssueDetail, IssueProperties, KanbanBoard
```

## PR Number Extraction

The `externalId` field is the primary source for the PR number. It is a `string | null` and is expected to contain the numeric PR number as a string (e.g., `"123"`), though this depends on how the agent populates it. Fallback logic:
1. `externalId` -- used directly if it looks like a number
2. Parse from `url` -- extract trailing number from GitHub/GitLab PR URLs (e.g., `/pull/123`)
3. Parse from `title` -- extract `#N` pattern
4. If none found, show the title truncated as the badge text

## Edge Cases

- **No PRs**: Badge is not rendered. No empty state needed.
- **Multiple PRs**: Show primary (or first) with `+N` overflow. Properties panel shows all.
- **PR without a number**: Show title instead of `PR #N`.
- **Long PR titles**: Truncate in badge; full title visible in properties panel.
- **Stale work products**: PR status may be outdated; this is acceptable as work products are updated by the agent during execution.

## Files Changed

| File | Change |
|------|--------|
| `server/src/services/work-products.ts` | Add `listPrWorkProductsForIssues` batch method |
| `server/src/routes/issues.ts` | Enrich list response with PR work products |
| `ui/src/components/PrBadge.tsx` | New component |
| `ui/src/pages/IssueDetail.tsx` | Add PrBadge to header |
| `ui/src/components/IssuesList.tsx` | Add PrBadge to desktopMetaLeading prop |
| `ui/src/components/IssueProperties.tsx` | Add PR property row |
| `ui/src/components/KanbanBoard.tsx` | Add PrBadge to kanban cards |

## Out of Scope

- Detecting PR references in comment text (e.g., `#123` in markdown)
- Real-time PR status syncing from GitHub
- PR review state display (beyond basic status)
- Filtering issues by PR status
