import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * Twilio webhook when call comes in.
 * Respond with TwiML that starts a Media Stream to our WebSocket.
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  const twiml = `
<Response>
  <Say language="nb-NO" voice="alice">
    Hei! Du snakker med TaskSync AI. Ett øyeblikk mens jeg kobler opp.
  </Say>
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
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.log("❌ Missing OPENAI_API_KEY in Railway Variables");
    try { twilioWs.close(); } catch {}
    return;
  }

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  let openaiReady = false;
  const pendingAudio = [];

  const sendToOpenAI = (obj) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj));
    }
  };

  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("🧠 Connected to OpenAI Realtime");

    // Match Twilio Media Streams audio: G.711 u-law (pcmu), 8kHz
    sendToOpenAI({
      type: "session.update",
      session: {
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
          "Du er TaskSync AI, en ekstremt profesjonell resepsjonist i Norge. " +
          "Snakk naturlig norsk, kort og menneskelig. " +
          "Start alltid med: 'Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?' " +
          "Hvis kunden vil booke: spør om tjeneste, ønsket dato og cirka tidspunkt. " +
          "Ikke finn på priser eller tider.",
      },
    });

    // Start samtalen med en gang (så det ikke blir stille)
    sendToOpenAI({
      type: "response.create",
      response: { modalities: ["audio"] },
    });

    // Flush audio som kom før OpenAI var klar
    while (pendingAudio.length) {
      sendToOpenAI({ type: "input_audio_buffer.append", audio: pendingAudio.shift() });
    }
  });

  openaiWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.log("OpenAI non-json message");
      return;
    }

    // Debug events (ikke spam deltas)
    if (data.type && !String(data.type).includes("delta")) {
      console.log("OpenAI event:", data.type);
    }

    if (data.type === "error") {
      console.log("❌ OpenAI error:", data.error);
    }

    // OpenAI audio -> Twilio
    if (data.type === "response.output_audio.delta") {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.delta }, // base64 audio/pcmu
        })
      );
    }

    // Når OpenAI oppfatter at brukeren stoppet å snakke, be om svar
    if (data.type === "input_audio_buffer.speech_stopped") {
      sendToOpenAI({ type: "response.create", response: { modalities: ["audio"] } });
    }
  });

  // Twilio audio -> OpenAI
  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      console.log("▶️ start", data.start?.streamSid);
      return;
    }

    if (data.event === "media") {
      const b64 = data.media?.payload;
      if (!b64) return;

      if (!openaiReady) pendingAudio.push(b64);
      else sendToOpenAI({ type: "input_audio_buffer.append", audio: b64 });

      return;
    }

    if (data.event === "stop") {
      console.log("⏹ Twilio stop");
      // Ikke lukk OpenAI her – la close håndteres under.
      return;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🧠 OpenAI WS closed", code, reason?.toString());
  });

  openaiWs.on("error", (e) => {
    console.log("❌ OpenAI WS error", e?.message || e);
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio stream closed");
    try { openaiWs.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
