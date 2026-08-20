# Local database mirror to Neon

This setup mirrors the local Paperclip PostgreSQL database to the dedicated
Neon project `paperclip-local-replica` every 15 minutes using a macOS `launchd`
job. It does not use Paperclip routines or consume model tokens.

The mirror is one-way. Neon is a reporting/backup copy and must not be used as
an application write target.

## Install

From the repository root:

```sh
chmod +x scripts/neon-mirror.sh scripts/install-neon-mirror-launchd.sh
./scripts/install-neon-mirror-launchd.sh
```

The installer obtains the direct Neon connection string through the Neon CLI
and stores it in the protected file
`~/.paperclip/instances/default/data/neon-mirror/credentials.env` (mode 0600).
It is not written to the repository or shell history.

## Inspect or stop

```sh
cat ~/.paperclip/instances/default/data/neon-mirror/status.json
tail -f ~/.paperclip/instances/default/data/neon-mirror/stderr.log
launchctl print gui/$(id -u)/com.paperclip.neon-mirror
launchctl bootout gui/$(id -u)/com.paperclip.neon-mirror
```

Each run is a full custom-format dump and an atomic restore. The restore is
single-transaction, so readers see either the previous complete mirror or the
new complete mirror, never the in-progress table-by-table restore. The worker
also compares public table names and refuses to report success if any table
that has source rows is empty in Neon. Exact row-count equality is not required
because the local application can write while a snapshot is being taken.

These are still full snapshot restores, so this is appropriate for the current
database size but should be replaced with a WAL/CDC relay if the database or
cadence grows substantially. Schema changes are included automatically in each
snapshot.
