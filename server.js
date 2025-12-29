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

app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  // No Twilio <Say> – pure stream to AI
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

app.get("/twilio/voice", (_req, res) =>
  res.status(200).send("Twilio voice endpoint (POST required).")
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
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

  const sendAudioToTwilio = (base64Audio) => {
    if (!streamSid) return;
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio },
      })
    );
  };

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // Your account requires ["audio","text"] – not audio-only
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
          "Start med: 'Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?'",
      },
    });

    openaiReady = true;

    // Force first greeting immediately
    sendToOpenAI({
      type: "response.create",
      response: {
        // some schemas accept this; if ignored, it's fine
        modalities: ["audio", "text"],
      },
    });
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

    // --- AUDIO HANDLING (support both schemas) ---
    // Schema A:
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      console.log("🔊 OpenAI audio delta (output_audio)");
      sendAudioToTwilio(msg.delta);
      return;
    }

    // Schema B (older):
    if (msg.type === "response.audio.delta" && msg.delta) {
      console.log("🔊 OpenAI audio delta (audio)");
      sendAudioToTwilio(msg.delta);
      return;
    }

    // Some variants:
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      console.log("🔊 OpenAI audio (output_audio.audio)");
      sendAudioToTwilio(msg.audio);
      return;
    }

    // Trigger response when OpenAI detects end of speech (if emitted)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      console.log("🟣 speech_stopped -> response.create");
      sendToOpenAI({ type: "response.create" });
      return;
    }

    // Helpful debug without spamming
    if (msg.type === "session.updated") console.log("🟣 session.updated");
    if (msg.type === "response.created") console.log("🟣 response.created");
    if (msg.type === "response.done") console.log("🟣 response.done");
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🧠 OpenAI WS closed", code, reason?.toString() || "");
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e?.message || e);
    try { twilioWs.close(); } catch {}
  });

  // Twilio -> OpenAI
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
