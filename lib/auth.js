// Login opcional con Nostr (NIP-07 en el cliente + NIP-98 de verificacion aqui).
// El servidor NUNCA confia en un pubkey "a secas": exige un evento kind 27235
// firmado y reciente. Si valida, emite un token HMAC stateless con caducidad.

import crypto from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TTL = 24 * 3600; // 24h
const MAX_SKEW = 60;   // segundos de tolerancia de reloj

/** Verifica un evento NIP-98 de login. Devuelve el pubkey (hex) o null. */
export function verifyNip98(event) {
  try {
    if (!event || event.kind !== 27235 || typeof event.pubkey !== "string") return null;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - (event.created_at || 0)) > MAX_SKEW) return null;
    const tag = (k) => event.tags?.find((t) => t[0] === k)?.[1];
    if ((tag("method") || "POST").toUpperCase() !== "POST") return null;
    const u = tag("u") || "";
    if (!u.includes("/api/nostr/login")) return null;
    if (!verifyEvent(event)) return null; // valida id + firma secp256k1
    return event.pubkey;
  } catch {
    return null;
  }
}

/** Token stateless: base64url(payload).hmac */
export function issueToken(pubkey) {
  const payload = Buffer.from(JSON.stringify({ pubkey, exp: Math.floor(Date.now() / 1000) + TTL })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Devuelve el pubkey verificado del token, o null si es invalido/caducado. */
export function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.pubkey || typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.pubkey;
  } catch {
    return null;
  }
}
