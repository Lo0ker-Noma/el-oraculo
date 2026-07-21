# 🔮 El Oráculo — guion del pitch (2-3 min)

> Repo: https://github.com/Lo0ker-Noma/el-oraculo · Demo local: `npm start` → localhost:5220

---

## 0 · Gancho (20 s) — *empieza SIN slides, mirando a la sala*

> «En el Hackathon #1 de esta serie gané un premio en sats. Y esa misma noche,
> en el bar, discutiendo si Bitcoin cerraba el mes por encima de X, alguien dijo:
> **"te apuesto 10.000 sats"**.
>
> Y nos quedamos callados. Porque… ¿quién decide quién ganó? ¿Quién guarda el bote?
> ¿Y si el que pierde no paga?
>
> Esa apuesta nunca se hizo. **El Oráculo es para que sí se haga.**»

## 1 · El problema (20 s)

> «Apostar entre amigos necesita dos cosas que el dinero de siempre no da:
> **un pago instantáneo que nadie pueda bloquear**, y **un árbitro que nadie pueda sobornar**.
>
> Las casas de apuestas resuelven lo segundo cobrándote comisión, pidiéndote el DNI
> y decidiendo ellas quién ganó. Eso no es arreglar el dinero: es alquilarlo.»

## 2 · La solución (25 s)

> «El Oráculo son apuestas sociales donde:
> **Lightning** pone los pagos —instantáneos, globales, sin cuentas—
> y **un agente de IA** pone el árbitro: investiga la respuesta con datos reales,
> **enseña sus fuentes** y reparte el bote él solo.
>
> Sin casa de apuestas. Sin árbitro humano. Sin confianza.»

## 3 · DEMO EN VIVO (60-70 s) — *el corazón, no lo saltes*

1. **Crear** — escribe: *"¿Bitcoin está ahora por encima de 50.000 dólares?"*
   Pon cierre y resolución con el **calendario**.
2. **Analizar** ⭐ — pulsa **"¿Qué probabilidad hay?"**
   > «Antes de apostar, el oráculo ya consulta datos reales y te dice la probabilidad. Con su fuente.»
3. **Apostar** — SÍ y NO, sale el **QR Lightning**, el bote sube en vivo.
   *(Invita a alguien de la sala a escanear.)*
4. **Resolver** — pulsa **"🔮 resolver ya"** y **narra mientras piensa**:
   > «Ahora el agente elige qué herramienta necesita, la ejecuta, y juzga.»
5. **Veredicto** — lee en alto el razonamiento y **señala la fuente**:
   > «Fíjate: no dice "confía en mí". Dice **de dónde** lo ha sacado.
   > Y el bote ya está pagado a la Lightning address del ganador.»

**Si hay tiempo (15 s) — la joya:** pregunta *"¿Va a llover hoy en Buenos Aires?"*
> «Miradlo: dice **INDETERMINADO** porque el día aún no ha acabado, y **devuelve las apuestas**.
> Un juez que sabe decir "no lo sé" vale más que uno que siempre sentencia.»

## 4 · Por qué está bien hecho (25 s) — *para Gorilatron*

> «Tres cosas de ingeniería:
> — El agente **usa herramientas de verdad**: CoinGecko, Open-Meteo, Wikipedia. Elige cuál, la ejecuta y cita.
> — **Todo degrada con elegancia**: sin wallet, modo demo; sin IA, veredicto simulado. Se puede evaluar sin una sola credencial.
> — Está **pentesteado**: CSP estricta, rate limiting, anti-SSRF, login Nostr verificado con firma NIP-98. Está en el `PENTEST.md`.»

## 5 · Cierre (20 s)

> «El Oráculo convierte un *"te apuesto una cerveza"* en un contrato que se cumple solo.
>
> Todo abierto, MIT, funcionando. Y lo mejor: el árbitro no se puede sobornar…
> porque enseña sus fuentes.
>
> **Que hable el oráculo.** ⚡🔮»

---

## Chuleta

**Si preguntan por la custodia del bote:**
> «Hoy el oráculo lo custodia mientras la apuesta vive, como cualquier quiniela.
> En el roadmap: hold-invoices y Cashu para no custodiar nada.»

**Si preguntan "¿y si la IA se equivoca?":**
> «Por eso enseña las fuentes: es auditable. Y ante la duda responde INDETERMINADO y
> devuelve el dinero. Siguiente paso: tres agentes independientes que voten —
> como el jurado de este hackathon.»

**Si preguntan por el coste:**
> «Cero. Las herramientas son APIs públicas gratis y el modelo va en free tier.»

**Si falla internet o la cuota:** arranca en **modo demo** — el flujo completo
(crear → apostar → bote → resolver → reparto) funciona igual. Ten una apuesta
ya resuelta en pantalla como plan B.

## Checklist antes de salir

- [ ] `npm start` y la web abierta en localhost:5220
- [ ] Cuota de Gemini disponible (20/día — **no la gastes ensayando**)
- [ ] Una apuesta ya resuelta visible como red de seguridad
- [ ] Wallet en el móvil por si alguien escanea el QR
- [ ] Repo abierto en otra pestaña
