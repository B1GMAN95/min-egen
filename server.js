import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * Twilio webhook når samtale kommer inn.
 * Vi svarer med TwiML som starter Media Stream til vår WebSocket.
 */
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host; // Railway host
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

wss.on("connection", (ws) => {
  console.log("✅ Twilio stream connected");

  ws.on("message", (msg) => {
    // Twilio sender JSON events: connected, start, media, mark, stop
    // https://www.twilio.com/docs/voice/media-streams/websocket-messages
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") console.log("▶️ start", data.start?.streamSid);
      if (data.event === "media") {
        // data.media.payload = base64 audio (mulaw 8khz)
        // I neste steg: send dette til OpenAI Realtime
      }
      if (data.event === "stop") console.log("⏹ stop");
    } catch (e) {
      console.log("non-json msg", msg.toString());
    }
  });

  ws.on("close", () => console.log("🔌 Twilio stream closed"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
