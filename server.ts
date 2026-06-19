import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI, Modality } from "@google/genai";

// Load .env.local first (documented for local dev), then .env. dotenv does not
// override already-set vars, so .env.local takes precedence.
dotenv.config({ path: ".env.local" });
dotenv.config();

// --- AI configuration ---
// All AI calls run server-side so no API key ships in the client. Text, image
// and TTS are routed through the NabuGate gateway when NABU_GATEWAY_URL is set;
// otherwise they call Gemini directly (the Gemini fallback below).
// NOTE: the NABU_* values are `let` because the admin settings panel can
// override them at runtime (persisted in SQLite — see loadSettings/applySetting).
let NABU_GATEWAY_URL = process.env.NABU_GATEWAY_URL || "";
let NABU_API_KEY = process.env.NABU_API_KEY || "";
let NABU_MODEL = process.env.NABU_MODEL || "nabu-smart";
let NABU_IMAGE_MODEL = process.env.NABU_IMAGE_MODEL || "nabu-image";
let NABU_AUDIO_MODEL = process.env.NABU_AUDIO_MODEL || "nabu-voice";
let NABU_EMBED_MODEL = process.env.NABU_EMBED_MODEL || "nabu-embed";
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "text-embedding-004";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3-flash-preview";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
// How long to wait on a NabuGate request before giving up (ms). Keeps a hung
// gateway from blocking a request forever. Image generation gets 2x this.
let NABU_TIMEOUT_MS = Number(process.env.NABU_TIMEOUT_MS) || 60000;
// Password that gates the in-app settings panel (GET/POST /api/settings). When
// empty the panel is disabled, so the gateway address/key can never be changed
// by an anonymous visitor.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// aiBackend reports which backend is wired up, for startup logs and /api/health.
function aiBackend(): "nabugate" | "gemini" | "none" {
  if (NABU_GATEWAY_URL) return "nabugate";
  if (GEMINI_API_KEY) return "gemini";
  return "none";
}

// withTimeout runs fn with an AbortSignal that fires after timeoutMs, so a slow
// or unreachable gateway fails fast instead of hanging. For streaming callers,
// resolve fn as soon as the response headers arrive so the body can stream past
// the timeout window.
async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// verifyNabuGate pings the gateway once at startup so a wrong URL/key shows up in
// the logs immediately instead of only failing on the first user request.
async function verifyNabuGate(): Promise<void> {
  if (!NABU_GATEWAY_URL) return;
  try {
    const resp = await withTimeout(5000, (signal) =>
      fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/healthz`, {
        headers: { ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}) },
        signal,
      }),
    );
    if (resp.ok) console.log("NabuGate reachable ✓");
    else console.warn(`NabuGate health check returned HTTP ${resp.status}. Check NABU_API_KEY / gateway config.`);
  } catch (err: any) {
    console.warn(`NabuGate not reachable: ${err?.name === "AbortError" ? "timeout" : err?.message || err}`);
  }
}

const DB_PATH = process.env.DATABASE_PATH || "mokri_assistant.db";
const db = new Database(DB_PATH);

// Initialize Database
db.exec(`
  -- Drop old tables if they exist with old schema
  -- This is a simple way to handle schema changes in dev
  -- In production, you would use migrations
  PRAGMA foreign_keys = OFF;
  
  -- Check if 'phone' column exists in 'users' (old schema)
  -- If it does, we need to migrate or recreate
`);

try {
  const tableInfo = db.prepare("PRAGMA table_info(users)").all();
  const hasPhone = tableInfo.some((col: any) => col.name === 'phone');
  if (hasPhone) {
    db.exec("DROP TABLE IF EXISTS queries; DROP TABLE IF EXISTS users;");
  }
} catch (e) {
  // Table might not exist yet
}

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT UNIQUE NOT NULL, -- Can be phone or email
    type TEXT NOT NULL, -- 'phone' or 'email'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_context TEXT, -- New field for "about yourself"
    problem TEXT NOT NULL,
    personality TEXT,
    style TEXT,
    language TEXT,
    answer TEXT NOT NULL,
    images TEXT, -- JSON array of image URLs
    is_public INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- Cached embeddings for the podcast corpus (semantic search grounding).
  CREATE TABLE IF NOT EXISTS podcast_vectors (
    idx INTEGER PRIMARY KEY,   -- index into the podcasts array
    vec BLOB NOT NULL          -- Float32 little-endian embedding
  );

  -- Tracks which embedding model/corpus the cached vectors were built for, so
  -- stale caches are rebuilt automatically.
  CREATE TABLE IF NOT EXISTS embed_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    signature TEXT NOT NULL
  );

  -- Admin-editable runtime config (overrides the NABU_* env defaults).
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// --- Admin-editable runtime settings (persisted in SQLite) ---
// These override the NABU_* env defaults so the gateway address / models can be
// changed from the in-app settings panel without a redeploy. NABU_TIMEOUT_MS is
// numeric; everything else is a plain string.
const SETTABLE: Record<string, "string" | "number"> = {
  NABU_GATEWAY_URL: "string",
  NABU_API_KEY: "string",
  NABU_MODEL: "string",
  NABU_IMAGE_MODEL: "string",
  NABU_AUDIO_MODEL: "string",
  NABU_EMBED_MODEL: "string",
  NABU_TIMEOUT_MS: "number",
};

// applySetting writes one saved value back onto the live config binding.
function applySetting(key: string, value: string): void {
  switch (key) {
    case "NABU_GATEWAY_URL": NABU_GATEWAY_URL = value; break;
    case "NABU_API_KEY": NABU_API_KEY = value; break;
    case "NABU_MODEL": NABU_MODEL = value; break;
    case "NABU_IMAGE_MODEL": NABU_IMAGE_MODEL = value; break;
    case "NABU_AUDIO_MODEL": NABU_AUDIO_MODEL = value; break;
    case "NABU_EMBED_MODEL": NABU_EMBED_MODEL = value; break;
    case "NABU_TIMEOUT_MS": NABU_TIMEOUT_MS = Number(value) || NABU_TIMEOUT_MS; break;
  }
}

// loadSettings overlays any persisted overrides on top of the env defaults.
function loadSettings(): void {
  try {
    const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    for (const r of rows) if (r.key in SETTABLE) applySetting(r.key, r.value);
  } catch (err: any) {
    console.error("Failed to load settings:", err?.message || err);
  }
}

loadSettings();

// runChat sends a chat completion. It prefers the NabuGate gateway (so every
// project shares one routing/fallback/secret layer); if the gateway is not
// configured it falls back to calling Gemini directly.
async function runChat(
  messages: { role: string; content: string }[],
  temperature?: number,
): Promise<{ content: string; provider: string }> {
  if (NABU_GATEWAY_URL) {
    const data: any = await withTimeout(NABU_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: NABU_MODEL, messages, temperature }),
        signal,
      });
      if (!resp.ok) {
        throw new Error(`NabuGate error ${resp.status}: ${await resp.text()}`);
      }
      return resp.json();
    });
    return { content: data.choices?.[0]?.message?.content || "", provider: data.provider || "nabugate" };
  }

  if (!GEMINI_API_KEY) {
    throw new Error("No AI backend configured (set NABU_GATEWAY_URL or GEMINI_API_KEY)");
  }
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const systemText = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const response = await ai.models.generateContent({
    model: GEMINI_TEXT_MODEL,
    contents,
    config: {
      temperature: temperature ?? 0.8,
      ...(systemText ? { systemInstruction: systemText } : {}),
    },
  });
  return { content: response.text || "", provider: "gemini" };
}

// pcmToWav wraps raw mono 16-bit PCM in a WAV container (used for the
// Gemini-direct TTS path; the gateway already returns a complete audio file).
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// runImage generates one image via NabuGate (or Gemini fallback) and returns a
// ready-to-use data URL.
async function runImage(prompt: string): Promise<string | null> {
  if (NABU_GATEWAY_URL) {
    const data: any = await withTimeout(NABU_TIMEOUT_MS * 2, async (signal) => {
      const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: NABU_IMAGE_MODEL, prompt, n: 1, aspect_ratio: "16:9" }),
        signal,
      });
      if (!resp.ok) throw new Error(`NabuGate image error ${resp.status}: ${await resp.text()}`);
      return resp.json();
    });
    const b64 = data.data?.[0]?.b64_json;
    return b64 ? `data:image/png;base64,${b64}` : null;
  }

  if (!GEMINI_API_KEY) throw new Error("Image generation not configured");
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const imageResponse = await ai.models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents: [{ text: prompt }],
    config: { imageConfig: { aspectRatio: "16:9" } },
  });
  const part = imageResponse.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  return part?.inlineData ? `data:image/png;base64,${part.inlineData.data}` : null;
}

// runSpeech synthesizes speech via NabuGate (returns the provider's audio file)
// or Gemini directly (raw PCM wrapped to WAV here). Always returns a playable
// base64 file plus its MIME type.
async function runSpeech(text: string, voice?: string): Promise<{ audioBase64: string; mimeType: string } | null> {
  if (NABU_GATEWAY_URL) {
    return await withTimeout(NABU_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: NABU_AUDIO_MODEL, input: text, voice }),
        signal,
      });
      if (!resp.ok) throw new Error(`NabuGate tts error ${resp.status}: ${await resp.text()}`);
      const mimeType = resp.headers.get("content-type") || "audio/mpeg";
      const buf = Buffer.from(await resp.arrayBuffer());
      return { audioBase64: buf.toString("base64"), mimeType };
    });
  }

  if (!GEMINI_API_KEY) throw new Error("TTS not configured");
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_TTS_MODEL,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
    },
  });
  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) return null;
  const wav = pcmToWav(Buffer.from(base64Audio, "base64"), 24000);
  return { audioBase64: wav.toString("base64"), mimeType: "audio/wav" };
}

// --- Semantic search over the podcast corpus ---

interface Podcast {
  title: string;
  text: string;
  link: string;
  mp3_url: string | null;
}

let PODCASTS: Podcast[] = [];
try {
  PODCASTS = JSON.parse(fs.readFileSync(path.join(__dirname, "podcasts_db.json"), "utf8"));
} catch {
  PODCASTS = [];
}

const embeddingsAvailable = () => Boolean(NABU_GATEWAY_URL || GEMINI_API_KEY);

// runEmbeddings embeds texts via NabuGate (or Gemini's batchEmbedContents).
async function runEmbeddings(texts: string[]): Promise<number[][]> {
  if (NABU_GATEWAY_URL) {
    const data: any = await withTimeout(NABU_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: NABU_EMBED_MODEL, input: texts }),
        signal,
      });
      if (!resp.ok) throw new Error(`NabuGate embeddings error ${resp.status}: ${await resp.text()}`);
      return resp.json();
    });
    return (data.data || []).map((d: any) => d.embedding as number[]);
  }

  if (!GEMINI_API_KEY) throw new Error("Embeddings not configured");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const data: any = await withTimeout(NABU_TIMEOUT_MS, async (signal) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map(t => ({ model: `models/${GEMINI_EMBED_MODEL}`, content: { parts: [{ text: t }] } })),
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`Gemini embeddings error ${resp.status}: ${await resp.text()}`);
    return resp.json();
  });
  return (data.embeddings || []).map((e: any) => e.values as number[]);
}

function corpusText(p: Podcast): string {
  // Title + a bounded slice of the transcript to stay within embedding limits.
  return `${p.title}\n${(p.text || "").slice(0, 6000)}`;
}

function corpusSignature(): string {
  const model = NABU_GATEWAY_URL ? `nabu:${NABU_EMBED_MODEL}` : `gemini:${GEMINI_EMBED_MODEL}`;
  return crypto.createHash("sha1").update(`${model}|${PODCASTS.length}`).digest("hex");
}

function floatsToBuf(v: number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function bufToFloats(b: Buffer): Float32Array {
  // Read element-wise to avoid alignment assumptions on the underlying buffer.
  const out = new Float32Array(Math.floor(b.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

let corpusReady = false;
let corpusBuilding = false;

function vectorCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM podcast_vectors").get() as any).c;
}

function storedSignature(): string | null {
  const row = db.prepare("SELECT signature FROM embed_meta WHERE id = 1").get() as any;
  return row?.signature ?? null;
}

// ensureCorpusVectors builds (once) the cached corpus embeddings if missing or
// stale. It runs in the background; callers fall back to keyword search until
// it completes.
async function ensureCorpusVectors(): Promise<void> {
  if (corpusReady || corpusBuilding || PODCASTS.length === 0 || !embeddingsAvailable()) return;
  const sig = corpusSignature();
  if (storedSignature() === sig && vectorCount() === PODCASTS.length) {
    corpusReady = true;
    return;
  }
  corpusBuilding = true;
  try {
    db.exec("DELETE FROM podcast_vectors;");
    const insert = db.prepare("INSERT OR REPLACE INTO podcast_vectors (idx, vec) VALUES (?, ?)");
    const tx = db.transaction((rows: { idx: number; vec: Buffer }[]) => {
      for (const r of rows) insert.run(r.idx, r.vec);
    });
    const BATCH = 32;
    for (let i = 0; i < PODCASTS.length; i += BATCH) {
      const slice = PODCASTS.slice(i, i + BATCH);
      const vecs = await runEmbeddings(slice.map(corpusText));
      tx(vecs.map((v, j) => ({ idx: i + j, vec: floatsToBuf(v) })));
    }
    db.prepare("INSERT OR REPLACE INTO embed_meta (id, signature) VALUES (1, ?)").run(sig);
    corpusReady = true;
    console.log(`Corpus embeddings ready (${PODCASTS.length} podcasts).`);
  } catch (err: any) {
    console.error("Corpus embedding build failed:", err?.message || err);
  } finally {
    corpusBuilding = false;
  }
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function semanticSearch(query: string, k: number): Promise<Podcast[]> {
  const [qvec] = await runEmbeddings([query]);
  if (!qvec) return [];
  const rows = db.prepare("SELECT idx, vec FROM podcast_vectors").all() as { idx: number; vec: Buffer }[];
  return rows
    .map(r => ({ idx: r.idx, score: cosine(bufToFloats(r.vec), qvec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => PODCASTS[s.idx])
    .filter(Boolean);
}

function keywordSearch(query: string, k: number): Podcast[] {
  if (!query || PODCASTS.length === 0) return [];
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return PODCASTS
    .map(p => {
      const content = (p.title + " " + p.text).toLowerCase();
      let score = 0;
      keywords.forEach(kw => { if (content.includes(kw)) score++; });
      return { p, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.p);
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Health & AI-backend diagnostics. Reports which backend is wired up and, for
  // NabuGate, whether the gateway is actually reachable right now — handy for
  // confirming the connection from a browser or uptime check.
  app.get("/api/health", async (_req, res) => {
    const backend = aiBackend();
    const info: any = {
      status: "ok",
      aiBackend: backend,
      textModel: backend === "nabugate" ? NABU_MODEL : backend === "gemini" ? GEMINI_TEXT_MODEL : null,
    };
    if (backend === "nabugate") {
      info.gateway = {
        url: NABU_GATEWAY_URL,
        models: { text: NABU_MODEL, image: NABU_IMAGE_MODEL, audio: NABU_AUDIO_MODEL, embed: NABU_EMBED_MODEL },
      };
      try {
        const ping = await withTimeout(5000, (signal) =>
          fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/healthz`, {
            headers: { ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}) },
            signal,
          }),
        );
        info.gateway.reachable = ping.ok;
        info.gateway.statusCode = ping.status;
      } catch (err: any) {
        info.gateway.reachable = false;
        info.gateway.error = err?.name === "AbortError" ? "timeout" : err?.message || "unreachable";
      }
    }
    res.json(info);
  });

  // --- Admin settings panel (change the NabuGate address / models at runtime) ---
  // Gated by ADMIN_PASSWORD (sent in the x-admin-password header). The panel is
  // disabled entirely when ADMIN_PASSWORD is unset, so secrets are never exposed
  // or editable by anonymous visitors.
  const adminAuthorized = (req: any): boolean => {
    if (!ADMIN_PASSWORD) return false;
    const provided = Buffer.from(String(req.header("x-admin-password") || ""));
    const expected = Buffer.from(ADMIN_PASSWORD);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  // Never returns the API key itself — only whether one is set.
  const publicSettings = () => ({
    NABU_GATEWAY_URL,
    NABU_MODEL,
    NABU_IMAGE_MODEL,
    NABU_AUDIO_MODEL,
    NABU_EMBED_MODEL,
    NABU_TIMEOUT_MS,
    hasNabuApiKey: Boolean(NABU_API_KEY),
    aiBackend: aiBackend(),
  });

  // Lets the client know whether the panel is available without leaking config.
  app.get("/api/settings/status", (_req, res) => {
    res.json({ enabled: Boolean(ADMIN_PASSWORD) });
  });

  app.get("/api/settings", (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(403).json({ error: "Settings panel disabled. Set ADMIN_PASSWORD to enable it." });
    if (!adminAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
    res.json(publicSettings());
  });

  app.post("/api/settings", (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(403).json({ error: "Settings panel disabled. Set ADMIN_PASSWORD to enable it." });
    if (!adminAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

    const updates = (req.body && typeof req.body === "object") ? (req.body.settings ?? req.body) : {};
    const toSave: { key: string; value: string }[] = [];
    let embeddingConfigChanged = false;

    for (const [key, type] of Object.entries(SETTABLE)) {
      if (!(key in updates)) continue;
      const raw = updates[key];
      if (raw === undefined || raw === null) continue;
      // Blank API key means "keep the current one".
      if (key === "NABU_API_KEY" && String(raw).trim() === "") continue;
      let value = String(raw).trim();

      if (key === "NABU_GATEWAY_URL" && value) {
        try {
          const u = new URL(value);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad scheme");
          value = value.replace(/\/$/, "");
        } catch {
          return res.status(400).json({ error: "NABU_GATEWAY_URL must be a valid http(s) URL" });
        }
      }
      if (type === "number") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: `${key} must be a positive number` });
        value = String(Math.round(n));
      }
      if (key === "NABU_GATEWAY_URL" || key === "NABU_EMBED_MODEL") embeddingConfigChanged = true;
      toSave.push({ key, value });
    }

    try {
      const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      const tx = db.transaction((rows: { key: string; value: string }[]) => {
        for (const r of rows) { stmt.run(r.key, r.value); applySetting(r.key, r.value); }
      });
      tx(toSave);
    } catch (err: any) {
      console.error("save settings error:", err?.message || err);
      return res.status(500).json({ error: "Failed to save settings" });
    }

    // The cached corpus embeddings depend on the gateway/embed model, so rebuild
    // them next time if either changed.
    if (embeddingConfigChanged) {
      corpusReady = false;
      void ensureCorpusVectors();
    }
    res.json({ success: true, settings: publicSettings() });
  });

  // API Routes
  app.post("/api/login", (req, res) => {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: "Identifier is required" });

    const type = identifier.includes("@") ? "email" : "phone";

    try {
      const stmt = db.prepare("INSERT OR IGNORE INTO users (identifier, type) VALUES (?, ?)");
      stmt.run(identifier, type);
      const user = db.prepare("SELECT * FROM users WHERE identifier = ?").get(identifier);
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/save-query", (req, res) => {
    const { userId, userContext, problem, personality, style, language, answer, images, isPublic } = req.body;
    try {
      const stmt = db.prepare(`
        INSERT INTO queries (user_id, user_context, problem, personality, style, language, answer, images, is_public)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(userId, userContext, problem, personality, style, language, answer, JSON.stringify(images || []), isPublic ? 1 : 0);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save query" });
    }
  });

  app.get("/api/history/:userId", (req, res) => {
    try {
      const queries = db.prepare("SELECT * FROM queries WHERE user_id = ? ORDER BY created_at DESC").all(req.params.userId);
      res.json(queries.map(q => ({ ...q, images: JSON.parse(q.images as string) })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  app.get("/api/public-feed", (req, res) => {
    try {
      const queries = db.prepare(`
        SELECT q.*, u.identifier as user_id_text 
        FROM queries q 
        JOIN users u ON q.user_id = u.id 
        WHERE q.is_public = 1 
        ORDER BY q.created_at DESC 
        LIMIT 50
      `).all();
      res.json(queries.map(q => {
        const idText = q.user_id_text as string;
        const masked = idText.includes("@") 
          ? idText.split("@")[0].substring(0, 3) + "***@" + idText.split("@")[1]
          : idText.substring(0, 4) + "****" + idText.substring(8);
        
        return { 
          ...q, 
          images: JSON.parse(q.images as string),
          user_id_text: masked
        };
      }));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch public feed" });
    }
  });

  // --- AI endpoints (server-side; keeps API keys out of the client) ---

  // Text analysis — routed through NabuGate (or Gemini fallback).
  app.post("/api/analyze", async (req, res) => {
    const { messages, temperature } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages is required" });
    }
    try {
      const result = await runChat(messages, temperature);
      res.json(result);
    } catch (err: any) {
      console.error("analyze error:", err?.message || err);
      res.status(502).json({ error: "AI request failed" });
    }
  });

  // Streaming text analysis — Server-Sent Events of { delta } objects.
  app.post("/api/analyze-stream", async (req, res) => {
    const { messages, temperature } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages is required" });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      if (NABU_GATEWAY_URL) {
        // Connect timeout only: once headers arrive the answer may stream for a
        // while, so we don't cap the total streaming duration.
        const upstream = await withTimeout(30000, (signal) =>
          fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
            },
            body: JSON.stringify({ model: NABU_MODEL, messages, temperature, stream: true }),
            signal,
          }),
        );
        if (!upstream.ok || !upstream.body) throw new Error(`gateway stream error ${upstream.status}`);
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const l = line.trim();
            if (!l.startsWith("data:")) continue;
            const d = l.slice(5).trim();
            if (d === "[DONE]") continue;
            try {
              const delta = JSON.parse(d).choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            } catch { /* ignore keep-alive lines */ }
          }
        }
      } else {
        if (!GEMINI_API_KEY) throw new Error("No AI backend configured");
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const systemText = messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n\n");
        const contents = messages
          .filter((m: any) => m.role !== "system")
          .map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        const stream = await ai.models.generateContentStream({
          model: GEMINI_TEXT_MODEL,
          contents,
          config: { temperature: temperature ?? 0.8, ...(systemText ? { systemInstruction: systemText } : {}) },
        });
        for await (const chunk of stream) {
          const t = chunk.text;
          if (t) send({ delta: t });
        }
      }
      send({ done: true });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      console.error("analyze-stream error:", err?.message || err);
      if (!res.headersSent) {
        res.status(502).json({ error: "AI stream failed" });
      } else {
        send({ error: "stream failed" });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  // Relevant podcast context — semantic search (embeddings) with a keyword
  // fallback while the corpus embeddings are still being built.
  app.post("/api/relevant-context", async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });
    try {
      if (embeddingsAvailable() && corpusReady) {
        return res.json({ method: "semantic", results: await semanticSearch(query, 5) });
      }
      if (embeddingsAvailable()) void ensureCorpusVectors(); // build for next time
      res.json({ method: "keyword", results: keywordSearch(query, 5) });
    } catch (err: any) {
      console.error("relevant-context error:", err?.message || err);
      res.json({ method: "keyword", results: keywordSearch(query, 5) });
    }
  });

  // Image generation — routed through NabuGate (Gemini fallback).
  app.post("/api/generate-image", async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    try {
      const image = await runImage(prompt);
      if (image) {
        res.json({ image });
      } else {
        res.status(502).json({ error: "No image returned" });
      }
    } catch (err: any) {
      console.error("image error:", err?.message || err);
      res.status(502).json({ error: "Image generation failed" });
    }
  });

  // Text-to-speech — routed through NabuGate (Gemini fallback). Returns a
  // ready-to-play base64 audio file plus its MIME type.
  app.post("/api/tts", async (req, res) => {
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const audio = await runSpeech(text, voice);
      if (audio) {
        res.json(audio);
      } else {
        res.status(502).json({ error: "No audio returned" });
      }
    } catch (err: any) {
      console.error("tts error:", err?.message || err);
      res.status(502).json({ error: "TTS failed" });
    }
  });

  // Serve the podcast corpus the client fetches. Registered before the static
  // handler so it works in production too (the file lives next to server.ts,
  // not in the built dist/).
  app.get("/podcasts_db.json", (_req, res) => {
    res.sendFile(path.join(__dirname, "podcasts_db.json"));
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, "dist");
    app.use(express.static(distDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          // index.html must always be revalidated so a redeploy is picked up
          // immediately (it points at the freshly content-hashed bundle).
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // Vite emits content-hashed filenames under /assets — safe forever.
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    const backend = aiBackend();
    if (backend === "nabugate") {
      console.log(
        `AI backend: NabuGate → ${NABU_GATEWAY_URL} ` +
        `(text=${NABU_MODEL}, image=${NABU_IMAGE_MODEL}, audio=${NABU_AUDIO_MODEL}, embed=${NABU_EMBED_MODEL})`,
      );
      void verifyNabuGate();
    } else if (backend === "gemini") {
      console.log("AI backend: Gemini direct. Set NABU_GATEWAY_URL (+ NABU_API_KEY) to route through NabuGate.");
    } else {
      console.warn("AI backend: NONE configured. Set NABU_GATEWAY_URL (+ NABU_API_KEY) or GEMINI_API_KEY.");
    }
    // Warm the semantic-search corpus in the background (no-op if no embeddings).
    void ensureCorpusVectors();
  });
}

startServer();
