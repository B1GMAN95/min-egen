import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/voice/token", async (req, res) => {
  try {
    const { systemPrompt, voice } = req.body;

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: voice || "alloy",
        instructions:
          systemPrompt ||
          "You are TaskSync AI. Professional Norwegian receptionist. Do not interrupt.",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      client_secret: data.client_secret.value,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync voice gateway running on :${PORT}`);
});
