import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("mokri_assistant.db");

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

async function startServer() {
  const app = express();
  const PORT = 3000;

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
