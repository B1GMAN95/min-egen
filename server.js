import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = Number(process.env.PORT || 3000);

process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("🔥 unhandledRejection:", reason);
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("TaskSync AI voice bridge is running"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

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

const server = http.createServer(app);

// Twilio websocket endpoint
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

    // Start samtalen umiddelbart
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

    // Support both event names for audio delta
    if ((msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") && msg.delta) {
      console.log("🔊 OpenAI audio delta");
      sendAudioToTwilio(msg.delta);
      return;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      console.log("🟣 speech_stopped -> response.create");
      sendToOpenAI({ type: "response.create" });
      return;
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

      sendToOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stream stop");
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("⚠️ Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });
});

// 🔥 Railway-safe listen
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
