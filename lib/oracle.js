// El corazon del proyecto: el agente-oraculo.
// Investiga la pregunta con busqueda web real (server tool de Anthropic),
// decide el resultado y lo justifica con fuentes. Sin humano en el medio.

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
 * Proveedores (en orden): Grok (XAI_API_KEY) -> Claude (ANTHROPIC_API_KEY) -> null.
 */
export async function resolveWithAI(market) {
  if (process.env.XAI_API_KEY || process.env.GROK_API_KEY) {
    const v = await resolveWithGrok(market);
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

// --- Grok (xAI) — chat completions con Live Search nativo -------------------

async function resolveWithGrok(market) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  const model = process.env.GROK_MODEL || "grok-4";
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
