
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "FixIt AI" });
});

app.post("/api/ai/chat", async (req, res) => {
  try {
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

app.listen(PORT, () => {
  console.log(`FixIt backend running at http://localhost:${PORT}`);
});
