# RoadMap Studio (web)

The roadmap app from the desktop version, as a web application: same timeline,
ribbon, charts, dependencies, initiatives, key dates, placeholders and exports -
with the roadmaps on a server, Microsoft Entra ID single sign-on, and roadmaps
shared and edited by several people at once.

- **Deploy:** see [DEPLOY.md](DEPLOY.md) - `docker compose --env-file work.env up --build -d`.
- **Sign-in:** SAML, configured from Azure's federation metadata URL; the app
  publishes its own metadata at `/saml/metadata` for the Azure side. People are
  created automatically at their first sign-in. A local administrator account
  (`admin` / `admin` at first start - change it) signs in at `/auth/local`,
  for setting up before SSO works ([DEPLOY.md](DEPLOY.md#the-local-administrator)).
- **Guided tour:** the first sign-in opens a tutorial that builds a sample
  roadmap with the person, one feature per step - the button or field to use
  is spotlit, the step waits until it has been done (or does it on request).
  Always available again from *Help > Tutorial* ([ui/tour.js](ui/tour.js)).
- **Sharing:** the owner shares a roadmap with Editors (change it together,
  live) or Viewers (watch it change). Shared roadmaps are marked in red; the
  banner shows who is on it right now, and each person's selection shows on the
  timeline in their colour.
- **Presenting:** *Home > Present* (or *File > Present*) builds a deck from any
  roadmaps you can open - yours and the ones shared with you - and shows them
  full screen with nothing else on the page: no panels, no comments, no edit
  handles. The arrow keys step through the items (each one spotlit with a card
  of its details), up/down move between the roadmaps of the deck, +/- zoom,
  Esc ends. Everyone who has the roadmap open sees "Follow X's presentation"
  in the red banner; following makes their screen show exactly what the
  presenter's shows, and carries them along to the next roadmap of the deck
  if it is shared with them ([ui/present.js](ui/present.js)). Decks can be
  saved for the next meeting (personal, in your settings).

## How editing together works

The browser never uploads the whole roadmap. Each edit becomes a few small
operations (`set` a field, `add`, `move`, `del` an entity), the server applies
them in arrival order under a row lock and pushes them to everyone else over
Server-Sent Events. Conflicts resolve per field - two people changing different
fields of the same task both keep their change. Each browser keeps the last
confirmed server state and replays its own unconfirmed edits on top of
everything that arrives, so every browser ends up with exactly the server's
roadmap ([ui/sync.js](ui/sync.js)). Undo replays the inverse of *your* last edit,
so it never undoes a colleague's work.

| | |
|---|---|
| Server | Go, one static binary with the UI embedded ([main.go](main.go)) |
| Data | PostgreSQL 16 ([migrations/](migrations/)) |
| Sign-in | [saml.go](saml.go) (crewjam/saml), sessions in [auth.go](auth.go) |
| Live updates | [hub.go](hub.go): SSE + Postgres LISTEN/NOTIFY |
| Edit operations | [ops.go](ops.go) and [ui/ops.js](ui/ops.js) - same rules, same test cases ([testdata/ops/cases.json](testdata/ops/cases.json)) |
| UI | plain JavaScript, no packages ([ui/](ui/)) |

## Tests

```bash
go test ./...      # operations, deployment guards, routes
npm test           # browser side: operations, diff, multi-browser convergence
```

`test/sync.test.js` simulates a server with several browsers editing at random
and delivering messages in random orders, and checks every browser ends up
identical to the server.
