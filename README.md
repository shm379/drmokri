<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/4f565623-8ccb-40c2-adf3-a2cab9063285

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy with Coolify

This repo ships with a `Dockerfile` and a `docker-compose.yml` so it can be
deployed to a self-hosted [Coolify](https://coolify.io) instance.

### Option A — Docker Compose (recommended)

1. In Coolify, create a new **Resource → Docker Compose** and point it at this
   Git repository (it auto-detects `docker-compose.yml`).
2. Add the following **Environment Variables** (all runtime — no build secrets):
   - `GEMINI_API_KEY` — Gemini key for image/TTS (and text fallback).
   - `NABU_GATEWAY_URL`, `NABU_API_KEY`, `NABU_MODEL` — to route text through
     NabuGate (see the [AI backend](#ai-backend) section).
   - `APP_URL` — the public URL Coolify assigns to the app (optional).
3. Coolify provisions the `mokri-data` volume automatically, which persists the
   SQLite database (`/data/mokri_assistant.db`) across redeploys.
4. Set the exposed port to **3000** (Coolify handles the reverse proxy + HTTPS).
5. Click **Deploy**.

### Option B — Dockerfile

1. Create a new **Resource → Dockerfile** (or Application) pointing at this repo.
2. Add the runtime environment variables (`GEMINI_API_KEY`, and optionally the
   `NABU_*` vars — see [AI backend](#ai-backend)).
3. Set the port to **3000**.
4. Add a **Persistent Storage** mount at `/data` so the SQLite database survives
   redeploys.
5. Click **Deploy**.

### AI backend

All AI calls run **server-side** — no API key is shipped to the browser. Text
analysis (streamed live), image generation, text-to-speech, and semantic search
over the podcast corpus are all sent to the
[NabuGate gateway](https://github.com/nabuxai/NabuGate) (a separate project)
when configured; otherwise the server calls Gemini directly.

- Set `NABU_GATEWAY_URL` (+ `NABU_API_KEY`, `NABU_MODEL`, `NABU_IMAGE_MODEL`,
  `NABU_AUDIO_MODEL`, `NABU_EMBED_MODEL`) to route everything through NabuGate.
- Set `GEMINI_API_KEY` as the fallback for text/image/TTS/embeddings when
  NabuGate is not configured.

**Streaming:** `/api/analyze-stream` returns the answer as Server-Sent Events so
the UI types it out live.

**Health check:** `GET /api/health` reports the active AI backend and, when
NabuGate is configured, pings the gateway and returns whether it is reachable
(`{ "aiBackend": "nabugate", "gateway": { "reachable": true, ... } }`). The
server also logs the active backend — and a NabuGate reachability check — on
startup.

**Semantic search:** `/api/relevant-context` ranks podcasts by embedding
similarity (alias `nabu-embed`). Corpus vectors are built once and cached in
SQLite (rebuilt automatically if the model or corpus changes); until they are
ready — or if no embeddings backend is configured — it falls back to keyword
matching.

### Environment variables

| Variable           | Where    | Description                                                       |
| ------------------ | -------- | ----------------------------------------------------------------- |
| `GEMINI_API_KEY`   | Runtime  | Gemini fallback for text/image/TTS. Server-side only.             |
| `NABU_GATEWAY_URL` | Runtime  | NabuGate base URL (e.g. `http://nabugate:8080`).                  |
| `NABU_API_KEY`     | Runtime  | Internal API key sent to NabuGate.                                |
| `NABU_MODEL`       | Runtime  | NabuGate text alias (default `nabu-smart`).                       |
| `NABU_IMAGE_MODEL` | Runtime  | NabuGate image alias (default `nabu-image`).                      |
| `NABU_AUDIO_MODEL` | Runtime  | NabuGate speech alias (default `nabu-voice`).                     |
| `NABU_EMBED_MODEL` | Runtime  | NabuGate embedding alias for semantic search (default `nabu-embed`). |
| `NABU_TIMEOUT_MS`  | Runtime  | Per-request timeout for gateway calls in ms (default `60000`; images get 2x). The answer stream is exempt once it starts. |
| `PORT`             | Runtime  | Port the server listens on (default `3000`).                      |
| `DATABASE_PATH`    | Runtime  | SQLite file path (server default `mokri_assistant.db`; the Docker image sets `/data/mokri_assistant.db`). |
| `APP_URL`          | Runtime  | Public URL of the deployment (optional).                          |

### Build & run locally with Docker

```bash
docker build -t drmokri .
docker run -p 3000:3000 -v drmokri-data:/data \
  -e GEMINI_API_KEY=your_key_here \
  -e NABU_GATEWAY_URL=http://host.docker.internal:8080 -e NABU_API_KEY=nabu_dev_key_change_me \
  drmokri
```
