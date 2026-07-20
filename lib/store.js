// Persistencia simple en JSON (data/markets.json). Sin DB: un hackathon no
// necesita mas, y el jurado puede inspeccionar el estado a mano.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "markets.json");

let markets = [];
try {
  markets = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  markets = [];
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(markets, null, 2));
}

export const uid = () => crypto.randomBytes(6).toString("hex");

export function allMarkets() {
  return markets;
}

export function getMarket(id) {
  return markets.find((m) => m.id === id);
}

export function createMarket({ question, description, closes_at, resolves_at }) {
  const m = {
    id: uid(),
    question,
    description: description || "",
    created_at: Math.floor(Date.now() / 1000),
    closes_at,   // unix: fin de apuestas
    resolves_at, // unix: momento en que el oraculo resuelve
    status: "open", // open -> resolving -> resolved | void
    verdict: null,  // {outcome: 'si'|'no'|'indeterminado', confianza, razonamiento, fuentes[]}
    bets: [],       // {id, side, sats, lnaddress, invoice, payment_hash, paid, payout_sats, payout_status}
  };
  markets.unshift(m);
  save();
  return m;
}

export function addBet(market, bet) {
  market.bets.push(bet);
  save();
  return bet;
}

export function update() {
  save();
}

/** Bote y reparto: los ganadores se reparten TODO el bote pro-rata a su apuesta. */
export function pools(market) {
  const paid = market.bets.filter((b) => b.paid);
  const si = paid.filter((b) => b.side === "si").reduce((s, b) => s + b.sats, 0);
  const no = paid.filter((b) => b.side === "no").reduce((s, b) => s + b.sats, 0);
  return { si, no, total: si + no, apostadores: paid.length };
}

export function computePayouts(market, outcome) {
  const paid = market.bets.filter((b) => b.paid);
  const { total } = pools(market);
  if (outcome === "indeterminado") {
    // devolucion: cada uno recupera su apuesta
    for (const b of paid) b.payout_sats = b.sats;
  } else {
    const winners = paid.filter((b) => b.side === outcome);
    const winnersStake = winners.reduce((s, b) => s + b.sats, 0);
    for (const b of paid) {
      b.payout_sats = b.side === outcome && winnersStake > 0
        ? Math.floor((b.sats / winnersStake) * total)
        : 0;
    }
    // si nadie acerto, devolucion
    if (winners.length === 0) for (const b of paid) b.payout_sats = b.sats;
  }
  save();
  return paid.filter((b) => b.payout_sats > 0);
}
