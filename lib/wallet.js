// Capa de pagos del bote, pensada para NO caerse nunca en una demo en vivo.
//
// Cobrar el bote tiene dos caminos independientes:
//   1) NWC (get_balance / make_invoice / lookup_invoice / pay_invoice) — permite
//      ademas confirmar pagos y repartir premios automaticamente.
//   2) LNURL-pay contra la Lightning address (HTTPS puro, sin relays) — se usa
//      como RESCATE si la wallet NWC no contesta. Genera invoices reales que
//      ingresan en la misma wallet, asi que el bote sigue funcionando.
//
// Todas las llamadas NWC llevan timeout: si la wallet no responde, se marca
// como caida y se deja de esperar por ella (antes esto colgaba la funcion de
// Vercel hasta el 504 y el boton "Apostar" no hacia nada).

const NWC_URL = process.env.NWC_URL || "";
const NWC_TIMEOUT_MS = Number(process.env.NWC_TIMEOUT_MS || 5000);
const CAIDA_MS = 60_000; // tras un timeout, no reintentar NWC durante 1 min
// Si la wallet NWC no contesta de forma cronica, PREFER_LNURL=1 salta el intento
// y emite las facturas directamente por LNURL (instantaneo, sin esperas).
const PREFER_LNURL = /^(1|true|si|sí)$/i.test(process.env.PREFER_LNURL || "");

export const DEMO = !NWC_URL;

// Lightning address para el rescate LNURL: variable propia o la lud16 del NWC.
export const LN_ADDRESS = (() => {
  if (process.env.LIGHTNING_ADDRESS) return process.env.LIGHTNING_ADDRESS.trim();
  try {
    const q = new URL(NWC_URL.replace("nostr+walletconnect://", "https://")).searchParams;
    return (q.get("lud16") || "").trim();
  } catch {
    return "";
  }
})();

const salud = { nwcCaidoHasta: 0, ultimoError: "" };
export const nwcDisponible = () => Boolean(NWC_URL) && Date.now() >= salud.nwcCaidoHasta;
export const estadoPagos = () => ({
  demo: DEMO,
  nwc_ok: nwcDisponible(),
  lnurl: Boolean(LN_ADDRESS),
  ultimo_error: salud.ultimoError || null,
});

function conTimeout(promesa, ms, etiqueta) {
  return Promise.race([
    promesa,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout de ${ms}ms en ${etiqueta}`)), ms)),
  ]);
}

let client = null;
async function nwcClient() {
  if (client) return client;
  const { NWCClient } = await import("@getalby/sdk");
  client = new NWCClient({ nostrWalletConnectUrl: NWC_URL });
  return client;
}

/** Ejecuta una operacion NWC con timeout. Devuelve null si falla (no lanza). */
async function nwc(etiqueta, fn) {
  if (!nwcDisponible()) return null;
  try {
    const c = await conTimeout(nwcClient(), NWC_TIMEOUT_MS, "conexion NWC");
    return await conTimeout(fn(c), NWC_TIMEOUT_MS, etiqueta);
  } catch (e) {
    salud.nwcCaidoHasta = Date.now() + CAIDA_MS;
    salud.ultimoError = `${etiqueta}: ${e.message}`;
    console.warn(`[wallet] NWC no responde (${etiqueta}: ${e.message}). Rescate por LNURL durante ${CAIDA_MS / 1000}s.`);
    return null;
  }
}

const demoInvoices = {}; // payment_hash -> created_at ms

/** Invoice real via LNURL-pay contra la Lightning address (sin relays). */
async function invoiceLnurl(sats, memo) {
  if (!LN_ADDRESS || !LN_ADDRESS.includes("@")) return null;
  try {
    const [user, dominio] = LN_ADDRESS.split("@");
    const meta = await conTimeout(
      fetch(`https://${dominio}/.well-known/lnurlp/${encodeURIComponent(user)}`).then((r) => r.json()),
      8000, "LNURL metadata"
    );
    if (meta.status === "ERROR" || !meta.callback) throw new Error(meta.reason || "sin callback");
    const msats = sats * 1000;
    if (meta.minSendable && msats < meta.minSendable) throw new Error("importe por debajo del minimo");
    if (meta.maxSendable && msats > meta.maxSendable) throw new Error("importe por encima del maximo");
    const url = new URL(meta.callback);
    url.searchParams.set("amount", String(msats));
    if (meta.commentAllowed && memo) url.searchParams.set("comment", memo.slice(0, meta.commentAllowed));
    const res = await conTimeout(fetch(url).then((r) => r.json()), 10000, "LNURL callback");
    if (res.status === "ERROR" || !res.pr) throw new Error(res.reason || "sin invoice");
    return { invoice: res.pr, payment_hash: null, via: "lnurl" };
  } catch (e) {
    console.warn(`[wallet] LNURL fallo: ${e.message}`);
    return null;
  }
}

/** Crea una invoice para una apuesta. Devuelve {invoice, payment_hash, via}. */
export async function createInvoice(sats, memo) {
  if (DEMO) {
    const hash = "demo-" + Math.random().toString(16).slice(2, 14);
    demoInvoices[hash] = Date.now();
    return { invoice: `lnbc-DEMO-${sats}sats-${hash}`, payment_hash: hash, via: "demo" };
  }

  // 1) camino normal: la wallet emite la invoice (permite confirmar por hash)
  if (!PREFER_LNURL) {
    const res = await nwc("make_invoice", (c) => c.makeInvoice({ amount: sats * 1000, description: memo }));
    if (res?.invoice) return { invoice: res.invoice, payment_hash: res.payment_hash, via: "nwc" };
  }

  // 2) rescate: invoice real por LNURL (ingresa en la misma wallet)
  const lnurl = await invoiceLnurl(sats, memo);
  if (lnurl) return lnurl;

  throw new Error("La wallet no responde y no se pudo generar la factura por LNURL.");
}

/** ¿Esta pagada esta invoice? Solo fiable si la emitio NWC. */
export async function isPaid(payment_hash) {
  if (DEMO) return Date.now() - (demoInvoices[payment_hash] || 0) > 4000;
  if (!payment_hash) return false; // invoice LNURL: se confirma por ingreso
  const res = await nwc("lookup_invoice", (c) => c.lookupInvoice({ payment_hash }));
  if (!res) return false;
  return res.state === "settled" || Boolean(res.settled_at) || Boolean(res.preimage);
}

/** Ingresos LIQUIDADOS de la wallet: [{ sats, settled_at }].
 *  Necesario para wallets que no reportan estado por payment_hash (Primal) y
 *  para confirmar las invoices emitidas por LNURL: se casan por importe+hora. */
export async function ingresosLiquidados(limit = 50) {
  if (DEMO) return [];
  const r = await nwc("list_transactions", (c) => c.listTransactions({ limit }));
  if (!r) return [];
  const list = r.transactions || r || [];
  return list
    .filter((t) => t.type === "incoming" && t.state === "settled")
    .map((t) => ({ sats: Math.round((t.amount || 0) / 1000), settled_at: t.settled_at || t.created_at || 0 }));
}

/** Paga `sats` a una Lightning address (reparto del bote). */
export async function payToAddress(lnaddress, sats, comment) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, demo: true };
  }
  const { LightningAddress } = await import("@getalby/lightning-tools");
  const ln = new LightningAddress(lnaddress);
  await conTimeout(ln.fetch(), 10000, "LNURL del ganador");
  const invoice = await conTimeout(
    ln.requestInvoice({ satoshi: sats, comment: comment?.slice(0, 100) }),
    10000, "invoice del ganador"
  );
  const r = await nwc("pay_invoice", (c) => c.payInvoice({ invoice: invoice.paymentRequest }));
  if (!r) throw new Error("La wallet no responde: no se pudo enviar el premio.");
  return { ok: true };
}
