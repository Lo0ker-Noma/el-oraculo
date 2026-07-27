#!/usr/bin/env node
// EL ORÁCULO — apuestas sociales con bote Lightning resueltas por un agente IA.
// Flujo: crear apuesta -> apostar si/no (invoice al bote) -> al vencer, el agente
// consulta sus herramientas, dicta veredicto, lo publica en Nostr y reparte el bote.
//
// Funciona igual en local (node server.js) y en serverless (Vercel), donde el
// estado vive en Upstash y la resolucion se dispara por peticion, no por timer.

import "./lib/env.js"; // carga .env antes que el resto de modulos
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { nip19 } from "nostr-tools";
import * as store from "./lib/store.js";
import * as wallet from "./lib/wallet.js";
import { resolveWithAI, demoVerdict, analizarProbabilidad, preguntarOraculo } from "./lib/oracle.js";
import { publishVerdict } from "./lib/nostr.js";
import { verifyNip98, issueToken, verifyToken } from "./lib/auth.js";
import { securityHeaders, rateLimit, safeLnAddress, sanitizeUrls, clean } from "./lib/security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5220;
const EN_VERCEL = Boolean(process.env.VERCEL);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const npubOf = (pk) => { try { return pk ? nip19.npubEncode(pk) : null; } catch { return null; } };

const publicMarket = (m) => ({
  id: m.id,
  question: m.question,
  description: m.description,
  created_at: m.created_at,
  closes_at: m.closes_at,
  resolves_at: m.resolves_at,
  status: m.status,
  verdict: m.verdict,
  nostr: m.nostr,
  pools: store.pools(m),
  bets: m.bets.filter((b) => b.paid).map((b) => ({
    id: b.id, side: b.side, sats: b.sats,
    npub: npubOf(b.pubkey), payout_sats: b.payout_sats, payout_status: b.payout_status,
  })),
});

// --- Login opcional con Nostr (NIP-07 cliente + NIP-98 aqui) ---------------

app.post("/api/nostr/login", rateLimit(15, 10 * 60_000), (req, res) => {
  const pubkey = verifyNip98(req.body?.event);
  if (!pubkey) return res.status(401).json({ ok: false, error: "Firma Nostr invalida o caducada." });
  res.json({ ok: true, token: issueToken(pubkey), pubkey, npub: npubOf(pubkey) });
});

// --- Acceso: QR para que la sala entre desde el movil ----------------------

app.get("/api/acceso", async (req, res) => {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const local = /localhost|127\.0\.0\.1|192\.168\.|\[::1\]/.test(base);
  try {
    const qr = await QRCode.toDataURL(base, { margin: 1, width: 320 });
    res.json({ ok: true, url: base, qr, local });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Mercados ---------------------------------------------------------------

app.get("/api/markets", async (_req, res) => {
  const markets = await store.load();
  res.json({
    ok: true,
    demo: wallet.DEMO,
    // apuestas que ya deberian resolverse: el front las dispara
    pendientes: markets.filter((m) => m.status === "open" && Date.now() / 1000 >= m.resolves_at).map((m) => m.id),
    markets: markets.map(publicMarket),
  });
});

app.post("/api/markets", rateLimit(8, 10 * 60_000), async (req, res) => {
  const question = clean(req.body?.question, 280);
  const description = clean(req.body?.description, 500);
  if (question.length < 6) return res.status(400).json({ ok: false, error: "La pregunta es muy corta." });

  const now = Math.floor(Date.now() / 1000);
  const MAX = now + 365 * 24 * 3600; // como mucho, un año vista
  const clamp = (v, def, min, max) => Math.min(max, Math.max(min, Number(v) || def));
  const parseTs = (v) => {
    if (!v) return null;
    const t = Math.floor(new Date(v).getTime() / 1000);
    return Number.isFinite(t) ? t : null;
  };
  let closes = parseTs(req.body?.closes_at) ?? now + clamp(req.body?.minutes_open, 10, 1, 1440) * 60;
  let resolves = parseTs(req.body?.resolves_at) ?? now + clamp(req.body?.minutes_resolve, 15, 1, 1440) * 60;
  if (closes <= now) return res.status(400).json({ ok: false, error: "El cierre de apuestas debe ser futuro." });
  if (closes > MAX || resolves > MAX) return res.status(400).json({ ok: false, error: "Fecha demasiado lejana (máximo 1 año)." });
  resolves = Math.max(resolves, closes); // nunca resolver antes de cerrar

  const markets = await store.load();
  const m = store.nuevoMercado({ question, description, closes_at: closes, resolves_at: resolves });
  markets.unshift(m);
  await store.save(markets);
  res.json({ ok: true, market: publicMarket(m) });
});

// --- Oráculo: análisis previo y chat ---------------------------------------

app.post("/api/analizar", rateLimit(12, 10 * 60_000), async (req, res) => {
  const question = clean(req.body?.question, 280);
  if (question.length < 6) return res.status(400).json({ ok: false, error: "La pregunta es muy corta." });
  const r = await analizarProbabilidad(question);
  if (!r) return res.status(503).json({ ok: false, error: "El oráculo no puede analizar ahora (IA sin configurar o cuota diaria agotada)." });
  res.json({ ok: true, ...r, fuentes: sanitizeUrls(r.fuentes) });
});

app.post("/api/preguntar", rateLimit(20, 10 * 60_000), async (req, res) => {
  const pregunta = clean(req.body?.pregunta, 300);
  if (pregunta.length < 3) return res.status(400).json({ ok: false, error: "Escribe una pregunta." });
  const r = await preguntarOraculo(pregunta);
  if (!r) return res.status(503).json({ ok: false, error: "El oráculo guarda silencio (IA sin configurar o cuota diaria agotada)." });
  res.json({ ok: true, ...r, fuentes: sanitizeUrls(r.fuentes) });
});

// --- Apuestas ---------------------------------------------------------------

app.post("/api/markets/:id/bet", rateLimit(30, 10 * 60_000), async (req, res) => {
  const markets = await store.load();
  const m = store.find(markets, req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: "Apuesta no encontrada." });
  if (m.status !== "open" || Date.now() / 1000 > m.closes_at) {
    return res.status(400).json({ ok: false, error: "Las apuestas estan cerradas." });
  }
  const side = req.body?.side === "si" ? "si" : req.body?.side === "no" ? "no" : null;
  const sats = Math.floor(Number(req.body?.sats));
  const lnaddress = clean(req.body?.lnaddress, 253);
  if (!side) return res.status(400).json({ ok: false, error: "Elige SI o NO." });
  if (!Number.isFinite(sats) || sats < 10 || sats > 10_000_000) {
    return res.status(400).json({ ok: false, error: "Cantidad invalida (entre 10 y 10.000.000 sats)." });
  }
  if (!wallet.DEMO && !safeLnAddress(lnaddress)) {
    return res.status(400).json({ ok: false, error: "Pon una Lightning address valida (usuario@wallet.com) para cobrar si ganas." });
  }
  const pubkey = verifyToken(req.body?.token) || null; // identidad opcional verificada
  try {
    const { invoice, payment_hash } = await wallet.createInvoice(sats, `El Oraculo · ${side.toUpperCase()} · ${m.question.slice(0, 60)}`);
    const bet = {
      id: store.uid(), side, sats, lnaddress, pubkey, invoice, payment_hash,
      invoiced_at: Math.floor(Date.now() / 1000),
      paid: false, paid_match: null, payout_sats: 0, payout_status: null,
    };
    m.bets.push(bet);
    await store.save(markets);
    const qr = await QRCode.toDataURL(invoice, { margin: 1, width: 280 });
    res.json({ ok: true, bet_id: bet.id, invoice, qr, demo: wallet.DEMO });
  } catch (e) {
    res.status(500).json({ ok: false, error: `No pude crear la invoice: ${e.message}` });
  }
});

// Confirma si una apuesta esta pagada. En DEMO usa el temporizador simulado.
// En real, como Primal no reporta el estado por payment_hash, buscamos un
// ingreso liquidado del mismo importe posterior a la creacion de la invoice
// que no haya sido ya asignado a otra apuesta del mismo mercado.
async function confirmarPago(m, bet) {
  if (bet.paid) return true;
  if (wallet.DEMO) {
    if (await wallet.isPaid(bet.payment_hash)) bet.paid = true;
    return bet.paid;
  }
  const ingresos = await wallet.ingresosLiquidados();
  const usados = new Set(m.bets.filter((b) => b.paid && b.paid_match != null).map((b) => b.paid_match));
  const desde = (bet.invoiced_at || 0) - 30; // margen por desfase de reloj
  const match = ingresos.find(
    (t) => t.sats === bet.sats && t.settled_at >= desde && !usados.has(t.settled_at)
  );
  if (match) { bet.paid = true; bet.paid_match = match.settled_at; }
  return bet.paid;
}

app.get("/api/markets/:id/bet/:betId", async (req, res) => {
  const markets = await store.load();
  const m = store.find(markets, req.params.id);
  const bet = m?.bets.find((b) => b.id === req.params.betId);
  if (!bet) return res.status(404).json({ ok: false, error: "Apuesta no encontrada." });
  if (!bet.paid && (await confirmarPago(m, bet))) {
    await store.save(markets);
  }
  res.json({ ok: true, paid: bet.paid, pools: store.pools(m) });
});

// --- Resolucion (el agente) -------------------------------------------------

async function resolveMarket(markets, m) {
  m.status = "resolving";
  await store.save(markets);
  console.log(`[oraculo] resolviendo: "${m.question}"`);

  // confirmar pagos pendientes antes de repartir
  for (const b of m.bets) {
    if (!b.paid) await confirmarPago(m, b);
  }

  let verdict = await resolveWithAI(m);
  if (!verdict) verdict = demoVerdict(m);
  verdict.fuentes = sanitizeUrls(verdict.fuentes);
  m.verdict = verdict;

  const winners = store.computePayouts(m, verdict.outcome);
  for (const b of winners) {
    try {
      if (b.lnaddress && safeLnAddress(b.lnaddress)) {
        await wallet.payToAddress(b.lnaddress, b.payout_sats, `El Oraculo: ganaste "${m.question.slice(0, 60)}"`);
        b.payout_status = "pagado";
      } else {
        b.payout_status = wallet.DEMO ? "pagado" : "sin-lnaddress";
      }
    } catch (e) {
      b.payout_status = "error-pago";
      console.warn(`[oraculo] pago fallo: ${e.message}`);
    }
  }
  m.status = "resolved";

  const nostr = await publishVerdict(m);
  m.nostr = { published: nostr.published };
  await store.save(markets);
  console.log(`[oraculo] veredicto: ${verdict.outcome.toUpperCase()} · nostr: ${nostr.published ? "publicado" : "no"}`);
}

// Disparo de la resolucion. En serverless no hay temporizador: el front llama
// aqui cuando una apuesta vence (o el presentador pulsa "resolver ya").
app.post("/api/markets/:id/resolve", rateLimit(20, 10 * 60_000), async (req, res) => {
  const markets = await store.load();
  const m = store.find(markets, req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: "No existe." });
  if (m.status !== "open") return res.status(400).json({ ok: false, error: `Estado: ${m.status}` });
  const vencida = Date.now() / 1000 >= m.resolves_at;
  const esAdmin = req.body?.admin === ADMIN_PASSWORD;
  // La resolucion automatica (cuando vence) la dispara el front y es libre.
  // Forzarla antes de tiempo ("resolver ya") es solo para el admin.
  if (!vencida && !esAdmin) {
    return res.status(403).json({ ok: false, error: "Solo el admin puede forzar la resolucion antes de tiempo." });
  }
  try {
    await resolveMarket(markets, m);
    res.json({ ok: true, market: publicMarket(m) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Fallo al resolver." });
  }
});

// --- Admin: borrar una apuesta (para limpiar pruebas) ----------------------
app.post("/api/admin/markets/:id/delete", rateLimit(30, 10 * 60_000), async (req, res) => {
  if (req.body?.admin !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Contraseña de admin incorrecta." });
  const markets = await store.load();
  const i = markets.findIndex((m) => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: "No existe." });
  const [borrada] = markets.splice(i, 1);
  await store.save(markets);
  res.json({ ok: true, deleted: borrada.id });
});

// Comprueba la contraseña de admin (para desbloquear el panel).
app.post("/api/admin/login", rateLimit(20, 10 * 60_000), (req, res) => {
  res.json({ ok: req.body?.admin === ADMIN_PASSWORD });
});

// En local mantenemos el vigilante; en Vercel lo dispara el front.
if (!EN_VERCEL) {
  setInterval(async () => {
    try {
      const markets = await store.load();
      const due = markets.filter((m) => m.status === "open" && Date.now() / 1000 >= m.resolves_at);
      for (const m of due) await resolveMarket(markets, m);
    } catch (e) {
      console.error(e);
    }
  }, 20_000);

  app.listen(PORT, () => {
    console.log(
      `🔮 El Oraculo -> http://localhost:${PORT}  ` +
        `(${wallet.DEMO ? "MODO DEMO: pagos simulados" : "wallet NWC real"}` +
        `${store.REMOTO ? ", estado en Upstash" : ", estado en fichero"})`
    );
  });
}

export default app;
