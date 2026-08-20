export type RosterManifestEntry = { id?: string; name: string; role?: string | null };
export type LiveRosterEntry = { id: string; name: string; role: string | null; status: string; hasCostHistory: boolean };

export function auditRoster(manifest: RosterManifestEntry[], live: LiveRosterEntry[]) {
  const names = new Set(manifest.map((entry) => entry.name.trim().toLowerCase()));
  const ids = new Set(manifest.flatMap((entry) => entry.id ? [entry.id] : []));
  const dbOnlyAgents = live.filter((agent) => !ids.has(agent.id) && !names.has(agent.name.trim().toLowerCase()));
  const repoOnlyAgents = manifest.filter((entry) => !live.some((agent) => (entry.id && entry.id === agent.id) || entry.name.trim().toLowerCase() === agent.name.trim().toLowerCase()));
  const roleCounts = new Map<string, number>();
  for (const entry of [...manifest, ...live]) {
    const role = (entry.role ?? "general").trim().toLowerCase();
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  return {
    dbOnlyAgents,
    repoOnlyAgents,
    duplicateRoleFamilies: [...roleCounts].filter(([, count]) => count > 1).map(([role, count]) => ({ role, count })),
    agentsWithNoCostHistory: live.filter((agent) => !agent.hasCostHistory),
    agentsInError: live.filter((agent) => agent.status === "error"),
    remediation: { action: "operator_review_only", note: "No agents were deleted, terminated, or quarantined." },
  };
}
