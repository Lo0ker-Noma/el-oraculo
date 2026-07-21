// Estado del oraculo, con dos backends:
//   - Upstash Redis (REST) si hay UPSTASH_REDIS_REST_URL/TOKEN  -> sirve en
//     serverless (Vercel), donde no hay disco ni proceso permanente.
//   - Fichero local data/markets.json para desarrollo.
// La API es asincrona en ambos casos.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "markets.json");
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "oraculo:markets";

export const REMOTO = Boolean(RURL && RTOKEN);

let cache = null; // ultimo estado conocido (unica fuente en local; red de seguridad en remoto)

async function redis(cmd) {
  const r = await fetch(RURL, {
    method: "POST",
    headers: { Authorization: `Bearer ${RTOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  return (await r.json()).result;
}

/** Devuelve TODAS las apuestas (array). */
export async function load() {
  if (REMOTO) {
    try {
      const raw = await redis(["GET", KEY]);
      cache = raw ? JSON.parse(raw) : [];
      return cache;
    } catch (e) {
      console.warn(`[store] Upstash no responde al leer: ${e.message}`);
      return cache || [];
    }
  }
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    cache = [];
  }
  return cache;
}

/** Persiste la lista completa. */
export async function save(markets) {
  cache = markets;
  if (REMOTO) {
    try {
      await redis(["SET", KEY, JSON.stringify(markets)]);
    } catch (e) {
      console.warn(`[store] Upstash no responde al escribir: ${e.message}`);
    }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(markets, null, 2));
  } catch (e) {
    console.warn(`[store] no pude escribir el fichero: ${e.message}`);
  }
}

export const uid = () => crypto.randomBytes(6).toString("hex");

export const find = (markets, id) => markets.find((m) => m.id === id);

export function nuevoMercado({ question, description, closes_at, resolves_at }) {
  return {
    id: uid(),
    question,
    description: description || "",
    created_at: Math.floor(Date.now() / 1000),
    closes_at,
    resolves_at,
    status: "open", // open -> resolving -> resolved
    verdict: null,
    bets: [],
  };
}

/** Bote por lado, contando solo apuestas pagadas. */
export function pools(market) {
  const paid = market.bets.filter((b) => b.paid);
  const si = paid.filter((b) => b.side === "si").reduce((s, b) => s + b.sats, 0);
  const no = paid.filter((b) => b.side === "no").reduce((s, b) => s + b.sats, 0);
  return { si, no, total: si + no, apostadores: paid.length };
}

/** Calcula el reparto (muta el mercado). Devuelve quien cobra. */
export function computePayouts(market, outcome) {
  const paid = market.bets.filter((b) => b.paid);
  const { total } = pools(market);
  if (outcome === "indeterminado") {
    for (const b of paid) b.payout_sats = b.sats; // devolucion
  } else {
    const winners = paid.filter((b) => b.side === outcome);
    const winnersStake = winners.reduce((s, b) => s + b.sats, 0);
    for (const b of paid) {
      b.payout_sats =
        b.side === outcome && winnersStake > 0 ? Math.floor((b.sats / winnersStake) * total) : 0;
    }
    if (winners.length === 0) for (const b of paid) b.payout_sats = b.sats; // nadie acerto
  }
  return paid.filter((b) => b.payout_sats > 0);
}
