# RoadMap Studio

A single-file Windows app for swimlane roadmaps: **Swimlane → Sub-swimlane → Tasks / Milestones**, with
% complete, resources needed, status, drag-and-drop editing and one-click "Copy image" for slides.

| Platform | File | How it runs |
|---|---|---|
| Windows 10/11 | `dist\RoadMapStudio.exe` | one file, own window (WebView2, ships with Windows); falls back to the browser without it |
| macOS 11+ (Intel and Apple Silicon) | `dist\RoadMapStudio-macOS.zip` -> `RoadMap Studio.app` | same engine; the UI opens in a Chrome/Edge app window, or the default browser. Unsigned - see "READ ME FIRST.txt" in the zip for the one-time Gatekeeper step |

No installer and no runtime to install on either. The macOS build has **never been run on a real Mac** from this
machine; its shared non-Windows code path is exercised on Linux (WSL), and the bundle layout, permissions and
universal binary are verified with `file`/`unzip`.

## Where data lives

Windows: `%ProgramData%\RoadMapStudio\` (falls back to `%LOCALAPPDATA%\RoadMapStudio`). macOS: `~/Library/Application Support/RoadMapStudio/`. Same files on both, so a Full backup moves everything between a Mac and a PC.

| file | what |
|---|---|
| `workspace.json` | every roadmap; written atomically, previous copy kept as `workspace.bak.json` |
| `history\<roadmap>\<time>.json` | saved versions - automatic every few minutes while editing, plus "Save version now" |

**Import / Export → Full backup** bundles the workspace and all history into one JSON that restores on any PC.
Single roadmaps export as JSON, CSV (Excel), PNG and SVG; JSON and CSV import back.

## Updates

`build.ps1` writes `dist\latest.json` (version, release notes, SHA-256 of each file). Copy the whole `dist\`
folder to an **update location** - an https URL (CDN, static site) or a folder such as `\server\share\RoadMapStudio`.
Each copy of the app checks that location once a day and offers "Update to x.y.z"; the (i) dialog has the
location field and "Check now". Bake a default location into the build so nobody has to type it:

```powershell
powershell -ExecutionPolicy Bypass -File .uild.ps1 -UpdateURL 'https://cdn.example.com/roadmap' -Notes 'What changed'
```

The update downloads this platform's file, verifies the checksum from `latest.json`, renames the running
executable to `.old`, writes the new one, relaunches with `--after-update` and removes `.old` on the next start.
The exe must sit in a folder the user can write to (not Program Files). Bump `appVersion` in `main.go` for
every release - the check compares versions, not file dates. The checksum protects against a damaged download,
not a hostile server: use https, or a share only the release owner can write to.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Needs only Go. The script enforces the 72-hour release-age gate on every Go module, draws the icon,
embeds icon + manifest, runs the tests and writes `dist\RoadMapStudio.exe`, then cross-compiles macOS amd64 + arm64 and
`tools/mkmacapp` joins them into a universal binary (no lipo needed) inside a zipped `.app` with Unix permissions intact. The UI (`ui\`) is plain
HTML/CSS/JS with no npm dependencies.

Develop the UI live: `go run . --dev --port 5280 --data build/devdata`, then open http://127.0.0.1:5280.
