/* ==========================================================================
   server.js — Gerenciador do site BemEstarClinic
   Node puro + SQLite (driver escolhido em db.js).
   · Site:   http://localhost:5185/
   · Painel: http://localhost:5185/admin/   (senha inicial mostrada só no 1º boot)
   "Publicar" regenera o index.html (marcadores <!--#KEY-->) e o config.js.
   ========================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { abrirBanco, DRIVER_NOME, DRIVER_AVISO } = require("./db");
const { criarLimitador } = require("./limitador");
const { agendarBackups } = require("./backup");
const { tratarUpload, disponivel: imagemPronta } = require("./imagem");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5185;   // PORT por env permite subir uma cópia de teste

/* Versão do gerenciador — fonte única da verdade. O painel lê daqui pela API,
   não do HTML: assim, mesmo com o navegador servindo o admin do cache, o número
   exibido é sempre o da versão que está REALMENTE rodando no servidor.
   Subir ao publicar alterações no painel ou no server.js. */
const APP_VERSION = "1.29.0";

/* ==========================================================================
   CONSULTA DE CEP
   Fonte: ViaCEP (base dos Correios, aberta e sem chave). Se ela falhar, tenta a
   BrasilAPI — assim o preenchimento não morre por indisponibilidade de um
   serviço. A API oficial dos Correios exige contrato e credencial; estas duas
   servem os mesmos dados de endereçamento.
   O resultado fica em cache por 30 dias: CEP praticamente não muda, e isso
   evita ir à internet a cada tecla.
   ========================================================================== */
const cacheCep = new Map();               // cep -> { dados, ts }
const CEP_TTL = 30 * 24 * 3600e3;         // 30 dias
const cepPorIp = new Map();               // ip -> { n, ts }
const CEP_MAX = 60, CEP_JANELA = 60e3;    // 60 consultas por minuto por IP
function podeConsultarCep(ip) {
  const t = cepPorIp.get(ip);
  if (!t || Date.now() - t.ts > CEP_JANELA) { cepPorIp.set(ip, { n: 1, ts: Date.now() }); return true; }
  t.n++;
  return t.n <= CEP_MAX;
}
setInterval(() => { const lim = Date.now() - CEP_JANELA; for (const [k, v] of cepPorIp) if (v.ts < lim) cepPorIp.delete(k); }, 5 * 60e3).unref();

async function pegarJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);   // não deixa a request pendurada
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "BemEstarClinic/1.0" } });
    if (!r.ok) return null;
    return await r.json();
  } finally { clearTimeout(timer); }
}
/* Devolve sempre o mesmo formato, venha de onde vier. */
async function buscarCep(cep) {
  try {
    const v = await pegarJson(`https://viacep.com.br/ws/${cep}/json/`);
    if (v && !v.erro && v.localidade) {
      return { cep, logradouro: v.logradouro || "", complemento: v.complemento || "",
        bairro: v.bairro || "", cidade: v.localidade, uf: v.uf || "" };
    }
    if (v && v.erro) return null;                        // CEP inexistente: não adianta tentar de novo
  } catch (e) { /* cai para a segunda fonte */ }
  const b = await pegarJson(`https://brasilapi.com.br/api/cep/v1/${cep}`);
  if (b && b.city) {
    return { cep, logradouro: b.street || "", complemento: "",
      bairro: b.neighborhood || "", cidade: b.city, uf: b.state || "" };
  }
  return null;
}

/* CSP do painel /admin. Segunda linha de defesa: mesmo que um texto vindo do
   banco escape do escape do HTML, o navegador recusa script de outra origem,
   <object>/<embed> e a página dentro de um iframe alheio. 'unsafe-inline' é
   necessário porque o painel usa <script> e style inline. */
const CSP_PAINEL = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";

/* Sistema de gestão da clínica (/restrito) — app INDEPENDENTE deste painel.
   Compartilha só o processo e a porta; banco, sessão e login são separados. */
/* O .env é lido ANTES do require do restrito.js: aquele módulo monta a conexão
   do Postgres a partir das variáveis de ambiente, então elas precisam já estar
   no lugar. Em produção quem as entrega é o systemd (EnvironmentFile) e este
   carregarEnv não acha arquivo nenhum — o que está certo. */
const { Q, carregarAmbiente } = require("./pg");
carregarAmbiente(__dirname);
const { handleRestrito, iniciarRestrito, sessao: sessaoRestrito, auditar: auditarRestrito,
        registrarEncerrarPainel, aoMudarEquipe,
        /* O paciente respondendo pelo link. A lógica fica lá, junto dos dados
           e das regras de quem pode abrir; aqui só há a rota pública. */
        estadoDoLink, iniciarTeste, concluirTeste, salvarRascunho,
        abrirComNascimento } = require("./restrito");

/* ==========================================================================
   LA CHAT — módulo instalado, não biblioteca copiada

   `lachat.js` é o conector do projeto LA-Chat, copiado para cá inteiro. Ele
   não lê o nosso banco, não grava arquivo, não abre porta: repassa as rotas
   `/chat/*` para o serviço do chat e emite o PASSE que diz quem está logado.

   ATUALIZAR o chat é substituir este arquivo — `npm run chat:atualizar`.

   POR QUE A SESSÃO DO /restrito, e não a do /admin: o chat é da EQUIPE da
   clínica (profissionais, secretaria, administração), que é exatamente quem
   tem conta no sistema de gestão. O /admin é o painel do SITE, com uma senha
   só, compartilhada — ali não há "quem", e um chat sem quem não é chat.

   Visitante do site e paciente respondendo teste recebem `null` daqui, e para
   eles o chat simplesmente não existe.
   ========================================================================== */
const conectorChat = require("./lachat");
/* Declarado ANTES do uso. Funcionaria depois — a referência vive dentro de uma
   função, que só roda em tempo de requisição —, mas quem lesse o `usuario()`
   pararia para checar se é um erro de zona morta. */
const CARGO_POR_PERFIL = {
  admin: "Administração", secretaria: "Recepção", profissional: "Profissional de saúde",
};
const chat = conectorChat({
  url: process.env.CHAT_URL || "http://127.0.0.1:5197",
  segredo: process.env.CHAT_SEGREDO_PASSE,
  contexto: "bemestarclinic",       // separa os dados desta clínica dos outros sites

  /* SOB /restrito, e não na raiz — por causa do COOKIE.
     A sessão da gestão é gravada com `Path=/restrito`, isolamento decidido na
     auditoria de segurança para que ela nunca acompanhe uma requisição do site
     público nem do /admin. O navegador respeita esse caminho ao pé da letra:
     com o chat em `/chat/passe`, o cookie simplesmente NÃO era enviado, e o
     passe respondia 401 — enquanto o mesmo endereço no `curl`, com o cookie
     na mão, respondia 200. O sintoma acusava autenticação; a causa era rota.
     Movendo o chat para dentro de /restrito, o cookie volta a valer sem
     afrouxar nada. */
  prefixo: "restrito/chat",

  usuario(req) {
    /* SÍNCRONO por contrato — o conector não espera Promise. Por isso só o que
       a sessão já carrega entra aqui: uma consulta ao banco devolveria uma
       Promise, o conector a trataria como objeto e o passe sairia com
       `id: undefined`. Falharia em silêncio, com todo mundo virando o mesmo
       usuário no chat. */
    const s = sessaoRestrito(req);
    if (!s || !s.userId) return null;
    return {
      id: s.userId,                 // id de g_usuarios: estável e único
      nome: s.nome,
      /* O cargo aparece ao lado do nome na lista do chat. É o que distingue
         "Maria da recepção" de "Maria psicóloga" quando as duas conversam. */
      cargo: CARGO_POR_PERFIL[s.perfil] || "Equipe",
      papel: s.perfil === "admin" ? "admin" : "membro",
    };
  },
});

const UPLOAD_DIR = path.join(ROOT, "assets", "img", "uploads");
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = abrirBanco(path.join(ROOT, "data", "site.db"));
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

/* O IP REAL de quem está pedindo.

   Atrás do nginx o socket é sempre 127.0.0.1, então o IP verdadeiro precisa
   chegar por cabeçalho. Só que cabeçalho é texto que o CLIENTE também
   escreve. O nginx monta `X-Forwarded-For: <o que o cliente mandou>, <IP
   real>` — ele ACRESCENTA no fim, não substitui. Ler o PRIMEIRO item da lista,
   como estava aqui, é ler exatamente o que o visitante digitou.

   Na prática isso anulava a trava de força bruta: bastava mandar um
   X-Forwarded-For diferente a cada tentativa para nenhuma "contar" duas vezes
   no mesmo IP, e a senha podia ser tentada infinitas vezes.

   Duas correções: o cabeçalho só é aceito quando a conexão de fato veio do
   nginx local, e usamos o X-Real-IP — que o nginx SOBRESCREVE — ou, na falta
   dele, o ÚLTIMO item da lista, o único que o nginx escreveu. */
const DO_PROXY = /^(?:::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/;
function clientIp(req) {
  const direto = String(req.socket.remoteAddress || "");
  if (!DO_PROXY.test(direto)) return direto;                      // conexão direta: só o socket vale
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const lista = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.length ? lista[lista.length - 1] : direto;
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

/* ------------------------------ Sessões ----------------------------------
   Os números da força bruta saíram daqui: agora moram em limitador.js, junto
   das regras que os usam. */
const SESSAO_HORAS = 12;          // sessão parada por mais que isso, cai

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

/* Sair do sistema de gestão encerra também a sessão do painel DESTE navegador.
   Quem entrou aqui pelo atalho de 9 pontos não digitou a senha do painel: a
   porta foi aberta pela credencial do /restrito, e some junto com ela.

   Quem entrou no painel pela senha, no mesmo navegador, também sai — e é o
   comportamento certo num computador de recepção, onde "saí do sistema"
   precisa querer dizer que o computador ficou trancado.

   Devolve true se havia mesmo uma sessão para encerrar; é o que permite ao
   /restrito só limpar o cookie quando fez sentido. */
registrarEncerrarPainel((req) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m || !sessions.has(m[1])) return false;
  sessions.delete(m[1]);
  console.log("  · /admin: sessão encerrada junto com a saída do /restrito");
  return true;
});

/* FREIO CONTRA ADIVINHAÇÃO DE SENHA — ver limitador.js.

   A trava anterior contava só por IP, e por isso não enxergava o ataque
   distribuído: a conta é uma só, mas os IPs não, então uma lista de proxies
   dava um orçamento novo de cinco tentativas a cada endereço e o bloqueio
   nunca disparava. O limitador soma também POR CONTA, faz a espera crescer a
   cada erro e grava a contagem em disco — antes ela morria no reinício
   automático de madrugada, devolvendo o orçamento inteiro ao atacante. */
/* O arquivo é configurável por ambiente PARA AS SUÍTES, e só. Elas erram
   senha e data de propósito — é o que testam — e, gravando no mesmo arquivo
   do sistema, iam empilhando bloqueio de uma execução para a outra até a
   própria suíte não conseguir mais entrar. Um teste que fica vermelho por
   causa da execução anterior deixa de ser teste. */
const limite = criarLimitador({
  arquivo: process.env.LIMITES_ARQUIVO || path.join(ROOT, "data", "limites.json"),
});
limite.carregar();
process.on("exit", () => limite.gravar());

setInterval(() => {
  const agora = Date.now();
  limite.limpar();
  for (const [k, v] of sessions) if (agora - v > SESSAO_HORAS * 3600_000) sessions.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------ Publicar --------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ==========================================================================
   TEXTO FORMATADO DO PAINEL

   O painel ganhou um editor com negrito, listas e links, e o que ele grava é
   HTML. Isso significa que o site passa a IMPRIMIR marcação vinda do banco —
   e é aí que mora o risco: um texto colado de fora traria script, iframe e
   estilo junto, e o site é público.

   A regra é LISTA DE PERMITIDOS. Só o que está aqui passa; o resto vira texto.
   Lista de proibidos sempre esquece alguma coisa, e a que esquecer é a que vai
   ser usada.

   `href` é o único atributo aceito, e só em <a>, com o esquema conferido:
   `javascript:` num link é execução de código com a cara de um link comum.
   ========================================================================== */
/* Com o botão "</>" dá para escrever marcação à mão, e uma tag que não estivesse
   nesta lista sumiria calada — a pessoa salvaria a tabela e ela simplesmente não
   apareceria no site. Por isso a lista cobre também o que se escreve à mão.
   Todas as adições são INERTES: não executam nada e ficam sem atributo nenhum,
   porque htmlLimpo só preserva o href do <a>. Continuam de fora img (sem src
   sobra uma tag vazia — foto é pelo campo de imagem) e tudo que roda código. */
const TAGS_SITE = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li",
  "h2", "h3", "h4", "blockquote", "a", "span", "div", "hr", "sub", "sup", "code", "pre",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption"]);
const LINK_SEGURO = /^(https?:\/\/|mailto:|tel:|\/|#)/i;

function htmlLimpo(valor) {
  if (valor === null || valor === undefined) return valor;
  let s = String(valor);
  if (!s.includes("<")) return s;                     // texto puro: nada a fazer

  /* Fora antes de tudo: o conteúdo destas some junto com a tag. Remover só a
     tag deixaria o código do script solto como texto visível na página. */
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[^>]*\/?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, nome, attrs) => {
    const n = nome.toLowerCase();
    if (!TAGS_SITE.has(n)) return "";                 // descarta a tag, mantém o texto
    if (tag.startsWith("</")) return `</${n}>`;
    if (n === "br") return "<br>";
    if (n === "a") {
      const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || "");
      const href = m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
      if (!href || !LINK_SEGURO.test(href)) return "<a>";
      const externo = /^https?:\/\//i.test(href);
      return `<a href="${esc(href)}"${externo ? ' target="_blank" rel="noopener"' : ""}>`;
    }
    return `<${n}>`;                                   // todo o resto sem atributo
  });
}

/* Quais campos aceitam formatação. Fora daqui, o texto é gravado como veio.

   Os RESUMOS (`posts.excerpt`, `services.text`) ficam de propósito de fora:
   eles viram a descrição do Google e o JSON-LD, onde uma tag aparece crua no
   resultado de busca. O endereço também — entra no JSON-LD da clínica. */
const CAMPOS_RICOS = {
  posts: ["content"],
  services: ["content"],
  testimonials: ["text"],
  team: ["bio"],
};
function limparRicos(tabela, obj) {
  for (const c of CAMPOS_RICOS[tabela] || []) if (c in obj) obj[c] = htmlLimpo(obj[c]);
  return obj;
}

/* Um bloco de texto do painel, pronto para entrar na página.

   Convive com os dois formatos porque o conteúdo antigo é TEXTO PURO com
   parágrafos separados por linha em branco — e continua sendo, até alguém
   reabrir aquele texto no editor. Sem esta ponte, todo o conteúdo já
   publicado viraria um parágrafo só na primeira publicação depois desta
   versão. */
/* ==========================================================================
   TAMANHO REAL DA IMAGEM

   O `width`/`height` do <img> não muda o tamanho na tela (quem manda é o CSS):
   ele diz ao navegador a PROPORÇÃO, para reservar o espaço certo antes de a
   imagem carregar. Sem isso a página dá um pulo quando ela chega — e o número
   errado é pior que nenhum, porque reserva um retângulo deitado para uma foto
   em pé.

   A capa da matéria vinha com `width="900" height="500"` fixos no template. A
   clínica sobe foto de WhatsApp, que quase sempre está EM PÉ: o navegador
   reservava paisagem e o CSS recortava o resto.

   Lê direto do cabeçalho do arquivo, sem biblioteca: são os primeiros bytes de
   cada formato. Só vale para os nossos uploads — imagem de fora (Unsplash) é
   uma URL, e buscá-la aqui deixaria a publicação dependendo da internet. Nesse
   caso não declaramos nada, e o CSS acerta a proporção quando a imagem chega.
   ========================================================================== */
function medirImagem(url) {
  /* Vale para QUALQUER imagem nossa sob /assets/img/, não só os uploads: as
     fotos do Nosso Espaço e dos profissionais moram em subpastas próprias e
     também precisam de width/height, senão a página pula quando carregam (CLS).
     `..` é recusado explicitamente — a classe [A-Za-z0-9._-] o aceitaria — e o
     caminho resolvido ainda tem de cair dentro de assets/img. */
  const m = /^\/assets\/img\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/.exec(String(url || ""));
  if (!m || m[1].split("/").includes("..")) return null;
  const raiz = path.join(ROOT, "assets", "img");
  const arq = path.resolve(raiz, m[1]);
  if (arq !== raiz && !arq.startsWith(raiz + path.sep)) return null;
  let b;
  try { b = fs.readFileSync(arq); } catch { return null; }

  // PNG: largura e altura em big-endian logo depois do IHDR
  if (b.length > 24 && b.toString("hex", 0, 8) === "89504e470d0a1a0a")
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };

  // GIF: little-endian, no cabeçalho
  if (b.length > 10 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a"))
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };

  // WEBP (VP8 simples, VP8L sem perdas e VP8X estendido guardam em lugares diferentes)
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const tipo = b.toString("ascii", 12, 16);
    if (tipo === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (tipo === "VP8L") {
      const n = b.readUInt32LE(21);
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
    }
    if (tipo === "VP8X") return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
  }

  // JPEG: percorre os segmentos até achar o "start of frame", que carrega o tamanho
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }                 // ressincroniza em byte de preenchimento
      const marca = b[i + 1];
      if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) { i += 2; continue; }
      const tam = b.readUInt16BE(i + 2);
      /* SOF0..SOF15, menos DHT (c4), JPG (c8) e DAC (cc), que não são frames.
         É onde moram altura e largura — nesta ordem. */
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc)
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      if (tam < 2) break;                                    // tamanho inválido: para em vez de girar
      i += 2 + tam;
    }
  }
  return null;
}

/* Os atributos prontos para entrar no <img>, ou vazio se não dá para saber. */
function medidasDoImg(url) {
  const d = medirImagem(url);
  return d && d.w && d.h ? ` width="${d.w}" height="${d.h}"` : "";
}

/* ==========================================================================
   TÍTULO DA ABA (<title>) — alvo de 30 a 62 caracteres.

   Acima de ~62 o Google corta na exibição, e o corte cai no FIM, justamente
   onde costuma estar a cidade. Abaixo de ~30 sobra espaço e falta o termo pelo
   qual as pessoas procuram.

   Só o <title> passa por aqui. O <h1> e o og:title continuam com o título
   INTEIRO que o cliente escreveu — encurtar o cartão de compartilhamento não
   traria ganho nenhum e tiraria contexto de quem recebe o link.
   ========================================================================== */
const MARCA_TITULO = "BemEstarClinic";
function tituloTag(base, local = true) {
  let t = String(base || "").replace(/\s+/g, " ").trim();
  if (!t) return MARCA_TITULO;

  if (t.length > 62) {
    /* 1º corte: na pontuação que FECHA a ideia. "Ozonioterapia e Detox Iônico:
       como funciona o Protocolo Integrativo" vira "Ozonioterapia e Detox
       Iônico" — frase completa, palavra principal na frente. Cortar direto em
       62 deixaria "…como funciona o Protocolo", pendurado, que lê como título
       quebrado no resultado de busca. */
    const m = /^(.{20,62}?)\s*([?:—–|])/.exec(t);
    if (m) t = m[1] + (m[2] === "?" ? "?" : "");
  }
  if (t.length > 62) {
    // 2º corte: palavra inteira, e só se ainda sobrar título de verdade
    const corte = t.slice(0, 62);
    const esp = corte.lastIndexOf(" ");
    t = esp >= 40 ? corte.slice(0, esp).replace(/[\s,;:.—–-]+$/, "") : t;
  }

  // curto demais ganha marca (e a cidade, que é o que traz busca local)
  const sufixos = local ? [` | ${MARCA_TITULO} Caruaru`, ` | ${MARCA_TITULO}`] : [` | ${MARCA_TITULO}`];
  if (t.length < 45) for (const s of sufixos) if (t.length + s.length <= 62) return t + s;
  return t;
}

function blocoTexto(valor) {
  const s = String(valor || "").trim();
  if (!s) return "";
  if (/<(p|br|ul|ol|li|h2|h3|h4|blockquote|div|strong|b|em|i|a)\b/i.test(s)) return htmlLimpo(s);
  return s.split(/\n{2,}/).map((par) => `<p>${esc(par.trim()).replace(/\n/g, "<br>")}</p>`).join("\n        ");
}
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
  /* NÍVEL DO TÍTULO DO CARD — o mesmo card é usado em dois contextos:
     · na home ele vem DEPOIS de um <h2 class="section__title">, então é h3;
     · em /blog/ e /especialidades/ ele vem logo depois do <h1> da página, e h3
       ali pularia um nível (quebra a leitura por leitor de tela e enfraquece a
       estrutura do conteúdo).
     `nivelH` só aceita 2 ou 3: estas funções também são chamadas dentro de
     .map(), que passaria o ÍNDICE ou o ARRAY como argumento — sem a
     normalização, o 3º post da lista viraria h2 sozinho. */
  const nivelH = (n) => (n === 2 ? 2 : 3);

  const postCard = (p, nv) => `<article class="post-card" data-reveal>
            <a class="post-card__media" href="/blog/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img src="${esc(p.image)}" alt="${esc(p.title)} — BemEstarClinic, Caruaru-PE" loading="lazy" decoding="async" width="900" height="500"></a>
            <div class="post-card__body">
              <time class="post-card__date" datetime="${esc(p.date)}">${dateBR(p.date)}</time>
              <h${nivelH(nv)} class="post-card__title"><a href="/blog/${esc(p.slug)}/">${esc(p.title)}</a></h${nivelH(nv)}>
              <p class="post-card__excerpt">${esc(p.excerpt)}</p>
              <a class="post-card__more" href="/blog/${esc(p.slug)}/">Ler matéria →</a>
            </div>
          </article>`;

  const stats = JSON.parse(S.stats || "[]").map((s) =>
    `<div class="stat"><dd class="stat__num">${esc(s.num)}</dd><dt class="stat__label">${esc(s.label)}</dt></div>`).join("\n            ");

  const svcCard = (s, i, nv) => `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="service__icon">${ICONS[i % ICONS.length]}</div>
            <h${nivelH(nv)} class="service__title">${esc(s.title)}</h${nivelH(nv)}>
            <p class="service__text">${esc(s.text)}</p>
            <a class="service__more" href="/especialidades/${esc(s.slug)}/">Saiba mais →</a>
          </article>`;
  // home: sob o <h2> da seção Especialidades → h3
  const servicesHtml = services.slice(0, 9).map((s, i) => svcCard(s, i, 3)).join("\n          ");
  // /especialidades/: logo abaixo do <h1> da página → h2
  const servicesAllHtml = services.map((s, i) => svcCard(s, i, 2)).join("\n          ");

  // width/height medidos no próprio arquivo: sem eles o navegador não reserva o
  // espaço e a galeria do Nosso Espaço empurra o resto da página quando as fotos
  // chegam — é exatamente o CLS que o Core Web Vitals mede.
  const worksHtml = works.map((w, i) => `<figure class="work" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}><img src="${esc(w.image)}" alt="${esc(w.title)}${w.subtitle ? ` — ${esc(w.subtitle)}` : ""}, na BemEstarClinic em Caruaru-PE" loading="lazy" decoding="async"${medidasDoImg(w.image)}><figcaption class="work__label">${esc(w.title)}<small>${esc(w.subtitle || "")}</small></figcaption></figure>`).join("\n          ");

  const bullets = JSON.parse(S.about_bullets || "[]").map((b) => `<li>${CHECK} ${esc(b)}</li>`).join("\n            ");

  // na home entram só os marcados (hoje, os dois diretores); o guia completo
  // fica em /profissionais/, que lista todo mundo
  const teamHome = team.filter((m) => Number(m.na_home) === 1);
  const teamHtml = teamHome.map((m, i) => `<article class="card pro" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <figure class="pro__photo"><img src="${esc(m.photo)}" alt="${esc(m.name)} — ${esc(m.role)}" loading="lazy" width="300" height="340"></figure>
            <h3 class="pro__name">${esc(m.name)}</h3>
            <p class="pro__role">${esc(m.role)}</p>
            <div class="pro__bio">${blocoTexto(m.bio)}</div>
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
      /* Coordenadas conferidas pelo cliente no Google Maps (12/08/2026). É o que
         o Google usa para decidir se a clínica aparece na busca do mapa e no
         bloco local — endereço por extenso sozinho depende de geocodificação. */
      geo: { "@type": "GeoCoordinates", latitude: -8.260997, longitude: -35.966046 },
      // mesmos perfis declarados no Organization: um perfil só, duas entidades
      sameAs: [`https://www.instagram.com/${S.instagram}/`, "https://www.doctoralia.com.br/clinicas/bemestarclinic"],
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
  // home: sob o <h2> da seção Feed → h3
  html = setMarker(html, "BLOG", "          " + posts.slice(0, 3).map((p) => postCard(p, 3)).join("\n          "));
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
    const paragraphs = blocoTexto(sv.content || sv.text);
    // "Outras especialidades" já tem um <h2> próprio acima → h3
    const others = services.filter((x) => x.id !== sv.id).slice(0, 3).map((s, i) => svcCard(s, i, 3)).join("\n          ");
    // meta description própria: prefixo local + resumo, cortado em palavra inteira (≤158)
    const prefixo = `${sv.title} em Caruaru-PE e online. `;
    const resto = String(sv.text || "").replace(/\s+/g, " ").trim();
    let metaEsp = prefixo + resto;
    if (metaEsp.length > 158) {
      const corte = metaEsp.slice(0, 155);
      metaEsp = corte.slice(0, corte.lastIndexOf(" ")) + "…";
    }
    /* Três degraus, do mais completo ao mais enxuto. O 3º faltava: com um nome
       longo ("Protocolo Integrativo: Ozonioterapia e Detox Iônico"), até o
       formato curto passava de 62 e o Google cortava fora a cidade. */
    const tLongo = `${sv.title} em Caruaru-PE e Online`;
    const tMedio = `${sv.title} — Caruaru-PE`;
    const espTitleTag = tLongo.length <= 62 ? tLongo : (tMedio.length <= 62 ? tMedio : tituloTag(sv.title));
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
            ${m.bio ? `<div class="prof-card__bio">${blocoTexto(m.bio)}</div>` : ""}
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
  /* URL absoluta da capa — o mesmo cuidado do JSON-LD de cada post: caminho
     relativo é inválido em dados estruturados. */
  const capaAbs = (im) => (im ? (im.startsWith("http") ? im : SITE + im) : `${SITE}/assets/img/og-image.png`);
  /* A listagem tinha um bloco `Blog` FIXO no template: não citava matéria
     nenhuma, não tinha trilha e envelhecia a cada post novo. Agora sai do banco,
     como já era em /especialidades/ — o `blogPost` diz ao Google o que existe
     aqui dentro, e o BreadcrumbList é o que rende a trilha no resultado. */
  const blogJ = { "@context": "https://schema.org", "@graph": [
    { "@type": "Blog", "@id": `${SITE}/blog/#blog`, name: "Feed — BemEstarClinic",
      url: `${SITE}/blog/`, inLanguage: "pt-BR", description: strip(S.pg_feed_lead) || undefined,
      isPartOf: { "@id": `${SITE}/#site` }, publisher: { "@id": `${SITE}/#org` },
      blogPost: posts.map((po) => ({ "@type": "BlogPosting",
        headline: po.title, url: `${SITE}/blog/${po.slug}/`, datePublished: po.date,
        image: capaAbs(po.image), author: { "@id": `${SITE}/#org` } })) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Feed", item: `${SITE}/blog/` } ] },
  ] };
  fs.writeFileSync(path.join(ROOT, "blog", "index.html"),
    // /blog/: logo abaixo do <h1> da página → h2
    aplicarTextos(blogTpl, S).replaceAll("{{POSTS_HTML}}", "          " + (posts.map((p) => postCard(p, 2)).join("\n          ") || '<p class="blog-empty">Em breve, novidades por aqui! 🪷</p>'))
      .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(blogJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
      .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));
  const keepPosts = new Set(posts.map((x) => x.slug));
  for (const d of fs.readdirSync(path.join(ROOT, "blog"), { withFileTypes: true }))
    if (d.isDirectory() && !keepPosts.has(d.name)) fs.rmSync(path.join(ROOT, "blog", d.name), { recursive: true, force: true });
  for (const po of posts) {
    const paragraphs = blocoTexto(po.content);
    // sem medida no arquivo (imagem de fora), quem reserva o espaço é o CSS
    const dimsPost = medidasDoImg(po.image);
    /* BlogPosting (subtipo de Article) descreve melhor uma matéria de feed e é o
       que o Google espera no resultado enriquecido.
       A IMAGEM PRECISA SER ABSOLUTA: foto enviada pelo painel chega como
       "/assets/img/uploads/…", e URL relativa dentro do JSON-LD é inválida — o
       validador descarta o bloco inteiro e o post fica sem schema nenhum.
       Foto do Unsplash já vem com http e passa direto. */
    const imgAbs = capaAbs(po.image);
    const pj = { "@context": "https://schema.org", "@type": "BlogPosting",
      headline: po.title, description: po.excerpt, image: imgAbs, datePublished: po.date, inLanguage: "pt-BR",
      author: { "@type": "Organization", name: "BemEstarClinic", url: `${SITE}/` },
      publisher: { "@id": `${SITE}/#org` }, mainEntityOfPage: `${SITE}/blog/${po.slug}/`,
      isPartOf: { "@id": `${SITE}/#site` } };
    fs.mkdirSync(path.join(ROOT, "blog", po.slug), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "blog", po.slug, "index.html"),
      aplicarTextos(postTpl, S).replaceAll("{{TITLE_TAG}}", esc(tituloTag(po.title)))
        .replaceAll("{{TITLE}}", esc(po.title)).replaceAll("{{EXCERPT}}", esc(po.excerpt))
        .replaceAll("{{SLUG}}", esc(po.slug)).replaceAll("{{IMAGE_ABS}}", esc(imgAbs)).replaceAll("{{IMAGE}}", esc(po.image))
        .replaceAll("{{IMAGE_DIMS}}", dimsPost)
        .replaceAll("{{COVER_CLASS}}", dimsPost ? "" : " post__cover--reserva")
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

  /* ---------- llms.txt ----------
     O equivalente do robots.txt para assistentes de IA (llmstxt.org): um resumo
     em Markdown do que o site é e do que há dentro dele. Quem responde "qual
     clínica de ozonioterapia tem em Caruaru?" hoje é cada vez mais um
     assistente, e ele acerta muito mais lendo isto do que rastreando o HTML.

     GERADO NO PUBLISH, como o sitemap: um arquivo escrito à mão envelheceria a
     cada especialidade ou matéria nova — que é justamente o defeito que o bloco
     fixo do /blog/ tinha. Tudo aqui vem do BANCO; nada é inventado, e o que o
     cliente não preencheu simplesmente não aparece. */
  const linha = (t) => strip(t).replace(/\s+/g, " ").trim();
  const llms = [
    `# BemEstarClinic`,
    ``,
    `> ${linha(S.hero_lead) || "Clínica de psicanálise, psicologia, ozonioterapia e terapias integrativas."}`,
    ``,
    `Clínica em Caruaru-PE, com atendimento presencial e online para todo o Brasil.`,
    ``,
    `- Endereço: ${linha(S.address)}`,
    `- WhatsApp: ${S.whatsapp_display || ""} (https://wa.me/${S.whatsapp})`,
    S.phone_fixed ? `- Telefone: ${S.phone_fixed}` : null,
    `- E-mail: ${S.contact_email || ""}`,
    `- Horário: ${linha(S.footer_horario)}`,
    `- Agendamento: ${SITE}/agendar/`,
    ``,
    `## Especialidades`,
    ``,
    ...services.filter((s) => s.slug).map((s) => `- [${s.title}](${SITE}/especialidades/${s.slug}/): ${linha(s.text)}`),
    ``,
    `## Profissionais`,
    ``,
    `- [Guia de profissionais](${SITE}/profissionais/): equipe por especialidade.`,
    ...team.map((m) => `  - ${m.name} — ${linha(m.role)}`),
    ``,
    `## Feed`,
    ``,
    ...posts.map((po) => `- [${po.title}](${SITE}/blog/${po.slug}/)${po.date ? ` (${po.date})` : ""}: ${linha(po.excerpt)}`),
    ``,
    `## Institucional`,
    ``,
    `- [Política de Privacidade](${SITE}/privacidade/): tratamento de dados pessoais conforme a LGPD.`,
    `- CNPJ: ${S.cnpj || ""}`,
    ``,
    // `null` some (campo não preenchido); "" é linha em branco de propósito,
    // e o Markdown depende dela para separar as seções
  ].filter((l) => l !== null).join("\n");
  fs.writeFileSync(path.join(ROOT, "llms.txt"), llms.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");

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
    ["address", "Endereço completo", "endereco_cep"],
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
  /* Imagem de compartilhamento (og:image / twitter:image) em todas as páginas.
     EXCEÇÃO: quando o valor é um {{PLACEHOLDER}}, a página tem imagem PRÓPRIA e
     quem a preenche é o publish logo adiante. Sem essa guarda, esta troca
     acontecia antes da substituição e apagava a capa de cada post — os 9 posts
     saíam com o mesmo cartão genérico, que é justamente o que faz alguém NÃO
     compartilhar. Só a página com imagem fixa segue o que está no painel. */
  if (S.img_og) {
    const abs = S.img_og.startsWith("http") ? S.img_og : "https://bemestarclinic.com" + S.img_og;
    html = html.replace(/(<meta (?:property|name)="(?:og|twitter):image" content=")([^"]*)(")/g,
      (todo, ini, valor, fim) => (/^\{\{.+\}\}$/.test(valor.trim()) ? todo : `${ini}${abs}${fim}`));
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

/* Configuração do backup — usada tanto pela rotina automática (no listen) quanto
   pelo `node server.js --backup`, para que as duas gravem no mesmo lugar. */
const BACKUP_CFG = {
  destino: path.join(ROOT, "backups"),
  /* Só o banco do SITE é arquivo. A gestão virou PostgreSQL e é copiada por
     pg_dump — o gestao.db saiu daqui na v1.12.0. Se ele ainda estiver no disco,
     é o arquivo morto de antes da migração, e não deve ser copiado como se
     fosse o banco vivo: daria a impressão de que há backup atualizado dos
     prontuários quando o conteúdo pararia na data da virada. */
  bancos: [path.join(ROOT, "data", "site.db")],
  postgres: require("./pg").config(),
  intervaloHoras: Number(process.env.BACKUP_HORAS) || 24,
  manter: Number(process.env.BACKUP_MANTER) || 30,
};

// `node server.js --backup` força uma cópia agora, sem subir o servidor. É o que
// o deploy.sh chama antes de mexer em qualquer coisa.
if (process.argv.includes("--backup")) {
  const { rodarBackup } = require("./backup");
  const feitos = rodarBackup(BACKUP_CFG, "manual");
  process.exit(feitos.length ? 0 : 1);
}

// `node server.js --backup-status` lista a situação — usado pelo verificar.sh
if (process.argv.includes("--backup-status")) {
  const { statusBackup } = require("./backup");
  console.log(JSON.stringify(statusBackup(BACKUP_CFG), null, 2));
  process.exit(0);
}

const servidor = http.createServer(async (req, res) => {
  /* LA Sentinela: conta esta requisição. Não interfere na resposta — só
     pendura um ouvinte no "finish" e mede depois que ela terminou. Fica no
     topo de propósito, para que 404, 503 e erro também sejam contados. */
  sentinela.contar(req, res);

  /* LA Chat — antes de qualquer coisa, e é assim que o módulo pede.
     `rota()` devolve `true` quando tratou; o site então sai na hora.
     Sem CHAT_URL e CHAT_SEGREDO_PASSE no ambiente, o conector fica inativo e
     esta linha é um `return false` — o site roda igual, sem chat. */
  if (chat.rota(req, res)) return;

  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Cabeçalhos de segurança em toda resposta
  res.setHeader("X-Content-Type-Options", "nosniff");        // barra MIME sniffing
  res.setHeader("X-Frame-Options", "SAMEORIGIN");            // impede clickjacking no painel
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  /* HSTS — obriga o navegador a só voltar por HTTPS, fechando a janela de
     downgrade (o visitante que digita "bemestarclinic.com" e trafega o cookie
     de sessão em claro antes do redirect). Só sob HTTPS: emitir em HTTP puro
     travaria o acesso em ambiente sem certificado. Emitido AQUI, então vale
     para site, /admin e /restrito — todos passam por este handler. */
  if (req.headers["x-forwarded-proto"] === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    /* ======================================================================
       ENTRAR NO PAINEL DO SITE VINDO DO SISTEMA DE GESTÃO

       O atalho de 9 pontos do /restrito leva para cá. Quem já está logado
       como ADMINISTRADOR do sistema de gestão entra no /admin sem digitar a
       senha do painel de novo.

       POR QUE A ROTA MORA EM /restrito E NÃO EM /admin: o cookie de sessão do
       sistema de gestão é gravado com Path=/restrito, e o navegador só o envia
       para endereços sob esse caminho. Uma chamada a /admin/algo chegaria SEM
       ele, e o servidor concluiria — corretamente — que ninguém está logado.
       Foi o que aconteceu na primeira versão desta rota: ela mandava o usuário
       de volta para o /restrito. O teste automatizado não pegou porque montava
       o cabeçalho de cookie à mão, fazendo o que o navegador jamais faria.

       POR QUE ISTO É SEGURO — e onde estão os limites:

       · A troca acontece INTEIRAMENTE NO SERVIDOR. O navegador não recebe,
         nem envia, nem guarda a senha do painel em momento algum. Não há
         token na URL que possa vazar pelo histórico, pelo Referer ou por um
         print de tela.

       · SÓ o perfil `admin` do /restrito passa. A secretaria e o
         profissional recebem 403. Sem isso, quem atende o telefone poderia
         publicar conteúdo no site da clínica — é escalação de privilégio, e
         silenciosa, que é a pior espécie.

       · Só aceita navegação a partir do PRÓPRIO site (Sec-Fetch-Site). Um
         link numa página de terceiros não consegue criar a sessão do painel
         no navegador de quem está logado. Navegadores antigos, que não
         mandam esse cabeçalho, continuam funcionando — o que se perde ali é
         uma camada extra, não a checagem principal, que é o perfil.

       · Fica registrado na auditoria. Pular de um sistema para o outro é
         exatamente o tipo de movimento que a trilha existe para mostrar.
       ====================================================================== */
    if (p === "/restrito/painel-do-site" && req.method === "GET") {
      const s = sessaoRestrito(req);
      if (!s) { res.writeHead(302, { Location: "/restrito/" }); return res.end(); }
      if (s.perfil !== "admin") {
        auditarRestrito({ req, sessao: s, acao: "acesso", modulo: "admin",
          resumo: `${s.nome} tentou abrir o painel do site sem ser administrador` });
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Sem permissão</title>
<body style="font-family:system-ui,sans-serif;background:#F8F7FC;color:#2b2b3a;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:30rem;background:#fff;border:1px solid #e6e3f2;border-radius:16px;padding:2rem;text-align:center">
<h1 style="font-size:1.2rem;color:#5B4FD8;margin:0 0 .7rem">Painel do site</h1>
<p style="line-height:1.6;margin:0">O painel que edita o site da clínica é exclusivo do administrador do sistema.</p>
<p style="line-height:1.6;margin:.8rem 0 0"><a href="/restrito/" style="color:#5B4FD8">Voltar ao sistema de gestão</a></p></div>`);
      }
      /* `cross-site` é o caso que interessa barrar: alguém em outro domínio
         induzindo a navegação. `same-origin` (nosso link) e `none` (URL
         digitada à mão) passam. */
      if (req.headers["sec-fetch-site"] === "cross-site") {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Abra o painel pelo atalho dentro do sistema de gestão.");
      }
      const t = crypto.randomBytes(24).toString("hex");
      sessions.set(t, Date.now());
      const https = req.headers["x-forwarded-proto"] === "https";
      res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; Path=/; SameSite=Lax${https ? "; Secure" : ""}`);
      auditarRestrito({ req, sessao: s, acao: "acesso", modulo: "admin",
        resumo: `${s.nome} abriu o painel do site pelo atalho (entrou sem digitar a senha do painel)` });
      console.log(`  · /admin: sessão criada pelo atalho do /restrito (${s.nome})`);
      res.writeHead(302, { Location: "/admin/" });
      return res.end();
    }

  /* Se o banco da gestão não inicializou, o /restrito responde 503 com um
     recado claro — em vez de estourar uma exceção diferente a cada clique,
     deixando a equipe sem entender se o problema é a senha dela.
     O site e o /admin, que são SQLite, seguem o fluxo normal logo abaixo. */
  /* `gestaoNoAr()` tenta religar antes de desistir. É o que transforma uma
     queda de banco em soluço em vez de interrupção: quem chega depois que o
     PostgreSQL voltou já entra normalmente, sem ninguém mexer no servidor. */
  if (ERRO_GESTAO && (p === "/restrito" || p.startsWith("/restrito/")) && !(await gestaoNoAr())) {
    const api = p.startsWith("/restrito/api/");
    res.writeHead(503, {
      "Content-Type": api ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Retry-After": "300",
    });
    return res.end(api
      ? JSON.stringify({ error: "O sistema de gestão está indisponível: o banco de dados não respondeu. Avise o suporte." })
      : `<!doctype html><meta charset="utf-8"><title>Sistema indisponível</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#F8F7FC;color:#2b2b3a;
display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem}
.c{max-width:34rem;background:#fff;border:1px solid #e6e3f2;border-radius:16px;padding:2rem;
box-shadow:0 10px 30px rgba(91,79,216,.08)}h1{font-size:1.3rem;margin:0 0 .8rem;color:#5B4FD8}
p{line-height:1.6;margin:.6rem 0}small{color:#7a7a8c}</style>
<div class="c"><h1>Sistema de gestão indisponível</h1>
<p>O banco de dados do sistema não respondeu. <b>Nenhum dado foi perdido</b> — o sistema volta
assim que a conexão for restabelecida.</p>
<p>Se você é da equipe, avise o suporte técnico. O site da clínica continua funcionando
normalmente.</p>
<p><small>Detalhe para o suporte: falha ao conectar no PostgreSQL no boot do serviço.
Consulte <code>journalctl -u bemestar -n 40</code>.</small></p></div>`);
  }

  /* Sistema de gestão da clínica (/restrito) — app independente, banco próprio.
     Vem ANTES do modo manutenção de propósito: a equipe precisa continuar
     atendendo mesmo com o site fechado para o público. */
  try { if (handleRestrito(req, res, p)) return; }
  catch (e) {
    console.error("  ✖ /restrito:", e.message);
    if (!res.headersSent) { res.writeHead(500); res.end("Erro interno"); }
    return;
  }

  try {
    /* Modo manutenção: barra o visitante mas deixa passar o painel, a API e os
       assets (a própria página de aviso usa o favicon). Quem tem sessão de
       administrador continua vendo o site normal, para conferir antes de reabrir. */
    /* `/answer` passa pelo modo manutenção junto com o painel e a API: o link
       do teste está no celular de um paciente com prazo para responder, e
       fechar o site para trocar uma foto na home não pode fazer o prazo dele
       correr contra uma tela de "estamos atualizando". */
    if (emManutencao() && !p.startsWith("/admin") && !p.startsWith("/api/")
        && !p.startsWith("/answer/")
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
        /* A clínica tem um dono só, então a "conta" aqui é sempre a mesma — e
           é justamente isso que faz o balde por conta funcionar: ele soma os
           erros de TODOS os endereços, que é como o ataque distribuído
           passava despercebido pela trava por IP. */
        const v = limite.verificar("painel", ip, "admin");
        if (!v.ok) { res.setHeader("Retry-After", String(v.esperar)); return json(res, 429, { error: v.mensagem }); }
        const { password } = await readBody(req);
        const guardado = getS("admin_password_hash");
        if (!confereSenha(password, guardado)) {
          limite.errou("painel", ip, "admin");
          console.warn(`  ⚠ senha incorreta no painel — origem ${ip}`);
          return json(res, 401, { error: "Senha incorreta" });
        }
        // migração transparente: quem ainda estava no sha256 sobe para scrypt
        // no primeiro login certo, sem precisar trocar de senha
        if (senhaEhAntiga(guardado)) {
          setS("admin_password_hash", hashSenha(password));
          console.log("  · senha do painel migrada de sha256 para scrypt");
        }
        limite.acertou("painel", ip, "admin");
        const t = crypto.randomBytes(24).toString("hex");
        sessions.set(t, Date.now());
        // Secure só quando a requisição chegou por HTTPS (nginx informa no X-Forwarded-Proto).
        // Em produção isso impede que o cookie de sessão trafegue em claro.
        const https = req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; Path=/; SameSite=Lax${https ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }

      /* ---------------------- Busca de CEP (público) ----------------------
         Fica ANTES do login de propósito: o formulário de agendamento do site
         é usado por visitante, sem sessão.
         Por que passar pelo nosso servidor em vez de o navegador chamar direto:
          · a CSP do /admin e do /restrito é `connect-src 'self'` — chamada
            externa seria bloqueada, e afrouxá-la enfraqueceria a política;
          · o IP de quem digita o CEP não vai para um terceiro (LGPD);
          · dá para cachear e limitar o uso num lugar só.                     */
      const mcep = p.match(/^\/api\/cep\/(\d{8})$/);
      if (mcep && req.method === "GET") {
        const cep = mcep[1];
        const emCache = cacheCep.get(cep);
        if (emCache && Date.now() - emCache.ts < CEP_TTL) return json(res, 200, emCache.dados);
        if (!podeConsultarCep(clientIp(req))) return json(res, 429, { error: "Muitas consultas de CEP. Aguarde um instante." });
        try {
          const dados = await buscarCep(cep);
          if (!dados) return json(res, 404, { error: "CEP não encontrado." });
          cacheCep.set(cep, { dados, ts: Date.now() });
          if (cacheCep.size > 5000) cacheCep.delete(cacheCep.keys().next().value);
          return json(res, 200, dados);
        } catch (e) {
          console.warn("  ⚠ consulta de CEP falhou:", e.message);
          return json(res, 503, { error: "Não consegui consultar o CEP agora. Preencha o endereço à mão." });
        }
      }
      // CEP mal formatado: responde sem sair para a internet
      if (/^\/api\/cep\//.test(p)) return json(res, 400, { error: "Informe um CEP com 8 dígitos." });

      /* -------------- Teste de rastreio respondido pelo paciente ----------
         PÚBLICO, como o CEP: quem chega tem um link no WhatsApp e não tem
         login. As regras de quem pode abrir vivem no restrito.js, junto dos
         dados — aqui só há o transporte.

         O FREIO É O MESMO DO LOGIN, e pela mesma razão: um código de 8 a 11
         caracteres é adivinhável por força bruta se puder ser tentado sem
         limite, e cada acerto entrega o questionário de saúde de uma pessoa
         com nome. Errar código conta como erro; acertar limpa o balde.

         SÓ O BALDE POR IP — `conta` vai NULA, e isso é deliberado. Um valor
         fixo ali ("publico") seria um balde único para o mundo inteiro: bastava
         um atacante enchê-lo para NENHUM paciente conseguir mais responder
         teste nenhum. E um balde por CÓDIGO não serviria de nada, porque quem
         adivinha tenta um código DIFERENTE a cada vez — o balde nunca encheria,
         e o único efeito seria permitir trancar um paciente específico para
         fora do próprio teste.                                              */
      const mans = p.match(/^\/api\/answer\/([0-9A-Za-z]{8,11})(?:\/(iniciar|concluir|entrar|rascunho))?$/);
      if (mans) {
        const codigo = mans[1], acao = mans[2] || "";
        const ipA = clientIp(req);
        const vA = limite.verificar("answer", ipA, null);
        if (!vA.ok) { res.setHeader("Retry-After", String(vA.esperar)); return json(res, 429, { error: vA.mensagem }); }

        /* ================================================================
           O PASSE DO APARELHO

           Cookie com `Path=/api/answer`: só as rotas do link o recebem. A
           PÁGINA `/answer/<código>` é HTML estático e não precisa dele — quem
           confere é a API que ela chama. Restringir o caminho é o que impede
           este cookie de acompanhar o visitante pelo site inteiro.

           O NOME carrega o código porque um celular pode ter dois desafios de
           dois familiares: um cookie só faria o segundo link herdar o acesso
           do primeiro.
           ================================================================ */
        const nomeCookie = "acesso_" + codigo;
        const passe = (() => {
          const bruto = req.headers.cookie || "";
          const m = new RegExp("(?:^|;\\s*)" + nomeCookie + "=([^;]*)").exec(bruto);
          return m ? decodeURIComponent(m[1]) : "";
        })();

        if (acao === "entrar" && req.method === "POST") {
          /* ==============================================================
             AQUI o balde por CÓDIGO é a defesa inteira.

             O comentário do login diz que balde por código não serve contra
             adivinhação — e está certo lá, onde o atacante troca de código a
             cada tentativa. Aqui é o contrário: ele tem UM código e vai
             tentar datas. São poucas dezenas de milhares de datas plausíveis;
             sem balde, um robô entra em minutos.

             O efeito colateral conhecido (trancar o paciente para fora do
             próprio link) é limitado pelo limitador: quem já acertou daquele
             IP não é alcançado pelo balde da conta.
             ============================================================== */
          const vC = limite.verificar("answer-data", ipA, codigo);
          if (!vC.ok) { res.setHeader("Retry-After", String(vC.esperar)); return json(res, 429, { error: vC.mensagem }); }

          const b = await readBody(req);
          const r = await abrirComNascimento(codigo, b && b.nascimento);
          if (!r.ok) {
            limite.errou("answer-data", ipA, codigo);
            /* Uma resposta só para "código não existe", "data errada" e
               "paciente sem data cadastrada". Distinguir os três diria a quem
               tem o link se aquela pessoa é paciente da clínica. */
            return json(res, 401, { estado: "verificar", erro: "A data não confere." });
          }
          limite.acertou("answer-data", ipA, codigo);
          res.setHeader("Set-Cookie",
            `${nomeCookie}=${encodeURIComponent(r.passe)}; Path=/api/answer; Max-Age=${45 * 24 * 3600}` +
            `; HttpOnly; SameSite=Strict${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
          return json(res, 200, await estadoDoLink(codigo, r.passe));
        }

        if (!acao && req.method === "GET") {
          const r = await estadoDoLink(codigo, passe);
          if (r.estado === "inexistente") { limite.errou("answer", ipA, null); return json(res, 404, r); }
          limite.acertou("answer", ipA, null);
          return json(res, 200, r);
        }
        if (acao === "iniciar" && req.method === "POST") {
          const r = await iniciarTeste(codigo, passe);
          if (r.erro) { if (r.erro === "inexistente") limite.errou("answer", ipA, null);
            return json(res, r.erro === "inexistente" ? 404 : r.erro === "verificar" ? 401 : 409,
              { estado: r.erro }); }
          return json(res, 200, r);
        }
        if (acao === "rascunho" && req.method === "POST") {
          const b = await readBody(req);
          const r = await salvarRascunho(codigo, b && b.respostas, passe);
          if (r.erro) return json(res, r.erro === "inexistente" ? 404 : r.erro === "verificar" ? 401 : 409,
            { estado: r.erro });
          return json(res, 200, r);
        }
        if (acao === "concluir" && req.method === "POST") {
          const b = await readBody(req);
          const r = await concluirTeste(codigo, b && b.respostas, passe);
          if (r.erro) return json(res, r.erro === "inexistente" ? 404 : r.erro === "verificar" ? 401 : 409,
            { estado: r.erro, faltam: r.faltam || 0 });
          return json(res, 200, r);
        }
        return json(res, 405, { error: "Método não permitido." });
      }
      // Código fora do formato: recusado sem consultar o banco.
      if (/^\/api\/answer\//.test(p)) return json(res, 404, { estado: "inexistente" });

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
        /* Aqui também se adivinha senha: este endereço recebe a senha ATUAL.
           Sem freio, quem roubasse um cookie de sessão poderia testá-la à
           vontade por aqui, contornando o login. */
        const ipT = clientIp(req);
        const vT = limite.verificar("troca-senha", ipT, "admin");
        if (!vT.ok) { res.setHeader("Retry-After", String(vT.esperar)); return json(res, 429, { error: vT.mensagem }); }
        const { current, next } = await readBody(req);
        if (!confereSenha(current, getS("admin_password_hash"))) {
          limite.errou("troca-senha", ipT, "admin");
          return json(res, 400, { error: "Senha atual incorreta" });
        }
        limite.acertou("troca-senha", ipT, "admin");
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
        /* Os textos de seção já entravam CRUS na página (o setMarker injeta sem
           escapar) — era assim que negrito e link funcionavam ali. Agora que o
           editor grava HTML de verdade, eles passam pelo mesmo filtro do resto:
           o que muda não é a permissão, é o que se pode escrever. */
        for (const [k, v] of Object.entries(b))
          if (KEYS.includes(k)) setS(k, ESPECIAIS.includes(k) || k === "address" ? v : htmlLimpo(v));
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
          limparRicos(table, b);
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
          limparRicos(table, b);
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
        /* SVG fica de fora: é XML, aceita <script> dentro e seria servido da
           MESMA origem do site — um arquivo desses vira XSS armazenado, com
           acesso ao cookie de quem abrisse o link. Os SVG da identidade ficam
           em assets/img, versionados; o painel só envia imagem rasterizada. */
        const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/.exec(dataUrl || "");
        if (!m) return json(res, 400, { error: "Envie uma imagem PNG, JPG, WEBP ou GIF." });
        const safe = slug(path.parse(name || "foto").name).slice(0, 40) || "foto";
        /* O tipo declarado no `data:` é TEXTO que o cliente escreve — não prova
           nada sobre o conteúdo. Com o sharp instalado, quem decide a extensão
           é o que ele conseguiu DECODIFICAR; o que não abre como imagem é
           recusado em vez de ir para o disco. */
        const extEnviada = "." + m[1].split("/")[1].replace("jpeg", "jpg");
        const bruto = Buffer.from(m[2], "base64");
        const r = await tratarUpload(bruto, extEnviada);
        if (!r.buffer) {
          console.warn(`  ⚠ upload recusado: ${r.motivo}`);
          return json(res, 400, { error: "Não consegui ler esta imagem. Abra e salve o arquivo de novo, depois envie." });
        }
        const file = `${Date.now().toString(36)}-${safe}${r.ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), r.buffer);
        console.log(`  · upload ${file} ${r.tratada ? `— ${r.motivo}` : `(sem tratamento: ${r.motivo})`}`);
        return json(res, 200, { ok: true, path: `/assets/img/uploads/${file}` });
      }
      if (p === "/api/publish" && req.method === "POST") return json(res, 200, { ok: true, ...publish() });
      return json(res, 404, { error: "Rota não encontrada" });
    }

    if (p === "/admin" || p === "/admin/") {
      // no-store: painel autenticado não deve ficar em cache — e garante que a
      // versão mostrada na tela de login seja sempre a que está rodando agora.
      // CSP: mesmo que um texto do banco escape do escape, o navegador se recusa
      // a executar script de outra origem ou <object>; e frame-ancestors 'none'
      // fecha clickjacking no painel.
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_PAINEL });
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
    /* Extensões que nunca são conteúdo do site. Inclui os artefatos de deploy:
       um deploy.sh servido em HTTP 200 entrega de bandeja o nome do serviço, o
       usuário do systemd, o caminho da aplicação e onde ficam os backups. */
    const extProibida = /\.(js|json|md|db|log|bak|sqlite3?|ya?ml|toml|lock|sh|bash|service|env|conf|ini|sql|pem|key|crt|backup|old|orig|swp|tmp)$/i.test(p)
      && !p.startsWith("/assets/");
    // pastas que nunca devem ser navegáveis
    const dirProibido = /^\/(data|src|node_modules|nginx|backups|restrito\/arquivos)(\/|$)/.test(p);
    if (dirProibido || ocultoProibido || extProibida) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404");
    }

    /* ------------------- /answer/<codigo> — a página do paciente ---------
       Servida por ROTA, não como arquivo estático: o HTML mora em
       `restrito/answer.html`, fora da árvore pública do site, e é entregue em
       qualquer código de formato válido. A página é a mesma para todos; quem
       decide o que ela mostra é a API, depois de conferir o link.

       `noindex` no cabeçalho ALÉM da meta tag: um buscador que só faça HEAD
       não chega a ler o HTML, e este endereço nunca pode aparecer em busca. */
    const mAnswer = p.match(/^\/answer\/[0-9A-Za-z]{8,11}\/?$/);
    if (mAnswer && req.method === "GET") {
      const arq = path.join(ROOT, "restrito", "answer.html");
      if (!fs.existsSync(arq)) { res.writeHead(404); return res.end("404"); }
      res.writeHead(200, {
        "Content-Type": MIME[".html"],
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        /* CSP fechada: a página não carrega nada de fora e não deve poder.
           Sem `connect-src 'self'` a própria chamada à API cairia — é a linha
           que faz a política ser útil em vez de decorativa. */
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
          "style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      return res.end(fs.readFileSync(arq));
    }
    /* Código fora do formato não vira busca de arquivo: `/answer/../algo`
       precisa morrer aqui, não no `path.normalize` logo abaixo. */
    if (/^\/answer(\/|$)/.test(p)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }

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
});

/* ==========================================================================
   SUBIDA DO SERVIDOR

   A porta só abre DEPOIS que o sistema de gestão terminou de inicializar
   (conectar no PostgreSQL, aplicar migrations, semear cadastros). Conectar no
   Postgres é assíncrono — sem este await, a clínica poderia entrar no sistema
   durante a migração e receber "relation does not exist" numa tela de
   prontuário.

   MAS UMA FALHA NO POSTGRES NÃO DERRUBA O SITE.

   Eu tinha feito o processo inteiro sair com exit(1) quando o /restrito não
   inicializava. Estava errado, e derrubou a produção na virada: o site público
   e o /admin vivem no SQLite (data/site.db) e continuam perfeitamente
   funcionais sem o Postgres. Não há razão para o cliente perder o site — e a
   clínica perder o telefone que toca — porque uma variável de ambiente do
   sistema interno ficou faltando.

   O que vale é o RECORTE: quem depende do Postgres é só o /restrito, e é só
   ele que sai do ar, com uma mensagem que diz o que aconteceu. O resto atende
   normalmente.
   ========================================================================== */
let ERRO_GESTAO = null;

/* ==========================================================================
   A GESTÃO SE RECUPERA SOZINHA

   O banco sair do ar por alguns segundos é ROTINA, não exceção: o
   unattended-upgrades reinicia o PostgreSQL de madrugada e ele volta em ~5
   segundos. Em 29/07/2026 o app tentou conectar exatamente dentro dessa janela
   (banco parou 06:16:02, voltou 06:16:07; a tentativa foi às 06:16:04), falhou,
   e ficou servindo "sistema indisponível" por horas — com o banco de pé ao
   lado. A falha durou 5 segundos; o estrago, uma manhã inteira.

   O erro de projeto era tratar a inicialização como decisão ÚNICA e definitiva.
   Agora ela é uma TENTATIVA, repetida em dois momentos:

     · no boot, algumas vezes com espera crescente — cobre a janela do upgrade
       sem ninguém precisar fazer nada;
     · a cada acesso ao /restrito, se ainda estiver fora — assim uma queda mais
       longa se cura no primeiro clique de quem chegar depois que o banco voltar.

   A trava `religando` existe para que dez acessos simultâneos não abram dez
   reconexões; a espera mínima, para não martelar um banco que está mesmo fora.
   Ninguém precisa reiniciar serviço: quem religa é o próprio processo.
   ========================================================================== */
let religando = null;               // tentativa em curso (promessa compartilhada)
let proximaTentativa = 0;           // não tenta de novo antes disto
const ESPERA_ENTRE_TENTATIVAS = 15_000;

async function ligarGestao() {
  await iniciarRestrito();
  ERRO_GESTAO = null;
  /* Com a gestão de pé, o chat já pode saber quem é a equipe. Sem `await`: a
     sincronização é conveniência, e o sistema não espera por ela para atender. */
  sincronizarElencoDoChat("boot");
  ligarElencoContinuo();
}

/* Liga os dois gatilhos de reenvio UMA vez. `ligarGestao` roda de novo a cada
   religação do PostgreSQL, e sem esta trava cada queda do banco deixaria mais
   um relógio e mais um ouvinte para trás. */
let elencoContinuoLigado = false;
function ligarElencoContinuo() {
  if (elencoContinuoLigado || !chat.ligado) return;
  elencoContinuoLigado = true;
  aoMudarEquipe((motivo) => agendarElencoDoChat(motivo));
  const relogio = setInterval(() => sincronizarElencoDoChat("periódico"), 5 * 60_000);
  if (relogio.unref) relogio.unref();
}

/* ==========================================================================
   QUEM É A EQUIPE, para o chat

   O chat, sozinho, só conhece quem JÁ ENTROU nele. Numa clínica de oito
   pessoas isso é uma armadilha de partida: a primeira a abrir encontra
   "Ninguém por aqui ainda", conclui que não funciona e não volta — então a
   segunda também encontra vazio.

   Mandar o elenco resolve. Roda no boot e a cada mudança de usuário; é
   idempotente e barato (uma requisição interna, oito linhas de JSON).

   NUNCA DERRUBA NADA: se o chat estiver fora do ar, isto falha em silêncio e o
   sistema de gestão segue igual. O chat é conveniência; a agenda e o
   prontuário é que são o trabalho.
   ========================================================================== */
async function sincronizarElencoDoChat(motivo = "boot") {
  if (!chat.ligado || typeof chat.sincronizarElenco !== "function") return;
  try {
    /* ====================================================================
       SÓ QUEM PODE ENTRAR NO SISTEMA ENTRA NO CHAT (`ativo = 1`)

       "Todos os usuários existentes" quer dizer todo o cadastro de acesso —
       administração, recepção, profissionais —, e não só quem já abriu o chat
       alguma vez. Não quer dizer os DESATIVADOS: quem está desativado não
       consegue nem fazer login, e listá-lo aqui convidaria alguém a mandar uma
       mensagem para uma pessoa que nunca vai ler.

       Quem sai desta lista é desativado no chat pelo próprio módulo (as
       conversas antigas continuam íntegras, com autor). Quem volta, volta.
       ==================================================================== */
    const equipe = await Q.all(
      `SELECT id, nome, email, perfil, foto FROM g_usuarios WHERE ativo = 1 ORDER BY nome`);
    const r = await chat.sincronizarElenco(equipe.map((u) => ({
      id: u.id,
      nome: u.nome,
      /* O e-mail do login NÃO vai: nestes cadastros ele costuma ser um apelido
         ("admin", "qa_esc"), não um endereço — e no chat apareceria como
         contato falso. O que identifica a pessoa ali é nome e cargo. */
      cargo: CARGO_POR_PERFIL[u.perfil] || "Equipe",
      papel: u.perfil === "admin" ? "admin" : "membro",
      /* ================================================================
         A FOTO VAI COMO CAMINHO RELATIVO, e é isso que a faz funcionar.

         `/restrito/arquivos/…` resolve na origem da página — o navegador de
         quem está no sistema já leva o cookie do /restrito, então a imagem
         chega autenticada, sem rota pública e sem token na URL.

         Uma URL absoluta (`https://bemestarclinic.com/…`) daria no mesmo em
         produção e quebraria em qualquer outro endereço: o mesmo código roda
         em localhost durante o desenvolvimento. E o chat, do lado dele,
         aceita relativo justamente por ser o caso seguro — URL de terceiro
         faria cada abertura do chat contar a quem está online para o dono
         daquele servidor.
         ================================================================ */
      avatar: u.foto || "",
    })));

    /* Registra o BOOT sempre (é informação de partida) e, depois disso, só o
       que mudou de fato. O reenvio periódico é de 5 em 5 minutos: sem este
       filtro seriam 288 linhas idênticas por dia no journal. */
    if (r && r.ok && (motivo === "boot" || r.mudou)) {
      console.log(`  · LA Chat: ${r.sincronizados} pessoa(s) da equipe no chat` +
        (r.desativados ? `, ${r.desativados} desativada(s)` : "") +
        (motivo === "boot" ? "." : ` (${motivo}).`));
    } else if (r && !r.ok && r.motivo) {
      console.log(`  · LA Chat: elenco não sincronizado (${r.motivo}).`);
    }
  } catch (e) {
    console.warn("  ⚠ LA Chat: falha ao sincronizar o elenco —", e.message);
  }
}

/* ==========================================================================
   QUANDO REENVIAR O ELENCO

   Dois gatilhos, e os dois são necessários:

   · O AVISO da gestão (`aoMudarEquipe`) é o que faz a lista de Pessoas mudar
     na tela de quem está com o chat aberto, no instante em que o admin salva
     o cadastro. É o caminho normal.

   · O RELÓGIO é a rede de segurança. O chat pode estar fora do ar na hora do
     cadastro, ou ter sido reiniciado depois (e o banco dele é dele: um chat
     recém-instalado começa sem ninguém). Reenviar de 5 em 5 minutos faz o
     estado convergir sozinho, sem ninguém precisar reiniciar o site.

   Debounce de 2 s no aviso: salvar um usuário dispara uma escrita e às vezes
   duas (o acesso do profissional mexe em `profissionais` e em `g_usuarios`),
   e não faz sentido mandar o elenco inteiro duas vezes no mesmo segundo.
   ========================================================================== */
let elencoAgendado = null;
function agendarElencoDoChat(motivo) {
  if (elencoAgendado) clearTimeout(elencoAgendado);
  elencoAgendado = setTimeout(() => {
    elencoAgendado = null;
    sincronizarElencoDoChat(motivo);
  }, 2000);
  /* `unref`: um temporizador pendente não pode segurar o processo de pé na
     hora de encerrar o serviço. */
  if (elencoAgendado.unref) elencoAgendado.unref();
}

/* true se a gestão está no ar — religando antes, se for a hora de tentar. */
async function gestaoNoAr() {
  if (!ERRO_GESTAO) return true;
  if (Date.now() < proximaTentativa) return false;
  if (!religando) {
    proximaTentativa = Date.now() + ESPERA_ENTRE_TENTATIVAS;
    religando = ligarGestao()
      .then(() => console.log("  · /restrito: banco de volta — sistema de gestão religado sozinho."))
      .catch((e) => { ERRO_GESTAO = e; })
      .finally(() => { religando = null; });
  }
  await religando;
  return !ERRO_GESTAO;
}

(async () => {
  /* No boot vale insistir: o serviço sobe junto com o resto da máquina, e o
     PostgreSQL pode ainda estar abrindo. As esperas somam ~30s — bem mais que
     os 5 segundos de um upgrade. */
  const ESPERAS = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; ; i++) {
    try { await ligarGestao(); break; }
    catch (e) {
      ERRO_GESTAO = e;
      if (i >= ESPERAS.length) break;
      console.error(`  · /restrito: banco não respondeu (${e.message}) — nova tentativa em ${ESPERAS[i] / 1000}s`);
      await new Promise((r) => setTimeout(r, ESPERAS[i]));
    }
  }
  if (!ERRO_GESTAO) return;
  {
    const e = ERRO_GESTAO;
    console.error("\n  ✖ O SISTEMA DE GESTÃO (/restrito) NÃO INICIALIZOU.");
    console.error("    " + e.message);
    console.error("\n    O SITE E O /admin CONTINUAM NO AR (usam o SQLite, não o Postgres).");
    console.error("    Só o /restrito está indisponível. Verifique:");
    console.error("      · o serviço está no ar?   systemctl status postgresql");
    console.error("      · as credenciais chegaram? (PGHOST/PGUSER/PGPASSWORD/PGDATABASE)");
    console.error("        em produção vêm de /etc/bemestar.env, via EnvironmentFile do systemd:");
    console.error("        systemctl show bemestar -p EnvironmentFiles");
    console.error("      · o banco existe e o usuário tem acesso?");
    console.error("        psql -U bemestar -d bemestar_gestao -c '\\dt'");
    console.error("\n    Corrigido o problema, NÃO é preciso reiniciar nada: o sistema");
    console.error("    religa sozinho no primeiro acesso ao /restrito.\n");
  }
})();

/* ==========================================================================
   LA SENTINELA — conector de monitoramento

   Conta cada requisição e manda um "beat" assinado (HMAC-SHA256) para o
   gerenciador: acessos, IPs únicos por janela, faixas de status, tempo de
   resposta, e os recursos da máquina. Só ESCREVE para fora — não abre porta.

   POR QUE AQUI, e não junto dos outros require lá em cima: construir o conector
   já LIGA o laço de envio. Aqui ele nasce depois do banco e imediatamente antes
   do `listen`, que é a ordem certa — precisa existir antes da primeira
   requisição chegar (o handler chama `sentinela.contar`), mas não faz sentido
   começar a bater antes de o servidor estar de pé.

   O SEGREDO NÃO FICA NO CÓDIGO. Este repositório é PÚBLICO: um segredo commitado
   aqui vira permanente no histórico do GitHub, e este projeto já pagou esse
   preço duas vezes (o `visit_salt` e o `data/site.db` com hash de senha seguem
   no histórico). Ele vem do ambiente — `.env` no local (que está no
   .gitignore), `EnvironmentFile` do systemd em produção, igual às credenciais
   do PostgreSQL. Sem o segredo o conector fica INATIVO e avisa no boot; o site
   segue normal.
   ========================================================================== */
const { conectorSentinela } = require("./lasentinela");
const sentinela = conectorSentinela({
  url: process.env.SENT_URL || "http://localhost:5191",
  siteId: Number(process.env.SENT_SITE) || 1,
  segredo: process.env.SENT_SEGREDO,
});

/* O listen fica FORA do laço de tentativas, e nunca depois dele.

   A primeira versão desta correção esperava as tentativas terminarem para só
   então abrir a porta — e com o banco fora o SITE PÚBLICO ficava 30 segundos
   sem responder. Seria trocar um problema por outro pior: o site da clínica
   não depende do PostgreSQL e não pode ficar refém dele nem por um instante. */

/* LA Chat — a SEGUNDA linha do conector, e a que mais se esquece.
   `upgrade` é um evento separado do fluxo de requisição: ele NÃO passa pelo
   handler acima nem por `chat.rota()`. Sem esta linha o chat carrega,
   autentica, mostra as conversas e nunca recebe mensagem em tempo real — sem
   nada aparecer quebrado. O sintoma seria "às vezes não chega". */
chat.conectarUpgrade(servidor);

// Escuta só no localhost: quem fala com o mundo é o nginx. Sem isto, o painel
// ficaria acessível por http://IP:5185/admin/, sem HTTPS e sem cookie Secure.
// Para expor direto (ambiente sem proxy), rode com HOST=0.0.0.0
servidor.listen(PORT, process.env.HOST || "127.0.0.1", async () => {
  console.log(`\n  BemEstarClinic — site + gerenciador v${APP_VERSION}`);
  console.log(`  · Site:   http://localhost:${PORT}/`);
  console.log(`  · Painel: http://localhost:${PORT}/admin/`);
  console.log(`  · Banco do site:    ${DRIVER_NOME}${DRIVER_AVISO ? " ⚠ " + DRIVER_AVISO : ""} (data/site.db)`);
  console.log(imagemPronta()
    ? `  · Foto do painel:   tratada (gira pelo EXIF, apaga metadado/GPS, reduz a 2000px, grava WEBP)`
    : `  · Foto do painel:   ⚠ SEM TRATAMENTO — o sharp não carregou; rode "npm ci". A foto vai para o site como veio, COM os metadados (o EXIF do celular costuma trazer GPS).`);
  if (ERRO_GESTAO) {
    console.log(`  · Banco da gestão:  ✖ INDISPONÍVEL — /restrito fora do ar (site e /admin OK)`);
  } else {
    try {
      const v = await Q.versao();
      console.log(`  · Banco da gestão:  PostgreSQL — ${v.d} (usuário ${v.u})`);
    } catch (e) { console.log(`  · Banco da gestão:  ✖ ${e.message.split("\n")[0]}`); }
  }

  /* Backup automático dos DOIS bancos: o do site (cópia do arquivo) e o da
     gestão (dump SQL do Postgres). Roda aqui, no processo do site, porque é
     ele que sobe com o systemd — o restrito.js não tem boot próprio. */
  agendarBackups(BACKUP_CFG);

  // Testa a escrita no boot. Sem isto, um banco somente-leitura só aparece
  // quando o cliente tenta salvar algo e nada acontece — e o log fica mudo.
  try {
    setS("_teste_escrita", String(Date.now()));
    db.prepare("DELETE FROM settings WHERE key='_teste_escrita'").run();
  } catch (e) {
    const usuario = (() => { try { return require("node:os").userInfo().username; } catch { return "root"; } })();
    console.error(`  ✖ BANCO DO SITE SEM PERMISSÃO DE ESCRITA: ${e.message}`);
    console.error("    O painel não vai conseguir salvar nada. O processo roda como:", usuario);
    console.error(`    Corrija com: sudo chown -R ${usuario}: "${ROOT}/data" "${ROOT}/assets/img/uploads"`);
  }
  // avisa sem imprimir a senha: em produção esse log vai parar no journalctl
  if (confereSenha("bemestar-admin", getS("admin_password_hash")))
    console.log(`  ⚠ A senha do painel ainda é a padrão. Troque em Painel → Senha antes de publicar.\n`);
  else console.log("");
});
