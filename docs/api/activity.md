---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |
| `since` | ISO-8601 timestamp; only records with `createdAt >= since` (inclusive) |
| `until` | ISO-8601 timestamp; only records with `createdAt <= until` (inclusive) |
| `limit` | Page size, 1–1000 (default 100). Out-of-range values are clamped, not rejected |
| `offset` | Rows to skip for pagination (default 0) |

An unparseable `since`/`until` returns `400` rather than being ignored.

Records come back newest-first, ordered by `createdAt` then `id`. The `id`
tiebreaker makes a given `(limit, offset)` pair address a stable row, so
paging through a window will not skip or repeat records when several share a
timestamp.

To pull a full window larger than one page, walk `offset` until a page comes
back short:

```bash
OFFSET=0
while :; do
  PAGE=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/activity?since=2026-08-10T00:00:00Z&until=2026-08-17T00:00:00Z&limit=1000&offset=$OFFSET")
  COUNT=$(printf '%s' "$PAGE" | jq 'length')
  printf '%s' "$PAGE" | jq -c '.[]'
  [ "$COUNT" -lt 1000 ] && break
  OFFSET=$((OFFSET + 1000))
done
```

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
