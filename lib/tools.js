// Herramientas del oraculo: fuentes de verdad publicas y gratuitas (sin API key)
// que el agente elige y ejecuta para verificar una apuesta. Este es el "tool use"
// del agente: el modelo decide QUE consultar, nosotros lo ejecutamos y le
// devolvemos la evidencia con su URL para que cite.

const UA = { "User-Agent": "ElOraculo/1.0 (hackathon La Crypta)" };
const get = async (url, ms = 15000) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} en ${new URL(url).host}`);
  return r.json();
};

/** Catalogo que se le describe al modelo para que elija. */
export const TOOL_SPECS = [
  {
    name: "precio_cripto",
    descripcion: "Precio actual de una criptomoneda. Úsalo para apuestas sobre cotizaciones (BTC, ETH...).",
    params: { id: "id en CoinGecko, p.ej. bitcoin, ethereum, solana", vs: "moneda: usd, eur, ars" },
  },
  {
    name: "tiempo",
    descripcion: "Predicción/registro meteorológico de un lugar (lluvia, temperatura máx/mín) para una fecha.",
    params: { lugar: "ciudad, p.ej. Buenos Aires", fecha: "YYYY-MM-DD (hoy si se omite)" },
  },
  {
    name: "wikipedia",
    descripcion: "Resumen enciclopédico de un tema/persona/evento. Para hechos estables, no para datos de hoy.",
    params: { consulta: "término a buscar" },
  },
  {
    name: "busqueda_web",
    descripcion: "Búsqueda web general con resultados y fuentes. Úsala para noticias, deportes y cualquier hecho reciente.",
    params: { consulta: "qué buscar" },
  },
];

// --- Implementaciones -------------------------------------------------------

async function precio_cripto({ id = "bitcoin", vs = "usd" }) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}&include_last_updated_at=true`;
  const d = await get(url);
  const row = d[id];
  if (!row) throw new Error(`CoinGecko no conoce "${id}"`);
  return {
    dato: `${id} = ${row[vs]} ${vs.toUpperCase()}`,
    actualizado: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString() : null,
    fuente: `https://www.coingecko.com/en/coins/${id}`,
  };
}

async function tiempo({ lugar, fecha }) {
  const g = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(lugar)}&count=1&language=es`);
  const loc = g.results?.[0];
  if (!loc) throw new Error(`No encuentro el lugar "${lugar}"`);
  const day = fecha || new Date().toISOString().slice(0, 10);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&start_date=${day}&end_date=${day}`;
  const d = await get(url);
  const i = 0;
  return {
    dato:
      `${loc.name} (${loc.country}) el ${day}: lluvia ${d.daily.precipitation_sum?.[i]} mm ` +
      `(prob. máx ${d.daily.precipitation_probability_max?.[i]}%), ` +
      `máx ${d.daily.temperature_2m_max?.[i]}°C / mín ${d.daily.temperature_2m_min?.[i]}°C`,
    fuente: `https://open-meteo.com/en/docs?latitude=${loc.latitude}&longitude=${loc.longitude}`,
  };
}

async function wikipedia({ consulta }) {
  const s = await get(`https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(consulta)}&format=json&srlimit=1&origin=*`);
  const hit = s.query?.search?.[0];
  if (!hit) throw new Error(`Wikipedia no encuentra "${consulta}"`);
  const title = hit.title;
  const sum = await get(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  return {
    dato: `${title}: ${(sum.extract || "").slice(0, 700)}`,
    fuente: sum.content_urls?.desktop?.page || `https://es.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

/** Búsqueda web general — requiere TAVILY_API_KEY (free tier, opcional). */
async function busqueda_web({ consulta }) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("busqueda_web no disponible (falta TAVILY_API_KEY)");
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ api_key: key, query: consulta, max_results: 5, search_depth: "basic" }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const d = await r.json();
  const items = (d.results || []).slice(0, 5);
  if (!items.length) throw new Error("sin resultados");
  return {
    dato: items.map((x, i) => `${i + 1}. ${x.title}: ${(x.content || "").slice(0, 220)}`).join("\n"),
    fuente: items.map((x) => x.url),
  };
}

const IMPL = { precio_cripto, tiempo, wikipedia, busqueda_web };

export function toolsDisponibles() {
  return TOOL_SPECS.filter((t) => t.name !== "busqueda_web" || process.env.TAVILY_API_KEY);
}

/** Ejecuta una herramienta. Devuelve {ok, dato, fuentes[]} sin lanzar. */
export async function runTool(name, params = {}) {
  const fn = IMPL[name];
  if (!fn) return { ok: false, dato: `herramienta desconocida: ${name}`, fuentes: [] };
  try {
    const r = await fn(params || {});
    const fuentes = Array.isArray(r.fuente) ? r.fuente : r.fuente ? [r.fuente] : [];
    return { ok: true, dato: r.dato + (r.actualizado ? ` (dato de ${r.actualizado})` : ""), fuentes };
  } catch (e) {
    return { ok: false, dato: `error en ${name}: ${e.message}`, fuentes: [] };
  }
}
