/**
 * TaskSync AI — Twilio Media Streams <-> OpenAI Realtime bridge (Railway)
 *
 * Endpoints:
 *  - GET  /health           -> ok
 *  - POST /twilio/voice     -> TwiML that starts a Media Stream to /twilio/stream
 *  - WS   /twilio/stream    -> Twilio Media Stream websocket
 *
 * Env:
 *  - OPENAI_API_KEY
 *  - OPENAI_MODEL (default: gpt-realtime)
 *  - PORT (default: 8080)
 */

const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = process.env.PORT || 8080;

if (!OPENAI_API_KEY) {
  console.error("Missing env OPENAI_API_KEY");
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Twilio will POST here when a call comes in.
// We respond with TwiML that opens a Media Stream to our websocket.
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

// Optional: makes browser testing nicer
app.get("/twilio/voice", (_req, res) => {
  res.status(200).send("Twilio voice endpoint (POST required).");
});

const server = http.createServer(app);

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // Connect to OpenAI Realtime via WebSocket
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;

  openaiWs = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // IMPORTANT: session.type is REQUIRED ("realtime")
    // Twilio Media Streams audio is g711_ulaw (μ-law 8k). Configure session to match.
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        modalities: ["audio"], // allow audio responses
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Server VAD: model replies when caller stops speaking
        turn_detection: { type: "server_vad" },
        // Voice + behavior via instructions
        instructions:
          "Du er TaskSync AI, en profesjonell norsk kundeservice-assistent. " +
          "Svar kort, naturlig og hjelpsomt på norsk. Still oppfølgingsspørsmål hvis nødvendig. " +
          "Hvis kunden vil booke, spør etter navn, dato, klokkeslett og tjeneste.",
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
    openaiReady = true;
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // Debug (kan kommenteres ut senere)
    if (msg.type === "error") {
      console.error("❌ OpenAI error:", msg.error || msg);
      return;
    }

    // Audio deltas from OpenAI -> send back to Twilio
    // In Realtime docs this event name is response.output_audio.delta
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      if (!streamSid) return;

      const twilioMedia = {
        event: "media",
        streamSid,
        media: { payload: msg.delta }, // already base64 g711_ulaw
      };
      twilioWs.send(JSON.stringify(twilioMedia));
    }

    // Optional logging
    if (msg.type === "session.updated") {
      console.log("🟣 session.updated");
    }
    if (msg.type === "response.created") {
      console.log("🟣 response.created");
    }
    if (msg.type === "response.done") {
      // console.log("🟣 response.done");
    }
  });

  openaiWs.on("close", () => {
    console.log("⚠️ OpenAI WS closed");
    try {
      twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err?.message || err);
    try {
      twilioWs.close();
    } catch {}
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid;
      console.log("🎧 Twilio stream start:", streamSid);
      return;
    }

    if (data.event === "media") {
      // Twilio sends base64 g711_ulaw audio
      const payload = data.media?.payload;
      if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN || !openaiReady) return;

      // Append audio into OpenAI input buffer
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        })
      );
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stream stop");
      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("⚠️ Twilio WS closed");
    try {
      openaiWs?.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err?.message || err);
    try {
      openaiWs?.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
