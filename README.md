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
2. Add the following **Environment Variables** in the resource settings:
   - `GEMINI_API_KEY` — your Gemini API key. Mark it as a **Build Variable** so
     Vite can inline it into the client bundle at build time.
   - `APP_URL` — the public URL Coolify assigns to the app (optional).
3. Coolify provisions the `mokri-data` volume automatically, which persists the
   SQLite database (`/data/mokri_assistant.db`) across redeploys.
4. Set the exposed port to **3000** (Coolify handles the reverse proxy + HTTPS).
5. Click **Deploy**.

### Option B — Dockerfile

1. Create a new **Resource → Dockerfile** (or Application) pointing at this repo.
2. Add the build argument / variable `GEMINI_API_KEY` (Build Variable).
3. Set the port to **3000**.
4. Add a **Persistent Storage** mount at `/data` so the SQLite database survives
   redeploys.
5. Click **Deploy**.

### Environment variables

| Variable         | Where        | Description                                              |
| ---------------- | ------------ | -------------------------------------------------------- |
| `GEMINI_API_KEY` | Build time   | Gemini API key, inlined into the client bundle by Vite.  |
| `PORT`           | Runtime      | Port the server listens on (default `3000`).             |
| `DATABASE_PATH`  | Runtime      | SQLite file path (default `/data/mokri_assistant.db`).   |
| `APP_URL`        | Runtime      | Public URL of the deployment (optional).                 |

### Build & run locally with Docker

```bash
docker build --build-arg GEMINI_API_KEY=your_key_here -t drmokri .
docker run -p 3000:3000 -v drmokri-data:/data drmokri
```
