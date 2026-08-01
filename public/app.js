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

// --- Perfiles Nostr (kind 0): resolver el seudónimo desde relays -------------
const PROFILE_RELAYS = ["wss://purplepag.es", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.nostr.band", "wss://relay.damus.io"];
const profileCache = {}; // hexpubkey -> nombre (string) | null (en curso)

// Decodifica un npub bech32 a pubkey hex (sin dependencias).
function npubToHex(npub) {
  try {
    const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    if (!npub || !npub.startsWith("npub1")) return null;
    const data = npub.slice(5);
    const vals = [];
    for (const c of data) { const i = CH.indexOf(c); if (i < 0) return null; vals.push(i); }
    const words = vals.slice(0, -6); // quita el checksum (6 chars)
    let acc = 0, bits = 0; const bytes = [];
    for (const w of words) {
      acc = (acc << 5) | w; bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
    }
    if (bytes.length !== 32) return null;
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

// Nombre a mostrar: si ya tenemos el perfil, el seudónimo; si no, dispara la
// carga en segundo plano y de momento devuelve el npub corto.
function displayName(npub, pubkeyHex) {
  const hex = pubkeyHex || (npub ? npubToHex(npub) : null);
  if (hex && typeof profileCache[hex] === "string") return profileCache[hex];
  if (hex && profileCache[hex] === undefined) resolveProfile(hex);
  return shortNpub(npub);
}

function resolveProfile(hex) {
  if (!hex || profileCache[hex] !== undefined) return;
  profileCache[hex] = null; // marca "en curso"
  let resuelto = false;
  for (const url of PROFILE_RELAYS) {
    let ws;
    try { ws = new WebSocket(url); } catch { continue; }
    const id = "p" + Math.random().toString(36).slice(2, 8);
    const cerrar = () => { try { ws.close(); } catch {} };
    ws.onopen = () => { try { ws.send(JSON.stringify(["REQ", id, { authors: [hex], kinds: [0], limit: 1 }])); } catch {} };
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d[0] === "EVENT" && d[2]?.kind === 0) {
        try {
          const meta = JSON.parse(d[2].content || "{}");
          const nm = String(meta.display_name || meta.displayName || meta.name || "").trim();
          if (nm && !resuelto) { resuelto = true; profileCache[hex] = nm; repintarNombres(); }
        } catch {}
        cerrar();
      } else if (d[0] === "EOSE") { cerrar(); }
    };
    ws.onerror = cerrar;
    setTimeout(cerrar, 6000);
  }
}

// Repinta las zonas donde aparecen seudónimos cuando llega un perfil.
function repintarNombres() {
  try { renderAuth(); } catch {}
  try { if (lastMarkets.length) render(lastMarkets); } catch {}
  // el modal de detalle se pinta una sola vez: hay que rehacerlo si sigue abierto
  try { if (detalleAbierto) detalle(detalleAbierto); } catch {}
}
const httpOnly = (u) => /^https?:\/\//i.test(u);

// Lightning address recordada en el navegador: se autorrellena en todas las
// apuestas sin necesidad de conectar Nostr ni volver a teclearla.
const LN_KEY = "oraculo_lnaddress";
const lnGuardada = () => { try { return localStorage.getItem(LN_KEY) || ""; } catch { return ""; } };
const recordarLn = (v) => {
  v = String(v || "").trim();
  try { if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) localStorage.setItem(LN_KEY, v); } catch {}
};

// Retorno pari-mutuel: si tu lado gana, el bote se reparte a prorrata.
// Con x sats en el lado S: multiplicador = (bote+x) / (lado_S + x).
const estimarRetorno = (p, side, x) => {
  x = Math.max(0, Math.floor(Number(x) || 0));
  const lado = side === "si" ? p.si : p.no;
  const total = p.total + x, ladoTot = lado + x;
  if (!x || !ladoTot) return null;
  return { mult: total / ladoTot, payout: Math.round((x * total) / ladoTot) };
};
function retornoTexto(m) {
  const s = selections[m.id];
  if (!s) return `<span class="muted">Elige SÍ o NO para ver tu retorno estimado.</span>`;
  const x = Number(drafts[m.id]?.sats ?? 210);
  const e = estimarRetorno(m.pools, s, x);
  if (!e) return `<span class="muted">Indica cuántos sats quieres apostar.</span>`;
  return `Si ganas cobrarías <b>~${fmt(e.payout)} sats</b> ` +
    `<span class="muted">· ×${e.mult.toFixed(2)} por sat (apuestas ${fmt(x)} a ${s.toUpperCase()})</span>`;
}

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
  if (auth) { b.textContent = "🟣 " + displayName(auth.npub, auth.pubkey); b.title = "Conectado — click para desconectar"; }
  else { b.textContent = "⚡ Conéctate con Nostr"; b.title = ""; }
}

// --- Crear apuesta ---------------------------------------------------------

let createSide = null; // lado de la apuesta inicial (opcional) al crear

async function createMarket() {
  $("createMsg").textContent = "";
  try {
    const j = await api("/api/markets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: $("q").value, description: $("desc").value,
        closes_at: $("closesAt").value, resolves_at: $("resolvesAt").value,
      }),
    });
    $("q").value = $("desc").value = "";
    $("analisisBox").classList.add("hidden");
    // ¿el creador puso una apuesta inicial? → la colocamos ya (abre el pago)
    if (createSide) {
      const sats = Math.floor(Number($("cSats").value) || 210);
      const ln = $("cLn").value.trim();
      await apostar(j.market.id, createSide, sats, ln, null);
      createSide = null;
      $("cSi")?.classList.remove("selSi"); $("cNo")?.classList.remove("selNo");
    }
    refresh(true);
  } catch (e) {
    $("createMsg").textContent = e.message;
  }
}

// --- Render ----------------------------------------------------------------

function saveDrafts() {
  document.querySelectorAll('input[id^="sats-"]').forEach((el) => { (drafts[el.id.slice(5)] ||= {}).sats = el.value; });
  document.querySelectorAll('input[id^="ln-"]').forEach((el) => { (drafts[el.id.slice(3)] ||= {}).ln = el.value; recordarLn(el.value); });
}

function marketCard(m) {
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
        <span class="muted" style="font-weight:400;font-size:.8rem"> · confianza ${esc(v.confianza)}${v.ai ? ` · 🤖 investigado por ${esc(v.provider || "IA")}` : ""}</span></div>
      <p>${esc(v.razonamiento)}</p>
      ${fuentes.length ? `<div class="sources">Fuentes: ${fuentes.map((f) => `<a href="${esc(f)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(f))}</a>`).join(" · ")}</div>` : ""}
      ${m.bets.some((b) => b.payout_sats > 0) ? `<div class="payouts">💸 Reparto: ${m.bets.filter((b) => b.payout_sats > 0).map((b) => `${b.npub ? esc(displayName(b.npub)) + " " : ""}${fmt(b.payout_sats)} sats (${esc(b.payout_status || "pendiente")})`).join(" · ")}</div>` : ""}
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
        <input type="number" id="sats-${m.id}" value="${esc(d.sats ?? 210)}" min="10" max="10000000" title="sats a apostar"> <span class="muted">sats</span>
        <input type="text" id="ln-${m.id}" maxlength="253" value="${esc(d.ln ?? lnGuardada())}" placeholder="tu-lightning@address (para cobrar si ganas)" ${DEMO ? "" : "required"}>
        <button class="glass-btn gold" data-action="bet" data-id="${m.id}">Apostar ⚡</button>
      </div>
      <div class="retorno" id="ret-${m.id}">${retornoTexto(m)}</div>
    </div>
    <p class="error" id="err-${m.id}"></p>`;
  } else {
    body = `<p class="muted">Apuestas cerradas. El oráculo resolverá en ${left(m.resolves_at)}.</p>`;
  }

  const estado = m.status === "resolved" ? "Resuelta" : m.status === "resolving" ? "Resolviendo…"
    : open ? `Cierra en ${left(m.closes_at)} · resuelve en ${left(m.resolves_at)}` : "Cerrada, esperando resolución";
  return `<div class="card glass market">
    <div class="q">${esc(m.question)}</div>
    ${m.description ? `<div class="muted">${esc(m.description)}</div>` : ""}
    <div class="meta">${estado} · bote <b>${fmt(p.total)} sats</b> · ${p.apostadores} apuestas</div>
    <div class="poolbar"><div class="si" style="width:${siPct}%"></div><div class="no" style="width:${100 - siPct}%"></div></div>
    <div class="pools"><span class="green">SÍ · ${fmt(p.si)} sats</span><span class="red">NO · ${fmt(p.no)} sats</span></div>
    ${body}
    <div class="cardActions"><button class="linkbtn" data-action="detalle" data-id="${m.id}">🔍 Ver detalle · quién ha apostado</button></div>
  </div>`;
}

function render(markets) {
  saveDrafts();
  $("modeBadge").textContent = DEMO
    ? "🧪 MODO DEMO — pagos simulados (configura NWC_URL para sats reales)"
    : "⚡ Wallet real conectada (NWC)";

  const abiertas = markets.filter((m) => m.status === "open" || m.status === "resolving");
  const cerradas = markets.filter((m) => m.status === "resolved");
  $("marketsOpen").innerHTML = abiertas.map(marketCard).join("") ||
    `<div class="card glass muted">No hay apuestas abiertas. Crea la primera 👆</div>`;
  $("marketsClosed").innerHTML = cerradas.map(marketCard).join("") ||
    `<div class="card glass muted">Todavía no hay apuestas resueltas.</div>`;
  const ct = document.querySelector(".closedTitle");
  if (ct) ct.style.display = cerradas.length ? "" : "none";
  if (adminUnlocked) renderAdmin(markets);
}

// --- Acciones (delegacion de eventos, sin handlers inline) -----------------

function pick(id, side) { saveDrafts(); selections[id] = side; render(lastMarkets); }

// Núcleo: crea la invoice de la apuesta y abre el modal de pago (real o demo).
async function apostar(id, side, sats, lnaddress, errEl) {
  if (errEl) errEl.textContent = "";
  try {
    const j = await api(`/api/markets/${id}/bet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, sats, lnaddress: lnaddress || "", token: auth?.token }),
    });
    $("payTitle").textContent = `Apuesta ${side.toUpperCase()} · ${fmt(sats)} sats`;
    $("payQr").src = j.qr;
    $("payInvoice").textContent = j.invoice;
    $("payStatus").textContent = j.demo ? "🧪 Modo demo: el pago se confirma solo en unos segundos…" : "Escanea y paga la invoice con tu wallet ⚡";
    $("payModal").classList.remove("hidden");
    // Sondeo rapido para que el pago se note casi al instante. Se evita
    // solapar peticiones si alguna tarda mas que el intervalo.
    let comprobando = false;
    const mirarPago = async () => {
      if (comprobando) return;
      comprobando = true;
      try {
        const st = await api(`/api/markets/${id}/bet/${j.bet_id}`);
        if (st.paid) {
          clearInterval(payPoll);
          $("payStatus").textContent = "✅ ¡Pagado! Estás dentro del bote.";
          setTimeout(() => { closePay(); refresh(true); }, 900);
        }
      } catch {} finally { comprobando = false; }
    };
    payPoll = setInterval(mirarPago, 700);
    mirarPago();
  } catch (e) {
    if (errEl) errEl.textContent = e.message;
    else $("createMsg").textContent = e.message;
  }
}

async function bet(id) {
  saveDrafts();
  const err = $(`err-${id}`);
  if (err) err.textContent = "";
  const side = selections[id];
  if (!side) { if (err) err.textContent = "Elige SÍ o NO primero."; return; }
  apostar(id, side, (drafts[id]?.sats) || 210, drafts[id]?.ln || "", err);
}

function closePay() { $("payModal").classList.add("hidden"); if (payPoll) clearInterval(payPoll); }

async function resolveNow(id) {
  try { await api(`/api/markets/${id}/resolve`, { method: "POST" }); } catch (e) { console.warn(e.message); }
  refresh(true);
}

// --- Detalle de una apuesta (quién ha apostado) ----------------------------

let detalleAbierto = null; // id del mercado mostrado en el modal de detalle

// Los nombres de Nostr llegan de forma asincrona: mientras el modal este
// abierto, lo repintamos periodicamente para que aparezcan sin cerrar y abrir.
setInterval(() => { if (detalleAbierto) { try { detalle(detalleAbierto); } catch {} } }, 1500);

function detalle(id) {
  const m = lastMarkets.find((x) => x.id === id);
  if (!m) return;
  detalleAbierto = id;
  const p = m.pools;
  const bets = m.bets || [];
  const filas = bets.length
    ? bets.map((b) => `<div class="betDetailRow">
        <span class="pill ${b.side}">${b.side === "si" ? "SÍ" : "NO"}</span>
        <span class="bdSats">${fmt(b.sats)} sats</span>
        <span class="bdWho">${b.npub ? "🟣 " + esc(displayName(b.npub)) : "<span class=\"muted\">anónimo</span>"}</span>
        ${b.payout_sats > 0 ? `<span class="green">+${fmt(b.payout_sats)} sats</span>` : ""}
      </div>`).join("")
    : `<p class="muted">Aún no hay apuestas pagadas en el bote.</p>`;
  $("detailTitle").textContent = m.question;
  $("detailBody").innerHTML =
    `<div class="detailMeta">Bote <b>${fmt(p.total)} sats</b> · ${p.apostadores} apuesta(s) pagadas · <span class="green">SÍ ${fmt(p.si)}</span> / <span class="red">NO ${fmt(p.no)}</span></div>
     <div class="betDetailList">${filas}</div>
     <p class="muted bdNote">🟣 = apostó identificándose con Nostr. El resto son anónimos (apostar no requiere login).</p>`;
  $("detailModal").classList.remove("hidden");
}
function closeDetail() { $("detailModal").classList.add("hidden"); detalleAbierto = null; }

// --- Admin (contraseña) -----------------------------------------------------

let adminUnlocked = false;
let adminPass = "";

async function adminLogin() {
  const pass = $("adminPass").value;
  $("adminMsg").textContent = "";
  try {
    const j = await api("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin: pass }),
    });
    if (!j.ok) throw new Error("Contraseña incorrecta.");
    adminUnlocked = true; adminPass = pass;
    try { sessionStorage.setItem("oraculo_admin", pass); } catch {}
    $("adminLocked").classList.add("hidden");
    $("adminPanel").classList.remove("hidden");
    renderAdmin(lastMarkets);
  } catch (e) {
    $("adminMsg").textContent = e.message;
  }
}

function adminLogout() {
  adminUnlocked = false; adminPass = "";
  try { sessionStorage.removeItem("oraculo_admin"); } catch {}
  $("adminPanel").classList.add("hidden");
  $("adminLocked").classList.remove("hidden");
  $("adminPass").value = "";
}

function renderAdmin(markets) {
  $("adminMarkets").innerHTML = markets.map((m) => `
    <div class="adminItem">
      <div class="adminQ">${esc(m.question)}<br><span class="muted">${m.status} · bote ${fmt(m.pools.total)} sats · ${m.pools.apostadores} apuestas</span></div>
      <div class="adminBtns">
        ${m.status === "open" ? `<button class="glass-btn sm" data-action="admresolve" data-id="${m.id}">🔮 Resolver ya</button>` : ""}
        <button class="glass-btn sm danger" data-action="admdelete" data-id="${m.id}">🗑 Borrar</button>
      </div>
    </div>`).join("") || `<p class="muted">No hay apuestas.</p>`;
}

async function adminResolve(id) {
  const el = document.querySelector(`[data-action="admresolve"][data-id="${id}"]`);
  if (el) { el.disabled = true; el.textContent = "🔮 Resolviendo…"; }
  try {
    await api(`/api/markets/${id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin: adminPass }),
    });
  } catch (e) { alert("No se pudo resolver: " + e.message); }
  refresh(true);
}

async function adminDelete(id) {
  const m = lastMarkets.find((x) => x.id === id);
  if (!confirm(`¿Borrar la apuesta "${m ? m.question : id}"? No se puede deshacer.`)) return;
  try {
    await api(`/api/admin/markets/${id}/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin: adminPass }),
    });
  } catch (e) { alert("No se pudo borrar: " + e.message); }
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
  refrescarPickers();
}
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => fijarPlazo(Number(b.dataset.preset)))
);

// --- Calendario propio (formato inequívoco, semana EU lunes-primero) --------

const DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const parseVal = (v) => (v ? new Date(v) : null);
const fmtLbl = (d) =>
  d ? `${DIAS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "—";

function crearPicker(id) {
  const input = $(id), btn = $(id + "_btn"), lbl = $(id + "_lbl");
  const seccion = document.getElementById("crear");
  let pop = null, ver = new Date(); // mes visible

  const reservar = () => { if (pop && seccion) seccion.style.paddingBottom = pop.offsetHeight + 28 + "px"; };
  const cerrar = () => {
    if (pop) { pop.remove(); pop = null; document.removeEventListener("click", fuera, true); }
    if (seccion) seccion.style.paddingBottom = "";
  };
  const fuera = (e) => { if (pop && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) cerrar(); };

  let elegido = null; // seleccion en curso (dia + hora), no se aplica hasta "Guardar"

  function pintar() {
    const hoy = new Date();
    const y = ver.getFullYear(), mo = ver.getMonth();
    const primero = new Date(y, mo, 1);
    const offset = (primero.getDay() + 6) % 7; // lunes = 0
    const dias = new Date(y, mo + 1, 0).getDate();
    const hh = String(elegido.getHours()).padStart(2, "0");
    const mm = String(elegido.getMinutes()).padStart(2, "0");
    let celdas = "";
    for (let i = 0; i < offset; i++) celdas += `<span class="cal-d empty"></span>`;
    for (let d = 1; d <= dias; d++) {
      const cls = ["cal-d"];
      if (elegido.getFullYear() === y && elegido.getMonth() === mo && elegido.getDate() === d) cls.push("sel");
      if (hoy.getFullYear() === y && hoy.getMonth() === mo && hoy.getDate() === d) cls.push("hoy");
      celdas += `<button type="button" class="${cls.join(" ")}" data-d="${d}">${d}</button>`;
    }
    pop.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-nav="-1">‹</button>
        <b>${MESES[mo]} ${y}</b>
        <button type="button" class="cal-nav" data-nav="1">›</button>
      </div>
      <div class="cal-dows">${DIAS.map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="cal-grid">${celdas}</div>
      <div class="cal-time"><span>🕒 Hora</span><input type="time" class="cal-hora" value="${hh}:${mm}"></div>
      <button type="button" class="cal-save" data-save>✓ Guardar</button>`;
    reservar();
  }

  // fija en "elegido" la hora tecleada, para que sobreviva a los repintados
  function sincronizarHora() {
    const hora = pop.querySelector(".cal-hora");
    if (!hora || !hora.value) return;
    const [hh, mm] = hora.value.split(":");
    elegido.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
  }

  function guardar() {
    sincronizarHora();
    input.value = paraInput(elegido);
    lbl.textContent = fmtLbl(elegido);
    cerrar();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop) return cerrar();
    elegido = parseVal(input.value) || new Date();
    ver = new Date(elegido);
    pop = document.createElement("div");
    pop.className = "cal-pop";
    pop.setAttribute("role", "dialog");
    btn.parentElement.appendChild(pop);
    pintar();
    setTimeout(() => document.addEventListener("click", fuera, true), 0);
    pop.addEventListener("click", (ev) => {
      const nav = ev.target.closest("[data-nav]");
      const dia = ev.target.closest("[data-d]");
      if (ev.target.closest("[data-save]")) { guardar(); return; }
      if (nav) {
        sincronizarHora();
        ver = new Date(ver.getFullYear(), ver.getMonth() + Number(nav.dataset.nav), 1);
        pintar();
      } else if (dia) {
        sincronizarHora(); // conserva la hora ya tecleada
        elegido.setFullYear(ver.getFullYear(), ver.getMonth(), Number(dia.dataset.d));
        pintar(); // solo resalta el dia; NO cierra
      }
    });
  });

  return { refresh: () => (lbl.textContent = fmtLbl(parseVal(input.value))) };
}

const PICKERS = ["closesAt", "resolvesAt"].map(crearPicker);
function refrescarPickers() { PICKERS.forEach((p) => p.refresh()); }

fijarPlazo(15); // por defecto: cierra en 15 min, resuelve 5 min después

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

// --- Acceso: QR para la sala ------------------------------------------------

async function cargarAcceso() {
  try {
    const j = await api("/api/acceso");
    $("accesoQr").src = j.qr;
    $("accesoUrl").textContent = j.url;
    $("accesoNota").textContent = j.local
      ? "⚠️ Esta dirección es local: solo funciona en tu red. Para el pitch, expón el servidor con un túnel (o define PUBLIC_URL) y el QR se actualizará solo."
      : "Cualquiera con este código puede entrar y probarlo ahora mismo.";
  } catch {
    $("accesoUrl").textContent = "no disponible";
  }
}
cargarAcceso();

// listeners (una sola vez)
$("btnAnalizar").addEventListener("click", analizar);
$("btnChat").addEventListener("click", preguntar);
// Enter envia; Shift+Enter hace salto de linea
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); preguntar(); }
});
$("btnCreate").addEventListener("click", createMarket);
if ($("cLn")) $("cLn").value = lnGuardada(); // autorrellenar Lightning address recordada
$("payClose").addEventListener("click", closePay);
$("detailClose").addEventListener("click", closeDetail);
$("nostrBtn").addEventListener("click", () => { if (auth) { auth = null; renderAuth(); } else nostrLogin(); });
$("adminUnlock").addEventListener("click", adminLogin);
$("adminLock").addEventListener("click", adminLogout);
$("adminPass").addEventListener("keydown", (e) => { if (e.key === "Enter") adminLogin(); });
// recuperar sesión de admin si estaba abierta
try { const ap = sessionStorage.getItem("oraculo_admin"); if (ap) { $("adminPass").value = ap; adminLogin(); } } catch {}

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
  if (el) {
    const { action, id, side } = el.dataset;
    if (action === "pick") pick(id, side);
    else if (action === "bet") bet(id);
    else if (action === "resolve") resolveNow(id);
    else if (action === "detalle") detalle(id);
    else if (action === "admresolve") adminResolve(id);
    else if (action === "admdelete") adminDelete(id);
    return;
  }
  // botones de la apuesta inicial (al crear)
  const cs = e.target.closest("[data-cstake]");
  if (cs) {
    createSide = createSide === cs.dataset.cstake ? null : cs.dataset.cstake;
    $("cSi")?.classList.toggle("selSi", createSide === "si");
    $("cNo")?.classList.toggle("selNo", createSide === "no");
  }
});

// retorno estimado en vivo + recordar la Lightning address al teclearla
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.id) return;
  if (el.id.startsWith("sats-")) {
    const id = el.id.slice(5);
    (drafts[id] ||= {}).sats = el.value;
    const r = $(`ret-${id}`), m = lastMarkets.find((x) => x.id === id);
    if (r && m) r.innerHTML = retornoTexto(m);
  } else if (el.id.startsWith("ln-") || el.id === "cLn") {
    recordarLn(el.value);
  }
});

// --- Loop ------------------------------------------------------------------

const disparadas = new Set(); // para no lanzar dos veces la misma resolución

async function refresh(force = false) {
  try {
    const j = await api("/api/markets");
    DEMO = j.demo;
    lastMarkets = j.markets;
    // en serverless no hay temporizador en el servidor: disparamos lo vencido
    for (const id of j.pendientes || []) {
      if (!disparadas.has(id)) { disparadas.add(id); resolveNow(id); }
    }
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
