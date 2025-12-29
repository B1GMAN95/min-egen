import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  const twiml = `
<Response>
  <Say language="nb-NO" voice="alice">Hei! Du snakker med TaskSync AI. Ett øyeblikk mens jeg kobler opp.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`.trim();

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

app.get("/", (_, res) => res.send("TaskSync Voice Bridge running"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio stream connected");

  const model = process.env.OPENAI_MODEL || "gpt-realtime";

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  });

  let openaiReady = false;
  const pendingAudio = [];

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  }

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("🧠 Connected to OpenAI Realtime");

    // Match Twilio Media Streams: G.711 u-law (pcmu) @ 8kHz
    sendToOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "semantic_vad" },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "marin",
          },
        },
        instructions:
          "Du er TaskSync AI, en profesjonell resepsjonist for bedrifter i Norge. " +
          "Snakk naturlig norsk. Svar kort, tydelig og vennlig. " +
          "Still oppklarende spørsmål. Hvis kunden vil booke: be om tjeneste, dato og klokkeslett.",
      },
    });

    // Flush audio som kom før OpenAI var klar
    while (pendingAudio.length) {
      sendToOpenAI({ type: "input_audio_buffer.append", audio: pendingAudio.shift() });
    }
  });

  // Twilio -> OpenAI (audio)
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "media") {
      const b64 = data.media.payload; // base64 pcmu
      if (!openaiReady) pendingAudio.push(b64);
      else sendToOpenAI({ type: "input_audio_buffer.append", audio: b64 });
    }

    if (data.event === "stop") {
      try { openaiWs.close(); } catch {}
    }
  });

  // OpenAI -> Twilio (audio + lifecycle)
  openaiWs.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    // Når modellen sender lyd-chunks
    if (data.type === "response.output_audio.delta") {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.delta }, // base64 audio/pcmu
        })
      );
    }

    // Når OpenAI oppdager at du sluttet å snakke (VAD)
    if (data.type === "input_audio_buffer.speech_stopped") {
      // Be modellen svare med audio
      sendToOpenAI({ type: "response.create", response: { modalities: ["audio"] } });
    }

    // (valgfritt) se tekst-transcript i logs
    if (data.type === "response.output_audio_transcript.delta") {
      // console.log("📝", data.delta);
    }
  });

  openaiWs.on("close", () => console.log("🧠 OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("❌ OpenAI WS error", e?.message || e));

  twilioWs.on("close", () => {
    console.log("🔌 Twilio stream closed");
    try { openaiWs.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
