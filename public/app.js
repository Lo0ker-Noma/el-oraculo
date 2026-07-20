const $ = (id) => document.getElementById(id);
let DEMO = true;
const selections = {}; // marketId -> 'si'|'no'
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

// --- Crear apuesta ---------------------------------------------------------

$("btnCreate").onclick = async () => {
  $("createMsg").textContent = "";
  try {
    await api("/api/markets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: $("q").value,
        description: $("desc").value,
        minutes_open: $("minOpen").value,
        minutes_resolve: $("minResolve").value,
      }),
    });
    $("q").value = $("desc").value = "";
    refresh();
  } catch (e) {
    $("createMsg").textContent = e.message;
  }
};

// --- Render ----------------------------------------------------------------

function render(markets) {
  $("modeBadge").textContent = DEMO
    ? "🧪 MODO DEMO — pagos simulados (configura NWC_URL para sats reales)"
    : "⚡ Wallet real conectada (NWC)";

  $("markets").innerHTML = markets.map((m) => {
    const p = m.pools;
    const siPct = p.total ? Math.round((p.si / p.total) * 100) : 50;
    const open = m.status === "open" && Date.now() / 1000 < m.closes_at;

    let body = "";
    if (m.status === "resolved" && m.verdict) {
      const v = m.verdict;
      body = `<div class="verdict">
        <div class="outcome ${v.outcome}">${v.outcome === "si" ? "✅ SÍ" : v.outcome === "no" ? "❌ NO" : "⚪ INDETERMINADO (devolución)"}
          <span class="muted" style="font-weight:400;font-size:.8rem"> · confianza ${v.confianza}${v.ai ? " · 🤖 investigado en la web" : ""}</span></div>
        <p>${esc(v.razonamiento)}</p>
        ${v.fuentes?.length ? `<div class="sources">Fuentes: ${v.fuentes.map((f) => `<a href="${esc(f)}" target="_blank" rel="noopener">${esc(short(f))}</a>`).join(" · ")}</div>` : ""}
        ${m.bets.some((b) => b.payout_sats > 0) ? `<div class="payouts">💸 Reparto: ${m.bets.filter((b) => b.payout_sats > 0).map((b) => `${fmt(b.payout_sats)} sats (${b.payout_status || "pendiente"})`).join(" · ")}</div>` : ""}
      </div>`;
    } else if (m.status === "resolving") {
      body = `<p class="resolving">🔮 El oráculo está investigando… (busca en la web, delibera y repartirá el bote)</p>`;
    } else if (open) {
      const sel = selections[m.id];
      body = `<div class="betForm">
        <div class="side">
          <button class="${sel === "si" ? "selSi" : ""}" onclick="pick('${m.id}','si')">SÍ</button>
          <button class="${sel === "no" ? "selNo" : ""}" onclick="pick('${m.id}','no')">NO</button>
        </div>
        <input type="number" id="sats-${m.id}" value="210" min="10" title="sats">
        <input type="text" id="ln-${m.id}" placeholder="tu-lightning@address (para cobrar si ganas)" ${DEMO ? "" : "required"}>
        <button class="gold" onclick="bet('${m.id}')">Apostar ⚡</button>
      </div>
      <p class="error" id="err-${m.id}"></p>`;
    } else {
      body = `<p class="muted">Apuestas cerradas. El oráculo resolverá en ${left(m.resolves_at)}. <button class="sec" onclick="resolveNow('${m.id}')">🔮 Resolver ahora</button></p>`;
    }

    return `<div class="card market">
      <div class="q">${esc(m.question)}</div>
      ${m.description ? `<div class="muted">${esc(m.description)}</div>` : ""}
      <div class="meta">${m.status === "resolved" ? "Resuelta" : m.status === "resolving" ? "Resolviendo…" : `Cierra en ${left(m.closes_at)} · resuelve en ${left(m.resolves_at)}`} · bote <b>${fmt(p.total)} sats</b> · ${p.apostadores} apuestas
      ${open ? ` · <button class="sec" style="padding:4px 10px;font-size:.75rem" onclick="resolveNow('${m.id}')">🔮 resolver ya</button>` : ""}</div>
      <div class="poolbar"><div class="si" style="width:${siPct}%"></div><div class="no" style="width:${100 - siPct}%"></div></div>
      <div class="pools"><span style="color:var(--green)">SÍ · ${fmt(p.si)} sats</span><span style="color:var(--red)">NO · ${fmt(p.no)} sats</span></div>
      ${body}
    </div>`;
  }).join("") || `<div class="card muted">No hay apuestas todavía. Crea la primera 👆</div>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (u) => u.replace(/^https?:\/\//, "").slice(0, 40);

window.pick = (id, side) => { selections[id] = side; refresh(); };

// --- Apostar + pagar -------------------------------------------------------

window.bet = async (id) => {
  const err = $(`err-${id}`);
  err.textContent = "";
  const side = selections[id];
  if (!side) { err.textContent = "Elige SÍ o NO primero."; return; }
  try {
    const j = await api(`/api/markets/${id}/bet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, sats: $(`sats-${id}`).value, lnaddress: $(`ln-${id}`).value }),
    });
    $("payTitle").textContent = `Apuesta ${side.toUpperCase()} · ${$(`sats-${id}`).value} sats`;
    $("payQr").src = j.qr;
    $("payInvoice").textContent = j.invoice;
    $("payStatus").textContent = j.demo ? "Modo demo: el pago se confirma solo en unos segundos…" : "Escanea y paga la invoice ⚡";
    $("payModal").classList.remove("hidden");
    payPoll = setInterval(async () => {
      const st = await api(`/api/markets/${id}/bet/${j.bet_id}`);
      if (st.paid) {
        $("payStatus").textContent = "✅ ¡Pagado! Estás dentro del bote.";
        clearInterval(payPoll);
        setTimeout(() => { closePay(); refresh(); }, 1200);
      }
    }, 1500);
  } catch (e) {
    err.textContent = e.message;
  }
};

window.closePay = () => { $("payModal").classList.add("hidden"); if (payPoll) clearInterval(payPoll); };

window.resolveNow = async (id) => {
  try { await api(`/api/markets/${id}/resolve`, { method: "POST" }); } catch {}
  refresh();
};

// --- Loop ------------------------------------------------------------------

async function refresh() {
  try {
    const j = await api("/api/markets");
    DEMO = j.demo;
    render(j.markets);
  } catch (e) {
    console.error(e);
  }
}
refresh();
setInterval(refresh, 4000);
