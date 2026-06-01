import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
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
const NABU_GATEWAY_URL = process.env.NABU_GATEWAY_URL || "";
const NABU_API_KEY = process.env.NABU_API_KEY || "";
const NABU_MODEL = process.env.NABU_MODEL || "nabu-smart";
const NABU_IMAGE_MODEL = process.env.NABU_IMAGE_MODEL || "nabu-image";
const NABU_AUDIO_MODEL = process.env.NABU_AUDIO_MODEL || "nabu-voice";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3-flash-preview";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
`);

// runChat sends a chat completion. It prefers the NabuGate gateway (so every
// project shares one routing/fallback/secret layer); if the gateway is not
// configured it falls back to calling Gemini directly.
async function runChat(
  messages: { role: string; content: string }[],
  temperature?: number,
): Promise<{ content: string; provider: string }> {
  if (NABU_GATEWAY_URL) {
    const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: NABU_MODEL, messages, temperature }),
    });
    if (!resp.ok) {
      throw new Error(`NabuGate error ${resp.status}: ${await resp.text()}`);
    }
    const data: any = await resp.json();
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
    const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: NABU_IMAGE_MODEL, prompt, n: 1, aspect_ratio: "16:9" }),
    });
    if (!resp.ok) throw new Error(`NabuGate image error ${resp.status}: ${await resp.text()}`);
    const data: any = await resp.json();
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
    const resp = await fetch(`${NABU_GATEWAY_URL.replace(/\/$/, "")}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NABU_API_KEY ? { Authorization: `Bearer ${NABU_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: NABU_AUDIO_MODEL, input: text, voice }),
    });
    if (!resp.ok) throw new Error(`NabuGate tts error ${resp.status}: ${await resp.text()}`);
    const mimeType = resp.headers.get("content-type") || "audio/mpeg";
    const buf = Buffer.from(await resp.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mimeType };
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

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
