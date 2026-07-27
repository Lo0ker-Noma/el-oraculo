#!/usr/bin/env node
// Diagnostico de la wallet Lightning del oraculo (NWC).
// Sirve para comprobar, ANTES de una demo en vivo, que la wallet puede:
//   1) conectarse,  2) consultar saldo,  3) emitir invoices (cobrar el bote),
//   4) confirmar pagos,  y opcionalmente  5) pagar a una Lightning address.
//
// Uso:
//   node scripts/check-wallet.js                 -> saldo + invoice de prueba (QR)
//   node scripts/check-wallet.js --esperar       -> ademas espera a que la pagues
//   node scripts/check-wallet.js --pagar u@w.com 21   -> ENVIA 21 sats de verdad
//
// El envio real solo ocurre si pasas --pagar explicitamente.

import "../lib/env.js";
import QRCode from "qrcode";

const NWC_URL = process.env.NWC_URL || "";
const args = process.argv.slice(2);
const esperar = args.includes("--esperar");
const iPagar = args.indexOf("--pagar");
const destino = iPagar >= 0 ? args[iPagar + 1] : null;
const importe = iPagar >= 0 ? Number(args[iPagar + 2] || 21) : 0;

const sats = (msats) => Math.round((msats || 0) / 1000);

if (!NWC_URL) {
  console.error("\n❌ No hay NWC_URL en .env — la app funcionaria en MODO DEMO (pagos simulados).");
  console.error("   Consigue una connection string NWC (Alby: Wallet > Connections > Add connection)");
  console.error("   con permisos para crear invoices, consultar y pagar, y ponla en .env:\n");
  console.error("   NWC_URL=nostr+walletconnect://...\n");
  process.exit(1);
}

const { NWCClient } = await import("@getalby/sdk");
const client = new NWCClient({ nostrWalletConnectUrl: NWC_URL });

try {
  // 1) saldo
  console.log("\n🔌 Conectando con la wallet...");
  const bal = await client.getBalance();
  console.log(`💰 Saldo disponible: ${sats(bal.balance).toLocaleString("es-ES")} sats`);

  // 2) emitir invoice (asi es como entra el bote)
  const prueba = 21;
  console.log(`\n🧾 Creando invoice de prueba de ${prueba} sats (asi cobra el bote)...`);
  const inv = await client.makeInvoice({ amount: prueba * 1000, description: "El Oraculo - prueba" });
  console.log("✅ Invoice creada. Escanea para probar el cobro:\n");
  console.log(await QRCode.toString(inv.invoice, { type: "terminal", small: true }));
  console.log(inv.invoice + "\n");

  // 3) confirmar el pago
  if (esperar) {
    console.log("⏳ Esperando a que la pagues (2 min max)...");
    const hasta = Date.now() + 120000;
    let pagada = false;
    while (Date.now() < hasta && !pagada) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const l = await client.lookupInvoice({ payment_hash: inv.payment_hash });
        pagada = Boolean(l.settled_at || l.preimage);
      } catch {}
      process.stdout.write(".");
    }
    console.log(pagada ? "\n✅ ¡Pago detectado! El cobro del bote funciona." : "\n⚠️ No se detecto el pago (no pasa nada si no la pagaste).");
  } else {
    const l = await client.lookupInvoice({ payment_hash: inv.payment_hash }).catch(() => null);
    console.log(l ? "✅ lookupInvoice responde (se pueden confirmar pagos)." : "⚠️ lookupInvoice no respondio.");
  }

  // 4) pago de premio (solo si se pide explicitamente)
  if (destino) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) throw new Error(`Lightning address invalida: ${destino}`);
    console.log(`\n💸 ENVIANDO ${importe} sats de VERDAD a ${destino} ...`);
    const { LightningAddress } = await import("@getalby/lightning-tools");
    const ln = new LightningAddress(destino);
    await ln.fetch();
    const dest = await ln.requestInvoice({ satoshi: importe, comment: "El Oraculo - prueba de reparto" });
    await client.payInvoice({ invoice: dest.paymentRequest });
    console.log("✅ Pago enviado. El reparto de premios funciona.");
    const bal2 = await client.getBalance();
    console.log(`💰 Saldo ahora: ${sats(bal2.balance).toLocaleString("es-ES")} sats`);
  } else {
    console.log("\nℹ️  Para probar el REPARTO (envia sats de verdad):");
    console.log("   node scripts/check-wallet.js --pagar tu-lightning@address 21");
  }

  console.log("\n🔮 Diagnostico terminado.\n");
} catch (e) {
  console.error(`\n❌ Fallo: ${e.message}`);
  console.error("   Revisa que la conexion NWC tenga permisos de crear invoice, consultar y pagar,");
  console.error("   y que tenga presupuesto asignado.\n");
  process.exit(1);
} finally {
  client.close?.();
}
