import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = Number(process.env.PORT || 3000);

// Crash-sikker logging (så Railway ikke bare dør “silent”)
process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("🔥 unhandledRejection:", reason));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("TaskSync AI voice bridge is running"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * Twilio hits this URL (POST) on inbound call.
 * We respond with TwiML that starts a Media Stream to our WS.
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

/**
 * Helper: small delay before we ask the model to answer, to reduce “talking over”.
 */
const THINKING_DELAY_MS = 350;

/**
 * Stronger system instructions: less interruption + always confirm date/time.
 */
const SYSTEM_INSTRUCTIONS = `
Du er TaskSync AI, en profesjonell norsk resepsjonist som tar imot telefoner.

VIKTIG (må følges):
- Avbryt aldri kunden. Vent til kunden er HELT ferdig med å snakke før du svarer.
- Hvis kunden sier “mhmm”, “eh”, “vent”, “bare”, eller tar en kort pause: IKKE svar. Vent.
- Når kunden ber om booking: ALDRI bekreft endelig før du har oppsummert og fått bekreftelse.
- Tid/dato: Gjenta tilbake nøyaktig dato og klokkeslett og spør “Stemmer det?” før du låser det.
- Hvis kunden sier “neste uke” er det uklart: spør hvilken dag (mandag–søndag) og dato hvis mulig.
- Bruk alltid 24-timers klokke (f.eks. 17:00).
- Hvis du er usikker (f.eks. hørte 16:00/17:00): spør igjen. Ikke gjett.
- Når du oppfatter en tid, les den tilbake tydelig: “klokken sytten null null (17:00)”.

Stil:
- Varm, rolig og menneskelig.
- Små bekreftelser (“skjønner”, “mm”) kun ETTER at kunden er ferdig (aldri midt i setningen).
- Kortfattede svar.

Start samtalen med:
“Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?”
`.trim();

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    try { twilioWs.close(); } catch {}
    return;
  }

  let streamSid = null;
  let openaiReady = false;
  let pendingResponseTimer = null;

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

  const scheduleResponseCreate = () => {
    if (!openaiReady) return;
    if (pendingResponseTimer) clearTimeout(pendingResponseTimer);
    pendingResponseTimer = setTimeout(() => {
      sendToOpenAI({ type: "response.create" });
    }, THINKING_DELAY_MS);
  };

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // Your account requires ["audio","text"]
    sendToOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // server_vad keeps it natural, but we slow replies with THINKING_DELAY_MS
        turn_detection: { type: "server_vad" },

        // Voice (you can try "marin" / "cedar" depending on availability)
        voice: "marin",

        instructions: SYSTEM_INSTRUCTIONS,
      },
    });

    openaiReady = true;

    // Force greeting immediately
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

    // Audio deltas (support multiple schemas)
    if (
      (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") &&
      msg.delta
    ) {
      // console.log("🔊 OpenAI audio delta");
      sendAudioToTwilio(msg.delta);
      return;
    }

    // When model thinks user finished speaking, ask it to respond (after short delay)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      // console.log("🟣 speech_stopped");
      scheduleResponseCreate();
      return;
    }

    // Optional: debug text output
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

      // Append caller audio
      sendToOpenAI({ type: "input_audio_buffer.append", audio: payload });
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

// Railway-safe listen
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
