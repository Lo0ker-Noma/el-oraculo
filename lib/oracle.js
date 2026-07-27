// El corazon del proyecto: el agente-oraculo.
// Investiga la pregunta con busqueda web real (server tool de Anthropic),
// decide el resultado y lo justifica con fuentes. Sin humano en el medio.

import { toolsDisponibles, runTool } from "./tools.js";

const SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["si", "no", "indeterminado"] },
    confianza: { type: "string", enum: ["alta", "media", "baja"] },
    razonamiento: { type: "string" },
    fuentes: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "confianza", "razonamiento", "fuentes"],
  additionalProperties: false,
};

const SYSTEM =
  "Eres EL ORACULO, un juez autonomo de apuestas sociales con dinero real (sats) en juego. " +
  "Tu unica tarea: determinar si la afirmacion de la apuesta resulto VERDADERA (si), FALSA (no) " +
  "o IMPOSIBLE DE VERIFICAR (indeterminado). Reglas:\n" +
  "1. USA la busqueda web para verificar hechos del mundo real. No respondas de memoria nada que pueda haber cambiado.\n" +
  "2. Se estrictamente literal con el texto de la apuesta. Si es ambigua o no hay evidencia clara, responde 'indeterminado' (se devuelven las apuestas).\n" +
  "3. En 'razonamiento' explica tu veredicto en 2-4 frases claras, en espanol.\n" +
  "4. En 'fuentes' lista las URLs concretas que sustentan el veredicto (vacio solo si es indeterminado o verificable sin web, p.ej. aritmetica).\n" +
  "5. Hay dinero de personas reales en juego: ante la duda, 'indeterminado' es mejor que un veredicto injusto.";

/**
 * Resuelve una apuesta. Devuelve {outcome, confianza, razonamiento, fuentes[], ai}.
 * Para RESOLUCIONES usamos Grok (Live Search) como principal; Gemini y Claude como respaldo.
 * (El analisis de probabilidad y las preguntas usan Gemini; ver mas abajo.)
 */
export async function resolveWithAI(market) {
  if (process.env.XAI_API_KEY || process.env.GROK_API_KEY) {
    const v = await resolveWithGrok(market);
    if (v) return v;
  }
  if (process.env.GEMINI_API_KEY) {
    const v = await resolveWithGemini(market);
    if (v) return v;
  }
  return resolveWithClaude(market);
}

function marketPrompt(market) {
  return (
    `APUESTA A RESOLVER (fecha actual: ${new Date().toISOString()}):\n` +
    `Pregunta: "${market.question}"\n` +
    (market.description ? `Contexto adicional: ${market.description}\n` : "") +
    `Creada: ${new Date(market.created_at * 1000).toISOString()}\n` +
    `Investiga lo necesario y emite tu veredicto.`
  );
}

// --- Gemini (Google) — agente con herramientas propias ----------------------
// El free tier de Gemini no incluye grounding con Google Search, asi que le
// damos NUESTRAS herramientas (lib/tools.js): el modelo decide que consultar,
// nosotros lo ejecutamos, y dictamina con la evidencia y sus URLs delante.

const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;

/** Cierra llaves/corchetes/comillas que quedaron abiertos (Gemini trunca el
 *  ultimo token a veces, incluso con finishReason=STOP). */
function cerrarJson(s) {
  let llaves = 0, corchetes = 0, enCadena = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { enCadena = !enCadena; continue; }
    if (enCadena) continue;
    if (ch === "{") llaves++;
    else if (ch === "}") llaves--;
    else if (ch === "[") corchetes++;
    else if (ch === "]") corchetes--;
  }
  let out = s.trimEnd();
  if (enCadena) out += '"';
  while (corchetes-- > 0) out += "]";
  while (llaves-- > 0) out += "}";
  return out;
}

async function geminiJSON(prompt, { model, key, timeout = 45000, intentos = 2 }) {
  let res, ultimoError = "";
  for (let i = 0; i < intentos; i++) {
    res = await fetch(GEMINI_URL(model, key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // maxOutputTokens generoso: estos modelos gastan tokens en "thinking"
        // y sin margen el JSON sale truncado.
        generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 8192 },
      }),
    });
    if (res.ok) break;
    ultimoError = (await res.text()).slice(0, 160);
    // 429: si es la cuota POR MINUTO reintentamos corto; si es la DIARIA no
    // tiene sentido esperar (y en serverless agotariamos el tiempo de funcion).
    const esDiaria = /PerDay|per day|RequestsPerDay/i.test(ultimoError);
    if (res.status === 429 && i < intentos - 1 && !esDiaria) {
      console.log("[oracle] Gemini 429 (por minuto), reintento en 5s...");
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (esDiaria) throw new Error("Gemini: cuota diaria del free tier agotada (20/día)");
    throw new Error(`Gemini ${res.status}: ${ultimoError}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const txt = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!txt) throw new Error(`Gemini sin texto (finishReason=${cand?.finishReason})`);
  // parseo robusto: recorta al objeto JSON y repara cierres si vino truncado
  const a = txt.indexOf("{");
  const slice = (a >= 0 ? txt.slice(a) : txt).replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(cerrarJson(slice));
    } catch (e) {
      throw new Error(`JSON invalido (${e.message}) · crudo: ${txt.slice(0, 400)}`);
    }
  }
}

/** Elige herramienta sin gastar cuota de IA en los casos evidentes.
 *  Devuelve null si no lo tiene claro (entonces decide el modelo). */
function planHeuristico(question) {
  const q = question.toLowerCase();
  const cripto = { bitcoin: /\bbtc\b|bitcoin/, ethereum: /\beth\b|ethereum/, solana: /\bsol\b|solana/ };
  for (const [id, re] of Object.entries(cripto)) {
    if (re.test(q) && /(precio|vale|cotiza|por encima|por debajo|supera|baja|sube|usd|eur|dólar|dolar|euro)/.test(q)) {
      const vs = /eur|euro/.test(q) ? "eur" : /ars|peso/.test(q) ? "ars" : "usd";
      return [{ herramienta: "precio_cripto", params: { id, vs } }];
    }
  }
  if (/(llover|lluvia|clima|tiempo|temperatura|grados|nieve|nevar)/.test(q)) {
    const m = question.match(/\ben\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-z][\wáéíóúñ]+){0,2})/);
    if (m) {
      // quitar coletillas temporales que se cuelan en el nombre del lugar
      const lugar = m[1].trim().replace(/\s+(mañana|hoy|ayer|pasado|próximo|proximo|semana|día|dia)$/i, "").trim();
      if (lugar) return [{ herramienta: "tiempo", params: { lugar } }];
    }
  }
  return null;
}

async function resolveWithGemini(market) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  try {
    // 1) que consultar: heuristica si es evidente (ahorra cuota), si no decide el modelo
    let llamadas = planHeuristico(market.question);
    if (llamadas) {
      console.log(`[oraculo] plan heuristico -> ${llamadas.map((c) => c.herramienta).join(", ")}`);
    } else {
      const catalogo = toolsDisponibles()
        .map((t) => `- ${t.name}: ${t.descripcion} params: ${JSON.stringify(t.params)}`)
        .join("\n");
      const plan = await geminiJSON(
        `${marketPrompt(market)}\n\nHerramientas disponibles:\n${catalogo}\n\n` +
          `Elige hasta 3 llamadas que te permitan verificar la apuesta con datos reales. ` +
          `Responde SOLO JSON: {"llamadas":[{"herramienta":"nombre","params":{}}]}`,
        { model, key }
      );
      llamadas = plan.llamadas || [];
    }

    // 2) las ejecutamos nosotros
    const evidencias = [];
    const fuentes = [];
    for (const c of llamadas.slice(0, 3)) {
      const r = await runTool(c.herramienta, c.params);
      evidencias.push(`[${c.herramienta}] ${r.dato}`);
      fuentes.push(...r.fuentes);
      console.log(`[oraculo] herramienta ${c.herramienta} -> ${r.ok ? "ok" : "fallo"}`);
    }

    // 3) veredicto con la evidencia delante
    const verdict = await geminiJSON(
      `${SYSTEM}\n\n${marketPrompt(market)}\n\n` +
        `EVIDENCIA RECOGIDA POR TUS HERRAMIENTAS (${new Date().toISOString()}):\n` +
        (evidencias.length ? evidencias.join("\n") : "(ninguna: no pudiste verificar nada)") +
        `\n\nFuentes citables: ${JSON.stringify(fuentes)}\n\n` +
        `Responde SOLO JSON: {"outcome":"si"|"no"|"indeterminado","confianza":"alta"|"media"|"baja","razonamiento":"...","fuentes":["url"]}`,
      { model, key }
    );

    if (!["si", "no", "indeterminado"].includes(verdict.outcome)) throw new Error("outcome invalido");
    verdict.confianza ||= "media";
    if (!verdict.fuentes?.length) verdict.fuentes = fuentes.slice(0, 6);
    return { ...verdict, ai: true, provider: "gemini" };
  } catch (e) {
    console.warn(`[oracle] Gemini fallo: ${e.message}`);
    return null;
  }
}

// --- Evidencia compartida (la usan veredicto, analisis y chat) --------------

async function recogerEvidencia(question, { model, key }) {
  let llamadas = planHeuristico(question);
  if (!llamadas) {
    const catalogo = toolsDisponibles()
      .map((t) => `- ${t.name}: ${t.descripcion} params: ${JSON.stringify(t.params)}`)
      .join("\n");
    try {
      const plan = await geminiJSON(
        `Pregunta: "${question}"\nFecha: ${new Date().toISOString()}\n\nHerramientas:\n${catalogo}\n\n` +
          `Elige hasta 2 llamadas útiles. SOLO JSON: {"llamadas":[{"herramienta":"nombre","params":{}}]}`,
        { model, key }
      );
      llamadas = plan.llamadas || [];
    } catch {
      llamadas = []; // sin cuota: seguimos sin evidencia
    }
  }
  const evidencias = [], fuentes = [];
  for (const c of llamadas.slice(0, 2)) {
    const r = await runTool(c.herramienta, c.params);
    evidencias.push(`[${c.herramienta}] ${r.dato}`);
    fuentes.push(...r.fuentes);
  }
  return { evidencias, fuentes };
}

/** Estima la probabilidad (0-100) de que la afirmacion resulte SI, con datos reales. */
export async function analizarProbabilidad(question) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  try {
    const { evidencias, fuentes } = await recogerEvidencia(question, { model, key });
    const r = await geminiJSON(
      `Eres EL ORACULO. Estima la probabilidad de que esta afirmacion resulte VERDADERA (SI).\n` +
        `AFIRMACION: "${question}"\nFecha actual: ${new Date().toISOString()}\n\n` +
        `EVIDENCIA DE TUS HERRAMIENTAS:\n${evidencias.join("\n") || "(ninguna: estima con cautela)"}\n\n` +
        `Fuentes citables: ${JSON.stringify(fuentes)}\n\n` +
        `Se honesto con la incertidumbre. No des consejos de inversion.\n` +
        `Responde SOLO JSON: {"probabilidad":0-100,"razonamiento":"maximo 2 frases","fuentes":["url"]}`,
      { model, key }
    );
    const p = Math.round(Number(r.probabilidad));
    if (!Number.isFinite(p)) throw new Error("probabilidad invalida");
    return {
      probabilidad: Math.max(0, Math.min(100, p)),
      razonamiento: String(r.razonamiento || "").slice(0, 600),
      fuentes: (r.fuentes?.length ? r.fuentes : fuentes).slice(0, 5),
      evidencias: evidencias.length,
    };
  } catch (e) {
    console.warn(`[oracle] analisis fallo: ${e.message}`);
    return null;
  }
}

/** Chat: responde una pregunta del usuario apoyandose en las herramientas. */
export async function preguntarOraculo(pregunta) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  try {
    const { evidencias, fuentes } = await recogerEvidencia(pregunta, { model, key });
    const r = await geminiJSON(
      `Eres EL ORACULO, un juez de apuestas que solo habla con datos. Responde en espanol, ` +
        `breve (maximo 4 frases), con tono sobrio y algo misterioso. NO des consejos de inversion.\n\n` +
        `PREGUNTA: "${pregunta}"\nFecha actual: ${new Date().toISOString()}\n\n` +
        `EVIDENCIA DE TUS HERRAMIENTAS:\n${evidencias.join("\n") || "(ninguna)"}\n\n` +
        `Fuentes citables: ${JSON.stringify(fuentes)}\n\n` +
        `Responde SOLO JSON: {"respuesta":"...","fuentes":["url"]}`,
      { model, key }
    );
    return {
      respuesta: String(r.respuesta || "").slice(0, 1200),
      fuentes: (r.fuentes?.length ? r.fuentes : fuentes).slice(0, 5),
    };
  } catch (e) {
    console.warn(`[oracle] chat fallo: ${e.message}`);
    return null;
  }
}

// --- Grok (xAI) — chat completions con Live Search nativo -------------------

async function resolveWithGrok(market) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  const model = process.env.GROK_MODEL || "grok-4.5";
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              SYSTEM +
              "\nResponde UNICAMENTE con un objeto JSON valido con esta forma exacta: " +
              `{"outcome":"si"|"no"|"indeterminado","confianza":"alta"|"media"|"baja","razonamiento":"...","fuentes":["url",...]}`,
          },
          { role: "user", content: marketPrompt(market) },
        ],
        search_parameters: { mode: "auto", return_citations: true },
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const verdict = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
    // citas de Live Search: si el modelo no puso fuentes, usa las del buscador
    const citations = data.citations || data.choices?.[0]?.message?.citations || [];
    if ((!verdict.fuentes || !verdict.fuentes.length) && citations.length) {
      verdict.fuentes = citations.slice(0, 6);
    }
    if (!["si", "no", "indeterminado"].includes(verdict.outcome)) throw new Error("outcome invalido");
    verdict.confianza ||= "media";
    verdict.fuentes ||= [];
    return { ...verdict, ai: true, provider: "grok" };
  } catch (e) {
    console.warn(`[oracle] Grok fallo: ${e.message}`);
    return null;
  }
}

// --- Claude (Anthropic) — web search server tool + JSON schema --------------

async function resolveWithClaude(market) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    return null;
  }
  try {
    const client = new Anthropic();
    let messages = [{ role: "user", content: marketPrompt(market) }];

    let response = await createCall(client, messages);
    // los server tools pueden pausar el turno; continuamos hasta terminar
    let guard = 0;
    while (response.stop_reason === "pause_turn" && guard++ < 5) {
      messages = [messages[0], { role: "assistant", content: response.content }];
      response = await createCall(client, messages);
    }
    if (response.stop_reason === "refusal") {
      return { outcome: "indeterminado", confianza: "baja", razonamiento: "El oraculo declino resolver esta apuesta.", fuentes: [], ai: true };
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const verdict = JSON.parse(text);
    return { ...verdict, ai: true, provider: "claude" };
  } catch (e) {
    console.warn(`[oracle] resolucion IA fallo: ${e.message}`);
    return null;
  }
}

function createCall(client, messages) {
  return client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages,
  });
}

/** Veredicto simulado para el modo demo sin credenciales. */
export function demoVerdict(market) {
  return {
    outcome: Math.random() < 0.5 ? "si" : "no",
    confianza: "media",
    razonamiento:
      "[MODO DEMO — sin credenciales de IA] Veredicto simulado al azar para demostrar el flujo completo " +
      "de resolucion y reparto del bote. Con una API key (Grok/xAI o Claude), el oraculo investiga en la web de verdad.",
    fuentes: [],
    ai: false,
  };
}
