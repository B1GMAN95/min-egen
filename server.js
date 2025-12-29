import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = Number(process.env.PORT || 3000);

process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("🔥 unhandledRejection:", reason));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("TaskSync AI voice bridge is running"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * IMPORTANT:
 * We enable Twilio speech recognition on the Media Stream.
 * Then we only let AI respond AFTER Twilio sends speech_final (meaning user finished).
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  // speechTimeout="auto" helps Twilio decide end-of-utterance
  // language set to nb-NO for Norwegian
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="speechRecognition" value="true"/>
      <Parameter name="language" value="nb-NO"/>
      <Parameter name="speechTimeout" value="auto"/>
    </Stream>
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

const SYSTEM_INSTRUCTIONS = `
Du er TaskSync AI, en profesjonell norsk resepsjonist.

KRITISK:
- Avbryt ALDRI kunden.
- Vent alltid til kunden er helt ferdig. Ikke svar på “mhmm”, små pauser eller tenking.
- Når kunden ber om booking: Oppsummer og få bekreftelse før du låser tid.
- “Neste uke” er uklart: spør hvilken dag og helst dato.
- Tid: gjenta tydelig (f.eks. “17:00”) og spør “Stemmer det?” før booking.

Stil:
- Rolig, menneskelig, vennlig.
- Ikke “overprat”.
Start med:
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

  // Buffer + gating: AI får kun snakke når vi sier "go"
  let canRespond = false;
  let lastFinalText = "";
  let respondTimer = null;

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
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
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

  const scheduleRespond = (ms = 1000) => {
    if (respondTimer) clearTimeout(respondTimer);
    respondTimer = setTimeout(() => {
      canRespond = true;

      // Tell OpenAI: user text (final transcript) as context, then respond
      if (lastFinalText?.trim()) {
        sendToOpenAI({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: lastFinalText.trim() }],
          },
        });
      }

      sendToOpenAI({ type: "response.create" });

      // reset
      lastFinalText = "";
    }, ms);
  };

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    sendToOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // IMPORTANT: we DO NOT rely on server_vad for when to answer
        // We only answer when Twilio says speech_final.
        turn_detection: { type: "disabled" },
        voice: "marin",
        instructions: SYSTEM_INSTRUCTIONS,
      },
    });

    openaiReady = true;

    // Greeting
    canRespond = true;
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

    // Only play AI audio when we allow responding (prevents talking over user)
    if (
      (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") &&
      msg.delta
    ) {
      if (!canRespond) return;
      sendAudioToTwilio(msg.delta);
      return;
    }

    // Once a response is done, lock until next speech_final
    if (msg.type === "response.done") {
      canRespond = false;
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

  /**
   * Twilio message types we care about:
   * - start
   * - media (audio)
   * - speech (partial transcript)
   * - speech_final (final transcript)
   */
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
      canRespond = false; // user may speak
      return;
    }

    // Always feed audio to OpenAI (for best understanding)
    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;
      if (!openaiReady) return;

      // User is speaking -> do NOT let AI speak
      canRespond = false;

      sendToOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    // If Twilio provides transcripts:
    if (data.event === "speech") {
      // partial transcript - ignore for responding
      return;
    }

    if (data.event === "speech_final") {
      // This is the key: user finished speaking
      const finalText = data.speech?.transcript || data.transcript || "";
      if (finalText.trim()) {
        console.log("🗣️ speech_final:", finalText.trim());
        lastFinalText = finalText.trim();
      }

      // Wait 1.0s after final to ensure user is truly done
      scheduleRespond(1100);
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
