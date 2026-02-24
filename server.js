import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/voice/token", async (req, res) => {
  // Placeholder: later we generate ephemeral client_secret here
  res.status(200).json({ ok: true, note: "token endpoint placeholder" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 TaskSync voice gateway running on :${PORT}`);
});
