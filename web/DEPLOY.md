# Deploying RoadMap Studio (web)

One host with Docker. Two containers stay running (`roadmap`, `postgres`); two
small steps run once at each start (`credentials-init`, `tls-init`).

```bash
docker compose --env-file deploy.env up --build -d
```

Before the first start, edit three lines in `deploy.env`: `RMS_PUBLIC_URL`,
`RMS_SAML_METADATA_URL`, `RMS_ADMIN_EMAILS` (none is secret). A site with its
own Docker Hub mirror, Go module proxy or outbound proxy names them at the end
of the same file; the defaults are the public locations.
`RMS_SAML_METADATA_URL` may stay empty for the first start - see
[the local administrator](#the-local-administrator) below.

## The local administrator

The first start creates one account with a password, next to single sign-on:
**user `admin`, password `admin`**. Sign in with it at
`https://<host>/auth/local` (also linked from the sign-in error and signed-out
pages). It is an administrator, so it can set things up before Azure is ready
and get back in if SSO ever breaks. While SSO is not configured,
`/login` goes straight to this page.

- **Change the password.** Until you do, a red bar on every page tells this
  account that the default is still in use. *Tools > Account > Password*, or
  the avatar menu > *Change password*. Changing it signs this account out
  everywhere else. A restart never puts `admin` back.
- **Forgotten password:** `docker exec roadmap-studio roadmap reset-admin-password`
  makes it `admin` / `admin` again (and turns the account back on, as an
  administrator).
- Only the hash is stored (PBKDF2-SHA256, 600,000 rounds). Five wrong
  passwords from one address lock that address out for 15 minutes; 30 from
  anywhere lock the account for 15 minutes (SSO sign-in is unaffected).
- **Turn it off** with `RMS_LOCAL_ADMIN=off` in deploy.env once SSO works and
  you would rather nobody could sign in with a password. Its open sessions
  stop working too; `on` brings it back with the same password.

## 1. Azure (Microsoft Entra ID)

1. **Entra admin center > Enterprise applications > New application > Create
   your own application** - name it "RoadMap Studio", choose *Integrate any
   other application you don't find in the gallery (Non-gallery)*.
2. **Single sign-on > SAML.** Either
   - **Upload metadata file**: download it from
     `https://<RMS_PUBLIC_URL>/saml/metadata` (the app serves it even before
     sign-in is configured), or
   - type the two values:
     | Azure field | Value |
     |---|---|
     | Identifier (Entity ID) | `https://<host>/saml/metadata` |
     | Reply URL (Assertion Consumer Service URL) | `https://<host>/saml/acs` |
     | Sign on URL (optional) | `https://<host>/login` |
3. **Attributes & Claims**: the defaults are enough. RoadMap Studio reads the
   object id (always sent), `emailaddress`, `name`, `givenname`, `surname` and
   `displayname` when present. Add a **group claim** only if you use
   `RMS_SAML_ALLOWED_GROUPS`.
4. **SAML Certificates**: copy the **App Federation Metadata Url**. Either
   put it in `RMS_SAML_METADATA_URL` in deploy.env, or - after the first start -
   sign in as the local administrator and enter it under **Tools > Users &
   sign-in** (a pasted *Federation Metadata XML* works there too). Settings
   saved in the app are stored in the database, apply to every server, and
   replace the env values. **Check metadata** reads it without saving;
   **Test sign-in** goes through Azure and shows every claim it sent and
   what the app would do with it, without signing anyone in. Group access
   (allow or deny lists of Azure group object ids) is there as well, off by
   default; it needs the groups claim added in Azure.
5. **Properties > Assignment required = Yes**, then **Users and groups**: add
   the people or groups who may use it. This is the real access control -
   everyone Azure lets through gets an account automatically at their first
   sign-in, with their name and email from the claims.

The app re-reads the metadata URL every day, so Azure's certificate rollover
needs nothing. The last good copy is kept in the database, so a restart while
Azure is unreachable still signs people in.

**If the server cannot reach login.microsoftonline.com:** download the
*Federation Metadata XML* instead, put it in `./saml/federation.xml`, and set
`RMS_SAML_METADATA_URL=` (empty) and `RMS_SAML_METADATA_FILE=/saml/federation.xml`.
Then the certificate rollover means downloading it again; Tools > Users &
sign-in shows each certificate's expiry date.

## 2. The host

- **Certificate:** the first start makes a self-signed one in `./certs`
  (browsers warn). Replace `tls.crt` and `tls.key` (PEM) with a real
  certificate - the app picks it up within a minute, no restart. If the
  outbound proxy re-signs TLS, put its CA there as `ca.crt`.
- **Ports:** 443 (HTTPS) and 80 (redirects to HTTPS). Change with `RMS_PORT` /
  `RMS_HTTP_PORT` if they are taken.
- **Data:** everything is in Postgres under `./pgdata` (bind mount). Back up with
  `docker exec roadmap-postgres pg_dump -U roadmap roadmap > roadmap-$(date +%F).sql`.
- **Password:** `./credentials/db_password` is generated at the first start and
  never appears in a file you edit, in the compose file or in the image.

## 3. After the first start

- Everyone's first sign-in opens the guided tour, which builds a small
  roadmap with them step by step (it makes its own roadmap, "My tutorial
  roadmap"). It can be closed at any step and restarted from *Help > Tutorial*.

- Sign in. The local `admin` and anyone listed in `RMS_ADMIN_EMAILS` are administrators and
  sees **Tools > Users & sign-in**: who has signed in, turning an account off,
  handing someone's roadmaps to a colleague, and the SSO status (identity
  provider, certificates, last metadata read, a "read again now" button).
- **Moving roadmaps from the desktop app:** in the desktop app, *File >
  Backup*; in the web app, *File > Import* that file. Every roadmap and its
  saved versions arrive as your own roadmaps.

## 4. Supply chain

- Nothing published in the last 72 hours is built in. The Docker build runs
  `tools/agegate -check -hours 72` right after downloading the Go modules and
  reads only the committed `go-publish-times.json`, so the build needs no
  access to the registries and gives the same answer everywhere.
  `go run ./tools/agegate -refresh` (on a machine with internet access)
  rewrites that file and `image-digests.json`; commit both.
- Every image is pinned by digest through `${IMAGE_REGISTRY}`; a pin may only
  move to an image that was already 72 hours old (asserted by `deploy_test.go`).
- `go test ./...` and `npm test` (no packages - plain `node --test`) run
  everything, including the deployment guards.

## 5. Several app containers

Edits are ordered with a row lock per roadmap and fanned out through Postgres
`LISTEN/NOTIFY`, so two or more `roadmap` containers behind a load balancer
work without anything else. This has been designed for but **only tested with
one container**.

A presentation's "follow" works across containers like everything else live:
the presenter's view (roadmap, zoom, scroll position, spotlit item) travels in
the presence stream through Postgres NOTIFY, so a follower served by another
container sees the same thing within about 300 ms.

## Test setup

`lab.env` (`docker compose --env-file lab.env up --build -d`) signs in through
`tools/devidp`, a TEST identity provider that answers like Entra ID (same
claims, signed assertions) so the real SAML path is exercised without Azure.
On the test host (the file assumes 192.168.5.254 - change both addresses):

```bash
go build -o devidp ./tools/devidp     # or GOOS=linux on another machine
nohup ./devidp -base http://192.168.5.254:8090 -sp https://192.168.5.254/saml/metadata &
```

It lets anyone sign in as anyone - never run it anywhere real.
