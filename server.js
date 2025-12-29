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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nb-NO">Hei! Du snakker med TaskSync AI.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// browser-test vennlig
app.get("/twilio/voice", (_req, res) => {
  res.status(200).send("Twilio voice endpoint (POST required).");
});

const server = http.createServer(app);

// WS server for Twilio
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    try { twilioWs.close(); } catch {}
    return;
  }

  let streamSid = null;

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let openaiReady = false;

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // Viktig: session.type MUST være "realtime"
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          instructions:
            "Du er TaskSync AI, en profesjonell norsk resepsjonist. " +
            "Snakk naturlig norsk. Svar kort og vennlig. " +
            "Start med: 'Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?'",
        },
      })
    );

    // Start samtalen med en gang
    openaiWs.send(JSON.stringify({ type: "response.create" }));
    openaiReady = true;
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.error("❌ OpenAI error:", msg.error);
      return;
    }

    // OpenAI audio -> Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🧠 OpenAI WS closed", code, reason?.toString());
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

    if (data.event === "media" && openaiReady) {
      const payload = data.media?.payload;
      if (!payload) return;
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
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

server.listen(PORT, () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
