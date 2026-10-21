/* ==========================================================================
   testar-carrossel.cjs — várias fotos e vídeos por matéria do Feed (site 1.33.0)

   O PEDIDO: "no feed, permita a opção de inserir mais de uma mídia por feed
   (ilimitado), e quando tiver mais de 1 mídia, mostrar no site como
   carrossel".

   O QUE ESTA SUÍTE GUARDA
     1. O servidor só aceita mídia NOSSA (foto/vídeo enviados pelo painel).
     2. Publicado: matéria com 3 mídias abre com carrossel na ordem certa (a
        capa primeiro), a lista mostra o selo "3", e a de uma mídia só fica
        como sempre foi.
     3. No navegador: setas, contador, pontos e teclado andam juntos; trocar de
        slide pausa o vídeo; a foto em pé cabe inteira na moldura; o celular
        não ganha barra lateral; e o painel envia várias fotos de uma vez,
        muda a ordem e tira mídia — salvando na hora.

   RODA NUMA CÓPIA do projeto: o "Publicar" reescreve o index.html e o blog/,
   e os envios gravam em assets/. O banco do site nasce novo dentro da cópia;
   o /restrito (PostgreSQL) só é aberto na subida, nada é gravado nele. Sem
   Chrome, a seção 3 é pulada e diz que foi.

     node testar-carrossel.cjs
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* 5341: longe da 5185 (o site) e das portas das suítes dos outros projetos. */
const PORTA = Number(process.env.PORTA_TESTE_CARROSSEL) || 5341;
const BASE = `http://127.0.0.1:${PORTA}`;
const DEP = PORTA + 1000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bemestar-carrossel-"));
const COPIA = path.join(TMP, "site");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0; const falhas = [];
function certo(nome, cond, detalhe = "") {
  if (cond) { ok++; console.log(`  ok   ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
/* A cópia: tudo menos dados, backups, envios e dependências (estas vêm da
   pasta real por NODE_PATH — apagar a cópia nunca alcança o node_modules). */
function copiarProjeto() {
  const fora = /^(node_modules|data|backups|\.git|\.claude)$|^assets[\\/]video$|^assets[\\/]img[\\/]uploads$|^restrito[\\/]arquivos$/;
  fs.cpSync(__dirname, COPIA, { recursive: true, filter: (src) => !fora.test(path.relative(__dirname, src)) });
}
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  console.log("\n=== Várias mídias por matéria do Feed (carrossel) ===\n");
  copiarProjeto();
  const servidor = spawn(process.execPath, ["server.js"], {
    cwd: COPIA,
    env: { ...process.env, NODE_PATH: path.join(__dirname, "node_modules"), PORT: String(PORTA), BACKUP_HORAS: "100000",
      CHAT_URL: "", CHAT_SEGREDO_PASSE: "", SENT_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  servidor.stdout.on("data", (d) => (log += d));
  servidor.stderr.on("data", (d) => (log += d));
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "bemestar-carrossel-chrome-"));
  const VIDEOS = path.join(COPIA, "assets", "video");
  let chrome = null;
  try {
    let vivo = false;
    /* até 60 s: a subida espera o PostgreSQL do /restrito e o tratamento de imagem */
    for (let i = 0; i < 240 && !vivo; i++) { try { await fetch(BASE + "/"); vivo = true; } catch { await espera(250); } }
    if (!vivo) throw new Error("o servidor não subiu:\n" + log.slice(-800));
    const ent = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bemestar-admin" }) });
    const sid = (ent.headers.get("set-cookie") || "").split(";")[0].split("=")[1];
    const A = "sid=" + sid;
    const api = async (rota, metodo = "GET", corpo, cookie = A) => {
      const r = await fetch(BASE + rota, { method: metodo, headers: { cookie, "content-type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    };
    const posts = async () => (await api("/api/content")).j.posts || [];
    const foto = async (nome) => (await api("/api/upload", "POST", { name: nome, dataUrl: PNG_1X1 })).j.path;
    fs.mkdirSync(VIDEOS, { recursive: true });
    const hoje = new Date().toISOString().slice(0, 10);

    /* ------------------------------------------------------------ 1. recusas */
    await api("/api/posts", "POST", { title: "Zz Qa Base", excerpt: "x", date: hoje });
    const idBase = (await posts()).find((p) => p.title === "Zz Qa Base").id;
    const recusa = async (midias) => (await api(`/api/posts/${idBase}`, "PUT", { midias: JSON.stringify(midias) })).status;
    certo("link javascript: → recusado", await recusa([{ tipo: "foto", url: "javascript:alert(1)" }]) === 400);
    certo("foto fora da pasta (../) → recusada", await recusa([{ tipo: "foto", url: "/assets/img/uploads/../../server.js" }]) === 400);
    certo("foto de outro site → recusada", await recusa([{ tipo: "foto", url: "https://exemplo.test/x.jpg" }]) === 400);
    certo("tipo que não é foto nem vídeo → recusado", await recusa([{ tipo: "pdf", url: "/assets/video/x.mp4" }]) === 400);
    certo("JSON torto → recusado", (await api(`/api/posts/${idBase}`, "PUT", { midias: "{nao" })).status === 400);
    certo("…e nada disso chegou ao banco", !((await posts()).find((p) => p.id === idBase) || {}).midias);
    certo("sem sessão → 401", (await api(`/api/posts/${idBase}`, "PUT", { midias: "[]" }, "sid=nada")).status === 401);
    await api(`/api/posts/${idBase}`, "DELETE");

    /* O vídeo sai POR FAIXA (1.33.0): sem isso, o vídeo do carrossel não deixa
       avançar e o iPhone, que pede "bytes=0-1" antes de tudo, não toca. */
    const amostra = Buffer.alloc(5000); for (let i = 0; i < amostra.length; i++) amostra[i] = i % 251;
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-faixa.mp4"), amostra);
    const U = BASE + "/assets/video/zz-qa-faixa.mp4";
    const r0 = await fetch(U, { headers: { range: "bytes=0-1" } });
    const b0 = Buffer.from(await r0.arrayBuffer());
    certo("vídeo: Range bytes=0-1 → 206 com 2 bytes e Content-Range", r0.status === 206 && b0.length === 2 && r0.headers.get("content-range") === "bytes 0-1/5000", `${r0.status} ${r0.headers.get("content-range")}`);
    const r1 = await fetch(U, { headers: { range: "bytes=-500" } });
    certo("vídeo: Range de sufixo → os últimos 500 bytes, certos", r1.status === 206 && Buffer.from(await r1.arrayBuffer()).equals(amostra.subarray(4500)));
    certo("vídeo: Range fora do arquivo → 416", (await fetch(U, { headers: { range: "bytes=9000-" } })).status === 416);
    const r3 = await fetch(U);
    certo("vídeo: sem Range → 200 inteiro, com Content-Length e Accept-Ranges", r3.status === 200 && Buffer.from(await r3.arrayBuffer()).equals(amostra)
      && r3.headers.get("content-length") === "5000" && r3.headers.get("accept-ranges") === "bytes");
    certo("a página continua saindo inteira", (await (await fetch(BASE + "/")).text()).includes("</html>"));
    fs.unlinkSync(path.join(VIDEOS, "zz-qa-faixa.mp4"));

    /* ------------------------------------------------------------ 2. publicado */
    const f1 = await foto("capa.png"), f2 = await foto("terceira.png");
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-feed.mp4"), Buffer.alloc(3000, 1));
    await api("/api/posts", "POST", { title: "Zz Qa Semana do Bem-Estar", excerpt: "Com fotos e vídeo.", content: "<p>Texto.</p>", image: f1, date: hoje,
      midias: JSON.stringify([{ tipo: "video", url: "/assets/video/zz-qa-feed.mp4" }, { tipo: "foto", url: f2 }]) });
    await api("/api/posts", "POST", { title: "Zz Qa Uma Foto Só", excerpt: "Só a capa.", content: "<p>Texto.</p>", image: await foto("unica.png"), date: hoje });
    const idVarias = (await posts()).find((p) => p.title === "Zz Qa Semana do Bem-Estar").id;
    const pub = await api("/api/publish", "POST");
    certo("publicado", pub.status === 200, JSON.stringify(pub.j).slice(0, 200));
    const ler = (rel) => fs.readFileSync(path.join(COPIA, rel), "utf8");
    const pag = ler("blog/zz-qa-semana-do-bem-estar/index.html");
    const itens = [...pag.matchAll(/<div class="carrossel__item"[^>]*>\s*<(img|video) src="([^"]+)"([^>]*)>/g)].map((m) => ({ src: m[2], resto: m[3] }));
    certo("a matéria abre com um carrossel de 3 mídias, a capa primeiro", pag.includes("data-carrossel") && itens.length === 3
      && itens[0].src === f1 && itens[1].src === "/assets/video/zz-qa-feed.mp4" && itens[2].src === f2, JSON.stringify(itens));
    certo("só a primeira foto carrega de cara; a outra espera", /fetchpriority="high"/.test(itens[0] && itens[0].resto) && /loading="lazy"/.test(itens[2] && itens[2].resto));
    certo("o vídeo não baixa nada antes do play e mostra a capa da clínica", /preload="none"/.test(itens[1] && itens[1].resto) && /poster="\/assets\/img\/capa-video\.svg"/.test(itens[1] && itens[1].resto));
    const unica = ler("blog/zz-qa-uma-foto-so/index.html");
    certo("matéria de uma foto só fica como sempre foi (sem carrossel)", !unica.includes("data-carrossel") && /<figure class="post__cover( post__cover--reserva)?"><img/.test(unica));
    const lista = ler("blog/index.html");
    const cartao = (slug) => (new RegExp(`href="/blog/${slug}/" tabindex="-1" aria-hidden="true">(.*?)<img`, "s").exec(lista) || [])[1] ?? "(não achei)";
    certo("na lista, o cartão da matéria com 3 mídias leva o selo \"3\"", /<span class="post-card__qtd" aria-label="3 fotos e vídeos">3<\/span>/.test(cartao("zz-qa-semana-do-bem-estar")), cartao("zz-qa-semana-do-bem-estar"));
    certo("…e o de uma foto só, não", cartao("zz-qa-uma-foto-so") === "", cartao("zz-qa-uma-foto-so"));

    /* ------------------------------------------------------------ 3. navegador */
    const CHROME = [process.env.CHROME,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((c) => { try { return fs.existsSync(c); } catch { return false; } });
    if (!CHROME) { console.log("  · navegador pulado: não achei o Chrome (defina CHROME=<caminho>)"); return; }
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${DEP}`, `--user-data-dir=${perfil}`, "about:blank"], { stdio: "ignore" });
    let alvos = null;
    for (let i = 0; i < 60 && !alvos; i++) { try { alvos = await (await fetch(`http://127.0.0.1:${DEP}/json/list`)).json(); } catch { await espera(250); } }
    const ws = new WebSocket(alvos.find((a) => a.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const esp = new Map(); const eventos = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && esp.has(m.id)) { esp.get(m.id)(m); esp.delete(m.id); } else if (m.method) eventos.push(m);
    });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; esp.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const na = async (expr, gesto = false) => {
      const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesto });
      if (r.result.exceptionDetails) throw new Error("no navegador: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result?.value;
    };
    const ate = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await na(expr)) return true; await espera(200); } return false; };
    await cdp("Page.enable");
    await cdp("Network.enable");
    await cdp("Network.setCookie", { name: "sid", value: sid, url: BASE });
    await cdp("Page.navigate", { url: BASE + "/privacidade/" });
    await ate(`document.readyState === "complete"`);

    /* Um vídeo de verdade (o falso não toca), para provar a pausa; e uma foto
       EM PÉ de verdade, para provar que ela cabe inteira na moldura. */
    const webm = await na(`(async () => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 180; const g = c.getContext("2d");
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
      const partes = []; rec.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
      const t0 = performance.now(); rec.start(200);
      await new Promise((ok) => { const tq = setInterval(() => { g.fillStyle = "hsl(" + ((performance.now() - t0) / 10 % 360) + ",80%,50%)"; g.fillRect(0, 0, 320, 180);
        if (performance.now() - t0 > 3000) { clearInterval(tq); ok(); } }, 33); });
      rec.stop(); await new Promise((r) => (rec.onstop = r));
      const b = new Blob(partes, { type: "video/webm" });
      return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.split(",")[1]); f.readAsDataURL(b); });
    })()`);
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-feed.mp4"), Buffer.from(webm, "base64"));
    const emPe = await na(`(() => { const c = document.createElement("canvas"); c.width = 600; c.height = 900; const g = c.getContext("2d"); g.fillStyle = "#0B4EA2"; g.fillRect(0, 0, 600, 900); return c.toDataURL("image/png").split(",")[1]; })()`);
    fs.writeFileSync(path.join(COPIA, f2.replace(/^\//, "")), Buffer.from(emPe, "base64"));   // a 3ª mídia passa a ser uma foto em pé

    const estado = `(() => { const c = document.querySelector("[data-carrossel]"); const t = c.querySelector(".carrossel__trilho");
      return { cont: c.querySelector(".carrossel__contador")?.textContent, ant: c.querySelector(".carrossel__seta--ant")?.disabled,
        prox: c.querySelector(".carrossel__seta--prox")?.disabled, ponto: [...c.querySelectorAll(".carrossel__pontos button")].findIndex((b) => b.getAttribute("aria-current") === "true"),
        pos: Math.round(t.scrollLeft / t.clientWidth) }; })()`;
    await cdp("Page.navigate", { url: BASE + "/blog/zz-qa-semana-do-bem-estar/" });
    await ate(`!!document.querySelector(".carrossel__contador")`);
    let e = await na(estado);
    certo("abre na 1ª mídia: contador 1 / 3, sem seta para trás", e.cont === "1 / 3" && e.ant === true && e.prox === false && e.ponto === 0, JSON.stringify(e));
    await na(`document.querySelector(".carrossel__seta--prox").click()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "2 / 3"`, 4000);
    e = await na(estado);
    certo("a seta avança: 2 / 3, o ponto acompanha e a faixa rolou", e.cont === "2 / 3" && e.ponto === 1 && e.pos === 1 && e.ant === false, JSON.stringify(e));
    await na(`(async () => { const v = document.querySelectorAll(".carrossel__item video")[0]; v.muted = true; await v.play(); })()`, true);
    await espera(400);
    const tocando = await na(`!document.querySelectorAll(".carrossel__item video")[0].paused`);
    await na(`(() => { const t = document.querySelector(".carrossel__trilho"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); })()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "3 / 3"`, 4000);
    e = await na(estado);
    certo("a seta do teclado leva à 3ª, e a seta para frente some no fim", e.cont === "3 / 3" && e.prox === true, JSON.stringify(e));
    certo("…e o vídeo que tocava no slide anterior PAUSOU", tocando && await na(`document.querySelectorAll(".carrossel__item video")[0].paused`), `tocando antes: ${tocando}`);
    await ate(`(() => { const i = document.querySelectorAll(".carrossel__item img")[1]; return i.complete && i.naturalWidth > 0; })()`, 6000);
    const encaixe = await na(`(() => { const it = document.querySelectorAll(".carrossel__item")[2], i = it.querySelector("img");
      const a = it.getBoundingClientRect(), b = i.getBoundingClientRect(); return { item: [Math.round(a.width), Math.round(a.height)], img: [Math.round(b.width), Math.round(b.height)], nat: [i.naturalWidth, i.naturalHeight], fit: getComputedStyle(i).objectFit }; })()`);
    certo("a foto em pé cabe INTEIRA na moldura (não cresce para fora nem é cortada)",
      encaixe.img[1] <= encaixe.item[1] && encaixe.img[0] <= encaixe.item[0] && encaixe.fit === "contain" && encaixe.nat[1] > encaixe.nat[0], JSON.stringify(encaixe));
    await na(`document.querySelectorAll(".carrossel__pontos button")[0].click()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "1 / 3"`, 4000);
    certo("o ponto leva direto à 1ª", (await na(estado)).cont === "1 / 3");
    certo("sem script, a faixa ainda rola e para em cada mídia (scroll-snap)", (await na(`getComputedStyle(document.querySelector(".carrossel__trilho")).scrollSnapType`)) === "x mandatory");

    await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
    await cdp("Page.navigate", { url: BASE + "/blog/zz-qa-semana-do-bem-estar/" });
    await ate(`!!document.querySelector(".carrossel__contador")`); await espera(400);
    const larg = await na(`({ pagina: document.documentElement.scrollWidth, tela: innerWidth, item: document.querySelector(".carrossel__item").getBoundingClientRect().width, trilho: document.querySelector(".carrossel__trilho").clientWidth })`);
    certo("no celular: sem barra lateral na página, e cada mídia ocupa a faixa inteira", larg.pagina <= larg.tela && Math.abs(larg.item - larg.trilho) < 1, JSON.stringify(larg));
    await cdp("Emulation.clearDeviceMetricsOverride");

    /* ---------------------------------------------------------------- painel */
    await cdp("Page.navigate", { url: BASE + "/admin/" });
    await ate(`!!document.getElementById("midias-${idVarias}")`);
    await na(`window.confirm = () => true`);
    const minis = () => na(`[...document.querySelectorAll("#midias-${idVarias} .midia")].map((m) => m.querySelector(".midia__num").textContent)`);
    certo("no painel, a matéria mostra as 2 mídias além da capa, numeradas 2 e 3", JSON.stringify(await minis()) === JSON.stringify(["2", "3"]), JSON.stringify(await minis()));
    const arqs = [];
    for (const n of ["quarta", "quinta"]) {
      const b64 = await na(`(() => { const c = document.createElement("canvas"); c.width = 2600; c.height = 1800; const g = c.getContext("2d"); g.fillStyle = "#${n === "quarta" ? "1FA8DC" : "7ED321"}"; g.fillRect(0, 0, 2600, 1800); return c.toDataURL("image/png").split(",")[1]; })()`);
      const p = path.join(TMP, n + ".png"); fs.writeFileSync(p, Buffer.from(b64, "base64")); arqs.push(p);
    }
    await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
    eventos.length = 0;
    await na(`[...document.querySelectorAll("#midias-${idVarias} ~ .anexos__botoes button")].find((b) => b.textContent.includes("Fotos")).click()`, true);
    let escolha = null;
    for (let t = 0; t < 5000 && !escolha; t += 100) { escolha = eventos.find((x) => x.method === "Page.fileChooserOpened"); if (!escolha) await espera(100); }
    certo("o + Fotos abre o seletor (e aceita várias)", !!escolha && escolha.params.mode === "selectMultiple", JSON.stringify(escolha && escolha.params));
    if (escolha) await cdp("DOM.setFileInputFiles", { files: arqs, backendNodeId: escolha.params.backendNodeId });
    await ate(`document.querySelectorAll("#midias-${idVarias} .midia").length === 4`, 20000);
    const lerMidias = async () => JSON.parse(((await posts()).find((p) => p.id === idVarias) || {}).midias || "[]");
    let m = [];
    for (let t = 0; t < 8000; t += 300) { m = await lerMidias(); if (m.length === 4) break; await espera(300); }
    certo("as duas fotos entram e já ficam SALVAS (4 mídias além da capa)", m.length === 4 && m[2].tipo === "foto" && m[3].tipo === "foto", JSON.stringify(m));
    const medida = m[2] && await na(`new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok(null); i.src = ${JSON.stringify(m[2] ? m[2].url : "")}; })`);
    certo("…reduzidas antes de subir (no máximo 1920 px)", medida && medida[0] <= 1920 && medida[0] > 100, JSON.stringify(medida));
    const antes = m.map((x) => x.url);
    await na(`[...document.querySelectorAll("#midias-${idVarias} .midia")][3].querySelector('[aria-label="Mover para a esquerda"]').click()`, true);
    await espera(900);
    m = await lerMidias();
    certo("mover troca a ordem e salva", m[2] && m[3] && m[2].url === antes[3] && m[3].url === antes[2], JSON.stringify(m.map((x) => x.url)));
    await na(`[...document.querySelectorAll("#midias-${idVarias} .midia")][0].querySelector('[aria-label="Tirar"]').click()`, true);
    await espera(900);
    m = await lerMidias();
    certo("tirar remove a mídia e salva", m.length === 3 && !m.some((x) => x.tipo === "video"), JSON.stringify(m));
    await na(`(() => { const i = document.querySelector('[data-t="posts"][data-id="${idVarias}"][data-f="excerpt"]'); i.value = "Resumo novo."; })()`);
    await na(`[...document.querySelectorAll("button")].find((b) => b.getAttribute("onclick") === "saveRow('posts',${idVarias})").click()`, true);
    await espera(1200);
    const salvo = (await posts()).find((p) => p.id === idVarias);
    certo("Salvar a matéria guarda o texto e mantém as mídias", salvo.excerpt === "Resumo novo." && JSON.parse(salvo.midias || "[]").length === 3, JSON.stringify({ excerpt: salvo.excerpt, midias: salvo.midias }));

    ws.close();
  } catch (e) {
    falhas.push("execução: " + e.message);
    console.log("  FALHA execução — " + e.message);
  } finally {
    if (chrome) chrome.kill();
    servidor.kill();
    await espera(600);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
    console.log(`\n  ${ok} ok, ${falhas.length} falha(s)`);
    if (falhas.length) { console.log("  " + falhas.join("\n  ")); process.exitCode = 1; }
  }
})();
