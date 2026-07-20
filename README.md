# 🔮 El Oráculo

**Apuestas sociales con bote Lightning, resueltas por un agente de IA — sin
casa de apuestas, sin árbitro humano, sin confianza.**

Cualquiera crea una apuesta (*"¿BTC cierra hoy por encima de 100.000 USD?"*,
*"¿llueve mañana en Buenos Aires?"*). La gente entra pagando sats al bote
(SÍ o NO). Cuando llega la hora, **un agente autónomo investiga la respuesta
en la web real, dicta veredicto con sus fuentes, lo publica en Nostr y
reparte el bote a los ganadores por Lightning**. Nadie puede hacer trampas y
nadie custodia nada más que el oráculo mismo.

Proyecto para el reto **🤖 AI Agents — Bots & Automation** de los
[Lightning Hackathons 2026 de La Crypta](https://hackaton.lacrypta.ar/).

## ¿Esto arregla el dinero?

Los mercados de predicción necesitan dos cosas que el dinero fiat no da:
**pagos instantáneos sin fronteras ni cuentas** (Lightning) y **un árbitro
neutral que nadie pueda sobornar** (un agente de IA que muestra sus fuentes).
El Oráculo junta las dos: mercados de predicción entre amigos, comunidades o
desconocidos, con liquidación en segundos y resolución verificable. Es la
pieza que convierte "te apuesto una cerveza" en un contrato que se cumple solo.

## Probar en 30 segundos (sin wallet, sin API keys)

```bash
git clone https://github.com/Lo0ker-Noma/el-oraculo
cd el-oraculo
npm install
npm start        # -> http://localhost:5220
```

Sin configurar nada arranca en **MODO DEMO**: las invoices se "pagan" solas a
los segundos y el veredicto se simula — todo el flujo (crear → apostar → bote
→ resolución → reparto) es evaluable sin credenciales.

### Modo real

Crea un `.env` (ver `.env.example`):

| Variable | Qué habilita |
|---|---|
| `NWC_URL` | Wallet del oráculo (Alby/LNbits/LaWallet vía [NWC](https://nwc.dev)). Cobra las apuestas de verdad y **paga los premios** a la Lightning address de cada ganador. |
| `XAI_API_KEY` | **(recomendado)** El agente investiga con **Live Search de Grok (xAI)** y cita las fuentes. |
| `ANTHROPIC_API_KEY` | Alternativa: **Claude Opus 4.8** + web search server tool + salida con schema. |
| `ORACLE_NSEC` | Identidad Nostr del oráculo: publica cada veredicto como nota pública (kind 1). |
| `SESSION_SECRET` | Firma los tokens del **login opcional con Nostr** (NIP-07). Si falta, se genera aleatorio al arrancar. |

Cada pieza degrada con elegancia: puedes activar solo la que quieras.

## Cómo decide el oráculo

El agente recibe la pregunta y la fecha, y opera con reglas de juez:

1. **Busca en la web** (hasta 6 búsquedas) — nunca responde de memoria algo que pueda haber cambiado.
2. Es **estrictamente literal** con el texto de la apuesta.
3. Ante ambigüedad o falta de evidencia → **INDETERMINADO** y se devuelven las apuestas.
4. Devuelve un veredicto estructurado: `{outcome, confianza, razonamiento, fuentes[]}` (salida JSON con schema, no texto libre).

El reparto: los ganadores se llevan **todo el bote** pro-rata a su apuesta.
Si nadie acierta o es indeterminado, devolución íntegra.

## Arquitectura

```
crear apuesta ─▶ server.js (Express + vigilante cada 20s)
apostar SÍ/NO ─▶ invoice NWC al bote ─▶ confirmación por lookup
   ⏰ llega la hora ─▶ lib/oracle.js   · Claude Opus 4.8 + web_search + JSON schema
                    ─▶ lib/store.js    · cálculo de reparto pro-rata
                    ─▶ lib/wallet.js   · payInvoice a cada Lightning address ganadora
                    ─▶ lib/nostr.js    · publica el veredicto (kind 1)
frontend: vanilla HTML/CSS/JS · QR de pago · estado en vivo
```

- **Stack:** Node + Express, `@getalby/sdk` (NWC), `@getalby/lightning-tools`
  (Lightning address → invoice), `@anthropic-ai/sdk`, `nostr-tools`, `qrcode`.
- **Sin DB**: estado en `data/markets.json`, inspeccionable a mano.
- El botón **"🔮 resolver ya"** dispara la resolución al instante (perfecto
  para demos en vivo).

## Identidad (opcional) y seguridad

- **Login con Nostr (NIP-07):** puedes apostar anónimamente, o conectarte con tu
  extensión (Alby, nos2x…) para que tus apuestas queden atribuidas a tu `npub`.
  No se confía en un pubkey a secas: el cliente firma un evento **NIP-98** que el
  servidor verifica antes de emitir un token de sesión.
- **Endurecido y pentesteado:** CSP estricta, rate limiting, validación de
  entrada, anti-SSRF en las Lightning addresses y anti-XSS en las fuentes del
  veredicto. Detalle completo en **[PENTEST.md](./PENTEST.md)**.

## Limitaciones honestas (MVP de hackathon)

- El oráculo custodia el bote mientras la apuesta está viva (como toda quiniela).
  Roadmap: hold invoices / cashu para minimizar custodia.
- Resolución = 1 agente. Roadmap: 3 agentes independientes votan (como el jurado
  de este hackathon 😉).
- Apuestas binarias SÍ/NO. Roadmap: múltiples resultados y odds dinámicas.

## Licencia

MIT — hecho con 🔮⚡ por LookerLABS para La Crypta.
