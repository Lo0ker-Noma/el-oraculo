// Utilidades de endurecimiento: cabeceras, rate limiting, validaciones.

export function securityHeaders(_req, res, next) {
  // script-src 'self' (sin unsafe-inline): el front no usa handlers inline.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      // relays Nostr: sólo para leer perfiles (kind 0) por WebSocket
      "connect-src 'self' wss://relay.primal.net wss://relay.damus.io wss://nos.lol wss://relay.nostr.band; " +
      "frame-ancestors 'none'; " +
      "base-uri 'none'; form-action 'self'; object-src 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

// rate limiting en memoria (sliding window por IP + ruta)
const buckets = new Map();
export function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ ok: false, error: "Demasiadas peticiones, prueba en un momento." });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const f = arr.filter((t) => now - t < 3_600_000);
    if (f.length) buckets.set(k, f);
    else buckets.delete(k);
  }
}, 600_000).unref();

/** Lightning address valida y NO apuntando a hosts internos (anti-SSRF basico). */
export function safeLnAddress(addr) {
  if (typeof addr !== "string" || !/^[^@\s]{1,64}@[^@\s]{1,253}\.[^@\s]{2,63}$/.test(addr)) return false;
  const domain = addr.split("@")[1].toLowerCase();
  if (domain === "localhost" || domain.endsWith(".local") || domain.endsWith(".internal")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1|172\.(1[6-9]|2\d|3[01])\.)/.test(domain)) return false;
  return true;
}

/** Solo URLs http(s) reales (evita javascript:, data:, etc. en las fuentes). */
export function sanitizeUrls(arr, max = 8) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((u) => typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u)).slice(0, max);
}

/** Recorta y normaliza texto de usuario. */
export function clean(str, maxLen) {
  return String(str ?? "").trim().slice(0, maxLen);
}
