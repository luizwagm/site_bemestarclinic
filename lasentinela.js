/* ==========================================================================
   lasentinela.js — CONECTOR do LA Sentinela para os sites do gerador
   (copie para a raiz do site: BemEstarClinic, Forms Fitness, Daniel's,
    Imobiliária, Kenósis, NYC, Óticas, Troféu, LA Publisher…)

   O que faz, sem depender de nada além do Node:
     1. CONTA cada requisição do site (hits, IPs únicos, faixas de status,
        tempo de resposta, caminhos e origens mais pedidos);
     2. LÊ os recursos do servidor (CPU/RAM/disco/uptime) e do processo;
     3. ENVIA de tempos em tempos um "beat" assinado para o gerenciador.

   IPs únicos por janela (hora/dia/semana/mês) são contados AQUI, com um mapa
   ip→últimoacesso: o gerenciador não teria como somar isso sem contar o mesmo
   visitante várias vezes. Só as contagens viajam — nenhum IP é enviado em
   lista, a não ser os poucos "mais ativos" que você pediu para ver.

   SEGURANÇA: cada beat é assinado com HMAC-SHA256 de (timestamp + corpo), com
   o segredo do site (o mesmo cadastrado no gerenciador). Nada é lido do site;
   o conector só ESCREVE para fora, então não abre porta nova de ataque.

   INSTALAÇÃO — 2 linhas no server.js do site. Veja INSTALAR.md.
   ========================================================================== */
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

const VERSAO_CONECTOR = "1.0";

function conectorSentinela(opts = {}) {
  const url = (opts.url || process.env.SENT_URL || "").replace(/\/+$/, "");
  const siteId = Number(opts.siteId || process.env.SENT_SITE || 0);
  const segredo = opts.segredo || process.env.SENT_SEGREDO || "";
  const intervaloMs = Math.max(15, Number(opts.intervaloS || process.env.SENT_INTERVALO || 60)) * 1000;
  const discoPath = opts.discoPath || process.cwd();
  const ligado = !!(url && siteId && segredo);

  if (!ligado) {
    console.warn("  ⚠ LA Sentinela: conector inativo (faltou url/siteId/segredo). Nada será enviado.");
  }

  /* ------------------- contadores da janela atual --------------------- */
  let janela = novaJanela();
  function novaJanela() {
    return { inicio: Date.now(), hits: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0,
      tempoSoma: 0, tempoN: 0, bytes: 0, ipsJanela: new Set(),
      paths: new Map(), refs: new Map(), ips: new Map() };
  }
  /* ip -> último acesso (ms), para as janelas deslizantes hora/dia/semana/mês */
  const ultimoIp = new Map();
  const TETO_IPS = 200_000;   // trava de memória para site muito movimentado

  const topN = (mapa, k) => { const v = (mapa.get(k) || 0) + 1; mapa.set(k, v); if (mapa.size > 4000) podar(mapa, 1000); };
  function podar(mapa, manter) {
    const ord = [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, manter);
    mapa.clear(); for (const [k, v] of ord) mapa.set(k, v);
  }
  const doMapa = (mapa, n = 20) => [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const ipDe = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.headers["x-real-ip"] || req.socket?.remoteAddress || "";

  /* --------------------------- contar() ------------------------------
     Chamar no TOPO do handler HTTP do site. Não interfere na resposta;
     apenas registra quando ela termina. */
  function contar(req, res) {
    if (!ligado) return;
    const t0 = Date.now();
    const ip = ipDe(req);
    let pathname = "/";
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { }
    const ref = String(req.headers["referer"] || req.headers["referrer"] || "");

    res.once("finish", () => {
      try {
        const j = janela;
        j.hits++;
        const st = res.statusCode || 0;
        if (st >= 500) j.s5xx++; else if (st >= 400) j.s4xx++; else if (st >= 300) j.s3xx++; else if (st >= 200) j.s2xx++;
        const dt = Date.now() - t0; j.tempoSoma += dt; j.tempoN++;
        const cl = Number(res.getHeader && res.getHeader("content-length")) || 0; if (cl) j.bytes += cl;
        if (ip) {
          j.ipsJanela.add(ip);
          if (ultimoIp.size < TETO_IPS || ultimoIp.has(ip)) ultimoIp.set(ip, Date.now());
          topN(j.ips, ip);
        }
        /* não polui os "top caminhos" com asset estático nem com o próprio beat */
        if (!/\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|map)$/i.test(pathname)) topN(j.paths, pathname.slice(0, 120));
        if (ref && !ref.includes(req.headers.host || "")) { try { topN(j.refs, new URL(ref).host.slice(0, 120)); } catch { } }
      } catch { /* medir nunca pode quebrar a resposta */ }
    });
  }

  /* -------------------- janelas deslizantes de IP --------------------- */
  function contagensJanela() {
    const agora = Date.now();
    const corte = agora - 30 * 24 * 3600_000;
    let online = 0, hora = 0, dia = 0, semana = 0, mes = 0;
    for (const [ip, t] of ultimoIp) {
      if (t < corte) { ultimoIp.delete(ip); continue; }   // passou de 30 dias: esquece
      const d = agora - t;
      if (d <= 5 * 60_000) online++;
      if (d <= 3600_000) hora++;
      if (d <= 24 * 3600_000) dia++;
      if (d <= 7 * 24 * 3600_000) semana++;
      mes++;                                               // sobreviveu ao corte = dentro de 30 dias
    }
    return { online, hora, dia, semana, mes };
  }

  /* ----------------------- recursos do servidor ---------------------- */
  function host() {
    let disco = { total: null, livre: null };
    try { const s = fs.statfsSync(discoPath); disco = { total: s.blocks * s.bsize, livre: s.bavail * s.bsize }; } catch { }
    const la = os.loadavg();
    return {
      hostname: os.hostname(), node: process.version,
      cpu1: la[0], cpu5: la[1], cpu15: la[2], ncpu: os.cpus().length,
      mem_total: os.totalmem(), mem_livre: os.freemem(),
      disco_total: disco.total, disco_livre: disco.livre, disco: [disco],
      uptime_s: Math.round(os.uptime()),
    };
  }

  /* ------------------------------ beat ------------------------------- */
  async function enviarBeat() {
    if (!ligado) return;
    const j = janela; janela = novaJanela();   // fecha a janela e começa outra
    const corpo = JSON.stringify({
      conector: VERSAO_CONECTOR,
      host: host(),
      proc: { rss: process.memoryUsage().rss, uptime_s: Math.round(process.uptime()) },
      acessos: {
        inicio: new Date(j.inicio).toISOString(), fim: new Date().toISOString(),
        hits: j.hits, ips_unicos: j.ipsJanela.size,
        s2xx: j.s2xx, s3xx: j.s3xx, s4xx: j.s4xx, s5xx: j.s5xx,
        tempo_med: j.tempoN ? j.tempoSoma / j.tempoN : null, bytes: j.bytes,
        top_paths: doMapa(j.paths), top_refs: doMapa(j.refs), top_ips: doMapa(j.ips, 12),
        janelas: contagensJanela(),
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = "sha256=" + crypto.createHmac("sha256", segredo).update(`${ts}.${corpo}`).digest("hex");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const r = await fetch(`${url}/api/sentinela/beat`, {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", "X-SENT-SITE": String(siteId), "X-SENT-TS": String(ts), "X-SENT-SIG": sig },
        body: corpo,
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); console.warn(`  ⚠ LA Sentinela: beat recusado (${r.status}) ${e.error || ""}`); }
    } catch (e) {
      /* gerenciador fora do ar não pode derrubar o site: só avisa e segue */
      if (process.env.SENT_DEBUG) console.warn("  ⚠ LA Sentinela: falha ao enviar beat:", e.message);
    } finally { clearTimeout(timer); }
  }

  let laco = null;
  function iniciar() {
    if (!ligado || laco) return;
    laco = setInterval(() => { enviarBeat().catch(() => {}); }, intervaloMs);
    if (laco.unref) laco.unref();
    /* primeiro beat rápido, para o site aparecer "vivo" logo após subir */
    setTimeout(() => { enviarBeat().catch(() => {}); }, 5000).unref?.();
    console.log(`  · LA Sentinela: conector ativo → ${url} (site ${siteId}, beat ${intervaloMs / 1000}s)`);
  }
  function parar() { if (laco) clearInterval(laco); laco = null; }

  if (ligado) iniciar();
  return { contar, enviarBeat, iniciar, parar, ativo: ligado };
}

module.exports = { conectorSentinela };
