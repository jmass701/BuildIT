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
| **Data browser** | Inspect and delete the records each app has stored. |
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

Tests: `npm test` (end-to-end over HTTP: auth, generation, preview, runtime data API, app auth, versions, deploy, subdomain hosting, and the Claude request/response handling with a stubbed client).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Enables Claude generation. Without it, template mode. |
| `BUILDIT_MODEL` | `claude-opus-5-5` | Model used to generate apps. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL used in links; `https://` also turns on secure cookies. |
| `APPS_DOMAIN` | – | Serve published apps at `<slug>.<APPS_DOMAIN>` (needs a wildcard DNS record + TLS cert). `localhost:3000` works for local dev in most browsers. |

## Architecture

```
server/                 Express 5 + node:sqlite, run with tsx (no build step)
  src/builder.ts        Builder API: accounts, projects, chat, versions, deploys, data browser
  src/runtime.ts        Public API used by generated apps: entities + end-user auth (bearer tokens, open CORS)
  src/hosting.ts        Serves preview/live apps and injects the SDK
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

- **Data access rules**: every app's data API is public to anyone who has the app URL; records carry `created_by`, but per-row permissions (Base44-style RLS) aren't enforced yet.
- **Generation**: whole-file regeneration on every edit; large apps would benefit from diff-based edits and streaming progress to the UI.
- **Jobs**: generation runs in-process; a restart marks in-flight builds as failed. A queue (and multiple workers) is the next step for scale.
- **Storage**: SQLite on one node. Swap for Postgres to run several instances.
- **Not yet**: file uploads, custom domains, integrations (email, payments, LLM calls from generated apps), team workspaces, billing/quotas.
