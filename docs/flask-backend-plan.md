# Flask Backend Integration Plan

## Overview

The DFD editor already has two features that make this integration lightweight: a `?readonly` embed mode that strips all editor chrome to canvas-only, and a `?src=<url>` load mechanism that fetches any URL and renders it as a diagram. This plan exploits both. We scaffold a minimal Flask server in `server/`, wire a Vite dev proxy so `/api` calls are same-origin during development, add a thin TypeScript save client, and connect both processes with a single `npm run dev:all` command.

**Embed mode answer (Step 0):** No work needed. `?readonly` is already implemented in `App.vue` — passing `?src=/api/diagrams/<uuid>&readonly` renders the diagram full-screen with all editing UI hidden. This is confirmed, documented, and free.

**Timing note:** TB-9 (OTM vs. native JSON format decision) is unresolved. Files stored via this server may need migration once TB-9 lands. Treat stored files as provisional until that decision is made. All files must preserve the `schema.id` field so a future migration script can identify their generation.

---

## Step 1 — Flask server scaffold

Create a `server/` directory at the repo root containing a minimal Flask application.

**Files to create:**
- `server/app.py` — Flask app
- `server/requirements.txt` — dependencies
- `server/data/` — flat-file diagram storage (git-ignored)

**Routes:**

```
GET  /api/health                → 200 { status: "ok" }
POST /api/diagrams              → create new diagram, return { id: <uuid> }
GET  /api/diagrams/<uuid>       → return stored JSON with Content-Type: application/json
PUT  /api/diagrams/<uuid>       → accept JSON body, persist to server/data/<uuid>.json
```

**Behavior:**
- Storage is flat files: `server/data/<uuid>.json` contains the raw diagram JSON
- `flask-cors` configured to allow `http://localhost:5173` in development
- `POST /api/diagrams` generates a UUID, writes an empty diagram scaffold, returns the ID
- `PUT` body is the verbatim JSON from the frontend — do not transform it; preserve `schema.id`
- Return `404` with `{ error: "not found" }` for unknown IDs

**Setup (Python):**
```
python -m venv server/.venv
source server/.venv/bin/activate   # or server/.venv/Scripts/activate on Windows
pip install -r server/requirements.txt
```

**Acceptance criteria:**
- `curl http://localhost:5000/api/health` returns `{"status": "ok"}`
- `POST /api/diagrams` returns a UUID; `GET /api/diagrams/<that-uuid>` returns the stored JSON
- `PUT /api/diagrams/<uuid>` with a valid `.dfd` body persists to disk and returns `204`

---

## Step 2 — Vite dev proxy

Add a proxy entry to `vite.config.ts` so that `/api/*` requests from the browser are forwarded to Flask on port 5000. This makes API calls same-origin from the browser's perspective — no CORS headers required in development.

**Change in `vite.config.ts`:**

```
server.proxy:
  "/api" → "http://127.0.0.1:5000"
  (rewrite not needed — Flask routes already start with /api)
```

**Immediate result:** Opening `http://localhost:5173/?src=/api/diagrams/<uuid>` loads and renders the stored diagram with zero additional TypeScript changes. The existing `loadFileFromUrl` in `FileManagement/index.ts` handles everything.

**Note on `?readonly`:** When opening a diagram for editing (read-write), do not include `?readonly`. The `?src=` mechanism is read-write by default.

**Note on display name:** The editor title bar derives the file name from the URL path, so a UUID-based URL will display as the UUID. This is acceptable for now; a `Content-Disposition` header on the GET endpoint can improve it later without frontend changes.

**Acceptance criteria:**
- `http://localhost:5173/?src=/api/diagrams/<uuid>` renders the diagram with no CORS errors in the browser console
- Network tab shows the `/api/diagrams/<uuid>` request going to Vite's dev server (proxied), not directly to port 5000

---

## Step 3 — TypeScript API save client

Add a thin API client module and wire a "save to server" action to the command processor.

**New file:** `src/assets/scripts/api/DfdApiClient.ts`

```
type DiagramId = string  // UUID

saveDiagram(id: DiagramId, payload: DfdPublisherOutput) → Promise<void>
  PUT /api/diagrams/<id>
  body: JSON.stringify(payload)
  Content-Type: application/json
  throws on non-2xx

createDiagram() → Promise<DiagramId>
  POST /api/diagrams
  returns the id from response JSON
```

Where `DfdPublisherOutput` is the type already produced by `DfdPublisher.publish()` — `{ nodes, edges }` with `parent` and `crosses` populated.

**Wire-up in `DfdCommandProcessor`:** Add a `SaveToServer` command that:
1. Calls `publisher.publish(file)` to get the current diagram state
2. Reads the diagram ID from the URL query params (or from a store field set at load time)
3. Calls `saveDiagram(id, output)`

Bind this command to `Ctrl+Shift+S` or a "Save to Server" menu entry — do not replace the existing `Ctrl+S` device-save flow.

**Affected files:**
- `src/assets/scripts/api/DfdApiClient.ts` (new)
- `src/assets/configuration/DfdCommandProcessor/DfdCommandProcessor.ts`
- `src/App.vue` (add keybinding or menu entry)

**Acceptance criteria:**
- With diagram loaded via `?src=/api/diagrams/<uuid>`, triggering the save command PUTs updated JSON to Flask
- `server/data/<uuid>.dfd` is updated on disk after save
- Existing `Ctrl+S` device-save flow is unchanged

---

## Step 4 — Local dev orchestration

Wire both servers to start with a single command.

**Install `concurrently`:**
```
npm install --save-dev concurrently
```

**Add to `package.json` scripts:**
```
"dev:flask": "cd server && .venv/bin/flask --app app run --debug"
"dev:all":   "concurrently --names 'vite,flask' --prefix-colors 'cyan,yellow'
              'npm run dev' 'npm run dev:flask'"
```

The `--debug` flag enables Flask's auto-reloader so Python changes hot-reload alongside Vite's HMR. `concurrently` kills both processes when either exits or Ctrl+C is pressed.

**Acceptance criteria:**
- `npm run dev:all` starts both Vite (port 5173) and Flask (port 5000) in a single terminal with color-coded output
- Killing with Ctrl+C stops both processes cleanly
- Changing a `.py` file restarts Flask; changing a `.ts` file triggers Vite HMR — neither restarts the other

---

## Definition of Done

- All step-level acceptance criteria met
- `npm run dev:all` starts a working environment from a clean checkout (after `npm install` and Python venv setup)
- A diagram can be created via `POST /api/diagrams`, loaded in the editor via `?src=/api/diagrams/<uuid>`, edited, and saved back via the save command — the round-trip is fully functional
- The `?src=/api/diagrams/<uuid>&readonly` embed URL renders the diagram with no editor chrome
- Existing `npm run test:unit` and `npm run lint` pass without modification
- `server/data/` is in `.gitignore`
- Stored `.dfd` files preserve the `schema.id` field
