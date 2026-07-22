/* ==========================================================================
   server.js — Gerenciador do site BemEstarClinic
   Node puro + SQLite nativo (node:sqlite) — zero dependências.
   · Site:   http://localhost:5185/
   · Painel: http://localhost:5185/admin/   (senha inicial mostrada só no 1º boot)
   "Publicar" regenera o index.html (marcadores <!--#KEY-->) e o config.js.
   ========================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = 5185;

/* Versão do gerenciador — fonte única da verdade. O painel lê daqui pela API,
   não do HTML: assim, mesmo com o navegador servindo o admin do cache, o número
   exibido é sempre o da versão que está REALMENTE rodando no servidor.
   Subir ao publicar alterações no painel ou no server.js. */
const APP_VERSION = "1.7.0";
const UPLOAD_DIR = path.join(ROOT, "assets", "img", "uploads");
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "data", "site.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT, sort INTEGER DEFAULT 0);
  -- especialidades ganham página própria: slug (URL) + content (texto longo)

  CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subtitle TEXT, image TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS testimonials (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, name TEXT, role TEXT, initials TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, bio TEXT, photo TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    excerpt TEXT, content TEXT, image TEXT, date TEXT, sort INTEGER DEFAULT 0);

  -- Contador de acessos do site público. O IP nunca é gravado em claro:
  -- guardamos só o hash (LGPD — dado pseudonimizado, não reversível na prática).
  CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL, path TEXT, referrer TEXT, ua TEXT, day TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_visits_ip_ts ON visits(ip_hash, ts);
  CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
  CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
`);

for (const col of ["slug TEXT DEFAULT ''", "content TEXT DEFAULT ''"]) {
  try { db.exec(`ALTER TABLE services ADD COLUMN ${col}`); } catch {}
}
// guia de profissionais: WhatsApp próprio, especialidades que atende e se sai na home
for (const col of ["whatsapp TEXT DEFAULT ''", "especialidades TEXT DEFAULT ''", "na_home INTEGER DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE team ADD COLUMN ${col}`); } catch {}
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* --------------------------------------------------------------------------
   Senha do painel — scrypt com salt individual.
   SHA-256 é rápido de propósito: uma GPU testa bilhões por segundo, então um
   banco vazado entrega a senha em minutos. O scrypt é deliberadamente lento e
   exige 16 MB de memória por tentativa, o que inviabiliza ataque em escala.
   Formato guardado: scrypt$N$r$p$salt$derivado
   -------------------------------------------------------------------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

// comparação sempre em tempo constante — igualdade com === vaza informação pelo tempo
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function confereSenha(senha, guardado) {
  if (!guardado) return false;
  if (!guardado.startsWith("scrypt$")) {
    // formato antigo (sha256 puro): ainda aceita para não travar ninguém —
    // quem chama migra logo depois de validar
    return iguais(Buffer.from(sha(senha)), Buffer.from(guardado));
  }
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2,
    { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}

const senhaEhAntiga = (guardado) => !!guardado && !guardado.startsWith("scrypt$");
const getS = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const setS = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* ==========================================================================
   Contador de acessos — só visitas humanas ao site público.
   Um mesmo IP conta 1 vez por janela de VISIT_WINDOW_MIN minutos; depois disso
   volta a contar (é uma nova visita, não um novo pageview). IPs diferentes
   contam sempre. Nada disso aparece no site — só em /api/stats, com sessão.
   ========================================================================== */
const VISIT_WINDOW_MIN = 30;
// Salt persistido: sem ele o hash de um IPv4 seria quebrável por força bruta
// (só existem 4 bilhões). Com salt aleatório por instalação, deixa de ser.
if (!getS("visit_salt")) setS("visit_salt", crypto.randomBytes(24).toString("hex"));
const VISIT_SALT = getS("visit_salt");

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|preview|monitor|uptime|curl|wget|python-requests|axios|headless|lighthouse|pagespeed|semrush|ahrefs|mj12|dotbot|petalbot|gptbot|ccbot|claudebot|perplexity/i;

function clientIp(req) {
  // atrás do nginx o socket é sempre 127.0.0.1 — o IP real vem no X-Forwarded-For
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || req.socket.remoteAddress || "";
}

function trackVisit(req, pathname) {
  try {
    if (req.method !== "GET") return;
    const ua = String(req.headers["user-agent"] || "");
    if (!ua || BOT_RE.test(ua)) return;                 // robôs não são visita
    if (req.headers["sec-fetch-dest"] === "iframe") return;

    const ipHash = sha(VISIT_SALT + clientIp(req));
    const agora = Date.now();
    const ultima = db.prepare("SELECT ts FROM visits WHERE ip_hash=? ORDER BY ts DESC LIMIT 1").get(ipHash);
    if (ultima && agora - Number(ultima.ts) < VISIT_WINDOW_MIN * 60_000) return;  // ainda na mesma visita

    const ref = String(req.headers.referer || "");
    db.prepare("INSERT INTO visits(ip_hash,path,referrer,ua,day,ts) VALUES(?,?,?,?,?,?)")
      .run(ipHash, pathname.slice(0, 300),
        ref.includes("bemestarclinic.com") || ref.includes("localhost") ? "" : ref.slice(0, 300),
        ua.slice(0, 300), new Date(agora).toISOString().slice(0, 10), agora);
  } catch { /* medir acesso nunca pode derrubar a entrega da página */ }
}

/* Retenção: a LGPD exige prazo definido, não "para sempre". 12 meses é o que
   permite comparar ano a ano; passou disso, o registro é apagado sozinho. */
const VISIT_RETENCAO_MESES = 12;
function limparVisitasAntigas() {
  try {
    const corte = Date.now() - VISIT_RETENCAO_MESES * 30 * 86_400_000;
    const r = db.prepare("DELETE FROM visits WHERE ts < ?").run(corte);
    if (r.changes) console.log(`  · contador: ${r.changes} registro(s) com mais de ${VISIT_RETENCAO_MESES} meses apagados`);
  } catch { /* nunca derruba o servidor */ }
}
limparVisitasAntigas();
setInterval(limparVisitasAntigas, 24 * 3600 * 1000).unref();

function statsAcessos() {
  const hoje = new Date().toISOString().slice(0, 10);
  const desde = (dias) => Date.now() - dias * 86_400_000;
  const num = (sql, ...p) => Number(db.prepare(sql).get(...p)?.n || 0);
  return {
    total: num("SELECT COUNT(*) n FROM visits"),
    hoje: num("SELECT COUNT(*) n FROM visits WHERE day=?", hoje),
    semana: num("SELECT COUNT(*) n FROM visits WHERE ts>=?", desde(7)),
    mes: num("SELECT COUNT(*) n FROM visits WHERE ts>=?", desde(30)),
    visitantes: num("SELECT COUNT(DISTINCT ip_hash) n FROM visits"),
    visitantesMes: num("SELECT COUNT(DISTINCT ip_hash) n FROM visits WHERE ts>=?", desde(30)),
    porDia: db.prepare("SELECT day, COUNT(*) total FROM visits WHERE ts>=? GROUP BY day ORDER BY day").all(desde(30)),
    topPaginas: db.prepare("SELECT path, COUNT(*) total FROM visits GROUP BY path ORDER BY total DESC LIMIT 12").all(),
    origens: db.prepare("SELECT referrer, COUNT(*) total FROM visits WHERE referrer<>'' GROUP BY referrer ORDER BY total DESC LIMIT 8").all(),
    janelaMin: VISIT_WINDOW_MIN,
  };
}

/* --------------------------------------------------------------------------
   Migração: o guia de profissionais era HTML fixo em src/profissionais.html.
   Passa para a tabela `team`, para que dê para incluir/editar/remover pelo painel.
   `especialidades` usa os MESMOS títulos das especialidades do site: assim os
   grupos saem na ordem certa e cada um linka para a página da especialidade.
   -------------------------------------------------------------------------- */
function migrarGuia() {
  if (getS("guia_migrado")) return;

  const doutores = [
    ["Dr. Prof. Ronalldo JM", "5581973037762",
      "Psicanálise (Individual e Casal), Acupuntura, Terapia Floral, Protocolo Integrativo (Ozonioterapia e Detox Iônico), Kinesioterapia (Fitas Elásticas), Fitoterapia, Homeopatia, Ventosaterapia, Exame de Biorressonância"],
    ["Dr. Prof. Samuel Teixdan", "",
      "Psicanálise (Individual e Casal), Aromaterapia, Protocolo Integrativo (Ozonioterapia e Detox Iônico), Fitoterapia"],
  ];
  for (const [nome, wa, esp] of doutores) {
    db.prepare("UPDATE team SET whatsapp=?, especialidades=?, na_home=1 WHERE name=?").run(wa, esp, nome);
  }

  const novos = [
    ["Dra. Núbia Tatiane Fernandes", "Psicóloga", "5581989727437", "Psicologia, Avaliação Psicológica e Psicossocial",
      "Atendimento psicológico clínico com abordagem acolhedora e personalizada: psicoterapia individual e avaliação psicológica."],
    ["Dr. Jailson Cavalcanti", "Nutrição Clínica, Esportiva e Funcional", "5581992470976", "Nutrição",
      "Nutrição clínica, esportiva e funcional, com planos alimentares individualizados."],
    ["Dra. Letícia Vital", "Nutrição Clínica e Esportiva", "5581995559259", "Nutrição",
      "Nutrição clínica e esportiva, com acompanhamento de performance e composição corporal."],
    ["Dra. Tainá Brito", "Nutrição Clínica", "5581994122222", "Nutrição",
      "Nutrição clínica com foco em reeducação alimentar e saúde a longo prazo."],
    ["Dra. Lorena Espósito", "Nutrição Clínica", "5581920043169", "Nutrição",
      "Nutrição clínica com acompanhamento individualizado."],
    ["Dra. Brunna Ferreira", "Nutrição Clínica", "5581993952003", "Nutrição",
      "Nutrição clínica com acompanhamento individualizado."],
    ["Dra. Jheniffer Melo", "Nutrição Clínica, Funcional e Integrativa", "5581983997647", "Nutrição",
      "Nutrição clínica, funcional e integrativa, dialogando com as demais terapias da clínica."],
  ];
  let ordem = Number(db.prepare("SELECT MAX(sort) m FROM team").get()?.m || 0);
  for (const [name, role, whatsapp, especialidades, bio] of novos) {
    if (db.prepare("SELECT id FROM team WHERE name=?").get(name)) continue;
    db.prepare("INSERT INTO team(name,role,bio,photo,whatsapp,especialidades,na_home,sort) VALUES(?,?,?,'',?,?,0,?)")
      .run(name, role, bio, whatsapp, especialidades, ++ordem);
  }
  setS("guia_migrado", "1");
  console.log("  · guia de profissionais migrado para o painel");
}

/* --------------------------------------------------------------------------
   Migração dos textos para o banco.
   Em vez de repetir aqui os valores padrão (que sairiam do ar com o HTML), a
   migração LÊ o conteúdo que já está entre os marcadores nos arquivos e grava
   no banco. Resultado: nada muda de aparência ao atualizar, e nenhuma chave
   fica em branco. Só preenche o que ainda não existe — nunca sobrescreve
   edição feita pelo cliente no painel.
   -------------------------------------------------------------------------- */
const IMG_TAG = {
  img_hero:    { w: 620, h: 780, extra: 'fetchpriority="high" decoding="async"' },
  img_clinica: { w: 620, h: 740, extra: 'loading="lazy" decoding="async"' },
  img_online:  { w: 560, h: 640, extra: 'loading="lazy" decoding="async"' },
};

function lerMarcador(html, chave) {
  const m = new RegExp(`<!--#${chave}-->([\\s\\S]*?)<!--/${chave}-->`).exec(html);
  return m ? m[1].trim() : null;
}

function migrarTextos() {
  const arquivos = [
    path.join(ROOT, "index.html"),
    ...["especialidades", "profissionais", "blog", "agendar", "privacidade"]
      .map((n) => path.join(ROOT, "src", `${n}.html`)),
  ];
  let novos = 0;
  for (const arq of arquivos) {
    if (!fs.existsSync(arq)) continue;
    const html = fs.readFileSync(arq, "utf8");
    // [A-Z0-9_] e não [A-Z_]: chaves como MVV_T1 e BTN_HERO_1 têm dígito e
    // eram silenciosamente ignoradas pela migração
    for (const m of html.matchAll(/<!--#([A-Z0-9_]+)-->/g)) {
      const chave = m[1].toLowerCase();
      if (!KEYS.includes(chave)) continue;      // marcador de bloco gerado, não é texto editável
      if (chave === "atendimento") continue;    // texto puro, tem valor próprio mais abaixo
      if (getS(chave) !== undefined) continue;  // já existe: respeita o que o cliente salvou
      let valor = lerMarcador(html, m[1]) || "";
      if (chave.startsWith("img_")) {
        // guarda só a URL e o alt; a tag <img> é remontada na publicação
        const src = /src="([^"]+)"/.exec(valor);
        const alt = /alt="([^"]*)"/.exec(valor);
        if (getS(chave + "_alt") === undefined && alt) setS(chave + "_alt", alt[1]);
        valor = src ? src[1] : "";
      }
      if (chave === "online_list" || chave === "about_bullets") {
        valor = [...valor.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1].trim()).join("\n");
      }
      // blocos repetidos viram "Título | Descrição [| link]", uma linha por item
      if (chave === "ticker") {
        // o HTML tem 4 grupos repetidos; guarda só a lista, sem duplicar
        valor = [...new Set([...valor.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => x[1].trim()))].join("\n");
      }
      if (chave === "passos_itens") {
        valor = [...valor.matchAll(/step__title">([\s\S]*?)<\/h3>[\s\S]*?step__text">([\s\S]*?)<\/p>/g)]
          .map((x) => `${x[1].trim()} | ${x[2].trim()}`).join("\n");
      }
      if (chave === "empresas_cards") {
        valor = [...valor.matchAll(/<article[\s\S]*?service__title">([\s\S]*?)<\/h3>\s*<p class="service__text">([\s\S]*?)<\/p>([\s\S]*?)<\/article>/g)]
          .map((x) => {
            const link = /href="([^"]+)"/.exec(x[3]);
            return `${x[1].trim()} | ${x[2].trim()}${link ? ` | ${link[1]}` : ""}`;
          }).join("\n");
      }
      setS(chave, valor);
      novos++;
    }
  }
  if (getS("img_og") === undefined) setS("img_og", "/assets/img/og-image.png");
  if (getS("manutencao") === undefined) setS("manutencao", "0");
  if (getS("manutencao_titulo") === undefined) setS("manutencao_titulo", "Estamos atualizando o site");
  if (getS("manutencao_texto") === undefined) setS("manutencao_texto", "Volte em instantes.");
  if (getS("atendimento") === undefined) setS("atendimento",
    "Atendemos pacientes de toda a região!\n📍 Consultas presenciais: somente em Caruaru – PE.\n💻 Consultas online: para todo o Brasil e exterior.");

  /* Reparo: a v1.6.0 gravou o HTML já renderizado do bloco em vez do texto puro,
     e blocoAtendimento() escapa o conteúdo — resultado: as tags <p> apareciam na
     tela. Converte de volta para uma linha por parágrafo. Roda uma vez só. */
  const at = getS("atendimento") || "";
  if (/<p[^>]*class="atendimento__/.test(at)) {
    const linhas = [...at.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((x) => x[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (linhas.length) {
      setS("atendimento", linhas.join("\n"));
      console.log("  · bloco “Atendemos pacientes…” corrigido (tinha HTML no lugar do texto)");
    }
  }
  if (novos) console.log(`  · ${novos} texto(s) do site migrados para o painel`);
}

/* ==========================================================================
   Modo manutenção — duas camadas, porque uma sozinha não cobre tudo:

   1) Aqui no app: com a chave ligada, todo visitante recebe a página de aviso
      com HTTP 503. Quem está logado no painel continua vendo o site normal,
      para conferir antes de reabrir.
   2) No nginx: o mesmo arquivo é servido quando o app está FORA DO AR (502/
      503/504). É o que cobre restart, deploy, git stash e qualquer queda —
      momentos em que o app não existe para responder nada.

   Por isso a página é gravada em disco como arquivo estático: o nginx precisa
   conseguir lê-la sem depender do Node.
   ========================================================================== */
const emManutencao = () => getS("manutencao") === "1";

function gerarPaginaManutencao(S) {
  const titulo = S.manutencao_titulo || "Estamos atualizando o site";
  const texto = S.manutencao_texto || "Volte em instantes.";
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(titulo)} — BemEstarClinic</title>
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,600&family=Figtree:wght@300;400;600&family=Questrial&display=swap" rel="stylesheet">
  <style>
    /* CSS embutido de propósito: se o app estiver fora do ar, o styles.css
       também não é servido — a página precisa se sustentar sozinha. */
    *{box-sizing:border-box;margin:0}
    body{min-height:100vh;display:grid;place-items:center;padding:2rem;
      font:400 16px/1.7 Figtree,system-ui,sans-serif;color:#2a2260;
      background:radial-gradient(900px 500px at 80% -10%,rgba(255,255,255,.16),transparent 60%),
                 radial-gradient(600px 400px at -5% 110%,rgba(185,138,70,.3),transparent 60%),
                 linear-gradient(135deg,#3b2f9e,#5b4fd8)}
    .caixa{width:min(560px,100%);background:#fff;border-radius:26px;padding:clamp(2rem,5vw,3rem);
      text-align:center;box-shadow:0 30px 70px rgba(30,22,80,.3)}
    .lotus{width:76px;height:76px;margin:0 auto 1.4rem;display:block}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;
      font-size:clamp(1.7rem,4.6vw,2.4rem);line-height:1.2;color:#2a2260;margin-bottom:.8rem}
    h1 em{font-style:italic;color:#b98a46}
    p{color:#5f5a7a;font-weight:300;font-size:1.05rem}
    .marca{margin-top:2rem;padding-top:1.4rem;border-top:1px solid #e7e4f5;
      font-family:Questrial,sans-serif;letter-spacing:.04em;color:#5136d6;font-weight:600}
    .zap{display:inline-flex;align-items:center;gap:.5rem;margin-top:1.4rem;padding:.8rem 1.5rem;
      border-radius:999px;background:#5b4fd8;color:#fff;text-decoration:none;font-weight:600}
    .zap:hover{background:#b98a46}
    .pulso{animation:pulso 2.4s ease-in-out infinite}
    @keyframes pulso{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.75;transform:scale(.95)}}
    @media(prefers-reduced-motion:reduce){.pulso{animation:none}}
  </style>
</head>
<body>
  <main class="caixa">
    <svg class="lotus pulso" viewBox="180 840 300 300" role="img" aria-label="BemEstarClinic">
      <path fill="#5136d6" d="M457.37,933.57c-12.78-6.05-27.06-9.42-42.14-9.42-6.31,0-12.49.59-18.47,1.73-10.36-30.93-35.62-55.03-67.26-63.77-31.63,8.74-56.9,32.84-67.25,63.77-5.98-1.13-12.16-1.73-18.47-1.73-15.08,0-29.37,3.38-42.15,9.42-1.87,7.58-2.86,15.51-2.86,23.66,0,54.51,44.19,98.7,98.7,98.7,9.79,0,19.24-1.42,28.17-4.08-3.59-13.09-9.55-25.19-17.4-35.81-15.83-21.43-39.33-36.86-66.44-42.21,6.88-1.37,13.99-2.08,21.27-2.08,25.01,0,48.05,8.43,66.44,22.59,18.39-14.17,41.43-22.59,66.43-22.59,7.28,0,14.39.71,21.27,2.08-27.11,5.36-50.61,20.78-66.44,42.21-7.85,10.62-13.81,22.72-17.4,35.81,8.93,2.66,18.39,4.08,28.18,4.08,54.5,0,98.69-44.19,98.69-98.7,0-8.16-.99-16.08-2.86-23.66ZM329.5,976.94c-10.47,0-18.97-8.49-18.97-18.97s8.49-18.97,18.97-18.97,18.97,8.49,18.97,18.97-8.49,18.97-18.97,18.97Z"/>
    </svg>
    <h1>${esc(titulo)}</h1>
    <p>${esc(texto)}</p>
    ${S.whatsapp ? `<a class="zap" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ""}
    <p class="marca">BemEstarClinic</p>
  </main>
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, "manutencao.html"), html);
  return html;
}

/* HTML do bloco "Atendemos pacientes…" — 1ª linha vira destaque, o resto parágrafo */
function blocoAtendimento(S) {
  const linhas = String(S.atendimento || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return "";
  const [titulo, ...resto] = linhas;
  return `<p class="atendimento__titulo">${esc(titulo)}</p>\n` +
    resto.map((l) => `          <p class="atendimento__linha">${esc(l)}</p>`).join("\n");
}

/* Remonta a tag <img> a partir da URL e do alt guardados no painel */
function tagImagem(chave, S) {
  const cfg = IMG_TAG[chave] || { w: 800, h: 600, extra: 'loading="lazy" decoding="async"' };
  const src = S[chave] || "";
  const alt = S[chave + "_alt"] || "";
  if (!src) return "";
  return `<img src="${esc(src)}" alt="${esc(alt)}" width="${cfg.w}" height="${cfg.h}" ${cfg.extra}>`;
}

/* ------------------------------- Seed ------------------------------------ */
function seed() {
  if (getS("hero_title")) return;
  const S = {
    admin_password_hash: hashSenha("bemestar-admin"),
    hero_badge: "🪷 Saúde mental e práticas integrativas · Caruaru-PE e online",
    hero_title: "Seu bem-estar em <em>boas mãos</em>.",
    hero_lead: "Cuidamos da sua saúde mental, física e do seu bem-estar de forma completa e acessível: equipe de especialistas e uma ampla variedade de tratamentos integrativos para você e sua família — presencial em Caruaru e online.",
    stats: JSON.stringify([
      { num: "16+", label: "especialidades integrativas" }, { num: "9", label: "profissionais no guia" },
      { num: "24h", label: "laudos de avaliação online" }, { num: "100%", label: "atendimento humanizado" },
    ]),
    about_title: "Quem <em>somos</em>",
    about_lead: "Cuidamos da sua saúde mental, física e bem-estar de forma completa e acessível! Contamos com uma equipe de especialistas e uma ampla variedade de tratamentos integrativos para atender você e sua família — com exames de biorressonância para avaliação completa da sua saúde.",
    about_bullets: JSON.stringify([
      "Cuidado com as pessoas: atendimento humanizado e personalizado",
      "Ética e transparência em todas as relações",
      "Terapias convencionais e complementares integradas",
      "Referência em saúde multiprofissional integrada",
    ]),
    whatsapp: "5581973037762",
    whatsapp_display: "(81) 9.7303-7762",
    phone_fixed: "(81) 4105-1109",
    contact_email: "faleconosco@bemestarclinic.com",
    instagram: "bemestarclinic_",
    address: "Empresarial Nordeste Corporate — Rua Arthur Antônio da Silva, 481, 7º andar, Sala 707 — Universitário, Caruaru-PE · CEP 55016-445",
    footer_tagline: "Saúde mental e práticas integrativas de bem-estar. Seu bem-estar em boas mãos — presencial em Caruaru-PE e online.",
  };
  for (const [k, v] of Object.entries(S)) setS(k, v);

  const ESP = [
    ["Psicanálise (Individual e Casal)",
     "Escuta qualificada baseada em Freud para compreender conflitos internos, emoções reprimidas e padrões inconscientes. Online e presencial.",
     "A Terapia Psicanalítica Individual é um processo terapêutico baseado nos fundamentos da psicanálise, criado por Sigmund Freud. Seu principal objetivo é ajudar o indivíduo a compreender seus conflitos internos, emoções reprimidas e padrões inconscientes que influenciam pensamentos e comportamentos.\n\nO que a terapia busca:\n✔️ Explorar o inconsciente e identificar traumas ocultos\n✔️ Entender padrões de comportamento e suas origens\n✔️ Desenvolver recursos internos para lidar com dificuldades emocionais\n✔️ Reduzir sintomas de ansiedade, depressão e outros transtornos\n✔️ Melhorar a qualidade dos relacionamentos interpessoais\n\nIndicações: tratamento da ansiedade e depressão, transtornos de personalidade, dificuldades nos relacionamentos, fobias e traumas, autoconhecimento e desenvolvimento pessoal.\n\nJá a Terapia Psicanalítica de Casal é voltada para casais que enfrentam dificuldades no relacionamento: compreende os conflitos inconscientes que afetam a dinâmica do casal, melhora a comunicação e fortalece o vínculo afetivo.\n\nUma jornada de autodescoberta e transformação — presencial em Caruaru ou online."],
    ["Protocolo Integrativo (Ozonioterapia e Detox Iônico)",
     "Ozônio medicinal + Detox Iônico: desintoxicação, imunidade, redução de inflamações e mais disposição física e mental.",
     "O Protocolo Integrativo combina duas técnicas complementares que potencializam os processos naturais do corpo.\n\nA Ozonioterapia utiliza uma mistura de oxigênio e ozônio medicinal, com propriedades anti-inflamatórias, antioxidantes, analgésicas e imunomoduladoras — estimula a regeneração celular, melhora a oxigenação dos tecidos e favorece a circulação.\n\nO Detox Iônico atua por bioeletricidade, auxiliando o organismo na eliminação de toxinas e resíduos metabólicos, com melhora da circulação e do equilíbrio energético.\n\nPrincipais benefícios:\n✔️ Eliminação de toxinas e metais pesados\n✔️ Redução de inflamações e dores crônicas\n✔️ Fortalecimento do sistema imunológico\n✔️ Melhora da circulação e da oxigenação celular\n✔️ Mais disposição, energia e vitalidade\n\nIndicações: dores musculares e articulares, artrite, artrose, fibromialgia, problemas circulatórios, estresse, fadiga crônica, baixa imunidade, desintoxicação, saúde estética e qualidade do sono."],
    ["Acupuntura",
     "Terapia milenar da Medicina Tradicional Chinesa, reconhecida pela OMS: equilíbrio energético, alívio de dores e bem-estar.",
     "A Acupuntura é uma terapia milenar da Medicina Tradicional Chinesa (MTC): aplicação de agulhas finas em pontos específicos do corpo para restaurar o equilíbrio energético, estimular o fluxo de Qi (energia vital) e melhorar a circulação.\n\nBenefícios:\n✔️ Redução da dor e de inflamações (dores musculares, articulares e crônicas)\n✔️ Regulação do sistema nervoso: ansiedade, insônia, estresse e depressão\n✔️ Fortalecimento do sistema imunológico\n✔️ Equilíbrio hormonal: TPM, menopausa e fertilidade\n✔️ Melhora da circulação e do metabolismo\n\nTratamentos frequentes: enxaqueca, hérnia de disco, fibromialgia, artrite, lombalgia, problemas digestivos (gastrite, refluxo), distúrbios hormonais (SOP), obesidade e retenção de líquidos, problemas respiratórios (rinite, sinusite, asma) e estética.\n\nOs efeitos podem ser sentidos já nas primeiras sessões. A acupuntura é reconhecida pela Organização Mundial da Saúde (OMS)."],
    ["Fitoterapia",
     "O poder das plantas medicinais: chás, extratos, tinturas e cápsulas para tratar e equilibrar, com menos efeitos colaterais.",
     "A Fitoterapia é o uso de plantas medicinais para tratar diversas condições de saúde e promover o equilíbrio físico e emocional — em chás, extratos, tinturas, cápsulas e óleos essenciais.\n\nBenefícios:\n✔️ Tratamento de doenças agudas e crônicas\n✔️ Apoio ao sistema imunológico\n✔️ Melhora da digestão e do metabolismo\n✔️ Redução de estresse e ansiedade\n✔️ Alívio de dores e inflamações\n✔️ Auxílio no controle hormonal (TPM, menopausa, fertilidade)\n\nExemplos: problemas digestivos (menta, gengibre, camomila), distúrbios emocionais (erva-cidreira, passiflora, lavanda), dores musculares e articulares, fortalecimento imunológico.\n\nOs efeitos são graduais e o acompanhamento profissional garante o ajuste ideal do tratamento — uma alternativa natural com menos riscos de efeitos colaterais. Online e presencial."],
    ["Terapia Floral",
     "Essências florais para equilíbrio emocional em todas as idades — de bebês a adultos, inclusive em fases de transição.",
     "A Terapia Floral utiliza essências de flores para tratar desequilíbrios emocionais e promover o bem-estar psicológico e físico — indicada para todas as idades, de bebês à fase adulta.\n\nBenefícios:\n✔️ Equilíbrio emocional: tristeza, medo, raiva, ansiedade e estresse\n✔️ Desenvolvimento emocional saudável, autoconfiança e autoestima\n✔️ Alívio de sintomas físicos associados (dores somáticas, insônia)\n✔️ Harmonia, paz interior e autocontrole\n✔️ Apoio em fases de transição: infância, adolescência, gravidez, menopausa e envelhecimento\n\nExemplos: bebês com dificuldade para dormir, cólicas ou ansiedade de separação (Chicory, Cherry Plum); crianças e adolescentes com medos, inseguranças, dificuldades escolares ou hiperatividade (Aspen e outras).\n\nA resposta é gradual e profunda, pois trabalha a raiz emocional. Segura e complementar a outros tratamentos. Online e presencial."],
    ["Aromaterapia",
     "Óleos essenciais que atuam pelo olfato e pela pele: menos estresse, sono melhor, alívio de dores e mais equilíbrio.",
     "A Aromaterapia utiliza óleos essenciais extraídos de plantas para promover a saúde física, mental e emocional — os aromas atuam pelo olfato e pela absorção na pele.\n\nBenefícios:\n✔️ Redução do estresse e da ansiedade\n✔️ Melhora do sono e combate à insônia\n✔️ Alívio de dores e inflamações\n✔️ Fortalecimento do sistema imunológico\n✔️ Equilíbrio hormonal (TPM, menopausa)\n✔️ Estímulo à concentração e à memória\n\nExemplos: ansiedade e estresse (lavanda, camomila, ylang-ylang); insônia (lavanda, cedro); dores (hortelã-pimenta, alecrim, gengibre); respiratório (eucalipto, tea tree); equilíbrio hormonal (gerânio, sálvia-esclareia); foco (alecrim, limão); pele (tea tree, rosa mosqueta).\n\nFormas de uso: inalação, massagens, banhos terapêuticos ou difusão ambiental. Online e presencial."],
    ["Avaliação Psicológica e Psicossocial",
     "Avaliação online regulamentada (CFP nº 11/2018) com resultado em até 24h — solução ágil para colaboradores e empresas.",
     "A avaliação psicossocial online é permitida desde 2018, conforme a Resolução CFP nº 11/2018 — mais acessibilidade, flexibilidade e praticidade, com segurança e respaldo ético.\n\nDiferenciais BemEstarClinic:\n✔️ Flexibilidade total: o colaborador realiza a avaliação de casa, da empresa ou de onde se sentir à vontade\n✔️ Resultado em até 24 horas, com processos digitais e integração de sistemas\n✔️ Condução por psicólogo(a), com acompanhamento contínuo\n✔️ Atenção adaptada a qualquer escolaridade e realidade de empresa\n✔️ Redução de custos operacionais: sem logística nem deslocamento\n\nMetodologia própria com duas abordagens — avaliação interna (atendimento no local) e externa (remota) — para a empresa escolher o formato ideal.\n\nTambém realizamos Avaliação Psicológica clínica e Avaliação Neuropsicológica."],
    ["Ventosaterapia",
     "Técnica milenar com copos de vácuo: alívio de dores, melhora da circulação e relaxamento muscular profundo.",
     "A Ventosaterapia é uma técnica terapêutica milenar realizada com copos que criam vácuo sobre a pele — estimula a circulação, libera toxinas e relaxa a musculatura.\n\nBenefícios:\n✔️ Alívio de dores musculares e articulares: tensões, contraturas, fibromialgia e artrite\n✔️ Melhora da circulação sanguínea e linfática\n✔️ Relaxamento muscular profundo\n✔️ Fortalecimento do sistema imunológico\n✔️ Redução de tensões emocionais (ansiedade e insônia)\n✔️ Melhora do metabolismo (auxílio no emagrecimento e celulite)\n\nTratamentos frequentes: lombalgia, cervicalgia, tendinite, hérnia de disco, dores crônicas, fibromialgia, cansaço crônico, estresse e qualidade do sono.\n\nOs benefícios podem ser sentidos logo na primeira sessão — isolada ou combinada com outras terapias."],
    ["Psicologia",
     "Psicoterapia individual, de casal, infantil e corporativa — saúde mental com abordagens integrativas e personalizadas.",
     "Na BemEstarClinic, o atendimento psicológico é completo, com foco na promoção da saúde mental e emocional, conduzido por psicólogos especializados em diversas áreas.\n\nNossos serviços:\n✅ Psicoterapia Individual — ansiedade, depressão, estresse e autoestima\n✅ Psicoterapia de Casal — comunicação e resolução de conflitos\n✅ Psicologia Infantil e Adolescente — dificuldades de aprendizado, bullying e transtornos emocionais\n✅ Psicologia Corporativa — programas de bem-estar, gestão de estresse e desenvolvimento pessoal\n✅ Avaliação Psicológica — testes e diagnósticos do perfil emocional e comportamental\n✅ Transtornos específicos — TDA, transtornos de ansiedade, TOC e outros\n\nCuidamos da sua saúde mental para que você viva melhor, com mais equilíbrio e qualidade de vida."],
    ["Exame de Biorressonância",
     "Exame não invasivo que analisa as frequências do organismo para detectar desequilíbrios antes dos sintomas.",
     "O Exame de Biorressonância é uma técnica não invasiva que identifica desequilíbrios no corpo pela análise das frequências vibracionais emitidas por células e órgãos — quando há desequilíbrios, essas frequências se alteram.\n\nBenefícios:\n✔️ Detecção precoce de alterações, antes mesmo dos sintomas\n✔️ Ajuste personalizado de terapias integrativas (homeopatia, fitoterapia, acupuntura)\n✔️ Avaliação do estado energético do corpo\n✔️ Prevenção e monitoramento contínuo da saúde\n✔️ Harmonização do organismo\n\nÉ totalmente seguro, não invasivo e sem necessidade de preparos especiais — ideal como avaliação completa e ponto de partida do seu plano de cuidado integrativo."],
    ["Homeopatia",
     "Sistema terapêutico da 'cura pelo semelhante': estimula a autocura tratando corpo, emoções e mente como um todo.",
     "A Homeopatia é um sistema terapêutico baseado no princípio da \"cura pelo semelhante\": substâncias naturais altamente diluídas estimulam as defesas do corpo e restauram o equilíbrio interno — tratando a pessoa como um todo, nos aspectos físicos, emocionais e mentais.\n\nBenefícios:\n✔️ Tratamento de doenças crônicas e agudas\n✔️ Melhora do equilíbrio emocional: ansiedade, estresse e depressão\n✔️ Fortalecimento do sistema imunológico\n✔️ Alívio de dores agudas e crônicas\n✔️ Mais vitalidade e bem-estar geral\n\nO processo de cura é gradual e trabalha a causa dos sintomas, não apenas a manifestação. Segura, sem efeitos colaterais indesejáveis, pode ser usada sozinha ou como complemento. Online e presencial."],
    ["Kinesioterapia (Fitas Elásticas)",
     "Kinesio Taping: fitas elásticas em pontos estratégicos para aliviar dores, estabilizar músculos e acelerar a reabilitação.",
     "A Kinesioterapia utiliza fitas elásticas (Kinesio Taping) aplicadas em pontos estratégicos do corpo para tratar e prevenir lesões musculoesqueléticas — restaurando a função muscular e articular sem medicamentos.\n\nBenefícios:\n✔️ Alívio de dores musculares e articulares, crônicas ou agudas\n✔️ Melhora da circulação sanguínea e linfática (redução de inchaços)\n✔️ Apoio e estabilização de músculos e articulações\n✔️ Melhora da propriocepção e correção postural\n✔️ Reabilitação funcional: mais flexibilidade e força\n\nA aplicação é segura, confortável e não invasiva: redução imediata da dor e ganho de mobilidade, com as fitas oferecendo suporte contínuo por vários dias."],
    ["Saúde e Segurança do Trabalhador",
     "Exames ocupacionais completos (admissional ao demissional), avaliações e serviços de segurança para empresas.",
     "A saúde do trabalhador é essencial para um ambiente seguro e produtivo. Realizamos todos os exames ocupacionais exigidos pelas normas trabalhistas.\n\nExames ocupacionais:\n🔹 Admissional · Demissional · Periódico · Retorno ao Trabalho · Mudança de Função\n\nExames complementares:\n🔸 Acuidade Visual (AC)\n🔸 PALO (Percepção de Altura e Luz Oscilante)\n🔸 Avaliação Psicossocial\n🔸 Avaliação Psicológica e Neuropsicológica\n🔸 Avaliação de Risco Ocupacional (Atestado/Laudo)\n\nServiços de segurança no trabalho:\n🛠️ Ergonomia — adequação dos postos de trabalho\n🛠️ Técnico/Engenheiro do Trabalho — prevenção de riscos e conformidade com as normas regulamentadoras\n\nSolução completa para a conformidade e o bem-estar dos colaboradores da sua empresa."],
    ["Riscos Psicossociais (NR-1)",
     "Sua empresa em conformidade com a NR-1: identificação, avaliação e gestão dos riscos psicossociais com time interdisciplinar.",
     "A NR-1 (Norma Regulamentadora nº 1) obriga as empresas a identificar, avaliar e gerenciar todos os riscos ocupacionais — incluindo os riscos psicossociais, entre as principais causas de adoecimento mental e afastamentos.\n\nO que são riscos psicossociais:\n⚠️ Carga de trabalho excessiva e metas abusivas\n⚠️ Pressão constante e prazos irrealistas\n⚠️ Falta de reconhecimento e suporte emocional\n⚠️ Assédio moral ou sexual\n⚠️ Conflitos interpessoais e ambiente hostil\n⚠️ Insegurança profissional\n\nO que a NR-1 exige:\n📜 Gerenciamento de Riscos Ocupacionais (GRO)\n📜 Programa de Gerenciamento de Riscos (PGR)\n📜 Ações de prevenção, acolhimento e proteção emocional\n\nA BemEstarClinic atende sua empresa com um time interdisciplinar: psicanálise clínica, psicologia (clínica, organizacional e escolar), fitoterapia, homeopatia, acupuntura, detox iônico, ozonioterapia, ginástica laboral e segurança do trabalho/engenharia ocupacional."],
    ["Nutrição",
     "Nutrição Clínica, Esportiva, Funcional e Integrativa: planos alimentares personalizados para saúde e resultados.",
     "A Nutrição promove saúde, prevenção de doenças e qualidade de vida por meio da alimentação adequada e personalizada — respeitando características físicas, rotina, objetivos e fase da vida de cada paciente.\n\nBenefícios:\n✔️ Melhoria da qualidade da alimentação e dos hábitos\n✔️ Prevenção e controle de doenças: diabetes, hipertensão, obesidade, gastrite, colesterol\n✔️ Controle e manutenção do peso corporal\n✔️ Mais disposição, energia e qualidade de vida\n✔️ Relação mais saudável com a alimentação\n\nÁreas de atuação:\n✅ Nutrição Clínica — avaliação e planos personalizados\n✅ Nutrição Esportiva — para praticantes de atividade física e atletas\n✅ Nutrição Funcional e Integrativa\n\nNosso guia conta com 6 nutricionistas para você escolher o acompanhamento ideal."],
    ["Diversas Especialidades",
     "Saúde completa: uma abordagem integral com diferentes áreas unidas pelo seu bem-estar físico, emocional e preventivo.",
     "Na BemEstarClinic, oferecemos uma abordagem integral de saúde, cobrindo diversos segmentos e especialidades para atender a todas as suas necessidades.\n\nCom uma equipe altamente capacitada, unimos diferentes áreas para oferecer soluções eficazes para o seu bem-estar — seja para a saúde física, emocional, mental ou preventiva.\n\nCom tratamentos inovadores, tecnologia e cuidado personalizado, temos muito mais a oferecer do que você imagina.\n\nQuer saber quais serviços podem transformar sua saúde e qualidade de vida? Fale com a gente pelo WhatsApp e descubra o que a BemEstarClinic pode fazer por você!"],
  ];
  ESP.forEach((s, i) => db.prepare("INSERT INTO services(title,slug,text,content,sort) VALUES(?,?,?,?,?)")
    .run(s[0], slug(s[0]), s[1], s[2], i));

  [["Recepção", "Chegue e sinta-se em casa", "https://images.unsplash.com/photo-1631217868264-e5b90bb7e133?auto=format&fit=crop&w=700&q=70"],
   ["Sala de atendimento", "Conforto e privacidade", "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=700&q=70"],
   ["Sala de ozonioterapia", "Equipamentos certificados", "https://images.unsplash.com/photo-1629909613654-28e377c37b09?auto=format&fit=crop&w=700&q=70"],
   ["Ambiente zen", "Detalhes que acolhem", "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=700&q=70"],
   ["Bem-estar integral", "Cuidado com corpo e mente", "https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=700&q=70"],
   ["Atendimento online", "Perto de você, em qualquer lugar", "https://images.unsplash.com/photo-1609220136736-443140cffec6?auto=format&fit=crop&w=700&q=70"]]
    .forEach((w, i) => db.prepare("INSERT INTO portfolio(title,subtitle,image,sort) VALUES(?,?,?,?)").run(w[0], w[1], w[2], i));

  [["Profissionais maravilhosos, clínica top 💚 Todos precisamos de terapia 💚💚", "Paciente verificado", "Avaliação no Google ★ 5,0", "G"],
   ["Ótimo atendimento, maravilhosos profissionais, ambiente bastante acolhedor.", "Paciente verificado", "Avaliação no Google ★ 5,0", "G"],
   ["Super recomendo. Excelente recepção e ótimos profissionais.", "Paciente verificado", "Avaliação no Google ★ 5,0", "G"]]
    .forEach((d, i) => db.prepare("INSERT INTO testimonials(text,name,role,initials,sort) VALUES(?,?,?,?,?)").run(d[0], d[1], d[2], d[3], i));

  console.log("· Banco inicializado. Senha do painel: bemestar-admin");
}
seed();
migrarGuia();
// migração leve: garante chaves novas em bancos já existentes
if (!getS("cnpj") || getS("cnpj") === "00.000.000/0001-00") setS("cnpj", "02.192.745/0001-25");
// migração leve: semeia o blog em bancos criados antes desta seção
if (db.prepare("SELECT COUNT(*) AS c FROM posts").get().c === 0) {
  [["Quando procurar um psicanalista? 7 sinais de que a terapia pode ajudar",
    "Ansiedade constante, padrões que se repetem, luto que não passa: veja os sinais de que uma escuta qualificada pode transformar seu momento.",
    "Procurar terapia não é sinal de fraqueza — é um ato de cuidado com você mesmo. Mas como saber a hora certa?\n\n1. Ansiedade ou tristeza constantes, que atrapalham o dia a dia;\n\n2. Padrões que se repetem: os mesmos conflitos nos relacionamentos, no trabalho, na família;\n\n3. Luto ou perda que não encontra lugar, mesmo com o tempo passando;\n\n4. Dificuldade para dormir, irritabilidade e cansaço sem causa física;\n\n5. Decisões importantes travadas por medo ou insegurança;\n\n6. Sensação de viver no automático, sem saber o que sente;\n\n7. Vontade de se conhecer melhor — a análise não é só para crises.\n\nNa psicanálise, a escuta qualificada ajuda a compreender o que se repete e a ressignificar o que dói. Na BemEstarClinic, o atendimento é individual ou de casal, presencial em Caruaru ou online.\n\nSe algum desses sinais falou com você, vamos conversar? Agende pelo WhatsApp. 🪷",
    "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=900&q=70", "2026-07-15"],
   ["NR-1 e riscos psicossociais: o que muda para a sua empresa",
    "A norma agora exige a gestão dos riscos psicossociais no trabalho. Entenda as obrigações — e como se adequar sem dor de cabeça.",
    "A NR-1 (Norma Regulamentadora nº 1) determina que toda empresa identifique, avalie e gerencie os riscos ocupacionais — e isso inclui os riscos psicossociais, hoje entre as principais causas de afastamento.\n\nO que são riscos psicossociais? Carga de trabalho excessiva, metas abusivas, pressão constante, falta de reconhecimento, assédio moral ou sexual, conflitos frequentes e ambientes hostis.\n\nO que a norma exige: implantar o Gerenciamento de Riscos Ocupacionais (GRO), desenvolver o Programa de Gerenciamento de Riscos (PGR), considerar os riscos psicossociais no planejamento de saúde e segurança, e promover ações de prevenção e acolhimento.\n\nComo a BemEstarClinic ajuda: avaliação psicossocial online com laudo em até 24 horas, time interdisciplinar (psicologia organizacional, psicanálise, ginástica laboral, segurança do trabalho) e metodologia própria com atendimento interno ou externo.\n\nSua empresa em conformidade e seus colaboradores bem cuidados. Peça uma proposta pelo WhatsApp. 🏢",
    "https://images.unsplash.com/photo-1519824145371-296894a0daa9?auto=format&fit=crop&w=900&q=70", "2026-07-08"],
   ["Ozonioterapia e Detox Iônico: como funciona o Protocolo Integrativo",
    "Duas terapias que se potencializam: entenda o passo a passo do protocolo que une desintoxicação, imunidade e mais energia.",
    "O Protocolo Integrativo da BemEstarClinic combina duas técnicas complementares que trabalham juntas pelo equilíbrio do organismo.\n\nA Ozonioterapia utiliza oxigênio e ozônio medicinal, com ação anti-inflamatória, antioxidante e imunomoduladora: melhora a oxigenação dos tecidos, estimula a regeneração celular e favorece a circulação.\n\nO Detox Iônico atua por bioeletricidade, auxiliando o corpo a eliminar toxinas e resíduos metabólicos — com efeito direto na disposição e na sensação de leveza.\n\nJuntas, as técnicas se potencializam: desintoxicação + oxigenação + imunidade em um mesmo plano de cuidado.\n\nPara quem é indicado? Dores crônicas, fibromialgia, baixa imunidade, fadiga, estresse, retenção de líquidos e programas de desintoxicação — sempre como terapia complementar, com avaliação individual.\n\nQuer saber se o protocolo é para você? Agende uma avaliação pelo WhatsApp. 💜",
    "https://images.unsplash.com/photo-1579684385127-1ef15d508118?auto=format&fit=crop&w=900&q=70", "2026-06-30"]]
    .forEach((p, i) => db.prepare("INSERT INTO posts(title,slug,excerpt,content,image,date,sort) VALUES(?,?,?,?,?,?,?)")
      .run(p[0], slug(p[0]), p[1], p[2], p[3], p[4], i));
}
// migração leve: semeia a equipe em bancos criados antes da seção Profissionais
if (db.prepare("SELECT COUNT(*) AS c FROM team").get().c === 0) {
  [["Dr. Prof. Ronalldo JM", "Presidente · Psicanalista clínico", "Especialista, Mestre e Doutor em Psicanálise Clínica (FENATE/PE 0004 · SBP 16000025). Psicanalista (individual e casal), ozonioterapeuta, acupunturista, terapeuta floral, ventosaterapeuta, cinesioterapeuta, fitoterapeuta, homeopata e biorressonância.", "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=600&q=75"],
   ["Dr. Prof. Samuel Teixdan", "Diretor · Psicanalista clínico", "Especialista e Doutor em Psicanálise Clínica (FENATE/PE 0005 · SBP 16000024). Psicanalista clínico (individual), Detox Iônico e aromaterapeuta.", "https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=600&q=75"],
   ["Dra. Núbia Tatiane Fernandes", "Psicóloga", "Atendimento psicológico clínico com abordagem acolhedora e personalizada. Psicoterapia individual e avaliações psicológicas.", "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=600&q=75"]]
    .forEach((m, i) => db.prepare("INSERT INTO team(name,role,bio,photo,sort) VALUES(?,?,?,?,?)").run(m[0], m[1], m[2], m[3], i));
}

/* ------------------------------ Sessões ---------------------------------- */
/* ------------------------- Sessão e força bruta --------------------------- */
const SESSAO_HORAS = 12;          // sessão parada por mais que isso, cai
const TENTATIVAS_MAX = 5;         // erros de senha antes do bloqueio
const BLOQUEIO_MIN = 15;          // duração do bloqueio por IP

const sessions = new Map();
const authed = (req) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const inicio = sessions.get(m[1]);
  if (!inicio) return false;
  // sessão sem prazo é sessão eterna: cookie roubado valeria para sempre
  if (Date.now() - inicio > SESSAO_HORAS * 3600_000) { sessions.delete(m[1]); return false; }
  sessions.set(m[1], Date.now());   // renova enquanto estiver em uso
  return true;
};

/* Sem isto, dá para tentar senha à vontade: 100 mil tentativas por minuto
   quebram qualquer senha curta. O bloqueio é por IP e some sozinho. */
const tentativas = new Map();
function loginBloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return 0;
  if (Date.now() > t.ate) { tentativas.delete(ip); return 0; }
  return t.erros >= TENTATIVAS_MAX ? Math.ceil((t.ate - Date.now()) / 60000) : 0;
}
function registrarErro(ip) {
  const t = tentativas.get(ip) || { erros: 0, ate: 0 };
  t.erros++;
  t.ate = Date.now() + BLOQUEIO_MIN * 60000;
  tentativas.set(ip, t);
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of tentativas) if (agora > v.ate) tentativas.delete(k);
  for (const [k, v] of sessions) if (agora - v > SESSAO_HORAS * 3600_000) sessions.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------ Publicar --------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ICONS = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 1 7 7c0 1.9-.7 3.2-1.7 4.5-.8 1-1.3 2.1-1.3 3.5v3h-6v-2H8a2 2 0 0 1-2-2v-3H4.5L6.2 10A7 7 0 0 1 12 3Z"/><path d="M11 9.5a1.8 1.8 0 1 1 1.8 1.8V13"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/><path d="M9 14a3 3 0 0 0 3 3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.8 14.6A5.4 5.4 0 0 1 21 20"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 1 1 7.5-6.3 5 5 0 1 1 7.5 6.3Z"/><path d="M6 12h3l1.5-2 2 3.5L14 12h4"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c-5.5 0-8-3.5-8-8 5.5 0 8 3.5 8 8Z"/><path d="M12 20c5.5 0 8-3.5 8-8-5.5 0-8 3.5-8 8Z"/><path d="M12 12c1.6-2.2 1.6-4.8 0-7-1.6 2.2-1.6 4.8 0 7Z"/></svg>',
];
const CHECK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';


function setMarker(html, key, content) {
  const re = new RegExp(`(<!--#${key}-->)[\\s\\S]*?(<!--\\/${key}-->)`);
  if (!re.test(html)) throw new Error(`Marcador ${key} não encontrado`);
  // replacement em função: evita que "$" no conteúdo seja interpretado ($$, $1…)
  return html.replace(re, (_m, open, close) => `${open}\n${content}\n${close}`);
}

/* --------------------------------------------------------------------------
   Opções dos <select> de especialidade (formulário de contato e /agendar/).

   No site "Psicanálise (Individual e Casal)" é UMA especialidade, com uma
   página só — e continua assim em todo lugar. Mas na hora de agendar são duas
   necessidades diferentes, e quem responde precisa saber qual antes de marcar.
   Por isso o desdobramento vive aqui, no formulário, e não no cadastro.

   Para desdobrar outra especialidade, basta acrescentar uma linha ao mapa.
   -------------------------------------------------------------------------- */
const DESDOBRA_NO_FORMULARIO = {
  "Psicanálise (Individual e Casal)": ["Psicanálise (Individual)", "Psicanálise (Casal)"],
};

function opcoesDoFormulario(services) {
  return services
    .flatMap((s) => DESDOBRA_NO_FORMULARIO[s.title] || [s.title])
    .map((titulo) => `<option>${esc(titulo)}</option>`)
    .join("\n                ");
}

function publish() {
  const S = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S[r.key] = r.value;
  const services = db.prepare("SELECT * FROM services ORDER BY sort,id").all();
  const works = db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all();
  const deps = db.prepare("SELECT * FROM testimonials ORDER BY sort,id").all();
  const team = db.prepare("SELECT * FROM team ORDER BY sort,id").all();
  const posts = db.prepare("SELECT * FROM posts ORDER BY date DESC, id DESC").all();
  const dateBR = (iso) => { const [y, m, d] = String(iso || "").split("-"); return d ? `${d}/${m}/${y}` : iso || ""; };
  const postCard = (p) => `<article class="post-card" data-reveal>
            <a class="post-card__media" href="/blog/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img src="${esc(p.image)}" alt="${esc(p.title)} — BemEstarClinic, Caruaru-PE" loading="lazy" decoding="async" width="900" height="500"></a>
            <div class="post-card__body">
              <time class="post-card__date" datetime="${esc(p.date)}">${dateBR(p.date)}</time>
              <h3 class="post-card__title"><a href="/blog/${esc(p.slug)}/">${esc(p.title)}</a></h3>
              <p class="post-card__excerpt">${esc(p.excerpt)}</p>
              <a class="post-card__more" href="/blog/${esc(p.slug)}/">Ler matéria →</a>
            </div>
          </article>`;

  const stats = JSON.parse(S.stats || "[]").map((s) =>
    `<div class="stat"><dd class="stat__num">${esc(s.num)}</dd><dt class="stat__label">${esc(s.label)}</dt></div>`).join("\n            ");

  const svcCard = (s, i) => `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="service__icon">${ICONS[i % ICONS.length]}</div>
            <h3 class="service__title">${esc(s.title)}</h3>
            <p class="service__text">${esc(s.text)}</p>
            <a class="service__more" href="/especialidades/${esc(s.slug)}/">Saiba mais →</a>
          </article>`;
  const servicesHtml = services.slice(0, 9).map(svcCard).join("\n          ");
  const servicesAllHtml = services.map(svcCard).join("\n          ");

  const worksHtml = works.map((w, i) => `<figure class="work" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}><img src="${esc(w.image)}" alt="${esc(w.title)}${w.subtitle ? ` — ${esc(w.subtitle)}` : ""}, na BemEstarClinic em Caruaru-PE" loading="lazy" decoding="async"><figcaption class="work__label">${esc(w.title)}<small>${esc(w.subtitle || "")}</small></figcaption></figure>`).join("\n          ");

  const bullets = JSON.parse(S.about_bullets || "[]").map((b) => `<li>${CHECK} ${esc(b)}</li>`).join("\n            ");

  // na home entram só os marcados (hoje, os dois diretores); o guia completo
  // fica em /profissionais/, que lista todo mundo
  const teamHome = team.filter((m) => Number(m.na_home) === 1);
  const teamHtml = teamHome.map((m, i) => `<article class="card pro" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <figure class="pro__photo"><img src="${esc(m.photo)}" alt="${esc(m.name)} — ${esc(m.role)}" loading="lazy" width="300" height="340"></figure>
            <h3 class="pro__name">${esc(m.name)}</h3>
            <p class="pro__role">${esc(m.role)}</p>
            <p class="pro__bio">${esc(m.bio)}</p>
          </article>`).join("\n          ");

  const depsHtml = deps.map((t, i) => `<figure class="card quote" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="quote__stars" aria-label="5 de 5">★★★★★</div>
            <blockquote class="quote__text">“${esc(t.text)}”</blockquote>
            <figcaption class="quote__author"><span class="avatar">${esc(t.initials)}</span><span><span class="quote__name">${esc(t.name)}</span><br><span class="quote__role">${esc(t.role)}</span></span></figcaption>
          </figure>`).join("\n          ");

  const contactInfo = `<a class="contact-tile" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5Z"/></svg></span>
              <span><span class="contact-tile__label">WhatsApp — resposta rápida</span><br><span class="contact-tile__value">${esc(S.whatsapp_display)}</span></span>
            </a>
            <a class="contact-tile" href="mailto:${esc(S.contact_email)}">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></span>
              <span><span class="contact-tile__label">E-mail</span><br><span class="contact-tile__value">${esc(S.contact_email)}</span></span>
            </a>
            <a class="contact-tile" href="https://www.instagram.com/${esc(S.instagram)}/" target="_blank" rel="noopener">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg></span>
              <span><span class="contact-tile__label">Instagram</span><br><span class="contact-tile__value">@${esc(S.instagram)}</span></span>
            </a>
            <a class="contact-tile" href="tel:${esc(String(S.phone_fixed || "").replace(/\D/g, ""))}">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.8 2.1Z"/></svg></span>
              <span><span class="contact-tile__label">Telefone fixo</span><br><span class="contact-tile__value">${esc(S.phone_fixed || "")}</span></span>
            </a>
            <a class="contact-tile" href="https://maps.google.com/?q=${encodeURIComponent("BemEstarClinic, Rua Arthur Antônio da Silva, 481, Sala 707, Universitário, Caruaru - PE")}" target="_blank" rel="noopener">
              <span class="contact-tile__icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg></span>
              <span><span class="contact-tile__label">Endereço</span><br><span class="contact-tile__value">${esc(S.address || "Caruaru - PE")}</span></span>
            </a>`;

  const SITE0 = "https://bemestarclinic.com";
  const mapsUrl = "https://maps.google.com/?q=" + encodeURIComponent("BemEstarClinic, Rua Arthur Antônio da Silva, 481, Sala 707, Universitário, Caruaru - PE");
  // NOTA: sem aggregateRating de propósito — marcar as próprias avaliações viola a
  // política de review snippets do Google e rende ação manual. As notas ficam só no HTML.
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": `${SITE0}/#org`, name: "BemEstarClinic",
      alternateName: "CIPS — Clínica Integrada de Psicanálise e da Saúde",
      url: `${SITE0}/`, logo: { "@type": "ImageObject", url: `${SITE0}/assets/img/mark-violet.svg` },
      email: S.contact_email, telephone: "+" + S.whatsapp,
      sameAs: [`https://www.instagram.com/${S.instagram}/`, "https://www.doctoralia.com.br/clinicas/bemestarclinic"] },
    { "@type": "MedicalClinic", "@id": `${SITE0}/#clinica`, name: "BemEstarClinic",
      image: `${SITE0}/assets/img/og-image.png`, url: `${SITE0}/`, hasMap: mapsUrl,
      description: "Clínica de psicanálise, psicologia, ozonioterapia e terapias integrativas em Caruaru-PE, com atendimento online para todo o Brasil.",
      telephone: "+" + S.whatsapp, email: S.contact_email, priceRange: "$$",
      currenciesAccepted: "BRL", availableLanguage: "pt-BR",
      // horário conforme informado no rodapé do site — manter os dois em sincronia
      openingHoursSpecification: [{ "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "18:00" }],
      address: { "@type": "PostalAddress",
        streetAddress: "Rua Arthur Antônio da Silva, 481, 7º andar, Sala 707 — Empresarial Nordeste Corporate",
        addressLocality: "Caruaru", addressRegion: "PE", postalCode: "55016-445", addressCountry: "BR" },
      // presencial só em Caruaru; online sem fronteira
      areaServed: [
        { "@type": "City", name: "Caruaru", containedInPlace: { "@type": "State", name: "Pernambuco" } },
        { "@type": "Country", name: "Brasil" },
      ],
      availableService: services.map((s) => ({ "@type": "MedicalTherapy", name: s.title,
        url: s.slug ? `${SITE0}/especialidades/${s.slug}/` : undefined })),
      employee: team.map((m) => ({ "@type": "Person", name: m.name, jobTitle: m.role, description: m.bio,
        image: m.photo && m.photo.startsWith("/") ? SITE0 + m.photo : m.photo, worksFor: { "@id": `${SITE0}/#org` } })),
      parentOrganization: { "@id": `${SITE0}/#org` } },
    { "@type": "WebSite", "@id": `${SITE0}/#site`, url: `${SITE0}/`, name: "BemEstarClinic", inLanguage: "pt-BR",
      publisher: { "@id": `${SITE0}/#org` },
      potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint",
        urlTemplate: `${SITE0}/busca/?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
  ] };
  const jsonldHtml = `<script type="application/ld+json">\n  ${JSON.stringify(jsonld, null, 2).replace(/\n/g, "\n  ")}\n  </script>`;

  const idx = path.join(ROOT, "index.html");
  let html = fs.readFileSync(idx, "utf8");
  html = setMarker(html, "JSONLD", "  " + jsonldHtml);
  // todos os textos de seção e as imagens do painel, de uma vez
  html = aplicarTextos(html, S);
  html = setMarker(html, "STATS", "            " + stats);
  html = setMarker(html, "SERVICES", "          " + servicesHtml);
  html = setMarker(html, "ABOUT_BULLETS", "            " + bullets);
  html = setMarker(html, "ONLINE_LIST", "            " +
    String(S.online_list || "").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => `<li>${esc(l)}</li>`).join("\n            "));
  html = setMarker(html, "ATENDIMENTO", "          " + blocoAtendimento(S));
  html = setMarker(html, "TICKER", "        " + renderTicker(S));
  html = setMarker(html, "PASSOS_ITENS", "          " + renderPassos(S));
  html = setMarker(html, "EMPRESAS_CARDS", "          " + renderEmpresas(S));
  html = setMarker(html, "TEAM", "          " + teamHtml);
  html = setMarker(html, "PORTFOLIO", "          " + worksHtml);
  html = setMarker(html, "TESTIMONIALS", "          " + depsHtml);
  html = setMarker(html, "CONTACT_INFO", "            " + contactInfo);
  const footerEsp = services.map((s) => `<a href="/especialidades/${esc(s.slug)}/">${esc(s.title)}</a>`).join("\n            ");
  html = setMarker(html, "FOOTER_ESP", "            " + footerEsp);
  // o e-mail do rodapé vinha fixo no HTML e divergia do cadastrado no painel
  html = setMarker(html, "FOOTER_EMAIL", `          <a href="mailto:${esc(S.contact_email)}">${esc(S.contact_email)}</a>`);
  html = setMarker(html, "BLOG", "          " + posts.slice(0, 3).map(postCard).join("\n          "));
  html = setMarker(html, "FORM_SERVICES", "                " + opcoesDoFormulario(services));
  html = setMarker(html, "CNPJ", S.cnpj);
  // atualiza QUALQUER wa.me/<numero> restante (footer etc.)
  html = html.replace(/wa\.me\/\d+/g, `wa.me/${S.whatsapp}`);
  // o preload do LCP aponta para a foto do topo — se ela mudar no painel,
  // um preload apontando para a imagem antiga baixaria um arquivo à toa
  if (S.img_hero) html = html.replace(/(<link rel="preload" as="image"[^>]*href=")[^"]*(")/, `$1${S.img_hero}$2`);
  fs.writeFileSync(idx, html);

  /* ---------- /especialidades/ + /especialidades/<slug>/ ---------- */
  const SITE = "https://bemestarclinic.com";
  const listTpl = fs.readFileSync(path.join(ROOT, "src", "especialidades.html"), "utf8");
  const espTpl = fs.readFileSync(path.join(ROOT, "src", "especialidade.html"), "utf8");
  fs.mkdirSync(path.join(ROOT, "especialidades"), { recursive: true });
  const listJ = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", name: "Especialidades — BemEstarClinic", url: `${SITE}/especialidades/`,
      inLanguage: "pt-BR", isPartOf: { "@id": `${SITE}/#site` }, about: { "@id": `${SITE}/#clinica` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Especialidades", item: `${SITE}/especialidades/` } ] },
    { "@type": "ItemList", name: "Especialidades atendidas",
      itemListElement: services.filter((s) => s.slug).map((s, i) => ({ "@type": "ListItem", position: i + 1,
        name: s.title, url: `${SITE}/especialidades/${s.slug}/` })) } ] };
  fs.writeFileSync(path.join(ROOT, "especialidades", "index.html"),
    aplicarTextos(listTpl, S).replaceAll("{{SERVICES_HTML}}", "          " + servicesAllHtml)
      .replaceAll("{{COUNT}}", String(services.length))
      .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(listJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
      .replace(/wa\.me\/\d+/g, `wa.me/${S.whatsapp}`));
  const keepEsp = new Set(services.map((s) => s.slug).filter(Boolean));
  for (const d of fs.readdirSync(path.join(ROOT, "especialidades"), { withFileTypes: true }))
    if (d.isDirectory() && !keepEsp.has(d.name)) fs.rmSync(path.join(ROOT, "especialidades", d.name), { recursive: true, force: true });
  for (const [i, sv] of services.entries()) {
    if (!sv.slug) continue;
    const paragraphs = String(sv.content || sv.text || "").split(/\n{2,}/)
      .map((par) => `<p>${esc(par.trim()).replace(/\n/g, "<br>")}</p>`).join("\n        ");
    const others = services.filter((x) => x.id !== sv.id).slice(0, 3).map(svcCard).join("\n          ");
    // meta description própria: prefixo local + resumo, cortado em palavra inteira (≤158)
    const prefixo = `${sv.title} em Caruaru-PE e online. `;
    const resto = String(sv.text || "").replace(/\s+/g, " ").trim();
    let metaEsp = prefixo + resto;
    if (metaEsp.length > 158) {
      const corte = metaEsp.slice(0, 155);
      metaEsp = corte.slice(0, corte.lastIndexOf(" ")) + "…";
    }
    const tLongo = `${sv.title} em Caruaru-PE e Online`;
    const espTitleTag = tLongo.length <= 62 ? tLongo : `${sv.title} — Caruaru-PE`;
    const ej = { "@context": "https://schema.org", "@graph": [
      { "@type": "MedicalWebPage", name: `${sv.title} — BemEstarClinic`, url: `${SITE}/especialidades/${sv.slug}/`,
        description: sv.text, inLanguage: "pt-BR",
        about: { "@type": "MedicalTherapy", name: sv.title },
        provider: { "@id": `${SITE}/#clinica` } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Especialidades", item: `${SITE}/especialidades/` },
        { "@type": "ListItem", position: 3, name: sv.title, item: `${SITE}/especialidades/${sv.slug}/` } ] } ] };
    fs.mkdirSync(path.join(ROOT, "especialidades", sv.slug), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "especialidades", sv.slug, "index.html"),
      aplicarTextos(espTpl, S).replaceAll("{{TITLE}}", esc(sv.title))
        .replaceAll("{{TITLE_ENC}}", encodeURIComponent(sv.title))
        .replaceAll("{{WA_TEXT}}", encodeURIComponent(`Olá! Quero agendar ${sv.title} na BemEstarClinic 🪷`))
        .replaceAll("{{SLUG}}", esc(sv.slug))
        .replaceAll("{{EXCERPT}}", esc(sv.text || ""))
        .replaceAll("{{META_DESC}}", esc(metaEsp))
        .replaceAll("{{TITLE_TAG}}", esc(espTitleTag))
        .replaceAll("{{ICON}}", ICONS[i % ICONS.length])
        .replaceAll("{{CONTENT_HTML}}", paragraphs)
        .replaceAll("{{RELATED}}", "          " + others)
        .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(ej, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
        .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));
  }

  /* ---------- /profissionais/ (guia) ---------- */
  const guiaTpl = fs.readFileSync(path.join(ROOT, "src", "profissionais.html"), "utf8");
  fs.mkdirSync(path.join(ROOT, "profissionais"), { recursive: true });
  const anchorProf = (nome) => "prof-" + slug(nome);
  const iniciais = (nome) => nome.replace(/^(Dr[a]?\.|Prof\.)\s*/gi, "").trim()
    .split(/\s+/).filter((p) => p.length > 2).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const listaEsp = (m) => String(m.especialidades || "").split(",").map((x) => x.trim()).filter(Boolean);
  const waFmt = (n) => {
    const d = String(n).replace(/\D/g, "").replace(/^55/, "");
    return d.length === 11 ? `(${d.slice(0, 2)}) ${d[2]}.${d.slice(3, 7)}-${d.slice(7)}` : n;
  };

  /* 1) Galeria: cada profissional aparece UMA vez. Sem foto, entram as iniciais —
        assim os cards mantêm a mesma altura e o alinhamento não quebra. */
  const cardsProf = team.map((m, i) => {
    const esp = listaEsp(m);
    const foto = m.photo
      ? `<img src="${esc(m.photo)}" alt="${esc(m.name)} — ${esc(m.role)} na BemEstarClinic, Caruaru-PE" loading="lazy" decoding="async" width="300" height="300">`
      : `<span class="prof-card__iniciais" aria-hidden="true">${esc(iniciais(m.name))}</span>`;
    return `<article class="prof-card" id="${anchorProf(m.name)}" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <figure class="prof-card__foto${m.photo ? "" : " prof-card__foto--vazia"}">${foto}</figure>
            <h3 class="prof-card__nome">${esc(m.name)}</h3>
            <p class="prof-card__role">${esc(m.role)}</p>
            ${m.bio ? `<p class="prof-card__bio">${esc(m.bio)}</p>` : ""}
            ${esp.length ? `<ul class="prof-card__tags">${esp.map((e, k) => {
              const sv = services.find((s) => s.title === e);
              // quem atende muita coisa (o Dr. Ronalldo tem 9) estouraria a altura do
              // card: as extras ficam no HTML (boas para o Google) mas escondidas até
              // o toque no "+N" — tooltip via title não existe em celular
              const extra = k >= 4 ? ' class="prof-card__tag--extra"' : "";
              return `<li${extra}>${sv && sv.slug ? `<a href="/especialidades/${esc(sv.slug)}/">${esc(e)}</a>` : esc(e)}</li>`;
            }).join("")}${esp.length > 4
              ? `<li class="prof-card__tags-toggle"><button type="button" class="prof-card__tags-mais" aria-expanded="false" data-mais="${esp.length - 4}">+${esp.length - 4}</button></li>`
              : ""}</ul>` : ""}
            ${m.whatsapp
              ? `<a class="prof-card__wa" href="https://wa.me/${esc(m.whatsapp)}" target="_blank" rel="noopener">WhatsApp: ${esc(waFmt(m.whatsapp))}</a>`
              : `<a class="prof-card__wa" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">Agendar pela recepção</a>`}
          </article>`;
  }).join("\n          ");

  /* 2) Grupos por especialidade — só nomes, nenhuma foto repetida.
        A ordem segue a das especialidades cadastradas; o que não bater vai ao fim. */
  const ordemEsp = new Map(services.map((s, i) => [s.title, i]));
  const grupos = new Map();
  for (const m of team) for (const e of listaEsp(m)) {
    if (!grupos.has(e)) grupos.set(e, []);
    grupos.get(e).push(m);
  }
  const gruposHtml = [...grupos.entries()]
    .sort((a, b) => (ordemEsp.get(a[0]) ?? 999) - (ordemEsp.get(b[0]) ?? 999))
    .map(([nome, pessoas]) => {
      const sv = services.find((s) => s.title === nome);
      return `<article class="guia-block" data-reveal>
            <h3 class="guia-block__title">${sv && sv.slug ? `<a href="/especialidades/${esc(sv.slug)}/">${esc(nome)}</a>` : esc(nome)}</h3>
            <ul class="guia-list">
              ${pessoas.map((p) => `<li><a href="#${anchorProf(p.name)}"><b>${esc(p.name)}</b></a> <span>${esc(p.role)}</span></li>`).join("\n              ")}
            </ul>
          </article>`;
    }).join("\n          ");

  const guiaJ = { "@context": "https://schema.org", "@graph": [
    { "@type": "CollectionPage", name: "Guia de Profissionais — BemEstarClinic", url: `${SITE}/profissionais/`,
      inLanguage: "pt-BR", isPartOf: { "@id": `${SITE}/#site` }, about: { "@id": `${SITE}/#clinica` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Guia de Profissionais", item: `${SITE}/profissionais/` } ] },
    ...team.map((m) => ({ "@type": "Person", "@id": `${SITE}/profissionais/#${anchorProf(m.name)}`,
      name: m.name, jobTitle: m.role, description: m.bio || undefined,
      image: m.photo ? (m.photo.startsWith("/") ? SITE + m.photo : m.photo) : undefined,
      telephone: m.whatsapp ? "+" + m.whatsapp : undefined,
      knowsAbout: listaEsp(m).length ? listaEsp(m) : undefined,
      worksFor: { "@id": `${SITE}/#org` }, areaServed: { "@type": "City", name: "Caruaru" } })),
  ] };
  // ATENÇÃO à ordem: o wa.me é normalizado no TEMPLATE primeiro. Se fosse depois,
  // trocaria o número de cada nutricionista pelo número geral da clínica.
  const guiaOut = aplicarTextos(guiaTpl, S).replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`)
    .replaceAll("{{PROFISSIONAIS_HTML}}", "          " + cardsProf)
    .replaceAll("{{GRUPOS_HTML}}", "          " + gruposHtml)
    .replaceAll("{{TOTAL}}", String(team.length))
    .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(guiaJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`);
  fs.writeFileSync(path.join(ROOT, "profissionais", "index.html"), guiaOut);

  /* ---------- /privacidade/ (LGPD) ---------- */
  const privTpl = fs.readFileSync(path.join(ROOT, "src", "privacidade.html"), "utf8");
  const hojeISO = new Date().toISOString().slice(0, 10);   // `today` só existe no bloco do sitemap, adiante
  const mailLink = `<a href="mailto:${esc(S.contact_email)}">${esc(S.contact_email)}</a>`;
  const privJ = { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", name: "Política de Privacidade — BemEstarClinic", url: `${SITE}/privacidade/`,
      inLanguage: "pt-BR", isPartOf: { "@id": `${SITE}/#site` }, publisher: { "@id": `${SITE}/#org` },
      dateModified: hojeISO },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Política de Privacidade", item: `${SITE}/privacidade/` } ] } ] };
  fs.mkdirSync(path.join(ROOT, "privacidade"), { recursive: true });
  let privHtml = aplicarTextos(privTpl, S).replaceAll("{{DATA_BR}}", dateBR(hojeISO))
    .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(privJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`);
  privHtml = setMarker(privHtml, "PRIV_CNPJ", esc(S.cnpj));
  privHtml = setMarker(privHtml, "PRIV_ENDERECO", esc(S.address));
  for (const k of ["PRIV_EMAIL", "PRIV_EMAIL2", "PRIV_EMAIL3", "PRIV_EMAIL_DPO"]) privHtml = setMarker(privHtml, k, mailLink);
  fs.writeFileSync(path.join(ROOT, "privacidade", "index.html"),
    privHtml.replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));

  /* ---------- /agendar/ (cadastro de paciente → WhatsApp) ---------- */
  const agendarTpl = fs.readFileSync(path.join(ROOT, "src", "agendar.html"), "utf8");
  fs.mkdirSync(path.join(ROOT, "agendar"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "agendar", "index.html"),
    setMarker(aplicarTextos(agendarTpl, S), "FORM_SERVICES", "                " + opcoesDoFormulario(services))
      .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));

  /* ---------- índice de busca (search-index.json) ---------- */
  const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const searchIndex = [
    { t: "Início — BemEstarClinic", u: "/", tipo: "Página", d: strip(S.hero_lead) },
    { t: "A Clínica — Missão, Visão e Valores", u: "/#clinica", tipo: "Página", d: strip(S.about_lead) },
    { t: "Guia de Profissionais", u: "/profissionais/", tipo: "Profissionais", d: "Nossa equipe por especialidade: psicanalistas, nutricionistas, psicóloga e terapeutas integrativos em Caruaru e online." },
    { t: "Para Empresas — Saúde do Trabalhador e NR-1", u: "/#empresas", tipo: "Empresas", d: "Exames ocupacionais, riscos psicossociais (NR-1) e avaliação psicossocial com laudo em até 24h." },
    { t: "Atendimento Online pelo WhatsApp", u: "/#online", tipo: "Página", d: "O atendimento online é feito pelo WhatsApp, com a mesma qualidade e sigilo do presencial." },
    { t: "Contato", u: "/#contato", tipo: "Página", d: `WhatsApp ${S.whatsapp_display}, e-mail ${S.contact_email}, ${strip(S.address)}` },
    ...services.filter((s) => s.slug).map((s) => ({ t: s.title, u: `/especialidades/${s.slug}/`, tipo: "Especialidade", d: strip(s.text) + " " + strip(s.content).slice(0, 300) })),
    ...posts.map((po) => ({ t: po.title, u: `/blog/${po.slug}/`, tipo: "Feed", d: strip(po.excerpt) + " " + strip(po.content).slice(0, 300) })),
    ...team.map((m) => ({ t: m.name, u: "/#profissionais", tipo: "Profissional", d: `${strip(m.role)}. ${strip(m.bio)}` })),
    { t: "Política de Privacidade", u: "/privacidade/", tipo: "Institucional", d: "Como tratamos os seus dados pessoais: o que coletamos, por quê, com quem compartilhamos, prazos de guarda e como exercer os seus direitos pela LGPD." },
  ];
  fs.mkdirSync(path.join(ROOT, "assets", "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "assets", "data", "search-index.json"), JSON.stringify(searchIndex));

  /* ---------- /busca/ (página de resultados) ---------- */
  fs.mkdirSync(path.join(ROOT, "busca"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "busca", "index.html"),
    fs.readFileSync(path.join(ROOT, "src", "busca.html"), "utf8").replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));

  /* ---------- blog: /blog/ + /blog/<slug>/ ---------- */
  const blogTpl = fs.readFileSync(path.join(ROOT, "src", "blog.html"), "utf8");
  const postTpl = fs.readFileSync(path.join(ROOT, "src", "post.html"), "utf8");
  fs.mkdirSync(path.join(ROOT, "blog"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "blog", "index.html"),
    aplicarTextos(blogTpl, S).replaceAll("{{POSTS_HTML}}", "          " + (posts.map(postCard).join("\n          ") || '<p class="blog-empty">Em breve, novidades por aqui! 🪷</p>'))
      .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));
  const keepPosts = new Set(posts.map((x) => x.slug));
  for (const d of fs.readdirSync(path.join(ROOT, "blog"), { withFileTypes: true }))
    if (d.isDirectory() && !keepPosts.has(d.name)) fs.rmSync(path.join(ROOT, "blog", d.name), { recursive: true, force: true });
  for (const po of posts) {
    const paragraphs = String(po.content || "").split(/\n{2,}/).map((par) => `<p>${esc(par.trim()).replace(/\n/g, "<br>")}</p>`).join("\n        ");
    const pj = { "@context": "https://schema.org", "@type": "Article",
      headline: po.title, description: po.excerpt, image: po.image, datePublished: po.date, inLanguage: "pt-BR",
      author: { "@type": "Organization", name: "BemEstarClinic", url: `${SITE}/` },
      publisher: { "@id": `${SITE}/#org` }, mainEntityOfPage: `${SITE}/blog/${po.slug}/` };
    fs.mkdirSync(path.join(ROOT, "blog", po.slug), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "blog", po.slug, "index.html"),
      aplicarTextos(postTpl, S).replaceAll("{{TITLE}}", esc(po.title)).replaceAll("{{EXCERPT}}", esc(po.excerpt))
        .replaceAll("{{SLUG}}", esc(po.slug)).replaceAll("{{IMAGE}}", esc(po.image))
        .replaceAll("{{DATE_ISO}}", esc(po.date)).replaceAll("{{DATE_BR}}", dateBR(po.date))
        .replaceAll("{{CONTENT_HTML}}", paragraphs)
        .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(pj, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
        .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));
  }

  /* ---------- sitemap.xml ---------- */
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, pri: "1.0", freq: "weekly" },
    { loc: `${SITE}/especialidades/`, pri: "0.9", freq: "monthly" },
    ...services.filter((s) => s.slug).map((s) => ({ loc: `${SITE}/especialidades/${s.slug}/`, pri: "0.8", freq: "monthly" })),
    { loc: `${SITE}/profissionais/`, pri: "0.8", freq: "monthly" },
    { loc: `${SITE}/blog/`, pri: "0.7", freq: "weekly" },
    ...posts.map((po) => ({ loc: `${SITE}/blog/${po.slug}/`, pri: "0.6", freq: "yearly" })),
    { loc: `${SITE}/privacidade/`, pri: "0.3", freq: "yearly" },
  ];
  // /agendar/ e /busca/ ficam de fora: são noindex (formulário e resultado de busca)
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`).join("\n") +
    `\n</urlset>\n`);

  // a página de manutenção acompanha o WhatsApp e a mensagem atuais
  gerarPaginaManutencao(S);

  // config.js
  const cfgPath = path.join(ROOT, "assets/js/config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/WHATSAPP_NUMBER = "[^"]*"/, `WHATSAPP_NUMBER = "${S.whatsapp}"`)
           .replace(/CONTACT_EMAIL = "[^"]*"/, `CONTACT_EMAIL = "${S.contact_email}"`);
  fs.writeFileSync(cfgPath, cfg);
  return { services: services.length, works: works.length, team: team.length, posts: posts.length };
}

/* ------------------------------ HTTP util --------------------------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, bad) => {
  let d = "", n = 0;
  req.on("data", (c) => { n += c.length; if (n > 25e6) { bad(new Error("payload muito grande")); req.destroy(); } d += c; });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error("JSON inválido")); } });
});
const TABLES = { services: ["title", "slug", "text", "content", "sort"], portfolio: ["title", "subtitle", "image", "sort"], testimonials: ["text", "name", "role", "initials", "sort"], team: ["name", "role", "bio", "photo", "whatsapp", "especialidades", "na_home", "sort"], posts: ["title", "slug", "excerpt", "content", "image", "date", "sort"] };
/* ==========================================================================
   CAMPOS — declaração única de tudo que é editável em "Textos do site".
   O painel monta a tela a partir daqui, então incluir um campo novo é acrescentar
   uma linha nesta lista + o marcador <!--#CHAVE--> no HTML. Nada mais.
   tipos: input | textarea | bigtext | image | lista
   ========================================================================== */
const CAMPOS = [
  { grupo: "🏠 Topo da página inicial", campos: [
    ["hero_badge", "Selo acima do título", "input"],
    ["hero_title", "Título principal — <em>texto</em> deixa em itálico dourado", "input"],
    ["hero_lead", "Texto de apoio", "textarea"],
    ["img_hero", "Foto do topo", "image"],
    ["img_hero_alt", "Descrição da foto do topo (acessibilidade e Google)", "input"],
    ["stats", "Números do topo — um por linha: 16+ | especialidades", "stats"],
  ]},
  { grupo: "🌿 Seção Especialidades", campos: [
    ["sec_esp_eyebrow", "Rótulo", "input"],
    ["sec_esp_title", "Título", "input"],
    ["sec_esp_sub", "Subtítulo", "textarea"],
  ]},
  { grupo: "💜 Seção A Clínica", campos: [
    ["about_title", "Título", "input"],
    ["about_lead", "Texto de apresentação", "textarea"],
    ["about_bullets", "Diferenciais — um por linha", "json_lista"],
    ["img_clinica", "Foto da seção", "image"],
    ["img_clinica_alt", "Descrição da foto", "input"],
    ["mvv_missao", "Missão", "textarea"],
    ["mvv_visao", "Visão", "textarea"],
    ["mvv_valores", "Valores", "textarea"],
  ]},
  { grupo: "👩‍⚕️ Seção Profissionais", campos: [
    ["sec_prof_eyebrow", "Rótulo", "input"],
    ["sec_prof_title", "Título", "input"],
    ["sec_prof_sub", "Subtítulo", "textarea"],
  ]},
  { grupo: "💻 Seção Atendimento Online", campos: [
    ["sec_online_eyebrow", "Rótulo", "input"],
    ["sec_online_title", "Título", "input"],
    ["sec_online_sub", "Texto", "textarea"],
    ["online_list", "Itens da lista (um por linha)", "lista"],
    ["img_online", "Foto da seção", "image"],
    ["img_online_alt", "Descrição da foto", "input"],
  ]},
  { grupo: "🏢 Seção Para Empresas", campos: [
    ["sec_emp_eyebrow", "Rótulo", "input"],
    ["sec_emp_title", "Título", "input"],
    ["sec_emp_sub", "Subtítulo", "textarea"],
    ["empresas_cards", "Os 3 serviços — uma linha cada: Título | Descrição | link (opcional)", "bigtext"],
  ]},
  { grupo: "🪜 Seção Como Funciona", campos: [
    ["sec_passos_eyebrow", "Rótulo", "input"],
    ["sec_passos_title", "Título", "input"],
    ["passos_itens", "Os passos — uma linha cada: Título | Descrição", "bigtext"],
  ]},
  { grupo: "🪷 Seção Nosso Espaço", campos: [
    ["sec_espaco_eyebrow", "Rótulo", "input"],
    ["sec_espaco_title", "Título", "input"],
    ["sec_espaco_sub", "Subtítulo", "textarea"],
  ]},
  { grupo: "⭐ Seção Depoimentos", campos: [
    ["sec_dep_eyebrow", "Rótulo", "input"],
    ["sec_dep_title", "Título", "input"],
    ["google_nota", "Selo de avaliação do Google", "input"],
  ]},
  { grupo: "📰 Seção Feed (home)", campos: [
    ["sec_feed_eyebrow", "Rótulo", "input"],
    ["sec_feed_title", "Título", "input"],
    ["sec_feed_sub", "Subtítulo", "textarea"],
  ]},
  { grupo: "📞 Seção Contato", campos: [
    ["sec_contato_eyebrow", "Rótulo", "input"],
    ["sec_contato_title", "Título", "input"],
    ["sec_contato_sub", "Subtítulo", "textarea"],
    ["contato_privacidade", "Aviso abaixo do formulário", "textarea"],
    ["atendimento", "Bloco “Atendemos pacientes…” — uma linha por parágrafo", "bigtext"],
  ]},
  { grupo: "📄 Página Especialidades", campos: [
    ["pg_esp_title", "Título da página", "input"],
    ["pg_esp_lead", "Texto de abertura", "textarea"],
  ]},
  { grupo: "📄 Página Profissionais", campos: [
    ["pg_prof_title", "Título da página", "input"],
    ["pg_prof_lead", "Texto de abertura", "textarea"],
  ]},
  { grupo: "📄 Página Feed", campos: [
    ["pg_feed_title", "Título da página", "input"],
    ["pg_feed_lead", "Texto de abertura", "textarea"],
  ]},
  { grupo: "📄 Página Agendar consulta", campos: [
    ["pg_agendar_title", "Título da página", "input"],
    ["pg_agendar_lead", "Texto de abertura", "textarea"],
  ]},
  { grupo: "📄 Página Privacidade", campos: [
    ["pg_priv_title", "Título da página", "input"],
    ["pg_priv_lead", "Texto de abertura", "textarea"],
  ]},
  { grupo: "🔘 Botões do site", campos: [
    ["btn_hero_1", "Topo — botão principal", "input"],
    ["btn_hero_2", "Topo — botão secundário", "input"],
    ["btn_ver_esp", "Especialidades — ver todas", "input"],
    ["btn_acolhido", "A Clínica — botão", "input"],
    ["btn_ver_prof", "Profissionais — ver todos", "input"],
    ["btn_online_wa", "Online — botão do WhatsApp", "input"],
    ["btn_empresas", "Para Empresas — botão", "input"],
    ["btn_ver_feed", "Feed — ver tudo", "input"],
    ["btn_form_enviar", "Formulário — botão de envio", "input"],
  ]},
  { grupo: "🏷️ Selos e faixa rolante", campos: [
    ["float_a", "Selo 1 sobre a foto do topo", "input"],
    ["float_b", "Selo 2 sobre a foto do topo", "input"],
    ["ticker", "Faixa rolante — uma especialidade por linha", "bigtext"],
    ["mvv_t1", "Título do 1º card (Missão)", "input"],
    ["mvv_t2", "Título do 2º card (Visão)", "input"],
    ["mvv_t3", "Título do 3º card (Valores)", "input"],
  ]},
  { grupo: "🔗 Rodapé e contato", campos: [
    ["footer_h_nav", "Título da coluna de navegação", "input"],
    ["footer_h_atend", "Título da coluna de atendimento", "input"],
    ["footer_tagline", "Frase do rodapé", "textarea"],
    ["whatsapp", "WhatsApp (só números, com 55)", "input"],
    ["whatsapp_display", "WhatsApp como aparece na tela", "input"],
    ["phone_fixed", "Telefone fixo", "input"],
    ["contact_email", "E-mail", "input"],
    ["instagram", "Instagram (sem @)", "input"],
    ["address", "Endereço completo", "textarea"],
    ["footer_horario", "Horário de atendimento (também vai para o Google)", "textarea"],
    ["cnpj", "CNPJ", "input"],
    ["img_og", "Imagem de compartilhamento (WhatsApp/Facebook)", "image"],
  ]},
];
const KEYS = CAMPOS.flatMap((g) => g.campos.map(([k]) => k));
// precisa vir depois de KEYS: a migração consulta a lista para saber o que é editável
migrarTextos();

// garante que a página de manutenção exista em disco desde o primeiro boot —
// o nginx a serve nas quedas, e nessa hora não há app para gerá-la
try {
  const S0 = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S0[r.key] = r.value;
  if (!fs.existsSync(path.join(ROOT, "manutencao.html"))) gerarPaginaManutencao(S0);
} catch { /* nunca impedir o servidor de subir */ }

/* Aplica em qualquer arquivo os textos simples guardados no painel.
   Chaves com formatação própria (listas, imagens) são tratadas à parte. */
const ESPECIAIS = ["stats", "about_bullets", "online_list", "atendimento", "passos_itens", "empresas_cards", "ticker"];

/* Faixa rolante: 4 grupos idênticos para o loop não ter emenda (ver styles.css) */
function renderTicker(S) {
  const itens = String(S.ticker || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!itens.length) return "";
  const grupo = `<div class="ticker__group">${itens.map((i) => `<span>${esc(i)}</span><i>🪷</i>`).join("")}</div>`;
  return Array(4).fill(grupo).join("\n        ");
}

/* Blocos repetidos: cada linha "Título | Descrição [| link]" vira um item */
const linhasDe = (v) => String(v || "").split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => l.split("|").map((p) => p.trim()));

function renderPassos(S) {
  return linhasDe(S.passos_itens).map(([titulo, texto], i) =>
    `<li class="step" data-reveal${i ? ` data-reveal-delay="${i}"` : ""}>
            <span class="step__num">${String(i + 1).padStart(2, "0")}</span>
            <h3 class="step__title">${esc(titulo || "")}</h3>
            <p class="step__text">${esc(texto || "")}</p>
          </li>`).join("\n          ");
}

function renderEmpresas(S) {
  return linhasDe(S.empresas_cards).map(([titulo, texto, link], i) =>
    `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="service__icon">${ICONS[i % ICONS.length]}</div>
            <h3 class="service__title">${esc(titulo || "")}</h3>
            <p class="service__text">${esc(texto || "")}</p>
            ${link ? `<a class="service__more" href="${esc(link)}">Saiba mais →</a>` : ""}
          </article>`).join("\n          ");
}
function aplicarTextos(html, S) {
  for (const chave of KEYS) {
    if (ESPECIAIS.includes(chave) || chave.endsWith("_alt")) continue;
    const MARCA = chave.toUpperCase();
    if (!html.includes(`<!--#${MARCA}-->`)) continue;
    html = setMarker(html, MARCA, chave.startsWith("img_") ? tagImagem(chave, S) : (S[chave] ?? ""));
  }
  // imagem de compartilhamento (og:image / twitter:image) em todas as páginas
  if (S.img_og) {
    const abs = S.img_og.startsWith("http") ? S.img_og : "https://bemestarclinic.com" + S.img_og;
    html = html.replace(/(<meta (?:property|name)="(?:og|twitter):image" content=")[^"]*(")/g, `$1${abs}$2`);
  }
  return html;
}
function slug(s) { return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

/* ------------------------------ Servidor ---------------------------------- */
// `node server.js --publicar` regenera as páginas sem subir o servidor: serve
// para conferir uma alteração de template sem passar pelo painel
if (process.argv.includes("--publicar")) {
  const r = publish();
  console.log(`  publicado: ${JSON.stringify(r)}`);
  process.exit(0);
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Cabeçalhos de segurança em toda resposta
  res.setHeader("X-Content-Type-Options", "nosniff");        // barra MIME sniffing
  res.setHeader("X-Frame-Options", "SAMEORIGIN");            // impede clickjacking no painel
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");

  try {
    /* Modo manutenção: barra o visitante mas deixa passar o painel, a API e os
       assets (a própria página de aviso usa o favicon). Quem tem sessão de
       administrador continua vendo o site normal, para conferir antes de reabrir. */
    if (emManutencao() && !p.startsWith("/admin") && !p.startsWith("/api/")
        && !p.startsWith("/assets/") && !p.startsWith("/.well-known/") && !authed(req)) {
      const arq = path.join(ROOT, "manutencao.html");
      const corpo = fs.existsSync(arq) ? fs.readFileSync(arq) : "Estamos atualizando o site. Volte em instantes.";
      // 503 + Retry-After: diz ao Google que é temporário. Com 200 ele indexaria
      // a página de aviso; com 404 acharia que o site sumiu.
      res.writeHead(503, { "Content-Type": MIME[".html"], "Retry-After": "3600", "Cache-Control": "no-store" });
      return res.end(corpo);
    }

    if (p.startsWith("/api/")) {
      if (p === "/api/login" && req.method === "POST") {
        const ip = clientIp(req);
        const faltam = loginBloqueado(ip);
        if (faltam) return json(res, 429, { error: `Muitas tentativas. Tente de novo em ${faltam} min.` });
        const { password } = await readBody(req);
        const guardado = getS("admin_password_hash");
        if (!confereSenha(password, guardado)) {
          registrarErro(ip);
          console.warn(`  ⚠ senha incorreta no painel — origem ${ip}`);
          return json(res, 401, { error: "Senha incorreta" });
        }
        // migração transparente: quem ainda estava no sha256 sobe para scrypt
        // no primeiro login certo, sem precisar trocar de senha
        if (senhaEhAntiga(guardado)) {
          setS("admin_password_hash", hashSenha(password));
          console.log("  · senha do painel migrada de sha256 para scrypt");
        }
        tentativas.delete(ip);
        const t = crypto.randomBytes(24).toString("hex");
        sessions.set(t, Date.now());
        // Secure só quando a requisição chegou por HTTPS (nginx informa no X-Forwarded-Proto).
        // Em produção isso impede que o cookie de sessão trafegue em claro.
        const https = req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; Path=/; SameSite=Lax${https ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (!authed(req)) return json(res, 401, { error: "Não autenticado" });
      if (p === "/api/me") return json(res, 200, { ok: true, version: APP_VERSION });
      if (p === "/api/stats") return json(res, 200, statsAcessos());
      if (p === "/api/manutencao") {
        if (req.method === "POST") {
          const { ligar, titulo, texto } = await readBody(req);
          if (titulo !== undefined) setS("manutencao_titulo", titulo);
          if (texto !== undefined) setS("manutencao_texto", texto);
          setS("manutencao", ligar ? "1" : "0");
          const S = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S[r.key] = r.value;
          gerarPaginaManutencao(S);   // regrava o arquivo que o nginx usa nas quedas
          console.log(`  · modo manutenção ${ligar ? "LIGADO" : "desligado"}`);
        }
        return json(res, 200, { ok: true, ligado: emManutencao(),
          titulo: getS("manutencao_titulo") || "", texto: getS("manutencao_texto") || "" });
      }
      if (p === "/api/logout" && req.method === "POST") {
        const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); if (m) sessions.delete(m[1]);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/password" && req.method === "POST") {
        const { current, next } = await readBody(req);
        if (!confereSenha(current, getS("admin_password_hash"))) return json(res, 400, { error: "Senha atual incorreta" });
        if (!next || String(next).length < 8) return json(res, 400, { error: "A nova senha precisa ter pelo menos 8 caracteres" });
        if (confereSenha(next, getS("admin_password_hash"))) return json(res, 400, { error: "A nova senha é igual à atual" });
        setS("admin_password_hash", hashSenha(next));
        // trocar a senha derruba as outras sessões: se alguém tinha um cookie
        // roubado, ele para de valer no momento da troca
        const meu = (/sid=([a-f0-9]+)/.exec(req.headers.cookie || "") || [])[1];
        for (const k of [...sessions.keys()]) if (k !== meu) sessions.delete(k);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/content") {
        const S = {}; for (const k of KEYS) S[k] = getS(k) || "";
        return json(res, 200, {
          settings: S,
          campos: CAMPOS,   // o painel monta a tela "Textos do site" a partir daqui
          services: db.prepare("SELECT * FROM services ORDER BY sort,id").all(),
          portfolio: db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all(),
          testimonials: db.prepare("SELECT * FROM testimonials ORDER BY sort,id").all(),
          team: db.prepare("SELECT * FROM team ORDER BY sort,id").all(),
          posts: db.prepare("SELECT * FROM posts ORDER BY date DESC, id DESC").all(),
        });
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = await readBody(req);
        for (const [k, v] of Object.entries(b)) if (KEYS.includes(k)) setS(k, v);
        return json(res, 200, { ok: true });
      }
      const tm = p.match(/^\/api\/(services|portfolio|testimonials|team|posts)(?:\/(\d+))?$/);
      if (tm) {
        const table = tm[1], id = tm[2], cols = TABLES[table];
        if (req.method === "POST" && !id) {
          const b = await readBody(req);
          if ((table === "services" || table === "posts") && (b.slug || b.title)) {
            b.slug = slug(b.slug || b.title || table) || table;
            const clash = db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(b.slug);
            if (clash) b.slug = `${b.slug}-${Date.now().toString(36)}`;
          }
          const use = cols.filter((c) => c in b);
          db.prepare(`INSERT INTO ${table}(${use.join(",")}) VALUES(${use.map(() => "?").join(",")})`).run(...use.map((c) => b[c]));
          return json(res, 200, { ok: true });
        }
        if (req.method === "PUT" && id) {
          const b = await readBody(req);
          if ((table === "services" || table === "posts") && ("slug" in b || "title" in b)) {
            b.slug = slug(b.slug || b.title || table) || table;
            const clash = db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(b.slug);
            if (clash && String(clash.id) !== String(id)) b.slug = `${b.slug}-${Date.now().toString(36)}`;
          }
          const use = cols.filter((c) => c in b);
          if (use.length) db.prepare(`UPDATE ${table} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && id) {
          db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
          return json(res, 200, { ok: true });
        }
      }
      if (p === "/api/upload" && req.method === "POST") {
        const { name, dataUrl } = await readBody(req);
        const m = /^data:(image\/(?:png|jpe?g|webp|svg\+xml|gif));base64,(.+)$/.exec(dataUrl || "");
        if (!m) return json(res, 400, { error: "Envie uma imagem (png, jpg, webp, svg ou gif)" });
        const safe = slug(path.parse(name || "foto").name).slice(0, 40) || "foto";
        const ext = m[1] === "image/svg+xml" ? ".svg" : "." + m[1].split("/")[1].replace("jpeg", "jpg");
        const file = `${Date.now().toString(36)}-${safe}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
        return json(res, 200, { ok: true, path: `/assets/img/uploads/${file}` });
      }
      if (p === "/api/publish" && req.method === "POST") return json(res, 200, { ok: true, ...publish() });
      return json(res, 404, { error: "Rota não encontrada" });
    }

    if (p === "/admin" || p === "/admin/") {
      // no-store: painel autenticado não deve ficar em cache — e garante que a
      // versão mostrada na tela de login seja sempre a que está rodando agora
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
      const adminHtml = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8")
        .replaceAll("{{APP_VERSION}}", APP_VERSION);
      return res.end(adminHtml);
    }
    /* Nunca servir: banco, fontes, metadados de repositório e arquivos ocultos.
       O /.git é o mais crítico — com ele, um git-dumper reconstrói o repositório
       inteiro (histórico incluso) a partir do site publicado.
       Exceção: /.well-known/ precisa passar, é por onde o Let's Encrypt valida
       o domínio para emitir e renovar o certificado. */
    const ocultoProibido = /(^|\/)\.(?!well-known\/)/.test(p);
    const extProibida = /\.(js|json|md|db|log|bak|sqlite3?|ya?ml|toml|lock)$/i.test(p) && !p.startsWith("/assets/");
    if (/^\/(data|src|node_modules)(\/|$)/.test(p) || ocultoProibido || extProibida) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404");
    }

    let file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("403"); }
    if (p === "/") file = path.join(ROOT, "index.html");
    else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }

    // Conta só a entrega de uma PÁGINA (não CSS, JS, imagem, sitemap ou robots):
    // é isso que faz 1 visita valer 1, e não 15 por causa dos assets da página.
    if (path.extname(file) === ".html") trackVisit(req, p);

    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) {
    // detalhe do erro vai só para o log do servidor: mensagem de exceção
    // costuma revelar caminho de arquivo e estrutura interna
    console.error(`  ✖ erro em ${p}:`, e.message);
    json(res, 500, { error: "Erro interno" });
  }
// Escuta só no localhost: quem fala com o mundo é o nginx. Sem isto, o painel
// ficaria acessível por http://IP:5185/admin/, sem HTTPS e sem cookie Secure.
// Para expor direto (ambiente sem proxy), rode com HOST=0.0.0.0
}).listen(PORT, process.env.HOST || "127.0.0.1", () => {
  console.log(`\n  BemEstarClinic — site + gerenciador v${APP_VERSION}`);
  console.log(`  · Site:   http://localhost:${PORT}/`);
  console.log(`  · Painel: http://localhost:${PORT}/admin/`);

  // Testa a escrita no boot. Sem isto, um banco somente-leitura só aparece
  // quando o cliente tenta salvar algo e nada acontece — e o log fica mudo.
  try {
    setS("_teste_escrita", String(Date.now()));
    db.prepare("DELETE FROM settings WHERE key='_teste_escrita'").run();
  } catch (e) {
    const usuario = (() => { try { return require("node:os").userInfo().username; } catch { return "root"; } })();
    console.error(`  ✖ BANCO SEM PERMISSÃO DE ESCRITA: ${e.message}`);
    console.error("    O painel não vai conseguir salvar nada. O processo roda como:", usuario);
    console.error(`    Corrija com: sudo chown -R ${usuario}: "${ROOT}/data" "${ROOT}/assets/img/uploads"`);
  }
  // avisa sem imprimir a senha: em produção esse log vai parar no journalctl
  if (confereSenha("bemestar-admin", getS("admin_password_hash")))
    console.log(`  ⚠ A senha do painel ainda é a padrão. Troque em Painel → Senha antes de publicar.\n`);
  else console.log("");
});
