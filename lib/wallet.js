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

/** ¿Esta pagada esta invoice? */
export async function isPaid(payment_hash) {
  if (DEMO) return Date.now() - (demoInvoices[payment_hash] || 0) > 4000;
  const c = await nwcClient();
  try {
    const res = await c.lookupInvoice({ payment_hash });
    return Boolean(res.settled_at || res.preimage);
  } catch {
    return false;
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
