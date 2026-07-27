// Capa de pagos del bote. Dos modos:
//  - REAL: wallet NWC (Alby/LNbits/LaWallet) via NWC_URL en .env.
//          makeInvoice para cobrar apuestas, lookupInvoice para confirmar,
//          payInvoice (a la Lightning address del ganador) para el reparto.
//  - DEMO: sin NWC_URL. Invoices simuladas que se "pagan" solas a los 4s y
//          pagos de premio simulados. Permite evaluar la app sin credenciales.

const NWC_URL = process.env.NWC_URL || "";
export const DEMO = !NWC_URL;

let client = null;
async function nwcClient() {
  if (client) return client;
  const { NWCClient } = await import("@getalby/sdk");
  client = new NWCClient({ nostrWalletConnectUrl: NWC_URL });
  return client;
}

const demoInvoices = {}; // payment_hash -> created_at ms

/** Crea una invoice para una apuesta. Devuelve {invoice, payment_hash}. */
export async function createInvoice(sats, memo) {
  if (DEMO) {
    const hash = "demo-" + Math.random().toString(16).slice(2, 14);
    demoInvoices[hash] = Date.now();
    return { invoice: `lnbc-DEMO-${sats}sats-${hash}`, payment_hash: hash };
  }
  const c = await nwcClient();
  const res = await c.makeInvoice({ amount: sats * 1000, description: memo });
  return { invoice: res.invoice, payment_hash: res.payment_hash };
}

/** ¿Esta pagada esta invoice? (solo fiable en DEMO y en wallets que reportan
 *  el estado por payment_hash. Primal NO lo hace: usar confirmPorIngreso). */
export async function isPaid(payment_hash) {
  if (DEMO) return Date.now() - (demoInvoices[payment_hash] || 0) > 4000;
  const c = await nwcClient();
  try {
    const res = await c.lookupInvoice({ payment_hash });
    return res.state === "settled" || Boolean(res.settled_at) || Boolean(res.preimage);
  } catch {
    return false;
  }
}

/** Lista de ingresos LIQUIDADOS de la wallet: [{ sats, settled_at }].
 *  Necesario porque algunas wallets (Primal) no reportan el estado de una
 *  invoice por payment_hash — los pagos recibidos solo aparecen aqui, con su
 *  importe y su hora de liquidacion, sin hash. Confirmamos por importe+tiempo. */
export async function ingresosLiquidados(limit = 50) {
  if (DEMO) return [];
  const c = await nwcClient();
  try {
    const r = await c.listTransactions({ limit });
    const list = r.transactions || r || [];
    return list
      .filter((t) => t.type === "incoming" && t.state === "settled")
      .map((t) => ({ sats: Math.round((t.amount || 0) / 1000), settled_at: t.settled_at || t.created_at || 0 }));
  } catch {
    return [];
  }
}

/** Paga `sats` a una Lightning address (reparto del bote). */
export async function payToAddress(lnaddress, sats, comment) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, demo: true };
  }
  const { LightningAddress } = await import("@getalby/lightning-tools");
  const ln = new LightningAddress(lnaddress);
  await ln.fetch();
  const invoice = await ln.requestInvoice({ satoshi: sats, comment: comment?.slice(0, 100) });
  const c = await nwcClient();
  await c.payInvoice({ invoice: invoice.paymentRequest });
  return { ok: true };
}
