# Shared editing - design notes (not implemented)

People want to work on the same roadmap. There is no server, and true peer-to-peer
between laptops on an office network does not work in practice (firewalls, NAT,
laptops asleep). What *is* realistic, in order of effort:

## Option A - a shared roadmap file with a lock (recommended first step)

A roadmap can live as a file on a shared location instead of inside the local
workspace: a network share (`\\server\share\Roadmaps\Platform.roadmap.json`), a
OneDrive/SharePoint folder synced to disk, or any folder everyone can reach.

**Open / Save as shared.** "Open shared roadmap…" adds a tab whose source is that
file; "Save as shared…" moves a local roadmap there. The tab shows a badge:
*Shared · you are editing* or *Read-only · Priya is editing since 10:12*.

**One editor at a time - the lock.** Next to the file sits `Platform.roadmap.lock`:

```json
{ "user": "avro", "machine": "LT-1234", "pid": 4120,
  "since": "2026-09-23T10:12:00Z", "heartbeat": "2026-09-23T10:41:30Z" }
```

- Taking the lock = creating the file **exclusively** (`O_CREATE|O_EXCL`); if it
  already exists you get read-only mode. On SMB shares that create is atomic.
- The editor refreshes `heartbeat` every 30 s while the roadmap is open.
- The lock is released when the tab is closed, the app exits, or the user
  switches to another roadmap - the engine removes the file on every exit path
  it controls (window close, Quit, `/api/quit`, browser-mode timeout).
- **Crash / kill / laptop lid closed:** nothing can release the lock, so a lock
  whose heartbeat is older than ~2 minutes is *stale* and anyone may take it over
  (the UI says "Priya's lock looks abandoned - take over?"). A returning editor
  whose lock was taken finds a fresh lock owned by someone else and drops to
  read-only with its unsaved edits kept as a local copy.

**Readers stay current.** A read-only tab polls the file's modification time
every 10 s and reloads; a "Notify me when it is free" toggle pops a toast the
moment the lock disappears, with one click to take it.

**Never overwrite silently - the revision check.** Every save writes
`rev` (+1) and `savedBy` into the file. Before writing, the editor re-reads the
file's `rev`; if it is not the one it loaded, someone else saved meanwhile
(possible only if a stale lock was taken over while the original editor was
offline) - the save is refused and the user gets *Keep mine as a copy* /
*Discard mine and reload*. This is the safety net under the lock.

**OneDrive specifics.** A OneDrive folder is just a local folder with sync lag
(seconds to minutes). Two people can each create the lock file locally before
either sees the other's; OneDrive then keeps both and renames one to
"...-LT-1234.lock". So on OneDrive the lock is *advisory* and the revision check
above is what really protects the data. Also enable "Always keep on this device"
for the folder, and expect the read-only poll to lag by the sync interval. A real
SMB share is much better for this; SharePoint via the OneDrive client behaves like
OneDrive.

**Shared history.** The file's sibling folder `Platform.history/` can receive the
same snapshots the local history gets, so anyone can restore a version.

**Cost:** two or three days. Everything is file I/O in the Go engine plus a banner,
two dialogs and a poll in the UI. No new dependencies, no server, works with the
existing update mechanism (the same share can host the releases).

## Option B - a tiny relay server (later, if A is not enough)

The same executable started with `--serve :8090` on any always-on machine (a VM,
a spare desktop) holds the workspace; desktop copies connect to it instead of a
local file. This allows **per-item locks** (two people edit different tasks of the
same roadmap at once) and instant refresh (WebSocket push) rather than one editor
per file. Still no accounts - trust the network, or put it behind an SSO
proxy. A week of work, and someone must own the machine it runs on.

## Option C - real-time co-editing (not recommended)

Google-Docs style simultaneous editing needs CRDT/OT merging and a relay for the
WebRTC handshake anyway; peer-to-peer without a server is not achievable on a
managed network. Only worth it if Option B proves insufficient.

## What to decide before building A

1. Where will files live - SMB share or OneDrive? (Changes how much the lock can be trusted.)
2. Who may take over a stale lock - anyone, or only after confirming?
3. Should the shared file also carry history, or is local history per person enough?
