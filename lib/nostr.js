// Publicacion del veredicto en Nostr (kind 1). Opcional: requiere ORACLE_NSEC
// en .env. Sin nsec, la app funciona igual y solo omite la publicacion.

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];

export async function publishVerdict(market) {
  const nsec = process.env.ORACLE_NSEC;
  if (!nsec) return { published: false, reason: "sin ORACLE_NSEC" };
  try {
    const { finalizeEvent } = await import("nostr-tools/pure");
    const { nip19 } = await import("nostr-tools"); // nip19 NO esta en /pure
    const { SimplePool } = await import("nostr-tools/pool");
    const sk = nsec.startsWith("nsec1") ? nip19.decode(nsec).data : Uint8Array.from(Buffer.from(nsec, "hex"));
    const v = market.verdict;
    const content =
      `🔮 EL ORÁCULO ha hablado\n\n` +
      `Apuesta: "${market.question}"\n` +
      `Veredicto: ${v.outcome.toUpperCase()} (confianza ${v.confianza})\n\n` +
      `${v.razonamiento}\n` +
      (v.fuentes?.length ? `\nFuentes:\n${v.fuentes.map((f) => `· ${f}`).join("\n")}\n` : "") +
      `\nBote repartido por Lightning ⚡ #ElOraculo #LightningHackathons`;
    const event = finalizeEvent(
      { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["t", "eloraculo"]], content },
      sk
    );
    const pool = new SimplePool();
    await Promise.any(pool.publish(RELAYS, event));
    pool.close(RELAYS);
    return { published: true, id: event.id };
  } catch (e) {
    console.warn(`[nostr] publicacion fallo: ${e.message}`);
    return { published: false, reason: e.message };
  }
}
