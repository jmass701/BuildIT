# BuildIT

An AI app builder in the spirit of Base44: describe an app in plain English, and BuildIT
writes it with Claude, gives it a database and user accounts, shows a live preview, lets you
keep refining it by chatting, and publishes it to its own URL.

## What's in the box

| | |
|---|---|
| **Prompt → app** | Claude (`claude-opus-5-5` by default) generates a complete multi-file web app plus its data model, using structured output. |
| **Chat to iterate** | Every follow-up message sends the current source back to Claude and saves the result as a new version. |
| **Built-in backend** | Generated apps get `window.BuildIt` with entity CRUD (`entities.Task.list/filter/get/create/update/delete`) and end-user auth (`auth.register/login/me/logout`). Data is validated against the app's declared schema. |
| **Live preview** | Latest version served at `/preview/<id>/`, embedded in the workspace with desktop/mobile toggles. |
| **Code editor** | Edit any file or the `entities.json` schema by hand; saving creates a new version. |
| **Versions** | Full history; restore any version or publish any version (rollback). |
| **Publishing** | One click puts a version live at `/apps/<slug>/` or `https://<slug>.<APPS_DOMAIN>/`. Preview and live are independent. |
| **Data browser** | Inspect and delete the records and uploaded files each app has stored. |
| **File uploads** | Generated apps call `BuildIt.files.upload(file)` (10 MB per file, 500 MB per app) and get back a URL to store in a record. Files are served with `nosniff` and a CSP sandbox; only images, audio/video, PDF and plain text render inline, everything else downloads. |
| **Custom domains** | Connect `app.yourcompany.com` to a project: add a CNAME to the platform host and a `_buildit-challenge` TXT record, click Verify, and the live version is served on that domain on its own origin. |
| **Team workspaces** | Every account has a personal workspace; create team workspaces, invite people by email as admin or member, and everyone in the workspace can build, edit and publish its apps. Apps can be moved between workspaces. |
| **Template mode** | With no API key, a built-in template generator scaffolds a CRUD app so the whole loop can be tried offline. |

## Quick start

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY to generate apps with Claude
npm run dev                 # API on :3000, builder UI on http://localhost:5173
```

Production:

```bash
npm run build && npm start  # everything served from http://localhost:3000
# or
docker build -t buildit . && docker run -p 3000:3000 -v buildit-data:/data -e ANTHROPIC_API_KEY=... buildit
```

Tests: `npm test` (end-to-end over HTTP: auth, generation, preview, runtime data API, app auth, versions, deploy, subdomain hosting, file uploads, custom domain verification and hosting (with a stubbed DNS resolver), workspaces/roles/invites, the pre-workspaces database migration, and the Claude request/response handling with a stubbed client).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Enables Claude generation. Without it, template mode. |
| `BUILDIT_MODEL` | `claude-opus-5-5` | Model used to generate apps. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL used in links; `https://` also turns on secure cookies. |
| `APPS_DOMAIN` | – | Serve published apps at `<slug>.<APPS_DOMAIN>` (needs a wildcard DNS record + TLS cert). `localhost:3000` works for local dev in most browsers. |

### Custom domains and TLS

Custom domains are told to CNAME to the host in `PUBLIC_URL`. BuildIT serves plain HTTP; for HTTPS on custom
domains put a TLS terminator with on-demand certificates in front. With Caddy:

```
{ on_demand_tls { ask http://localhost:3000/api/domains/check } }
https:// { tls { on_demand } reverse_proxy localhost:3000 }
```

`/api/domains/check?domain=…` answers 200 only for verified custom domains and existing `<slug>.<APPS_DOMAIN>` hosts,
so certificates are only issued for real apps.

### Workspace roles

| Role | Can |
|---|---|
| owner | everything, including deleting the workspace |
| admin | invite/remove members, change roles, rename the workspace, delete or move apps, connect domains |
| member | build, edit and publish the workspace's apps |

Invitations are matched by email: the invited person sees them on their dashboard after signing in with that address (no email is sent).

## Architecture

```
server/                 Express 5 + node:sqlite, run with tsx (no build step)
  src/builder.ts        Builder API: accounts, projects, chat, versions, deploys, data browser
  src/runtime.ts        Public API used by generated apps: entities + end-user auth (bearer tokens, open CORS)
  src/hosting.ts        Serves preview/live apps (path, APPS_DOMAIN subdomain, custom domain) and injects the SDK
  src/uploads.ts        File upload/download API for generated apps
  src/domains.ts        Custom domain validation and DNS TXT verification
  src/workspaces.ts     Team workspaces, members, roles and invitations
  src/generator/        Claude generator (structured output) and offline template generator
  static/buildit-sdk.js The window.BuildIt SDK injected into every app
web/                    React + Vite builder UI (dashboard, chat, preview, code, data, versions, settings)
```

Generation runs in the background; the UI polls the project status. Each generation or edit
creates an immutable version (full file set + entity schemas). A deployment points the live URL
at one version, so publishing and rollback are instant.

### Security model

Generated code is untrusted. When served from the platform origin (`/preview/...`, `/apps/...`)
it gets a `Content-Security-Policy: sandbox` header, giving it an opaque origin so it can't read
the builder's cookies or call the builder API. The runtime API therefore uses bearer tokens
instead of cookies. On `APPS_DOMAIN` subdomains each app already has its own origin and runs
unsandboxed (so `localStorage`-backed logins persist). Preview URLs are unlisted capabilities
(project UUIDs), not access-controlled.

## Known limitations / next steps

- **Data access rules**: every app's data and upload API is public to anyone who has the app URL; records and files carry `created_by`, but per-row permissions (Base44-style RLS) aren't enforced yet (only file deletion checks the uploader).
- **Generation**: whole-file regeneration on every edit; large apps would benefit from diff-based edits and streaming progress to the UI.
- **Jobs**: generation runs in-process; a restart marks in-flight builds as failed. A queue (and multiple workers) is the next step for scale.
- **Storage**: SQLite on one node, uploaded files included (as BLOBs). Swap for Postgres plus object storage (S3/R2) to run several instances or store a lot of files.
- **Invitations**: no emails are sent; invitees must sign in with the invited address. Ownership can't be transferred yet.
- **Not yet**: integrations (email, payments, LLM calls from generated apps), billing/quotas per plan.
