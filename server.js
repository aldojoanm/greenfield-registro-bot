// server.js
import "dotenv/config";
import express from "express";
import waRouter from "./wa.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use(waRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`BOT escuchando en http://localhost:${PORT}`); });
