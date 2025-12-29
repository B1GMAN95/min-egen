// server.js (ESM) – TaskSync AI Voice Bridge (Twilio <-> OpenAI Realtime)

import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { URL } from "url";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY env var");
}

const PORT = Number(process.env.PORT || 3000);

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

// --- HTTP ROUTES ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Healthcheck
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  // Simple landing
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("TaskSync AI voice bridge running");
  }

  // Twilio Voice webhook (returns TwiML)
  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    // Twilio hits this when call comes in.
    // We respond with TwiML that starts media stream to our WS endpoint.
    const host = req.headers.host;
    const wsUrl = `wss://${host}/twilio/stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nb-NO" voice="alice">Hei! Du snakker med TaskSync AI. Et øyeblikk, jeg kobler deg til.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml);
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// --- WEBSOCKET SERVER (Twilio Media Streams) ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/twilio/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  const connectOpenAI = () => {
    const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime");

      // IMPORTANT: modalities must be ["audio","text"] (NOT ["audio"] alone)
      // turn_detection helps not interrupt you. Increase silence for fewer cut-offs.
      const sessionCreate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          // Voice: keep it stable. (We can tune later.)
          voice: "alloy",
          // Make it less interrupt-y:
          turn_detection: {
            type: "server_vad",
            threshold: 0.55,
            prefix_padding_ms: 350,
            silence_duration_ms: 900,
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // System instructions:
          instructions:
            "Du er TaskSync AI, en profesjonell norsk resepsjonist. " +
            "La kunden snakke ferdig før du svarer. Still korte oppfølgingsspørsmål. " +
            "Når kunden sier dato/klokkeslett, gjenta og bekreft før du registrerer. " +
            "Hvis kunden sier 17:00 skal du ikke endre det til 16:00. " +
            "Hvis du er usikker, spør: 'Mener du klokken 17:00?'",
        },
      };

      openaiWs.send(JSON.stringify(sessionCreate));
      openaiReady = true;

      // Optional: greet once connected
      const firstResponse = {
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Hils kort og spør hva kunden ønsker hjelp med. Bruk naturlige småord som 'mm' og korte pauser, men ikke avbryt.",
        },
      };
      openaiWs.send(JSON.stringify(firstResponse));
    });

    openaiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Audio from OpenAI -> Twilio
      if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
        const payload = msg.delta; // base64
        const twilioMedia = {
          event: "media",
          streamSid,
          media: { payload },
        };
        twilioWs.send(JSON.stringify(twilioMedia));
      }

      // Debug helpful logs
      if (msg.type === "error") {
        console.log("❌ OpenAI error:", msg.error || msg);
      }
    });

    openaiWs.on("close", (code, reason) => {
      console.log("🧠 OpenAI WS closed", code, reason?.toString?.() || "");
      openaiReady = false;
    });

    openaiWs.on("error", (err) => {
      console.log("❌ OpenAI WS error", err?.message || err);
    });
  };

  // connect to OpenAI immediately
  connectOpenAI();

  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("🎧 Twilio stream start:", streamSid);
      return;
    }

    if (msg.event === "media") {
      // Twilio sends base64 g711_ulaw chunks
      const payload = msg.media?.payload;
      if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN || !openaiReady) return;

      // Send audio into OpenAI Realtime
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        })
      );
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Twilio stream stop");
      try {
        openaiWs?.close();
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
    console.log("❌ Twilio WS error", err?.message || err);
  });
});

// IMPORTANT: listen AFTER server is created (fixes your crash)
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync AI voice bridge running on :${PORT}`);
});
