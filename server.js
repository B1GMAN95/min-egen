// server.js (ESM)
import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Health
app.get("/", (req, res) => res.status(200).send("TaskSync voice gateway running"));

/**
 * POST /voice/token
 * Returns an ephemeral key for the browser to connect directly to OpenAI Realtime.
 * This keeps OPENAI_API_KEY on the server only.
 */
app.post("/voice/token", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Client may send business context later (optional)
    const { systemPrompt, voice } = req.body || {};

    // Sensible defaults for a Norwegian receptionist demo
    const prompt =
      systemPrompt ||
      `Du er TaskSync AI – en profesjonell norsk resepsjonist for bedrifter.
Snakk naturlig, rolig og hyggelig. Ikke avbryt brukeren.
Still alltid ett oppklarende spørsmål hvis du mangler info.
Når brukeren ber om booking: gjenta dato/tid tydelig og bekreft.`;

    // IMPORTANT: Supported modalities must include BOTH audio + text
    const sessionPayload = {
      model: "gpt-4o-realtime-preview",
      modalities: ["audio", "text"],
      instructions: prompt,
      // voice name depends on availability; if this fails, remove the 'voice' line.
      voice: voice || "alloy",
      // Push-to-talk behavior: we will manually trigger responses from the client
      turn_detection: { type: "none" },
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
    };

    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionPayload),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: "Failed to create realtime session",
        detail: data,
      });
    }

    // data.client_secret.value is what the browser uses as Bearer token
    return res.json({
      client_secret: data?.client_secret?.value,
      session: {
        id: data?.id,
        model: data?.model,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync voice gateway running on :${PORT}`);
});
