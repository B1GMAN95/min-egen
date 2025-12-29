import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * Twilio hits this on inbound call (POST).
 * We respond with TwiML that starts a Media Stream to our WebSocket.
 * (No robot <Say> here — pure AI.)
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// Browser-friendly
app.get("/twilio/voice", (_req, res) =>
  res.status(200).send("Twilio voice endpoint (POST required).")
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY (Railway Variables)");
    try { twilioWs.close(); } catch {}
    return;
  }

  let streamSid = null;
  let openaiReady = false;

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const sendToOpenAI = (obj) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  };

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // ✅ IMPORTANT FIX:
    // modalities must be ["audio","text"] (audio-only not allowed in your logs)
    sendToOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        voice: "marin",
        instructions:
          "Du er TaskSync AI, en profesjonell norsk resepsjonist. " +
          "Snakk naturlig norsk, kort og menneskelig. " +
          "Start alltid med: 'Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?' " +
          "Hvis kunden vil booke: spør om tjeneste, dato og klokkeslett. " +
          "Hvis du ikke vet priser/åpningstider, si at du trenger bedriftsinfo.",
      },
    });

    openaiReady = true;

    // Start med en gang (AI sier hei uten at bruker må snakke først)
    sendToOpenAI({ type: "response.create" });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.error("❌ OpenAI error:", msg.error || msg);
      return;
    }

    // OpenAI -> Twilio audio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }

    // (Optional) se tekst i logs (kjekt for debugging)
    if (msg.type === "response.output_text.delta" && msg.delta) {
      process.stdout.write(msg.delta);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🧠 OpenAI WS closed", code, reason?.toString() || "");
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e?.message || e);
    try { twilioWs.close(); } catch {}
  });

  // Twilio -> OpenAI audio
  twilioWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      console.log("🎧 Twilio stream start:", streamSid);
      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;
      if (!openaiReady) return;

      sendToOpenAI({
        type: "input_audio_buffer.append",
        audio: payload,
      });
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stream stop");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("⚠️ Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("❌ Twilio WS error", e?.message || e);
    try { openaiWs.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
