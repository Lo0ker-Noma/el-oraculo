const $ = (id) => document.getElementById(id);
let DEMO = true;
let auth = null; // { token, npub, pubkey }
const selections = {}; // marketId -> 'si'|'no'
const drafts = {};     // marketId -> {sats, ln}
let lastMarkets = [];
let lastSig = "";
let payPoll = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const fmt = (n) => n.toLocaleString("es-ES");
const left = (ts) => {
  const s = ts - Date.now() / 1000;
  if (s <= 0) return "ya";
  if (s < 90) return `${Math.ceil(s)}s`;
  return `${Math.ceil(s / 60)} min`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortUrl = (u) => u.replace(/^https?:\/\//, "").slice(0, 40);
const shortNpub = (n) => (n ? n.slice(0, 9) + "…" + n.slice(-4) : "");
const httpOnly = (u) => /^https?:\/\//i.test(u);

// --- Login opcional con Nostr (NIP-07) -------------------------------------

async function nostrLogin() {
  if (!window.nostr) {
    alert("No detecto una extensión Nostr (NIP-07). Instala Alby o nos2x y recarga.");
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    const event = await window.nostr.signEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", location.origin + "/api/nostr/login"], ["method", "POST"]],
      content: "",
    });
    const j = await api("/api/nostr/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    });
    auth = { token: j.token, npub: j.npub, pubkey: j.pubkey };
    renderAuth();
  } catch (e) {
    console.warn("login cancelado/fallido:", e.message);
  }
}

function renderAuth() {
  const b = $("nostrBtn");
  if (auth) { b.textContent = "🟣 " + shortNpub(auth.npub); b.title = "Conectado — click para desconectar"; }
  else { b.textContent = "⚡ Conéctate con Nostr"; b.title = ""; }
}

// --- Crear apuesta ---------------------------------------------------------

async function createMarket() {
  $("createMsg").textContent = "";
  try {
    await api("/api/markets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: $("q").value, description: $("desc").value,
        closes_at: $("closesAt").value, resolves_at: $("resolvesAt").value,
      }),
    });
    $("q").value = $("desc").value = "";
    $("analisisBox").classList.add("hidden");
    refresh(true);
  } catch (e) {
    $("createMsg").textContent = e.message;
  }
}

// --- Render ----------------------------------------------------------------

function saveDrafts() {
  document.querySelectorAll('input[id^="sats-"]').forEach((el) => { (drafts[el.id.slice(5)] ||= {}).sats = el.value; });
  document.querySelectorAll('input[id^="ln-"]').forEach((el) => { (drafts[el.id.slice(3)] ||= {}).ln = el.value; });
}

function render(markets) {
  saveDrafts();
  $("modeBadge").textContent = DEMO
    ? "🧪 MODO DEMO — pagos simulados (configura NWC_URL para sats reales)"
    : "⚡ Wallet real conectada (NWC)";

  $("markets").innerHTML = markets.map((m) => {
    const p = m.pools;
    const siPct = p.total ? Math.round((p.si / p.total) * 100) : 50;
    const open = m.status === "open" && Date.now() / 1000 < m.closes_at;
    const d = drafts[m.id] || {};

    let body = "";
    if (m.status === "resolved" && m.verdict) {
      const v = m.verdict;
      const fuentes = (v.fuentes || []).filter(httpOnly);
      body = `<div class="verdict">
        <div class="outcome ${esc(v.outcome)}">${v.outcome === "si" ? "✅ SÍ" : v.outcome === "no" ? "❌ NO" : "⚪ INDETERMINADO (devolución)"}
          <span class="muted" style="font-weight:400;font-size:.8rem"> · confianza ${esc(v.confianza)}${v.ai ? ` · 🤖 investigado en la web (${esc(v.provider || "IA")})` : ""}</span></div>
        <p>${esc(v.razonamiento)}</p>
        ${fuentes.length ? `<div class="sources">Fuentes: ${fuentes.map((f) => `<a href="${esc(f)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(f))}</a>`).join(" · ")}</div>` : ""}
        ${m.bets.some((b) => b.payout_sats > 0) ? `<div class="payouts">💸 Reparto: ${m.bets.filter((b) => b.payout_sats > 0).map((b) => `${b.npub ? esc(shortNpub(b.npub)) + " " : ""}${fmt(b.payout_sats)} sats (${esc(b.payout_status || "pendiente")})`).join(" · ")}</div>` : ""}
      </div>`;
    } else if (m.status === "resolving") {
      body = `<p class="resolving">🔮 El oráculo está investigando… (busca en la web, delibera y repartirá el bote)</p>`;
    } else if (open) {
      const sel = selections[m.id];
      body = `<div class="betBox">
        <div class="betLabel">Tu apuesta:</div>
        <div class="side">
          <button class="glass-btn ${sel === "si" ? "selSi" : ""}" data-action="pick" data-id="${m.id}" data-side="si">SÍ</button>
          <button class="glass-btn ${sel === "no" ? "selNo" : ""}" data-action="pick" data-id="${m.id}" data-side="no">NO</button>
        </div>
        <div class="betRow">
          <input type="number" id="sats-${m.id}" value="${esc(d.sats ?? 210)}" min="10" max="10000000" title="sats"> <span class="muted">sats</span>
          <input type="text" id="ln-${m.id}" maxlength="253" value="${esc(d.ln ?? "")}" placeholder="tu-lightning@address (para cobrar si ganas)" ${DEMO ? "" : "required"}>
          <button class="glass-btn gold" data-action="bet" data-id="${m.id}">Apostar ⚡</button>
        </div>
      </div>
      <p class="error" id="err-${m.id}"></p>`;
    } else {
      body = `<p class="muted">Apuestas cerradas. El oráculo resolverá en ${left(m.resolves_at)}. <button class="glass-btn sm" data-action="resolve" data-id="${m.id}">🔮 Resolver ahora</button></p>`;
    }

    return `<div class="card glass market">
      <div class="q">${esc(m.question)}</div>
      ${m.description ? `<div class="muted">${esc(m.description)}</div>` : ""}
      <div class="meta">${m.status === "resolved" ? "Resuelta" : m.status === "resolving" ? "Resolviendo…" : open ? `Cierra en ${left(m.closes_at)} · resuelve en ${left(m.resolves_at)}` : "Cerrada"} · bote <b>${fmt(p.total)} sats</b> · ${p.apostadores} apuestas${open ? ` · <button class="linkbtn" data-action="resolve" data-id="${m.id}">🔮 resolver ya</button>` : ""}</div>
      <div class="poolbar"><div class="si" style="width:${siPct}%"></div><div class="no" style="width:${100 - siPct}%"></div></div>
      <div class="pools"><span class="green">SÍ · ${fmt(p.si)} sats</span><span class="red">NO · ${fmt(p.no)} sats</span></div>
      ${body}
    </div>`;
  }).join("") || `<div class="card glass muted">No hay apuestas todavía. Crea la primera 👆</div>`;
}

// --- Acciones (delegacion de eventos, sin handlers inline) -----------------

function pick(id, side) { saveDrafts(); selections[id] = side; render(lastMarkets); }

async function bet(id) {
  saveDrafts();
  const err = $(`err-${id}`);
  if (err) err.textContent = "";
  const side = selections[id];
  if (!side) { if (err) err.textContent = "Elige SÍ o NO primero."; return; }
  const sats = (drafts[id]?.sats) || 210;
  try {
    const j = await api(`/api/markets/${id}/bet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, sats, lnaddress: drafts[id]?.ln || "", token: auth?.token }),
    });
    $("payTitle").textContent = `Apuesta ${side.toUpperCase()} · ${sats} sats`;
    $("payQr").src = j.qr;
    $("payInvoice").textContent = j.invoice;
    $("payStatus").textContent = j.demo ? "🧪 Modo demo: el pago se confirma solo en unos segundos…" : "Escanea y paga la invoice con tu wallet ⚡";
    $("payModal").classList.remove("hidden");
    payPoll = setInterval(async () => {
      const st = await api(`/api/markets/${id}/bet/${j.bet_id}`);
      if (st.paid) {
        $("payStatus").textContent = "✅ ¡Pagado! Estás dentro del bote.";
        clearInterval(payPoll);
        setTimeout(() => { closePay(); refresh(true); }, 1200);
      }
    }, 1500);
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

function closePay() { $("payModal").classList.add("hidden"); if (payPoll) clearInterval(payPoll); }

async function resolveNow(id) {
  try { await api(`/api/markets/${id}/resolve`, { method: "POST" }); } catch (e) { console.warn(e.message); }
  refresh(true);
}

// --- Calendario: valores por defecto y atajos ------------------------------

const paraInput = (d) => {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 16);
};
function fijarPlazo(minutos) {
  const cierre = new Date(Date.now() + minutos * 60000);
  const resol = new Date(cierre.getTime() + Math.max(5, Math.round(minutos * 0.2)) * 60000);
  $("closesAt").value = paraInput(cierre);
  $("resolvesAt").value = paraInput(resol);
}
fijarPlazo(15); // por defecto: cierra en 15 min, resuelve 5 min después
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => fijarPlazo(Number(b.dataset.preset)))
);

// --- Análisis de probabilidad ----------------------------------------------

async function analizar() {
  const box = $("analisisBox"), btn = $("btnAnalizar");
  const question = $("q").value.trim();
  box.classList.remove("hidden");
  if (question.length < 6) { box.innerHTML = `<span class="muted">Escribe primero la pregunta.</span>`; return; }
  btn.disabled = true;
  box.innerHTML = `<span class="muted">🔮 Consultando fuentes reales…</span>`;
  try {
    const j = await api("/api/analizar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const p = j.probabilidad;
    const color = p >= 60 ? "var(--green)" : p <= 40 ? "var(--red)" : "var(--violet)";
    box.innerHTML =
      `<div class="probRow"><div class="probNum" style="color:${color}">${p}%</div>
         <div class="probTxt"><b>de probabilidad de que salga SÍ</b><br><span class="muted">${esc(j.razonamiento)}</span></div></div>
       <div class="probBar"><div style="width:${p}%;background:${color}"></div></div>` +
      (j.fuentes?.length ? `<div class="sources">Fuentes: ${j.fuentes.filter(httpOnly).map((f) => `<a href="${esc(f)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(f))}</a>`).join(" · ")}</div>` : "");
  } catch (e) {
    box.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// --- Chat con el oráculo ----------------------------------------------------

function mensaje(texto, clase) {
  const d = document.createElement("div");
  d.className = "msg " + clase;
  d.textContent = texto;
  $("chatLog").appendChild(d);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return d;
}

async function preguntar() {
  const inp = $("chatInput"), pregunta = inp.value.trim();
  if (pregunta.length < 3) return;
  mensaje(pregunta, "yo");
  inp.value = "";
  const pensando = mensaje("🔮 consultando…", "oraculo pensando");
  try {
    const j = await api("/api/preguntar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pregunta }),
    });
    pensando.className = "msg oraculo";
    pensando.textContent = j.respuesta;
    const f = (j.fuentes || []).filter(httpOnly);
    if (f.length) {
      const s = document.createElement("div");
      s.className = "sources";
      s.innerHTML = "Fuentes: " + f.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(u))}</a>`).join(" · ");
      pensando.appendChild(s);
    }
  } catch (e) {
    pensando.className = "msg oraculo";
    pensando.textContent = "⚠️ " + e.message;
  }
}

// listeners (una sola vez)
$("btnAnalizar").addEventListener("click", analizar);
$("btnChat").addEventListener("click", preguntar);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") preguntar(); });
$("btnCreate").addEventListener("click", createMarket);
$("payClose").addEventListener("click", closePay);
$("nostrBtn").addEventListener("click", () => { if (auth) { auth = null; renderAuth(); } else nostrLogin(); });

// contadores de caracteres
[["q", "qCount", 160], ["desc", "descCount", 280]].forEach(([i, c, max]) => {
  const inp = $(i), cnt = $(c);
  if (!inp || !cnt) return;
  const upd = () => (cnt.textContent = `${inp.value.length}/${max}`);
  inp.addEventListener("input", upd); upd();
});
// fallback si falta el logo
const _nl = $("navLogo");
if (_nl) _nl.addEventListener("error", () => { _nl.classList.add("hidden"); const eye = document.querySelector(".brand .eye"); if (eye) eye.style.display = "inline"; });
const _hl = $("heroLogo");
if (_hl) _hl.addEventListener("error", () => _hl.classList.add("hidden"));

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id, side } = el.dataset;
  if (action === "pick") pick(id, side);
  else if (action === "bet") bet(id);
  else if (action === "resolve") resolveNow(id);
});

// --- Loop ------------------------------------------------------------------

async function refresh(force = false) {
  try {
    const j = await api("/api/markets");
    DEMO = j.demo;
    lastMarkets = j.markets;
    const sig = DEMO + "|" + JSON.stringify(j.markets);
    if (!force && sig === lastSig) return; // nada cambió: no repintar (no borrar el formulario)
    lastSig = sig;
    render(j.markets);
  } catch (e) {
    console.error(e);
  }
}
renderAuth();
refresh(true);
setInterval(() => refresh(false), 4000);
