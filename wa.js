// wa.js
import express from "express";
import { ensureEmployeeSheet, appendExpenseRow, todayTotalFor } from "./sheets.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG = process.env.DEBUG_LOGS === "1";
const dbg = (...a) => { if (DEBUG) console.log("[DBG]", ...a); };

const S = new Map();
const getS = (id) => { if (!S.has(id)) S.set(id, { etapa: "ask_personal" }); return S.get(id); };
const setS = (id, v) => S.set(id, v);

async function waSendQ(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[WA SEND ERROR]", r.status, t);
  }
}

const toText = (to, body) => waSendQ(to, { messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } });
const clamp = (t, n = 20) => (String(t).length <= n ? String(t) : String(t).slice(0, n - 1) + "…");

const toButtons = (to, body, buttons = []) => waSendQ(to, {
  messaging_product: "whatsapp", to, type: "interactive",
  interactive: { type: "button", body: { text: String(body).slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.payload || b.id, title: clamp(b.title) } })) } }
});

const toList = (to, body, title, rows = []) => waSendQ(to, {
  messaging_product: "whatsapp", to, type: "interactive",
  interactive: { type: "list", body: { text: String(body).slice(0, 1024) }, action: { button: title.slice(0, 20), sections: [{ title, rows: rows.slice(0, 10).map(r => ({ id: r.payload || r.id, title: clamp(r.title ?? "", 24) })) }] } }
});

const CATEGORIAS_MONETARIAS = ["combustible", "alimentacion", "hospedaje", "peajes", "aceites", "llantas", "frenos", "otros"];
const TODAS_CATEGORIAS = [...CATEGORIAS_MONETARIAS, "kilometraje vehiculo"];

const saludo = () => "Hola, soy el asistente de Greenfield. Registraré gastos y kilometrajes en tu hoja.";
async function pedirPersonal(to) {
  const rows = Array.from({ length: 10 }, (_, i) => ({ title: `Personal ${i + 1}`, payload: `EMP_${i + 1}` }));
  await toList(to, "Selecciona al responsable", "Elegir personal", rows);
}
async function pedirCategoria(to) {
  const items = TODAS_CATEGORIAS.map(c => ({ title: c[0].toUpperCase() + c.slice(1), payload: `CAT_${c.toUpperCase().replace(/\s+/g, "_")}` }));
  await toList(to, "¿Qué deseas registrar ahora?", "Seleccionar categoría", items);
}
async function pedirDetalle(to) { await toText(to, "Escribe una descripción breve del gasto."); }
async function pedirFactura(to) { await toText(to, "Número de factura o recibo. Si no corresponde, escribe “ninguno”."); }
async function pedirMonto(to, categoria) { if (categoria === "kilometraje vehiculo") await toText(to, "Ingresa los kilómetros recorridos (solo número)."); else await toText(to, "Ingresa el monto en bolivianos (solo número, ej.: 120.50)."); }
function parseNumberFlexible(s = "") { const t = String(s).replace(/\s+/g, "").replace(/,/g, "."); const n = Number(t); return Number.isFinite(n) ? n : NaN; }

router.get("/wa/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chall = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ""));
  return res.sendStatus(403);
});

router.post("/wa/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);
    dbg("IN", { from, type: msg.type, etapa: s.etapa });

    if (!s.greeted) {
      s.greeted = true;
      await toText(from, saludo());
      await pedirPersonal(from);
      s.etapa = "ask_personal";
      setS(from, s);
      return res.sendStatus(200);
    }

    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();
      const idU = id.toUpperCase();
      dbg("INTERACTIVE", idU, "ETAPA", s.etapa);

      if (idU.startsWith("EMP_")) {
        const idx = Number(idU.replace("EMP_", "")) || 1;
        const nombre = `Personal ${idx}`;
        const hoja = await ensureEmployeeSheet(nombre);
        s.empleado = hoja;
        s.etapa = "ask_categoria";
        setS(from, s);
        await toText(from, `Hoja seleccionada: ${hoja}`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (idU.startsWith("CAT_")) {
        const categoria = id.replace("CAT_", "").toLowerCase().replace(/_/g, " ");
        s.ultimaCategoria = categoria;
        s.pend = { detalle: "", factura: "", monto: null, km: null };
        if (categoria === "kilometraje vehiculo") { s.etapa = "ask_monto"; await pedirMonto(from, categoria); }
        else { s.etapa = "ask_detalle"; await pedirDetalle(from); }
        setS(from, s);
        return res.sendStatus(200);
      }

      if (idU === "SEGUIR") {
        s.etapa = "ask_categoria";
        setS(from, s);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (idU === "RESUMEN") {
        if (!s.empleado) { s.etapa = "ask_personal"; setS(from, s); await pedirPersonal(from); return res.sendStatus(200); }
        const total = await todayTotalFor(s.empleado);
        await toText(from, `Total de hoy para ${s.empleado}: Bs ${total.toFixed(2)}. ¿Deseas registrar algo más?`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim();
      dbg("TEXT", { text, etapa: s.etapa });

      if (/^(menu|inicio)$/i.test(text)) { s.etapa = "ask_personal"; setS(from, s); await pedirPersonal(from); return res.sendStatus(200); }
      if (/^resumen$/i.test(text) || /^ver\s+resumen$/i.test(text)) {
        if (!s.empleado) { s.etapa = "ask_personal"; setS(from, s); await pedirPersonal(from); return res.sendStatus(200); }
        const total = await todayTotalFor(s.empleado);
        await toText(from, `Total de hoy para ${s.empleado}: Bs ${total.toFixed(2)}. ¿Deseas registrar algo más?`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_personal") {
        const m = text.match(/personal\s*(\d+)/i);
        const idx = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(idx) || idx < 1 || idx > 50) { await pedirPersonal(from); return res.sendStatus(200); }
        const nombre = `Personal ${idx}`;
        const hoja = await ensureEmployeeSheet(nombre);
        s.empleado = hoja;
        s.etapa = "ask_categoria";
        setS(from, s);
        await toText(from, `Hoja seleccionada: ${hoja}`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_categoria") {
        const t = text.toLowerCase();
        const hit = TODAS_CATEGORIAS.find(c => t.includes(c));
        if (!hit) { await pedirCategoria(from); return res.sendStatus(200); }
        s.ultimaCategoria = hit;
        s.pend = { detalle: "", factura: "", monto: null, km: null };
        if (hit === "kilometraje vehiculo") { s.etapa = "ask_monto"; await pedirMonto(from, hit); }
        else { s.etapa = "ask_detalle"; await pedirDetalle(from); }
        setS(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_detalle") {
        s.pend.detalle = text;
        s.etapa = "ask_factura";
        setS(from, s);
        await pedirFactura(from);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_factura") {
        s.pend.factura = /^ninguno$/i.test(text) ? "" : text;
        s.etapa = "ask_monto";
        setS(from, s);
        await pedirMonto(from, s.ultimaCategoria);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_monto") {
        if (s.ultimaCategoria === "kilometraje vehiculo") {
          const km = parseNumberFlexible(text);
          if (!Number.isFinite(km) || km < 0) { await toText(from, "Envía un número válido de kilómetros."); return res.sendStatus(200); }
          s.pend.km = km;
        } else {
          const monto = parseNumberFlexible(text);
          if (!Number.isFinite(monto) || monto < 0) { await toText(from, "Envía un monto válido (ej.: 120.50)."); return res.sendStatus(200); }
          s.pend.monto = monto;
        }
        if (!s.empleado) { s.etapa = "ask_personal"; setS(from, s); await pedirPersonal(from); return res.sendStatus(200); }

        const { detalle, factura, monto, km } = s.pend;
        const saved = await appendExpenseRow(s.empleado, {
          detalle: s.ultimaCategoria === "kilometraje vehiculo" ? "" : detalle,
          factura: s.ultimaCategoria === "kilometraje vehiculo" ? "" : factura,
          categoria: s.ultimaCategoria,
          monto,
          km
        });
        const totalHoy = await todayTotalFor(s.empleado);
        const resumen =
          `Guardado en ${s.empleado}\n` +
          `• Categoría: ${s.ultimaCategoria}\n` +
          (s.ultimaCategoria === "kilometraje vehiculo"
            ? `• Km: ${km}\n`
            : `• Detalle: ${detalle || "—"}\n• Fact/Rec: ${factura || "—"}\n• Monto: Bs ${monto?.toFixed(2)}\n`) +
          `• ID: ${saved.id} — Fecha: ${saved.fecha}\n\n` +
          `Total de hoy: Bs ${totalHoy.toFixed(2)}`;
        await toText(from, resumen);

        s.etapa = "ask_categoria";
        s.pend = null;
        setS(from, s);
        await toButtons(from, "¿Deseas registrar algo más?", [
          { title: "Sí, seguir", payload: "SEGUIR" },
          { title: "Ver resumen", payload: "RESUMEN" }
        ]);
        return res.sendStatus(200);
      }

      if (/seguir/i.test(text)) { s.etapa = "ask_categoria"; setS(from, s); await pedirCategoria(from); return res.sendStatus(200); }

      if (s.etapa === "ask_categoria") { await pedirCategoria(from); return res.sendStatus(200); }
      if (s.etapa === "ask_personal") { await pedirPersonal(from); return res.sendStatus(200); }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

export default router;
