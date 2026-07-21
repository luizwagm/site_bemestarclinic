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
const APP_VERSION = "1.5.0";
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

/* ------------------------------- Seed ------------------------------------ */
function seed() {
  if (getS("hero_title")) return;
  const S = {
    admin_password_hash: sha("bemestar-admin"),
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
const sessions = new Map();
const authed = (req) => { const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); return m && sessions.has(m[1]); };

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

/* --------------------------------------------------------------------------
   Área de atendimento — gera /onde-atendemos/ e /terapia-em-<cidade>/.
   Distâncias rodoviárias conferidas (emsampa/rotas; Garanhuns via BR-423).
   IMPORTANTE: cada cidade tem contexto, perfil e FAQ PRÓPRIOS. Página local
   só se sustenta no Google quando traz informação real que não existe nas
   outras — molde repetido com o nome trocado é doorway page e derruba o site.
   -------------------------------------------------------------------------- */
const CIDADES = [
  { slug: "caruaru", nome: "Caruaru", km: 0, rota: "A clínica fica no bairro Universitário, ao lado do Polo Comercial e a poucos minutos do centro.", sede: true,
    contexto: [
      "A BemEstarClinic é uma clínica caruaruense. Ficamos no Empresarial Nordeste Corporate, no bairro Universitário — a mesma região dos principais laboratórios, consultórios e faculdades da cidade, o que facilita para quem já resolve várias coisas no mesmo dia.",
      "Caruaru concentra a maior rede de saúde do Agreste, mas a oferta de saúde mental ainda é desproporcional ao tamanho da cidade: filas longas na rede pública e poucos lugares que reúnem psicanálise, psicologia, avaliação psicológica e terapias integrativas sob o mesmo teto. Foi exatamente essa lacuna que a clínica veio ocupar, evoluindo do antigo CIPS para uma equipe multiprofissional.",
      "Para o morador de Caruaru, isso significa consulta sem viagem, horários flexíveis (inclusive fora do horário comercial) e a possibilidade de alternar entre presencial e online na mesma semana, sem trocar de profissional."
    ],
    perfil: "Em Caruaru, a procura se divide entre psicanálise individual, atendimento de casal e avaliação psicológica — esta última puxada por processos de porte de arma, cirurgia bariátrica e concursos, que exigem laudo assinado.",
    foco: ["psicanalise-individual-e-casal", "avaliacao-psicologica-e-psicossocial", "protocolo-integrativo-ozonioterapia-e-detox-ionico"],
    faq: [
      ["Onde fica a BemEstarClinic em Caruaru?", "Na Rua Arthur Antônio da Silva, 481, 7º andar, Sala 707 — Empresarial Nordeste Corporate, bairro Universitário, Caruaru-PE, CEP 55016-445. O prédio tem elevador e recepção."],
      ["Preciso de encaminhamento médico para marcar?", "Não. Você mesmo pode marcar a sua consulta pelo WhatsApp ou pelo formulário do site. Encaminhamento só é necessário em casos específicos de avaliação solicitada por terceiros."],
      ["Vocês atendem fora do horário comercial?", "Sim. Parte da equipe tem horários no fim da tarde e no início da noite, justamente para quem trabalha durante o dia. Confirme a disponibilidade no primeiro contato."]
    ] },

  { slug: "bezerros", nome: "Bezerros", km: 30, rota: "Pela BR-232, no sentido Recife — o trecho é duplicado em boa parte do caminho.",
    contexto: [
      "Bezerros fica a cerca de 30 km de Caruaru pela BR-232, a rodovia mais movimentada do Agreste. Na prática, é uma das cidades de onde se chega mais rápido à clínica: muita gente de Bezerros já trabalha, estuda ou faz compras em Caruaru e aproveita o mesmo deslocamento para a consulta.",
      "A cidade é conhecida nacionalmente pelos Papangus e pelo artesanato em papel machê e madeira — uma economia criativa que gira em torno de temporadas. Quem vive de artesanato e de carnaval conhece bem a alternância entre meses de trabalho exaustivo e meses de renda incerta, e esse ciclo cobra seu preço em ansiedade e sono.",
      "Para pacientes de Bezerros, costumamos sugerir o modelo misto: sessões online nas semanas cheias e presencial quando já houver viagem marcada para Caruaru."
    ],
    perfil: "De Bezerros chegam principalmente pedidos de psicanálise e terapia floral, além de acupuntura para dores crônicas de quem passa horas em trabalho manual repetitivo.",
    foco: ["psicanalise-individual-e-casal", "acupuntura", "terapia-floral"],
    faq: [
      ["Quanto tempo leva de Bezerros até a clínica?", "São cerca de 30 km pela BR-232. Com trânsito normal, a viagem costuma ficar abaixo de 40 minutos até o bairro Universitário, em Caruaru."],
      ["Dá para fazer terapia sem sair de Bezerros?", "Sim. As sessões de psicanálise, psicologia, terapia floral e aromaterapia funcionam integralmente online, pelo WhatsApp. Só os procedimentos de contato — como acupuntura e ozonioterapia — exigem presença na clínica."],
      ["Posso concentrar consulta e procedimento no mesmo dia?", "Pode, e é o que recomendamos para quem vem de fora. Avise no agendamento que você é de Bezerros e a recepção organiza os horários em sequência."]
    ] },

  { slug: "riacho-das-almas", nome: "Riacho das Almas", km: 24,
    rota: "Estrada curta e direta: é uma das cidades vizinhas mais próximas da clínica.",
    contexto: [
      "Com cerca de 24 km de distância, Riacho das Almas é praticamente um bairro estendido de Caruaru em termos de deslocamento. É perto o suficiente para que uma sessão semanal presencial caiba na rotina sem virar um sacrifício logístico.",
      "É um município de porte pequeno, com economia ligada à agricultura e à pecuária e uma rede de saúde enxuta. Serviços de saúde mental praticamente não existem no município, o que faz de Caruaru a referência natural — e é de lá que vem boa parte dos nossos pacientes do entorno rural.",
      "Para quem depende de transporte alternativo ou de carona, o atendimento online resolve a maior parte das necessidades sem custo de deslocamento."
    ],
    perfil: "A procura de Riacho das Almas se concentra em psicologia clínica, psicanálise e fitoterapia — esta última com boa aceitação em famílias que já têm tradição no uso de plantas medicinais.",
    foco: ["psicologia", "psicanalise-individual-e-casal", "fitoterapia"],
    faq: [
      ["Riacho das Almas é longe da clínica?", "Não. São cerca de 24 km até Caruaru, uma das menores distâncias entre as cidades que atendemos."],
      ["Não tenho carro. Como faço?", "O atendimento online pelo WhatsApp elimina o deslocamento e mantém o mesmo profissional e o mesmo sigilo. Você só precisa de um celular e de um lugar reservado para conversar."],
      ["Vocês trabalham com fitoterapia de verdade?", "Sim, com prescrição individualizada feita por profissional habilitado — não é indicação genérica de chá. Veja a página de fitoterapia para entender como funciona."]
    ] },

  { slug: "toritama", nome: "Toritama", km: 37,
    rota: "Pela BR-104, no sentido norte.",
    contexto: [
      "Toritama fica a cerca de 37 km de Caruaru pela BR-104 e é conhecida como a capital do jeans: uma cidade pequena que produz uma fatia enorme do jeans consumido no Brasil, em milhares de facções e lavanderias.",
      "Essa engrenagem tem um custo humano bem documentado — jornadas que se estendem noite adentro, trabalho por produção, semanas de pico antes das grandes feiras e uma linha muito tênue entre casa e oficina. O resultado que chega ao consultório é sempre parecido: exaustão, insônia, irritabilidade, crises de ansiedade e dores no pescoço, ombros e punhos de quem passa o dia na máquina.",
      "Por isso, com pacientes de Toritama o trabalho costuma começar por dois eixos ao mesmo tempo: a escuta do que está sendo empurrado com a barriga e o alívio físico do corpo que está sustentando essa rotina."
    ],
    perfil: "De Toritama vêm sobretudo casos ligados a estresse e exaustão do trabalho por produção: psicanálise, acupuntura para dores osteomusculares e ventosaterapia para tensão em ombros e coluna.",
    foco: ["psicanalise-individual-e-casal", "acupuntura", "ventosaterapia"],
    faq: [
      ["Trabalho na facção o dia todo. Tem horário para mim?", "Tem. Parte da equipe atende no fim da tarde e à noite, e o online permite sessão de casa depois do expediente, sem contar o tempo de estrada."],
      ["Quanto tempo de viagem de Toritama até Caruaru?", "São cerca de 37 km pela BR-104, normalmente menos de 40 minutos de carro."],
      ["Acupuntura ajuda em dor de quem costura o dia inteiro?", "É uma das indicações mais frequentes para dores osteomusculares e tensão muscular. A avaliação inicial define o número de sessões e se vale combinar com ventosaterapia."]
    ] },

  { slug: "santa-cruz-do-capibaribe", nome: "Santa Cruz do Capibaribe", km: 57,
    rota: "Pela BR-104, no sentido norte — mesmo eixo de Toritama.",
    contexto: [
      "Santa Cruz do Capibaribe está a cerca de 57 km de Caruaru pela BR-104 e é o coração do Polo de Confecções do Agreste, com o Moda Center movimentando a cidade em ciclos que não respeitam fim de semana nem feriado.",
      "A cidade cresceu rápido em torno do empreendedorismo familiar: quase todo mundo tem uma facção, uma banca ou um caminhão. Essa autonomia tem um lado difícil — não existe hora de desligar, o rendimento oscila e a pressão financeira é dividida dentro de casa, o que transforma questões de trabalho em questões conjugais com muita frequência.",
      "É por isso que Santa Cruz do Capibaribe é uma das cidades de onde mais recebemos pedidos de terapia de casal, e não apenas individual."
    ],
    perfil: "De Santa Cruz do Capibaribe chegam principalmente demandas de terapia de casal, psicanálise individual e o protocolo integrativo para quem chega no limite do esgotamento físico.",
    foco: ["psicanalise-individual-e-casal", "psicologia", "protocolo-integrativo-ozonioterapia-e-detox-ionico"],
    faq: [
      ["Vocês fazem terapia de casal para quem mora em Santa Cruz?", "Fazemos, presencial em Caruaru ou online. No formato online, o casal pode participar do mesmo aparelho ou de aparelhos separados, conforme combinado com o profissional."],
      ["Qual a distância até a clínica?", "Cerca de 57 km pela BR-104 — em geral, algo em torno de uma hora de viagem."],
      ["Consigo marcar em semana de feira?", "Sim, mas as agendas enchem rápido nesses períodos. Quem trabalha no Moda Center costuma fixar um horário recorrente para não perder a vaga."]
    ] },

  { slug: "gravata", nome: "Gravatá", km: 53,
    rota: "Pela BR-232, no sentido Recife.",
    contexto: [
      "Gravatá fica a cerca de 53 km de Caruaru pela BR-232 e ocupa uma posição peculiar: está a meio caminho entre o Agreste e a Região Metropolitana do Recife, o que dá ao morador a opção de seguir para qualquer um dos dois lados quando precisa de um serviço especializado.",
      "Conhecida pelo clima serrano, pela gastronomia e pelo turismo de fim de semana, a cidade vive uma sazonalidade forte — população que dobra em feriados, trabalho concentrado em hotelaria, restaurantes e caseiros de sítio. Quem vive desse fluxo lida com jornadas irregulares e com a inversão do descanso: trabalha quando os outros descansam.",
      "Para o paciente de Gravatá, Caruaru costuma compensar pela combinação de proximidade, custo e agenda — sobretudo quando a demanda envolve procedimentos que exigem retorno."
    ],
    perfil: "De Gravatá vêm bastante pedidos de aromaterapia e terapia floral associadas à psicanálise, além de nutrição para quem quer reorganizar a alimentação junto com o acompanhamento emocional.",
    foco: ["psicanalise-individual-e-casal", "aromaterapia", "nutricao"],
    faq: [
      ["Compensa vir de Gravatá para Caruaru?", "São cerca de 53 km pela BR-232, uma das melhores estradas do estado. Para acompanhamento contínuo, muitos pacientes alternam sessões online com idas pontuais à clínica."],
      ["Vocês atendem no fim de semana?", "A agenda regular é de segunda a sexta, mas quem trabalha em turismo e hotelaria costuma resolver bem com os horários de início da manhã ou fim da tarde. Vale perguntar a disponibilidade."],
      ["Aromaterapia funciona online?", "Funciona. A consulta define o blend e as orientações de uso; os óleos você recebe as indicações para adquirir e usar em casa."]
    ] },

  { slug: "sao-caitano", nome: "São Caitano", km: 21,
    rota: "Pela BR-423 — a cidade vizinha mais próxima da clínica.",
    contexto: [
      "São Caitano é a cidade vizinha mais próxima da clínica: cerca de 21 km pela BR-423. É perto o bastante para que a viagem não pese na decisão de começar um acompanhamento semanal.",
      "O município combina agricultura familiar, pecuária leiteira e um punhado de facções que atendem o polo de confecções da região. É uma economia de vínculos curtos, em que quase todo mundo se conhece — e isso tem um efeito direto na saúde mental: o medo de ser visto entrando num consultório de psicologia ainda afasta muita gente do cuidado.",
      "Esse é justamente um dos motivos pelos quais parte dos pacientes de São Caitano prefere fazer terapia em Caruaru, ou pelo online: o sigilo, que é obrigação profissional em qualquer formato, também vira uma questão prática de distância."
    ],
    perfil: "De São Caitano a procura maior é por psicanálise e psicologia clínica, com boa demanda também por homeopatia entre famílias que já têm essa cultura de tratamento.",
    foco: ["psicanalise-individual-e-casal", "psicologia", "homeopatia"],
    faq: [
      ["São Caitano fica a quantos km da clínica?", "Cerca de 21 km pela BR-423 — a menor distância entre as cidades que atendemos regularmente."],
      ["Alguém vai saber que eu faço terapia?", "Não. Sigilo é obrigação ética e legal do profissional, vale igualmente no presencial e no online, e nada do que é dito em sessão sai da sala."],
      ["Vocês atendem adolescentes?", "Sim, com o acompanhamento de responsável no processo inicial. Explique a situação no primeiro contato para indicarmos o profissional adequado."]
    ] },

  { slug: "agrestina", nome: "Agrestina", km: 23,
    rota: "Pela BR-104, no sentido sul.",
    contexto: [
      "Agrestina está a cerca de 23 km de Caruaru pela BR-104, no sentido sul — outra das cidades de onde se chega à clínica em pouco mais de meia hora.",
      "O município tem tradição em confecção e agricultura, e é vizinho de Cupira e Altinho, formando um pequeno corredor de municípios que dependem de Caruaru para serviços de média e alta complexidade. Em saúde mental, essa dependência é praticamente total.",
      "Como a distância é curta, é comum que pacientes de Agrestina mantenham o acompanhamento inteiramente presencial — o que ajuda bastante em processos que envolvem procedimentos, como ozonioterapia ou kinesioterapia."
    ],
    perfil: "De Agrestina chegam sobretudo demandas de psicanálise, kinesioterapia com fitas elásticas e avaliação psicológica para fins documentais.",
    foco: ["psicanalise-individual-e-casal", "kinesioterapia-fitas-elasticas", "avaliacao-psicologica-e-psicossocial"],
    faq: [
      ["Quanto tempo leva de Agrestina até Caruaru?", "São cerca de 23 km pela BR-104, geralmente pouco mais de meia hora de carro."],
      ["Vocês emitem laudo de avaliação psicológica?", "Sim, com profissional habilitado e prazo de entrega informado no momento da avaliação. Veja os detalhes na página de avaliação psicológica e psicossocial."],
      ["Preciso marcar antes ou posso chegar?", "É necessário agendar. A clínica trabalha com hora marcada para garantir que cada atendimento tenha o tempo adequado."]
    ] },

  { slug: "garanhuns", nome: "Garanhuns", km: 101,
    rota: "Pela BR-423, a Rodovia Mestre Dominguinhos — em torno de 1h35 de viagem.",
    contexto: [
      "Garanhuns é a mais distante das cidades que atendemos com regularidade: cerca de 101 km de Caruaru pela BR-423, algo em torno de uma hora e meia de estrada. Conhecida como a Suíça Pernambucana pelo clima ameno, é o principal centro do Agreste Meridional e sede do Festival de Inverno.",
      "É também uma cidade universitária, com campus da UPE e da UFAPE e um fluxo constante de estudantes que vêm de municípios menores. Público universitário longe de casa, com pressão acadêmica e orçamento apertado, é um dos perfis que mais busca terapia — e um dos que mais se beneficia do formato online.",
      "Pela distância, com pacientes de Garanhuns o online costuma ser a base do acompanhamento, com eventuais idas à clínica apenas quando há procedimento presencial indicado."
    ],
    perfil: "De Garanhuns predominam atendimentos online de psicanálise e psicologia, com procura relevante por avaliação psicológica e por acompanhamento de ansiedade em estudantes universitários.",
    foco: ["psicologia", "psicanalise-individual-e-casal", "avaliacao-psicologica-e-psicossocial"],
    faq: [
      ["Garanhuns é muito longe para fazer terapia em Caruaru?", "Para o presencial, são cerca de 101 km pela BR-423 (aproximadamente 1h35). Por isso, com pacientes de Garanhuns o acompanhamento costuma ser feito online, sem perda de qualidade."],
      ["O atendimento online tem o mesmo valor do presencial?", "Do ponto de vista clínico, sim: mesmo profissional, mesma duração, mesmo sigilo. A diferença é apenas o meio."],
      ["Sou estudante. Vocês têm alguma condição?", "Vale conversar no primeiro contato. A clínica trabalha com formatos e frequências diferentes, e nem sempre a sessão semanal é o que faz sentido no começo."]
    ] },

  { slug: "belo-jardim", nome: "Belo Jardim", km: 53,
    rota: "Pela BR-232, no sentido interior.",
    contexto: [
      "Belo Jardim fica a cerca de 53 km de Caruaru pela BR-232 e tem um perfil econômico diferente das vizinhas: é uma cidade industrial, marcada pela presença da Acumuladores Moura e de toda a cadeia de fornecedores que se formou ao redor dela.",
      "Onde há indústria de porte, há também exigência formal de saúde ocupacional — e é aí que a BemEstarClinic costuma ser procurada por empresas de Belo Jardim, não só por pessoas físicas. A NR-1, que passou a exigir o gerenciamento dos riscos psicossociais, colocou a saúde mental dentro da pauta obrigatória do RH.",
      "Atendemos, portanto, os dois lados: o trabalhador que busca acompanhamento individual e a empresa que precisa estruturar avaliação psicossocial e laudos."
    ],
    perfil: "De Belo Jardim vêm tanto demandas individuais de psicanálise quanto contratos corporativos de saúde e segurança do trabalhador e riscos psicossociais (NR-1).",
    foco: ["riscos-psicossociais-nr-1", "saude-e-seguranca-do-trabalhador", "psicanalise-individual-e-casal"],
    faq: [
      ["Vocês atendem empresas de Belo Jardim?", "Sim. A clínica tem uma frente voltada a empresas, com avaliação psicossocial, laudos e apoio ao cumprimento da NR-1. Veja a seção Para Empresas na página inicial."],
      ["Qual a distância até Caruaru?", "Cerca de 53 km pela BR-232."],
      ["A avaliação psicossocial pode ser feita na empresa?", "Esse formato é avaliado caso a caso, conforme o número de colaboradores e o escopo do trabalho. Fale com a gente para montarmos a proposta."]
    ] },

  { slug: "brejo-da-madre-de-deus", nome: "Brejo da Madre de Deus", km: 66,
    rota: "Subindo a serra, pelo acesso a Fazenda Nova.",
    contexto: [
      "Brejo da Madre de Deus está a cerca de 66 km de Caruaru e é uma das cidades mais altas e frias do Agreste — um brejo de altitude cercado por sertão, com agricultura de clima ameno e uma paisagem que destoa de tudo em volta.",
      "É no distrito de Fazenda Nova que fica a Nova Jerusalém, o maior teatro ao ar livre do mundo, que movimenta a cidade inteira na Semana Santa. Assim como acontece em Gravatá e Bezerros, é uma economia de temporada: meses de intensidade total seguidos de meses de espera.",
      "A distância é média, o que faz do formato misto a escolha mais frequente: online na maior parte do acompanhamento e presencial nos momentos em que faz diferença estar na sala."
    ],
    perfil: "De Brejo da Madre de Deus chegam principalmente pedidos de psicanálise, terapia floral e nutrição, com interesse crescente pelo exame de biorressonância.",
    foco: ["psicanalise-individual-e-casal", "terapia-floral", "exame-de-biorressonancia"],
    faq: [
      ["Quantos km separam Brejo da Madre de Deus da clínica?", "Cerca de 66 km até Caruaru."],
      ["O que é o exame de biorressonância?", "É uma avaliação usada dentro da abordagem integrativa da clínica. A página do exame explica o que ele analisa e como o resultado é utilizado no plano de cuidado."],
      ["Consigo fazer tudo online?", "As sessões de conversa e a terapia floral, sim. Biorressonância e procedimentos de contato precisam ser feitos presencialmente, em Caruaru."]
    ] },

  { slug: "surubim", nome: "Surubim", km: 76,
    rota: "No sentido norte do Agreste.",
    contexto: [
      "Surubim fica a cerca de 76 km de Caruaru, no Agreste Setentrional, e funciona como polo de comércio e serviços para um conjunto de municípios menores ao redor — Vertentes, Casinhas, Santa Maria do Cambucá, João Alfredo.",
      "Isso cria uma situação comum no interior: a cidade é referência para os vizinhos, mas ela própria precisa recorrer a Caruaru ou ao Recife quando a demanda é de especialidade. Em saúde mental, a distância até o Recife torna Caruaru a alternativa mais razoável.",
      "Pela distância, recomendamos começar pelo online e reservar o deslocamento para quando houver indicação de procedimento presencial."
    ],
    perfil: "De Surubim a procura se concentra em psicologia e psicanálise online, além de homeopatia e fitoterapia para acompanhamento continuado.",
    foco: ["psicologia", "homeopatia", "fitoterapia"],
    faq: [
      ["Vale a pena vir de Surubim até Caruaru?", "São cerca de 76 km. Para sessões de conversa, o online costuma fazer mais sentido; a viagem se justifica quando há procedimento presencial indicado."],
      ["Como funciona a primeira consulta online?", "Você agenda pelo site ou WhatsApp, recebe o horário confirmado e a orientação de como a sessão acontece. Só precisa de um lugar reservado e conexão estável."],
      ["Homeopatia e fitoterapia podem ser acompanhadas à distância?", "Podem, com consultas de retorno para ajuste da prescrição, sempre com profissional habilitado."]
    ] },

  { slug: "pesqueira", nome: "Pesqueira", km: 83,
    rota: "Pela BR-232, no sentido Sertão.",
    contexto: [
      "Pesqueira está a cerca de 83 km de Caruaru pela BR-232, já na transição do Agreste para o Sertão. A cidade tem história industrial ligada às fábricas de conservas de tomate e uma forte presença do povo indígena Xukuru do Ororubá, cuja terra ocupa boa parte do município.",
      "Esse é um contexto em que o cuidado em saúde precisa ser exercido com escuta e sem imposição cultural: modos próprios de entender adoecimento e cura convivem com a demanda por atendimento clínico formal. Terapias integrativas dialogam bem com esse território, desde que praticadas com respeito e por profissional habilitado.",
      "A distância torna o online a via principal, com deslocamento reservado para avaliações e procedimentos."
    ],
    perfil: "De Pesqueira vêm principalmente demandas de psicanálise e psicologia online, com interesse por fitoterapia e terapia floral dentro de uma abordagem integrativa.",
    foco: ["psicanalise-individual-e-casal", "fitoterapia", "terapia-floral"],
    faq: [
      ["Qual a distância de Pesqueira até a clínica?", "Cerca de 83 km pela BR-232, no sentido de Caruaru."],
      ["Vocês atendem online para o Sertão também?", "Sim. O atendimento online pelo WhatsApp não tem limite geográfico dentro do Brasil — e também alcança brasileiros que moram fora."],
      ["Terapias integrativas substituem tratamento médico?", "Não. Elas são complementares e não substituem acompanhamento médico nem medicação prescrita. A clínica trabalha de forma integrada, não concorrente."]
    ] },
];

function setMarker(html, key, content) {
  const re = new RegExp(`(<!--#${key}-->)[\\s\\S]*?(<!--\\/${key}-->)`);
  if (!re.test(html)) throw new Error(`Marcador ${key} não encontrado`);
  // replacement em função: evita que "$" no conteúdo seja interpretado ($$, $1…)
  return html.replace(re, (_m, open, close) => `${open}\n${content}\n${close}`);
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
      areaServed: [
        ...CIDADES.map((c) => ({ "@type": "City", name: c.nome, containedInPlace: { "@type": "State", name: "Pernambuco" } })),
        { "@type": "State", name: "Pernambuco" },
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
  html = setMarker(html, "HERO_BADGE", S.hero_badge);
  html = setMarker(html, "HERO_TITLE", S.hero_title);
  html = setMarker(html, "HERO_LEAD", S.hero_lead);
  html = setMarker(html, "STATS", "            " + stats);
  html = setMarker(html, "SERVICES", "          " + servicesHtml);
  html = setMarker(html, "ABOUT_TITLE", S.about_title);
  html = setMarker(html, "ABOUT_LEAD", S.about_lead);
  html = setMarker(html, "ABOUT_BULLETS", "            " + bullets);
  html = setMarker(html, "TEAM", "          " + teamHtml);
  html = setMarker(html, "PORTFOLIO", "          " + worksHtml);
  html = setMarker(html, "TESTIMONIALS", "          " + depsHtml);
  html = setMarker(html, "CONTACT_INFO", "            " + contactInfo);
  const footerEsp = services.map((s) => `<a href="/especialidades/${esc(s.slug)}/">${esc(s.title)}</a>`).join("\n            ");
  html = setMarker(html, "FOOTER_ESP", "            " + footerEsp);
  // Âncora curta (só o nome): o título "Atendemos em" já dá o contexto, e repetir
  // "Terapia em" 15 vezes empilhava 13 linhas no celular sem ganho de SEO.
  const footerCidades = [...CIDADES.map((c) => `<a href="/terapia-em-${c.slug}/">${esc(c.nome)}</a>`),
    `<a href="/terapia-em-pernambuco/">Todo o Pernambuco (online)</a>`,
    `<a href="/onde-atendemos/"><b>Ver toda a área →</b></a>`].join("\n            ");
  html = setMarker(html, "FOOTER_CIDADES", "            " + footerCidades);
  // o e-mail do rodapé vinha fixo no HTML e divergia do cadastrado no painel
  html = setMarker(html, "FOOTER_EMAIL", `          <a href="mailto:${esc(S.contact_email)}">${esc(S.contact_email)}</a>`);
  html = setMarker(html, "BLOG", "          " + posts.slice(0, 3).map(postCard).join("\n          "));
  const formServices = services.map((s) => `<option>${esc(s.title)}</option>`).join("\n                ");
  html = setMarker(html, "FORM_SERVICES", "                " + formServices);
  html = setMarker(html, "FOOTER_TAGLINE", S.footer_tagline);
  html = setMarker(html, "CNPJ", S.cnpj);
  // atualiza QUALQUER wa.me/<numero> restante (footer etc.)
  html = html.replace(/wa\.me\/\d+/g, `wa.me/${S.whatsapp}`);
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
    listTpl.replaceAll("{{SERVICES_HTML}}", "          " + servicesAllHtml)
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
    const cidadesLinks = [...CIDADES.map((c) => `<a href="/terapia-em-${c.slug}/">${esc(c.nome)}</a>`),
      `<a href="/terapia-em-pernambuco/">todo o Pernambuco</a>`].join("\n            ");
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
      espTpl.replaceAll("{{TITLE}}", esc(sv.title))
        .replaceAll("{{TITLE_ENC}}", encodeURIComponent(sv.title))
        .replaceAll("{{WA_TEXT}}", encodeURIComponent(`Olá! Quero agendar ${sv.title} na BemEstarClinic 🪷`))
        .replaceAll("{{SLUG}}", esc(sv.slug))
        .replaceAll("{{EXCERPT}}", esc(sv.text || ""))
        .replaceAll("{{META_DESC}}", esc(metaEsp))
        .replaceAll("{{TITLE_TAG}}", esc(espTitleTag))
        .replaceAll("{{CIDADES_LINKS}}", "            " + cidadesLinks)
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
            ${esp.length ? `<ul class="prof-card__tags">${esp.slice(0, 4).map((e) => {
              const sv = services.find((s) => s.title === e);
              return `<li>${sv && sv.slug ? `<a href="/especialidades/${esc(sv.slug)}/">${esc(e)}</a>` : esc(e)}</li>`;
            }).join("")}${esp.length > 4
              // quem atende muita coisa (o Dr. Ronalldo tem 9) estouraria a altura
              // do card e desalinharia a linha inteira do grid
              ? `<li class="prof-card__tags-mais" title="${esc(esp.slice(4).join(" · "))}">+${esp.length - 4}</li>`
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
  const guiaOut = guiaTpl.replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`)
    .replaceAll("{{PROFISSIONAIS_HTML}}", "          " + cardsProf)
    .replaceAll("{{GRUPOS_HTML}}", "          " + gruposHtml)
    .replaceAll("{{TOTAL}}", String(team.length))
    .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(guiaJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`);
  fs.writeFileSync(path.join(ROOT, "profissionais", "index.html"), guiaOut);

  /* ---------- /onde-atendemos/ + /terapia-em-<cidade>/ ---------- */
  const cidadeTpl = fs.readFileSync(path.join(ROOT, "src", "cidade.html"), "utf8");
  const hubTpl = fs.readFileSync(path.join(ROOT, "src", "onde-atendemos.html"), "utf8");
  const svcBySlug = new Map(services.filter((s) => s.slug).map((s) => [s.slug, s]));

  // página estadual: mesma estrutura, conteúdo próprio (foco em online)
  const ESTADO = { slug: "pernambuco", nome: "Pernambuco", estado: true,
    rota: "Presencial na sede, em Caruaru; online pelo WhatsApp para qualquer município do estado.",
    contexto: [
      "Pernambuco tem 184 municípios, e a oferta de saúde mental está longe de ser distribuída de forma equilibrada entre eles. Fora do Recife e de meia dúzia de polos regionais, encontrar psicanalista, psicólogo ou terapeuta integrativo com agenda disponível ainda é difícil — quando existe.",
      "A BemEstarClinic atende presencialmente em Caruaru, no Agreste, e online para todo o estado. O formato online é feito pelo WhatsApp e mantém exatamente as mesmas condições do presencial: o mesmo profissional, a mesma duração de sessão e o mesmo dever de sigilo, que é obrigação ética e legal independentemente do meio.",
      "Na prática, isso significa que morar em Petrolina, em Serra Talhada, em Ouricuri ou no Recife não impede ninguém de começar um acompanhamento aqui. Só os procedimentos de contato direto — ozonioterapia, detox iônico, acupuntura, ventosaterapia, kinesioterapia e o exame de biorressonância — exigem presença física na clínica."
    ],
    perfil: "No atendimento estadual, a maior parte da procura é por psicanálise e psicologia online, seguidas por avaliação psicológica com laudo e pelas terapias integrativas que dispensam contato presencial.",
    foco: ["psicanalise-individual-e-casal", "psicologia", "avaliacao-psicologica-e-psicossocial"],
    faq: [
      ["Vocês atendem online em todo o Pernambuco?", "Sim. O atendimento online é feito pelo WhatsApp e alcança qualquer município do estado, sem custo de deslocamento e com o mesmo sigilo do presencial."],
      ["Qual a diferença entre terapia online e presencial?", "Do ponto de vista clínico, nenhuma: mesmo profissional, mesma duração, mesmo compromisso ético. A diferença é apenas o meio pelo qual a sessão acontece."],
      ["O que precisa ser feito presencialmente?", "Os procedimentos de contato — ozonioterapia e detox iônico, acupuntura, ventosaterapia, kinesioterapia com fitas elásticas e o exame de biorressonância. Todo o resto funciona à distância."],
      ["Onde fica a clínica para quem quiser ir presencialmente?", "Na Rua Arthur Antônio da Silva, 481, Sala 707 — Empresarial Nordeste Corporate, bairro Universitário, Caruaru-PE."]
    ] };

  const LOCAIS = [...CIDADES, ESTADO];
  const cidadeUrl = (c) => `/terapia-em-${c.slug}/`;

  for (const c of LOCAIS) {
    const isEstado = !!c.estado, isSede = !!c.sede;
    // title ≤ ~60 e description ≤ ~158: acima disso o Google trunca na SERP e o CTR cai.
    // Nomes longos (Santa Cruz do Capibaribe, Brejo da Madre de Deus) usam a versão curta.
    const titleLongo = `Terapia em ${c.nome} — PE | Psicanálise e Terapias Integrativas`;
    const titleTag = isEstado
      ? "Terapia online em Pernambuco | BemEstarClinic"
      : titleLongo.length <= 62 ? titleLongo : `Terapia em ${c.nome}-PE | BemEstarClinic`;
    const metaDesc = isEstado
      ? "Terapia online para todo o Pernambuco: psicanálise, psicologia, avaliação psicológica e terapias integrativas, com o mesmo sigilo do presencial."
      : isSede
        ? "Psicanálise, psicologia, ozonioterapia e terapias integrativas em Caruaru-PE, no bairro Universitário. Presencial e online. Agende sua consulta."
        : `Terapia em ${c.nome}-PE: psicanálise, psicologia e terapias integrativas na clínica em Caruaru, a ${c.km} km — ou online. Agende sua consulta.`;
    const h1 = isEstado
      ? "Terapia <em>online</em> em Pernambuco"
      : isSede ? "Terapia em <em>Caruaru</em> — PE" : `Terapia em <em>${esc(c.nome)}</em> — PE`;
    const intro = isEstado
      ? "Psicanálise, psicologia, avaliação psicológica e terapias integrativas para quem mora em qualquer canto de Pernambuco — online pelo WhatsApp, ou presencial na nossa sede em Caruaru."
      : isSede
        ? "Somos uma clínica caruaruense de saúde mental e terapias integrativas, no bairro Universitário. Psicanálise, psicologia, avaliação psicológica, ozonioterapia e mais — presencial ou online."
        : `Mora em ${esc(c.nome)} e procura terapia? A BemEstarClinic fica a cerca de ${c.km} km, em Caruaru — e atende também online, pelo WhatsApp, para quem prefere não pegar a estrada.`;
    const h2Chegar = isEstado
      ? "Como funciona o atendimento em <em>todo o estado</em>"
      : isSede ? "Onde <em>estamos</em> em Caruaru" : `Como chegar até a clínica saindo de <em>${esc(c.nome)}</em>`;
    const h2Foco = isEstado
      ? "Mais procurado no <em>atendimento online</em>"
      : isSede ? "Mais procurado por quem mora em <em>Caruaru</em>" : `Mais procurado por quem vem de <em>${esc(c.nome)}</em>`;
    const h2Faq = isEstado
      ? "Perguntas sobre a <em>terapia online</em>"
      : `Perguntas de quem mora em <em>${esc(c.nome)}</em>`;
    const ctaTexto = isEstado
      ? "Onde quer que você esteja em Pernambuco, dá para começar esta semana — a primeira conversa já organiza o caminho."
      : isSede
        ? "Você está na mesma cidade que a gente: dá para marcar e vir sem nenhuma viagem pela frente."
        : `Se você mora em ${esc(c.nome)} ou na região, dá para começar hoje mesmo — presencial em Caruaru ou online, do jeito que couber na sua rotina.`;
    const labelDist = isEstado ? "Cobertura" : isSede ? "Localização" : "Distância";
    const distancia = isEstado ? "Todo o estado de Pernambuco, no formato online"
      : isSede ? "Bairro Universitário, Caruaru-PE" : `Cerca de ${c.km} km até a clínica, em Caruaru`;

    const contextoHtml = c.contexto.map((p) => `<p>${esc(p)}</p>`).join("\n          ");
    const focoHtml = c.foco.map((slug, i) => {
      const sv = svcBySlug.get(slug); if (!sv) return "";
      return `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
              <div class="service__icon">${ICONS[i % ICONS.length]}</div>
              <h3 class="service__title">${esc(sv.title)}</h3>
              <p class="service__text">${esc(sv.text)}</p>
              <a class="service__more" href="/especialidades/${esc(sv.slug)}/">Saiba mais →</a>
            </article>`;
    }).filter(Boolean).join("\n          ");
    const faqHtml = c.faq.map(([q, a]) =>
      `<details class="faq__item"><summary class="faq__q">${esc(q)}</summary><div class="faq__a"><p>${esc(a)}</p></div></details>`).join("\n          ");
    const outrasHtml = LOCAIS.filter((o) => o.slug !== c.slug)
      .map((o) => `<a href="${cidadeUrl(o)}">${esc(o.nome)}</a>`).join("\n            ");

    const cj = { "@context": "https://schema.org", "@graph": [
      { "@type": "MedicalClinic", "@id": `${SITE}${cidadeUrl(c)}#clinica`, name: "BemEstarClinic",
        url: `${SITE}${cidadeUrl(c)}`, image: `${SITE}/assets/img/og-image.png`, telephone: "+" + S.whatsapp,
        description: metaDesc, priceRange: "$$",
        address: { "@type": "PostalAddress", streetAddress: "Rua Arthur Antônio da Silva, 481, 7º andar, Sala 707 — Empresarial Nordeste Corporate",
          addressLocality: "Caruaru", addressRegion: "PE", postalCode: "55016-445", addressCountry: "BR" },
        areaServed: isEstado
          ? [{ "@type": "State", name: "Pernambuco" }]
          : [{ "@type": "City", name: c.nome, containedInPlace: { "@type": "State", name: "Pernambuco" } }],
        availableService: c.foco.map((sl) => svcBySlug.get(sl)).filter(Boolean).map((sv) => ({ "@type": "MedicalTherapy", name: sv.title })),
        parentOrganization: { "@id": `${SITE}/#org` } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Onde atendemos", item: `${SITE}/onde-atendemos/` },
        { "@type": "ListItem", position: 3, name: c.nome, item: `${SITE}${cidadeUrl(c)}` } ] },
      { "@type": "FAQPage", mainEntity: c.faq.map(([q, a]) => ({
        "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    ] };

    fs.mkdirSync(path.join(ROOT, `terapia-em-${c.slug}`), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `terapia-em-${c.slug}`, "index.html"),
      cidadeTpl.replaceAll("{{SLUG}}", esc(c.slug)).replaceAll("{{CIDADE}}", esc(c.nome))
        .replaceAll("{{TITLE_TAG}}", esc(titleTag)).replaceAll("{{META_DESC}}", esc(metaDesc))
        .replaceAll("{{H1}}", h1).replaceAll("{{INTRO}}", intro)
        .replaceAll("{{H2_CHEGAR}}", h2Chegar).replaceAll("{{H2_FOCO}}", h2Foco).replaceAll("{{H2_FAQ}}", h2Faq)
        .replaceAll("{{CTA_TEXTO}}", ctaTexto)
        .replaceAll("{{LABEL_DISTANCIA}}", labelDist).replaceAll("{{DISTANCIA}}", esc(distancia))
        .replaceAll("{{ROTA}}", esc(c.rota)).replaceAll("{{PERFIL}}", esc(c.perfil))
        .replaceAll("{{CONTEXTO_HTML}}", contextoHtml).replaceAll("{{FOCO_HTML}}", focoHtml)
        .replaceAll("{{FAQ_HTML}}", faqHtml).replaceAll("{{OUTRAS_HTML}}", outrasHtml)
        .replaceAll("{{COUNT}}", String(services.length))
        .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(cj, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
        .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));
  }

  // hub /onde-atendemos/
  const hubCards = LOCAIS.map((c, i) => `<a class="card cidade-card" href="${cidadeUrl(c)}" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <h3 class="cidade-card__nome">${esc(c.nome)}</h3>
            <p class="cidade-card__dist">${c.estado ? "Online, todo o estado" : c.sede ? "Aqui é a nossa sede" : `a cerca de ${c.km} km da clínica`}</p>
            <span class="cidade-card__more">Ver atendimento →</span>
          </a>`).join("\n          ");
  const hubJ = { "@context": "https://schema.org", "@graph": [
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Onde atendemos", item: `${SITE}/onde-atendemos/` } ] },
    { "@type": "ItemList", name: "Cidades atendidas pela BemEstarClinic",
      itemListElement: LOCAIS.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.nome, url: `${SITE}${cidadeUrl(c)}` })) },
  ] };
  fs.mkdirSync(path.join(ROOT, "onde-atendemos"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "onde-atendemos", "index.html"),
    hubTpl.replaceAll("{{CIDADES_HTML}}", "          " + hubCards)
      .replaceAll("{{JSONLD}}", `<script type="application/ld+json">\n  ${JSON.stringify(hubJ, null, 2).replace(/\n/g, "\n  ")}\n  </script>`)
      .replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`));

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
  let privHtml = privTpl.replaceAll("{{DATA_BR}}", dateBR(hojeISO))
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
    setMarker(agendarTpl, "FORM_SERVICES", "                " + services.map((s) => `<option>${esc(s.title)}</option>`).join("\n                "))
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
    { t: "Onde atendemos — Caruaru e região", u: "/onde-atendemos/", tipo: "Cobertura", d: "Cidades do Agreste atendidas pela clínica, com distância, acesso e as especialidades mais procuradas em cada uma." },
    { t: "Política de Privacidade", u: "/privacidade/", tipo: "Institucional", d: "Como tratamos os seus dados pessoais: o que coletamos, por quê, com quem compartilhamos, prazos de guarda e como exercer os seus direitos pela LGPD." },
    ...LOCAIS.map((c) => ({ t: c.estado ? "Terapia online em Pernambuco" : `Terapia em ${c.nome}`, u: cidadeUrl(c),
      tipo: "Cidade", d: strip(c.perfil) + " " + strip(c.contexto[0]) })),
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
    blogTpl.replaceAll("{{POSTS_HTML}}", "          " + (posts.map(postCard).join("\n          ") || '<p class="blog-empty">Em breve, novidades por aqui! 🪷</p>'))
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
      postTpl.replaceAll("{{TITLE}}", esc(po.title)).replaceAll("{{EXCERPT}}", esc(po.excerpt))
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
    { loc: `${SITE}/onde-atendemos/`, pri: "0.9", freq: "monthly" },
    ...LOCAIS.map((c) => ({ loc: `${SITE}${cidadeUrl(c)}`, pri: c.sede || c.estado ? "0.9" : "0.8", freq: "monthly" })),
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
const KEYS = ["hero_badge", "hero_title", "hero_lead", "stats", "about_title", "about_lead", "about_bullets",
  "whatsapp", "whatsapp_display", "phone_fixed", "contact_email", "instagram", "address", "footer_tagline", "cnpj"];
function slug(s) { return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

/* ------------------------------ Servidor ---------------------------------- */
http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  try {
    if (p.startsWith("/api/")) {
      if (p === "/api/login" && req.method === "POST") {
        const { password } = await readBody(req);
        if (sha(password) !== getS("admin_password_hash")) return json(res, 401, { error: "Senha incorreta" });
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
      if (p === "/api/logout" && req.method === "POST") {
        const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); if (m) sessions.delete(m[1]);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/password" && req.method === "POST") {
        const { current, next } = await readBody(req);
        if (sha(current) !== getS("admin_password_hash")) return json(res, 400, { error: "Senha atual incorreta" });
        if (!next || String(next).length < 6) return json(res, 400, { error: "Nova senha deve ter 6+ caracteres" });
        setS("admin_password_hash", sha(next));
        return json(res, 200, { ok: true });
      }
      if (p === "/api/content") {
        const S = {}; for (const k of KEYS) S[k] = getS(k) || "";
        return json(res, 200, {
          settings: S,
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
    if (/^\/(data|src|server\.js)(\/|$)/.test(p)) { res.writeHead(404); return res.end("404"); }

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
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`\n  BemEstarClinic — site + gerenciador v${APP_VERSION}`);
  console.log(`  · Site:   http://localhost:${PORT}/`);
  console.log(`  · Painel: http://localhost:${PORT}/admin/`);
  // avisa sem imprimir a senha: em produção esse log vai parar no journalctl
  if (getS("admin_password_hash") === sha("bemestar-admin"))
    console.log(`  ⚠ A senha do painel ainda é a padrão. Troque em Painel → Senha antes de publicar.\n`);
  else console.log("");
});
