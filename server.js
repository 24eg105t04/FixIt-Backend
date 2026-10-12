
import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import authRoutes from "./routes/auth.js";
import marketplaceRoutes from "./routes/marketplace.js";

const app = express();
const PORT = process.env.PORT || 8080;
import youfixRoutes from "./routes/youfix.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const allowedOrigins = new Set([
  process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)) }));
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads"), { fallthrough: false, maxAge: "1d" }));
app.use("/api/auth", authRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/youfix", youfixRoutes);

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "FixIt AI" });
});

app.post("/api/ai/chat", async (req, res) => {
  try {
    if (!ai) {
      return res.status(503).json({
        error: "FixIt AI is unavailable until GEMINI_API_KEY is configured.",
      });
    }
    const question = req.body?.question;

    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({
        error: "Please enter a device-related question.",
      });
    }

    if (question.length > 4000) {
      return res.status(400).json({
        error: "Please keep your question under 4000 characters.",
      });
    }

    const prompt = `
You are FixIt AI, a helpful electronics troubleshooting assistant.

Help users understand possible problems with phones, laptops,
tablets and other electronic devices.

For every answer:
- Explain likely causes without claiming certainty.
- Give clear, safe troubleshooting steps.
- Ask a relevant follow-up question when useful.
- Never claim a repair or diagnosis has been confirmed.
- Warn users not to open dangerous electrical equipment.
- For swollen batteries, smoke, burning smells or unusual heat,
  advise stopping use, disconnecting power if safe, and seeking
  qualified professional help.
- For liquid damage, advise powering off and not charging.
- Never recommend bypassing battery or electrical safety features.
- Keep answers friendly, practical and easy to understand.

User's question:
${question.trim()}
`;

    const result = await ai.models.generateContent({
      model: "gemini-flash-latest",
      contents: prompt,
    });

    const answer = result.text?.trim();

    if (!answer) {
      throw new Error("The AI returned an empty response.");
    }

    res.json({ answer });
  } catch (error) {
    console.error("FixIt AI error:", error.message);

    res.status(502).json({
      error:
        "FixIt AI could not respond right now. Please try again shortly.",
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) console.error("FixIt API error:", error.message);
  res.status(status).json({
    error: status === 413 ? "Request payload is too large." : status >= 500 ? "The server could not complete the request." : error.message,
  });
});

app.listen(PORT, () => {
  console.log(`FixIt backend running at http://localhost:${PORT}`);
});
