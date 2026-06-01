import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI, Modality } from "@google/genai";

dotenv.config();

// --- AI configuration ---
// Text completions are routed through the NabuGate gateway when configured.
// Image generation and TTS still call Gemini directly (the gateway MVP is
// text-only). Keeping these server-side means no API key ships in the client.
const NABU_GATEWAY_URL = process.env.NABU_GATEWAY_URL || "";
const NABU_API_KEY = process.env.NABU_API_KEY || "";
const NABU_MODEL = process.env.NABU_MODEL || "nabu-smart";
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

  // Image generation — Gemini (the gateway MVP is text-only).
  app.post("/api/generate-image", async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: "Image generation not configured" });
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const imageResponse = await ai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [{ text: prompt }],
        config: { imageConfig: { aspectRatio: "16:9" } },
      });
      const part = imageResponse.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
      if (part?.inlineData) {
        res.json({ image: `data:image/png;base64,${part.inlineData.data}` });
      } else {
        res.status(502).json({ error: "No image returned" });
      }
    } catch (err: any) {
      console.error("image error:", err?.message || err);
      res.status(502).json({ error: "Image generation failed" });
    }
  });

  // Text-to-speech — Gemini. Returns raw base64 PCM; the client wraps it as WAV.
  app.post("/api/tts", async (req, res) => {
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: "TTS not configured" });
    try {
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
      if (base64Audio) {
        res.json({ audioBase64: base64Audio });
      } else {
        res.status(502).json({ error: "No audio returned" });
      }
    } catch (err: any) {
      console.error("tts error:", err?.message || err);
      res.status(502).json({ error: "TTS failed" });
    }
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
