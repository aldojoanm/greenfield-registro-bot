import express from "express";
import { ensureEmployeeSheet, upsertDailyExpenseRow, todayTotalFor, todaySummary } from "./sheets.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG = process.env.DEBUG_LOGS === "1";
const log = (...a) => console.log("[WA]", ...a);
const dbg = (...a) => { if (DEBUG) console.log("[DBG]", ...a); };

/* ======================= Estado ======================= */
const S = new Map();
const getS = (id) => { if (!S.has(id)) S.set(id, { etapa: "ask_area" }); return S.get(id); };
const setS = (id, v) => S.set(id, v);

/* ======================= Envío WA ======================= */
async function waSendQ(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
  dbg("SEND", { to, type: payload.type || payload?.interactive?.type });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[WA SEND ERROR]", r.status, t);
  }
}
const clamp = (t, n = 24) => (String(t).length <= n ? String(t) : String(t).slice(0, n - 1) + "…");
const toText = (to, body) => waSendQ(to, { messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } });

/** Botones (máx 3) */
const toButtons = (to, body, buttons = []) => waSendQ(to, {
  messaging_product: "whatsapp", to, type: "interactive",
  interactive: {
    type: "button",
    body: { text: String(body).slice(0, 1024) },
    action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.payload || b.id, title: clamp(b.title, 20) } })) }
  }
});

/** List helper con auto-chunk en secciones de 10 filas */
const toList = (to, body, buttonTitle, rows = [], sectionTitle = "Opciones") => {
  const sections = [];
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10).map(r => ({ id: r.payload || r.id, title: clamp(r.title || "", 24) }));
    sections.push({ title: rows.length > 10 ? `${sectionTitle} ${Math.floor(i / 10) + 1}` : sectionTitle, rows: chunk });
  }
  return waSendQ(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body).slice(0, 1024) },
      action: { button: clamp(buttonTitle, 20), sections }
    }
  });
};

/* ======================= Cat/Campos ======================= */
const CAT_MON = ["combustible","alimentacion","hospedaje","peajes","aceites","llantas","frenos","otros"];
const CATS = [...CAT_MON, "kilometraje vehiculo"];

/* ======== NUEVO: Prefiltro por Área + Listas de responsables ======== */
const AREAS = {
  HORTIFRUT: [
    "Baneza Maldonado",
    "Moises Reyna",
    "Arturo Hinojosa",
    "Maira Cadima"
  ],
  AGROINDUSTRIA: [
    "John Gaviria",
    "Javier Bonilla",
    "Miguel Gonzales",
    "Miguel Mamani",
    "Darwin Coimbra",
    "Sebastian Rueda",
    "Alejandro Llado",
    "Diego Hinojosa",
    "Armin Hurtado",
    "Angel Suarez",
    "Alvaro Mitma",
    "Andres Moreno"
  ]
};

const saludo = () => "Hola, soy el asistente de Greenfield. Te ayudo a registrar gastos y kilometrajes.";

/* ==== UI paso 1: elegir área ==== */
async function pedirArea(to) {
  await toButtons(to, "Primero, elige el área:", [
    { title: "Hortifrut", payload: "AREA_HORTIFRUT" },
    { title: "Agroindustria", payload: "AREA_AGROINDUSTRIA" }
  ]);
}

/* ==== UI paso 2: elegir responsable según área ==== */
async function pedirResponsable(to, areaKey) {
  const key = String(areaKey || "").toUpperCase();
  const names = AREAS[key] || [];
  const rows = names.map((n, i) => ({ id: `EMP_${i}`, title: n }));
  await toList(to, "Selecciona al responsable", "Elegir", rows, key === "HORTIFRUT" ? "Hortifrut" : "Agroindustria");
}

/* ==== UI paso 3: elegir categoría (igual que antes) ==== */
async function pedirCategoria(to) {
  const items = CATS.map(c => ({ title: c[0].toUpperCase() + c.slice(1), payload: `CAT_${c.toUpperCase().replace(/\s+/g, "_")}` }));
  await toList(to, "¿Qué deseas registrar ahora?", "Seleccionar", items, "Categorías");
}
async function pedirDetalle(to) { await toText(to, "Describe brevemente el gasto."); }
async function pedirFactura(to) { await toText(to, "Número de factura o recibo. Si no corresponde, escribe “ninguno”."); }
async function pedirMonto(to, categoria) { if (categoria === "kilometraje vehiculo") await toText(to, "Ingresa los kilómetros recorridos (solo número)."); else await toText(to, "Ingresa el monto en bolivianos (solo número, ej.: 120.50)."); }
function parseNumberFlexible(s = "") { const t = String(s).replace(/\s+/g, "").replace(/,/g, "."); const n = Number(t); return Number.isFinite(n) ? n : NaN; }

/* ======================= Webhook ======================= */
router.get("/wa/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chall = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ""));
  return res.sendStatus(403);
});

router.post("/wa/webhook", async (req, res) => {
  try {
    if (DEBUG) log("BODY", JSON.stringify(req.body));
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);
    dbg("IN", { from, type: msg.type, etapa: s.etapa });

    // saludo + pedir área
    if (!s.greeted) {
      s.greeted = true;
      await toText(from, saludo());
      s.etapa = "ask_area";
      setS(from, s);
      await pedirArea(from);
      return res.sendStatus(200);
    }

    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();
      const idU = id.toUpperCase();
      dbg("INTERACTIVE", idU, "ETAPA", s.etapa);

      /* === Área seleccionada === */
      if (idU === "AREA_HORTIFRUT" || idU === "AREA_AGROINDUSTRIA") {
        s.area = idU.replace("AREA_", ""); // "HORTIFRUT" | "AGROINDUSTRIA"
        s.etapa = "ask_personal";
        setS(from, s);
        await pedirResponsable(from, s.area);
        return res.sendStatus(200);
      }

      /* === Responsable seleccionado (según área) === */
      if (idU.startsWith("EMP_") && s.etapa === "ask_personal" && s.area) {
        const idx = Number(idU.replace("EMP_", "")) || 0;
        const names = AREAS[s.area] || [];
        const nombre = names[idx] || names[0] || "Responsable";
        const hoja = await ensureEmployeeSheet(nombre);
        s.empleado = hoja;
        s.etapa = "ask_categoria";
        setS(from, s);
        await toText(from, `Responsable: ${nombre}`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      /* === Categoría === */
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
        if (!s.empleado) { s.etapa = "ask_area"; setS(from, s); await pedirArea(from); return res.sendStatus(200); }
        const txt = await todaySummary(s.empleado);
        await toText(from, txt);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim();
      dbg("TEXT", { text, etapa: s.etapa });

      if (/^(menu|inicio)$/i.test(text)) { s.etapa = "ask_area"; s.area = null; s.empleado = null; setS(from, s); await pedirArea(from); return res.sendStatus(200); }

      // Permitir elegir área por texto
      if (s.etapa === "ask_area") {
        if (/hortifrut/i.test(text)) {
          s.area = "HORTIFRUT"; s.etapa = "ask_personal"; setS(from, s); await pedirResponsable(from, s.area); return res.sendStatus(200);
        }
        if (/agroindustria/i.test(text)) {
          s.area = "AGROINDUSTRIA"; s.etapa = "ask_personal"; setS(from, s); await pedirResponsable(from, s.area); return res.sendStatus(200);
        }
        await pedirArea(from);
        return res.sendStatus(200);
      }

      // Elegir responsable por texto (coincidencia exacta/contiene)
      if (s.etapa === "ask_personal" && s.area) {
        const names = (AREAS[s.area] || []).map(n => n.toLowerCase());
        const pickIdx = names.findIndex(n => n === text.toLowerCase() || n.includes(text.toLowerCase()));
        if (pickIdx >= 0) {
          const nombre = AREAS[s.area][pickIdx];
          const hoja = await ensureEmployeeSheet(nombre);
          s.empleado = hoja;
          s.etapa = "ask_categoria";
          setS(from, s);
          await toText(from, `Responsable: ${nombre}`);
          await pedirCategoria(from);
          return res.sendStatus(200);
        }
        await pedirResponsable(from, s.area);
        return res.sendStatus(200);
      }

      // Categoría por texto
      if (s.etapa === "ask_categoria") {
        const t = text.toLowerCase();
        const hit = CATS.find(c => t.includes(c));
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
        if (!s.empleado) { s.etapa = "ask_area"; setS(from, s); await pedirArea(from); return res.sendStatus(200); }

        const { detalle, factura, monto, km } = s.pend;
        const saved = await upsertDailyExpenseRow(s.empleado, {
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
            ? `• Km agregados: ${km}\n`
            : `• Monto agregado: Bs ${monto?.toFixed(2)}\n` +
              `• Detalle: ${detalle || "—"}\n` +
              `• Fact/Rec: ${factura || "—"}\n`) +
          `• ID fila: ${saved.id} — Fecha: ${saved.fecha}\n` +
          `Total acumulado hoy: Bs ${totalHoy.toFixed(2)}`;
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

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

export default router;
