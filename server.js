import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

/**
 * ENV
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`running on :${PORT}`);
});


/**
 * Safety logs (so we see real errors)
 */
process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("🔥 unhandledRejection:", reason));

/**
 * Express app
 */
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("TaskSync AI voice bridge is running"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/**
 * Twilio webhook (A CALL COMES IN): must be HTTP POST
 * This returns TwiML that starts a live media stream to our WS.
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

/**
 * Server + WS
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

/**
 * Conversation tuning
 */
const THINKING_DELAY_MS = 600; // longer = less interrupting
const MIN_USER_SILENCE_TO_RESPOND_MS = 900; // extra gating

/**
 * System instructions: strict booking confirmation
 */
const SYSTEM_INSTRUCTIONS = `
Du er TaskSync AI, en profesjonell norsk resepsjonist på telefon.

KRITISK (må følges):
- Avbryt aldri kunden.
- Hvis kunden pauser, sier “mhmm”, “eh”, “vent”, eller høres ut som de tenker: ikke svar.
- Når kunden vil booke: du skal samle: tjeneste + dag/dato + klokkeslett + navn.
- “Neste uke” er uklart: spør hvilken dag (mandag–søndag). Hvis mulig, få dato også.
- Tid/dato: GJENTA tilbake helt nøyaktig og spør “Stemmer det?” før du bekrefter.
- Hvis du er usikker på tid (f.eks 16/17): spør igjen. Ikke gjett.
- Bruk 24-timers klokke: “17:00”. Les gjerne: “sytten null null (17:00)”.

Stil:
- Rolig, varm, menneskelig.
- Korte svar. Ikke overforklar.
Start alltid med:
“Hei! Jeg er TaskSync AI. Hvordan kan jeg hjelpe deg i dag?”
`.trim();

/**
 * --- μ-law utilities (for mixing room tone into AI audio) ---
 * Twilio media streams are 8kHz G.711 μ-law, base64.
 * We mix a very low-amplitude noise bed into AI speech frames only (safe).
 */

const MU_LAW_MAX = 0x1FFF;
const BIAS = 0x84;

function muLawDecode(uVal) {
  uVal = ~uVal;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0F;
  let sample = ((mantissa << 4) + 0x08) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

function muLawEncode(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  sample += BIAS;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const uVal = ~(sign | (exponent << 4) | mantissa);
  return uVal & 0xFF;
}

function base64ToU8(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function u8ToBase64(u8) {
  return Buffer.from(u8).toString("base64");
}

/**
 * Generate one 20ms frame of very low “room tone” in μ-law (8kHz => 160 samples)
 * This is soft noise, not harsh static.
 */
function makeRoomToneFrameUlaw(frameSamples = 160, amp = 120) {
  const out = new Uint8Array(frameSamples);
  for (let i = 0; i < frameSamples; i++) {
    // low random noise around 0 (PCM)
    const pcm = Math.floor((Math.random() * 2 - 1) * amp);
    out[i] = muLawEncode(pcm);
  }
  return out;
}

// Pre-generate a few variants, rotate them (sounds less repetitive)
const ROOM_TONE_FRAMES = Array.from({ length: 12 }, () => makeRoomToneFrameUlaw(160, 110));
let roomToneIdx = 0;

function mixRoomToneIntoUlawB64(aiAudioB64, mixLevel = 0.18) {
  // mixLevel: 0..1 (keep low)
  const ai = base64ToU8(aiAudioB64);

  // Ensure we have a frame to mix (same length as ai)
  const toneBase = ROOM_TONE_FRAMES[roomToneIdx++ % ROOM_TONE_FRAMES.length];

  // If ai chunk isn't exactly 160 samples, create tone of same length
  const tone = toneBase.length === ai.length ? toneBase : makeRoomToneFrameUlaw(ai.length, 110);

  const mixed = new Uint8Array(ai.length);

  for (let i = 0; i < ai.length; i++) {
    const aiPcm = muLawDecode(ai[i]);
    const tonePcm = muLawDecode(tone[i]);

    // Mix: mostly AI + a little room tone
    const pcm = Math.max(-MU_LAW_MAX, Math.min(MU_LAW_MAX, Math.floor(aiPcm + tonePcm * mixLevel)));
    mixed[i] = muLawEncode(pcm);
  }

  return u8ToBase64(mixed);
}

/**
 * Main WS logic
 */
wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY (set in Railway Variables)");
    try { twilioWs.close(); } catch {}
    return;
  }

  let streamSid = null;

  // Hard gating so AI NEVER talks over user:
  let userIsTalking = false;
  let lastUserAudioAt = 0;
  let responseTimer = null;

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

  function scheduleAIResponse() {
    if (responseTimer) clearTimeout(responseTimer);

    responseTimer = setTimeout(() => {
      const now = Date.now();
      const silentFor = now - lastUserAudioAt;

      // If user still talking OR not silent long enough: wait longer
      if (userIsTalking || silentFor < MIN_USER_SILENCE_TO_RESPOND_MS) {
        scheduleAIResponse();
        return;
      }

      sendToOpenAI({ type: "response.create" });
    }, THINKING_DELAY_MS);
  }

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // ✅ Must be ["audio","text"]
    sendToOpenAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // We keep server_vad but we also enforce our own hard gating above
        turn_detection: { type: "server_vad" },
        voice: "marin",
        instructions: SYSTEM_INSTRUCTIONS,
      },
    });

    // Greeting immediately (but allow it only if user not talking)
    setTimeout(() => {
      if (!userIsTalking) sendToOpenAI({ type: "response.create" });
    }, 350);
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

    // When OpenAI thinks user stopped, we schedule response but ONLY after real silence threshold
    if (msg.type === "input_audio_buffer.speech_stopped") {
      userIsTalking = false;
      scheduleAIResponse();
      return;
    }

    // If OpenAI says speech started (user talking), block AI output
    if (msg.type === "input_audio_buffer.speech_started") {
      userIsTalking = true;
      return;
    }

    // AUDIO OUT (support multiple event names)
    if (
      (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") &&
      msg.delta
    ) {
      // Hard rule: never talk over user
      if (userIsTalking) return;

      // Mix subtle room tone into AI audio (sounds more “real”)
      const withTone = mixRoomToneIntoUlawB64(msg.delta, 0.17);
      sendAudioToTwilio(withTone);
      return;
    }

    // Optional debug text
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

  // Twilio -> OpenAI (caller audio)
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

      // Mark user as talking
      userIsTalking = true;
      lastUserAudioAt = Date.now();

      // Feed audio to OpenAI
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

/**
 * ✅ Railway-stable listen
 * MUST bind 0.0.0.0 and use PORT
 */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
