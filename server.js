#!/usr/bin/env node
// EL ORÁCULO — apuestas sociales con bote Lightning resueltas por un agente IA.
// Flujo: crear apuesta -> apostar si/no (invoice al bote) -> a la hora fijada,
// el agente investiga en la web, dicta veredicto, lo publica en Nostr y
// reparte el bote a las Lightning addresses ganadoras. Sin humano en el medio.

import "./lib/env.js"; // carga .env antes que el resto de modulos
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import * as store from "./lib/store.js";
import * as wallet from "./lib/wallet.js";
import { resolveWithAI, demoVerdict } from "./lib/oracle.js";
import { publishVerdict } from "./lib/nostr.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5220;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const publicMarket = (m) => ({ ...m, pools: store.pools(m), bets: m.bets.filter((b) => b.paid).map(({ id, side, sats, payout_sats, payout_status }) => ({ id, side, sats, payout_sats, payout_status })) });

// --- Mercados ---------------------------------------------------------------

app.get("/api/markets", (_req, res) => {
  res.json({ ok: true, demo: wallet.DEMO, markets: store.allMarkets().map(publicMarket) });
});

app.post("/api/markets", (req, res) => {
  const { question, description, minutes_open, minutes_resolve } = req.body || {};
  if (!question?.trim()) return res.status(400).json({ ok: false, error: "Falta la pregunta." });
  const now = Math.floor(Date.now() / 1000);
  const closes = now + Math.max(1, Number(minutes_open) || 10) * 60;
  const resolves = Math.max(closes, now + Math.max(1, Number(minutes_resolve) || 15) * 60);
  const m = store.createMarket({ question: question.trim(), description: (description || "").trim(), closes_at: closes, resolves_at: resolves });
  res.json({ ok: true, market: publicMarket(m) });
});

// --- Apuestas ---------------------------------------------------------------

app.post("/api/markets/:id/bet", async (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: "Apuesta no encontrada." });
  if (m.status !== "open" || Date.now() / 1000 > m.closes_at) {
    return res.status(400).json({ ok: false, error: "Las apuestas estan cerradas." });
  }
  const side = req.body?.side === "si" ? "si" : req.body?.side === "no" ? "no" : null;
  const sats = Math.floor(Number(req.body?.sats));
  const lnaddress = (req.body?.lnaddress || "").trim();
  if (!side) return res.status(400).json({ ok: false, error: "Elige SI o NO." });
  if (!sats || sats < 10) return res.status(400).json({ ok: false, error: "Minimo 10 sats." });
  if (!wallet.DEMO && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lnaddress)) {
    return res.status(400).json({ ok: false, error: "Pon tu Lightning address (usuario@wallet.com) para cobrar si ganas." });
  }
  try {
    const { invoice, payment_hash } = await wallet.createInvoice(sats, `El Oraculo · ${side.toUpperCase()} · ${m.question.slice(0, 60)}`);
    const bet = store.addBet(m, {
      id: store.uid(), side, sats, lnaddress, invoice, payment_hash,
      paid: false, payout_sats: 0, payout_status: null,
    });
    const qr = await QRCode.toDataURL(invoice, { margin: 1, width: 280 });
    res.json({ ok: true, bet_id: bet.id, invoice, qr, demo: wallet.DEMO });
  } catch (e) {
    res.status(500).json({ ok: false, error: `No pude crear la invoice: ${e.message}` });
  }
});

app.get("/api/markets/:id/bet/:betId", async (req, res) => {
  const m = store.getMarket(req.params.id);
  const bet = m?.bets.find((b) => b.id === req.params.betId);
  if (!bet) return res.status(404).json({ ok: false, error: "Apuesta no encontrada." });
  if (!bet.paid && (await wallet.isPaid(bet.payment_hash))) {
    bet.paid = true;
    store.update();
  }
  res.json({ ok: true, paid: bet.paid, pools: store.pools(m) });
});

// --- Resolucion (el agente) -------------------------------------------------

async function resolveMarket(m, { force = false } = {}) {
  if (m.status !== "open") return;
  if (!force && Date.now() / 1000 < m.resolves_at) return;
  m.status = "resolving";
  store.update();
  console.log(`[oraculo] resolviendo: "${m.question}"`);

  // confirmar pagos pendientes antes de repartir (por si algun modal se cerro sin pollear)
  for (const b of m.bets) {
    if (!b.paid && (await wallet.isPaid(b.payment_hash))) b.paid = true;
  }
  store.update();

  let verdict = await resolveWithAI(m);
  if (!verdict) verdict = demoVerdict(m);
  m.verdict = verdict;

  // reparto del bote
  const winners = store.computePayouts(m, verdict.outcome);
  for (const b of winners) {
    try {
      if (b.lnaddress) {
        await wallet.payToAddress(b.lnaddress, b.payout_sats, `El Oraculo: ganaste "${m.question.slice(0, 60)}"`);
        b.payout_status = "pagado";
      } else {
        b.payout_status = wallet.DEMO ? "pagado" : "sin-lnaddress";
      }
    } catch (e) {
      b.payout_status = `error: ${e.message}`;
    }
  }
  m.status = "resolved";
  store.update();

  const nostr = await publishVerdict(m);
  m.nostr = nostr;
  store.update();
  console.log(`[oraculo] veredicto: ${verdict.outcome.toUpperCase()} · nostr: ${nostr.published ? "publicado" : nostr.reason}`);
}

// disparo manual (util para la demo en vivo: "resuelve AHORA")
app.post("/api/markets/:id/resolve", async (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ ok: false, error: "No existe." });
  if (m.status !== "open") return res.status(400).json({ ok: false, error: `Estado: ${m.status}` });
  resolveMarket(m, { force: true }); // async: el front hace polling
  res.json({ ok: true });
});

// vigilante: resuelve automaticamente lo que venza
setInterval(() => {
  for (const m of store.allMarkets()) resolveMarket(m).catch((e) => console.error(e));
}, 20000);

app.listen(PORT, () => {
  console.log(`🔮 El Oraculo -> http://localhost:${PORT}  (${wallet.DEMO ? "MODO DEMO: pagos simulados" : "wallet NWC real"})`);
});
