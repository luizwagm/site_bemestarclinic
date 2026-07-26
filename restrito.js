/* ==========================================================================
   restrito.js — Sistema de Gestão da BemEstarClinic (área /restrito)

   INDEPENDENTE do painel do site (/admin). Compartilha só o processo Node e a
   porta; tudo o mais é separado:
     · banco próprio  → data/gestao.db  (nunca toca em data/site.db)
     · sessão própria → cookie "rid"    (não confunde com o "sid" do admin)
     · login próprio, layout próprio, rotas próprias sob /restrito

   O server.js delega para cá tudo que começa com /restrito. Como o nginx já
   encaminha o domínio inteiro para o Node, /restrito funciona sem mexer no
   vhost.

   ATENÇÃO — dado sensível (LGPD): este banco guarda CPF, endereço, anamnese e
   prontuário de saúde. É dado pessoal SENSÍVEL (art. 5º, II da LGPD). Por isso:
   escuta só no localhost (herda do server.js), envia noindex, exige login, e o
   deploy.sh precisa proteger o gestao.db do mesmo jeito que protege o site.db.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
// Versão do sistema de gestão da clínica (/restrito). Feature nova → sobe a 2ª
// casa (1.1.0, 1.2.0…); correção de bug → a 3ª (1.0.1, 1.0.2…).
const SISTEMA_VERSION = "1.1.1";
// CSP das telas do sistema de gestão e do portal — bloqueia script/objeto
// externos; só libera as fontes do Google. 'unsafe-inline' é preciso porque as
// telas usam script/estilo inline. A janela de impressão (about:blank via
// document.write) herda esta política — por isso o print usa <script> inline
// e imagem de mesma origem, ambos permitidos aqui.
const CSP_GESTAO = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const db = new DatabaseSync(path.join(ROOT, "data", "gestao.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- operadores do sistema (login). perfil: admin | profissional | secretaria.
  -- profissional_id liga um usuário-profissional ao seu registro na tabela
  -- profissionais — é assim que ele enxerga "a SUA agenda".
  CREATE TABLE IF NOT EXISTS g_usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, email TEXT UNIQUE, senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL DEFAULT 'admin', ativo INTEGER DEFAULT 1,
    profissional_id INTEGER, criado TEXT);

  -- configurações internas do sistema (chave/valor)
  CREATE TABLE IF NOT EXISTS g_config (key TEXT PRIMARY KEY, value TEXT);

  -- Pacientes (clientes da clínica). Campos espelham a ficha de cadastro usada
  -- hoje pela recepção. "codigo" é o nº de prontuário exibido na ficha.
  CREATE TABLE IF NOT EXISTS pacientes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT, nome TEXT NOT NULL, nome_contato TEXT, foto TEXT,
    juridica INTEGER DEFAULT 0, estrangeiro INTEGER DEFAULT 0,
    cpf TEXT, rg TEXT, sexo TEXT, nascimento TEXT, naturalidade TEXT,
    estado_civil TEXT, convenio_id INTEGER, religiao TEXT, profissao TEXT, escolaridade TEXT,
    altura TEXT, peso TEXT, cor_pele TEXT, prioridade TEXT, sangue TEXT,
    cep TEXT, endereco TEXT, numero TEXT, bairro TEXT, cidade TEXT, complemento TEXT,
    celular TEXT, telefone TEXT, email TEXT, canal TEXT,
    mae TEXT, pai TEXT, tag TEXT, indicacao TEXT, avisos INTEGER DEFAULT 1,
    resp_nome TEXT, resp_cpf TEXT, resp_rg TEXT, resp_nascimento TEXT,
    consentimento INTEGER DEFAULT 0, observacao TEXT, criado TEXT);

  -- Convênios aceitos (Particular, Cartão BemEstarClinic, System Saúde…)
  CREATE TABLE IF NOT EXISTS convenios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, registro TEXT, contato TEXT, observacao TEXT,
    ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Procedimentos: cada linha é "o que se agenda". tipo = Consulta | Sessão |
  -- Procedimento (a agenda filtra por isso). cor identifica na agenda.
  CREATE TABLE IF NOT EXISTS procedimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, tipo TEXT DEFAULT 'Consulta', valor TEXT, duracao INTEGER DEFAULT 40,
    cor TEXT, ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Salas / consultórios
  CREATE TABLE IF NOT EXISTS salas (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Profissionais. "especialidade" guarda um JSON array de procedimentos que ele
  -- realiza; "cor" identifica a agenda dele na visão de todos os profissionais.
  CREATE TABLE IF NOT EXISTS profissionais (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, especialidade TEXT, registro TEXT, contato TEXT,
    cor TEXT, ativo INTEGER DEFAULT 1, criado TEXT);

  -- Agenda de atendimentos
  CREATE TABLE IF NOT EXISTS atendimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, profissional_id INTEGER, sala_id INTEGER, convenio_id INTEGER,
    procedimento_id INTEGER, especialidade TEXT,
    nome_agenda TEXT, celular TEXT,
    data TEXT, hora TEXT, hora_fim TEXT, valor TEXT,
    primeira INTEGER DEFAULT 0, encaixe INTEGER DEFAULT 0,
    lembrete INTEGER DEFAULT 1, nps INTEGER DEFAULT 1,
    status TEXT DEFAULT 'Agendado', observacoes TEXT, criado TEXT);

  -- Prontuário eletrônico (evolução por sessão). usuario_id = operador que criou
  -- o registro; o perfil "profissional" só enxerga os seus.
  CREATE TABLE IF NOT EXISTS prontuario (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, atendimento_id INTEGER, profissional TEXT, especialidade TEXT,
    data TEXT, avaliacao TEXT, evolucao TEXT, plano TEXT, encaminhamentos TEXT,
    anexos TEXT, responsavel TEXT, usuario_id INTEGER, criado TEXT);

  -- ANAMNESES. Uma linha por anamnese preenchida. "tipo" diz qual formulário
  -- (psicanalise | ozonio | integrativas) e "dados" guarda as respostas em JSON,
  -- então acrescentar pergunta no modelo NÃO exige mexer no banco.
  CREATE TABLE IF NOT EXISTS anamneses (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL, tipo TEXT NOT NULL, dados TEXT,
    profissional TEXT, data TEXT, usuario_id INTEGER, criado TEXT, atualizado TEXT);

  -- Documentos por paciente
  CREATE TABLE IF NOT EXISTS documentos_gestao (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, tipo TEXT, titulo TEXT, arquivo TEXT, data TEXT, criado TEXT);

  CREATE INDEX IF NOT EXISTS idx_atend_data ON atendimentos(data);
  CREATE INDEX IF NOT EXISTS idx_atend_pac ON atendimentos(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_pront_pac ON prontuario(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_anam_pac ON anamneses(paciente_id);
`);

// Migração leve para bancos criados antes destas colunas (o CREATE IF NOT EXISTS
// não altera tabela existente). Ignora o erro se a coluna já existir.
for (const alt of [
  "ALTER TABLE prontuario ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE g_usuarios ADD COLUMN profissional_id INTEGER",
  "ALTER TABLE profissionais ADD COLUMN cor TEXT",
  "ALTER TABLE profissionais ADD COLUMN criado TEXT",
  "ALTER TABLE atendimentos ADD COLUMN sala_id INTEGER",
  "ALTER TABLE atendimentos ADD COLUMN convenio_id INTEGER",
  "ALTER TABLE atendimentos ADD COLUMN procedimento_id INTEGER",
  "ALTER TABLE atendimentos ADD COLUMN hora_fim TEXT",
  "ALTER TABLE atendimentos ADD COLUMN nome_agenda TEXT",
  "ALTER TABLE atendimentos ADD COLUMN celular TEXT",
  "ALTER TABLE atendimentos ADD COLUMN primeira INTEGER DEFAULT 0",
  "ALTER TABLE atendimentos ADD COLUMN encaixe INTEGER DEFAULT 0",
  "ALTER TABLE atendimentos ADD COLUMN lembrete INTEGER DEFAULT 1",
  "ALTER TABLE atendimentos ADD COLUMN nps INTEGER DEFAULT 1",
]) { try { db.exec(alt); } catch { /* já existe */ } }

/* ------------------------- senha (scrypt) e config ------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function confereSenha(senha, guardado) {
  if (!guardado || !guardado.startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2, { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}
/* Hash descartável usado só para gastar o mesmo tempo quando o login digitado
   não existe — ver o comentário no /api/login. Nunca confere com senha alguma. */
const HASH_ISCA = hashSenha(crypto.randomBytes(16).toString("hex"));
const getC = (k) => db.prepare("SELECT value FROM g_config WHERE key=?").get(k)?.value;
const setC = (k, v) => db.prepare("INSERT INTO g_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* Semente: um usuário admin inicial. Senha padrão trocável na primeira entrada. */
if (db.prepare("SELECT COUNT(*) c FROM g_usuarios").get().c === 0) {
  db.prepare("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)")
    .run("Administrador", "admin", hashSenha("bemestar-gestao"), "admin", new Date().toISOString());
  console.log("  · /restrito: sistema de gestão criado. Login: admin · senha: bemestar-gestao");
}

/* Semente dos cadastros da clínica (listas passadas pela recepção). Só roda com
   a tabela vazia — o que o cliente editar depois nunca é sobrescrito. */
const AGORA_SEED = new Date().toISOString();
if (db.prepare("SELECT COUNT(*) c FROM convenios").get().c === 0) {
  ["Particular", "Cartão BemEstarClinic", "Efycard", "Forms Fitness Academia",
   "Pad Saúde", "Prosmed", "São Gabriel", "System Saúde"]
    .forEach((n, i) => db.prepare("INSERT INTO convenios(nome,ativo,sort,criado) VALUES(?,1,?,?)").run(n, i, AGORA_SEED));
}
if (db.prepare("SELECT COUNT(*) c FROM salas").get().c === 0) {
  ["Consultório 01", "Consultório 02", "Consultório 03"]
    .forEach((n, i) => db.prepare("INSERT INTO salas(nome,ativo,sort,criado) VALUES(?,1,?,?)").run(n, i, AGORA_SEED));
}
if (db.prepare("SELECT COUNT(*) c FROM procedimentos").get().c === 0) {
  // [nome, tipo, cor] — a cor identifica o procedimento na agenda
  [["Psicanálise Individual", "Consulta", "#5B4FD8"], ["Psicanálise Individual", "Sessão", "#7C6FE8"],
   ["Psicanálise Casal", "Consulta", "#4338A8"], ["Psicanálise Casal", "Sessão", "#6C5FD0"],
   ["Protocolo Integrativo — Ozônio e Detox", "Consulta", "#0E8F7E"], ["Protocolo Integrativo — Ozônio e Detox", "Sessão", "#14B8A6"],
   ["Ozonioterapia", "Consulta", "#0F766E"], ["Ozonioterapia", "Sessão", "#2DD4BF"],
   ["Detox Iônico", "Consulta", "#B45309"], ["Detox Iônico", "Sessão", "#F59E0B"],
   ["Acupuntura", "Consulta", "#BE185D"], ["Acupuntura", "Sessão", "#EC4899"],
   ["Aromaterapia", "Consulta", "#7C3AED"],
   ["Terapia Floral", "Consulta", "#A855F7"],
   ["Exame de Biorressonância", "Procedimento", "#0284C7"],
   ["Ventosaterapia", "Consulta", "#C2410C"], ["Ventosaterapia", "Sessão", "#F97316"],
   ["Kinesioterapia", "Consulta", "#15803D"], ["Kinesioterapia", "Sessão", "#22C55E"]]
    .forEach((p, i) => db.prepare("INSERT INTO procedimentos(nome,tipo,cor,duracao,ativo,sort,criado) VALUES(?,?,?,40,1,?,?)")
      .run(p[0], p[1], p[2], i, AGORA_SEED));
}
if (db.prepare("SELECT COUNT(*) c FROM profissionais").get().c === 0) {
  [["Dr. Ronalldo JM", "#5B4FD8"], ["Dr. Samuel Teixdan", "#0E8F7E"]]
    .forEach((p) => db.prepare("INSERT INTO profissionais(nome,especialidade,cor,ativo,criado) VALUES(?,'[]',?,1,?)")
      .run(p[0], p[1], AGORA_SEED));
}

/* ------------------------------- sessões --------------------------------- */
const SESSAO_HORAS = 8;
const sessoes = new Map();   // rid -> { userId, perfil, nome, ts }
function novaSessao(u) {
  const rid = crypto.randomBytes(24).toString("hex");
  sessoes.set(rid, { userId: u.id, perfil: u.perfil, nome: u.nome, profissionalId: u.profissional_id || null, ts: Date.now() });
  return rid;
}
function sessao(req) {
  const m = /(?:^|;\s*)rid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoes.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_HORAS * 3600_000) { sessoes.delete(m[1]); return null; }
  s.ts = Date.now();
  return { rid: m[1], ...s };
}
setInterval(() => {
  const lim = Date.now() - SESSAO_HORAS * 3600_000;
  for (const [k, v] of sessoes) if (v.ts < lim) sessoes.delete(k);
}, 30 * 60_000).unref();

/* Trava de força bruta por IP (igual filosofia do admin) */
const TENT_MAX = 5, BLOQ_MIN = 15;
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() - t.ts > BLOQ_MIN * 60_000) { tentativas.delete(ip); return false; }
  return t.n >= TENT_MAX;
}
function erroLogin(ip) {
  const t = tentativas.get(ip) || { n: 0, ts: Date.now() };
  t.n++; t.ts = Date.now(); tentativas.set(ip, t);
}

/* -------------------------------- utilidades ----------------------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Regras de agenda da clínica. O atendimento tem início e fim próprios (o fim é
   sugerido pela duração do procedimento, mas a recepção pode ajustar).
   Conferimos: horário válido, fim depois do início, dentro do expediente
   (06h–22h) e sem choque com outro atendimento DO MESMO profissional no dia —
   e, separadamente, sem choque na MESMA sala. Devolve a mensagem ou null. */
const EXPEDIENTE_INI = 6 * 60, EXPEDIENTE_FIM = 22 * 60;
const emMin = (hhmm) => { const [h, m] = String(hhmm || "").split(":").map(Number); return Number.isNaN(h) ? null : h * 60 + (m || 0); };
function validarAgenda(profissionalId, data, hora, excluirId, horaFim, salaId) {
  if (!hora) return null;                        // sem horário definido, sem regra a aplicar
  const ini = emMin(hora);
  if (ini === null) return "Horário inválido.";
  const fim = emMin(horaFim) ?? (ini + 40);
  if (fim <= ini) return "O horário final precisa ser depois do inicial.";
  if (ini < EXPEDIENTE_INI || fim > EXPEDIENTE_FIM)
    return "Horário fora do expediente da clínica (06h às 22h).";
  if (!data) return null;

  const choque = (linhas, quem) => {
    for (const o of linhas) {
      const oi = emMin(o.hora); if (oi === null) continue;
      const of = emMin(o.hora_fim) ?? (oi + 40);
      if (ini < of && oi < fim) return `Choque de horário: ${quem} já tem atendimento das ${o.hora} às ${o.hora_fim || "—"}.`;
    }
    return null;
  };
  const busca = (col, val) => excluirId
    ? db.prepare(`SELECT hora,hora_fim FROM atendimentos WHERE ${col}=? AND data=? AND hora<>'' AND status<>'Cancelado' AND id<>?`).all(val, data, excluirId)
    : db.prepare(`SELECT hora,hora_fim FROM atendimentos WHERE ${col}=? AND data=? AND hora<>'' AND status<>'Cancelado'`).all(val, data);

  if (profissionalId) { const e = choque(busca("profissional_id", profissionalId), "este profissional"); if (e) return e; }
  if (salaId) { const e = choque(busca("sala_id", salaId), "esta sala"); if (e) return e; }
  return null;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
const agora = () => new Date().toISOString();
function readBody(req) {
  return new Promise((ok, err) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } });
    req.on("error", err);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.end(JSON.stringify(obj));
}

/* Tabelas expostas via CRUD genérico e suas colunas graváveis */
const TAB = {
  pacientes: ["codigo", "nome", "nome_contato", "foto", "juridica", "estrangeiro", "cpf", "rg", "sexo",
    "nascimento", "naturalidade", "estado_civil", "convenio_id", "religiao", "profissao", "escolaridade",
    "altura", "peso", "cor_pele", "prioridade", "sangue", "cep", "endereco", "numero", "bairro", "cidade",
    "complemento", "celular", "telefone", "email", "canal", "mae", "pai", "tag", "indicacao", "avisos",
    "resp_nome", "resp_cpf", "resp_rg", "resp_nascimento", "consentimento", "observacao"],
  convenios: ["nome", "registro", "contato", "observacao", "ativo", "sort"],
  procedimentos: ["nome", "tipo", "valor", "duracao", "cor", "ativo", "sort"],
  salas: ["nome", "ativo", "sort"],
  profissionais: ["nome", "especialidade", "registro", "contato", "cor", "ativo"],
  atendimentos: ["paciente_id", "profissional_id", "sala_id", "convenio_id", "procedimento_id", "especialidade",
    "nome_agenda", "celular", "data", "hora", "hora_fim", "valor", "primeira", "encaixe", "lembrete", "nps",
    "status", "observacoes"],
  prontuario: ["paciente_id", "atendimento_id", "profissional", "especialidade", "data", "avaliacao", "evolucao", "plano", "encaminhamentos", "anexos", "responsavel", "usuario_id"],
  anamneses: ["paciente_id", "tipo", "dados", "profissional", "data", "usuario_id"],
  documentos_gestao: ["paciente_id", "tipo", "titulo", "arquivo", "data"],
};

const UPLOAD_DIR = path.join(ROOT, "restrito", "arquivos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Perfis de acesso. Cada perfil enxerga só os módulos abaixo; "usuarios" é
   sempre exclusivo do admin. O front esconde o que não pode, mas quem MANDA é
   esta checagem no servidor.
   - admin: acesso total.
   - secretaria/recepção: cadastros, agenda e relatórios — NÃO vê prontuário nem
     anamnese (dado clínico sensível).
   - profissional de saúde: sua agenda, seus prontuários e as anamneses. */
const PERFIS = ["admin", "secretaria", "profissional"];
const PERM = {
  admin: "*",
  secretaria: new Set(["pacientes", "profissionais", "atendimentos", "documentos_gestao",
    "convenios", "procedimentos", "salas", "relatorios"]),
  // profissional: sua agenda, seus prontuários e as anamneses dos pacientes.
  // Lê pacientes/profissionais/procedimentos só como apoio (nomes e seletores).
  profissional: new Set(["atendimentos", "prontuario", "anamneses"]),
};
const PERM_LEITURA = { profissional: new Set(["pacientes", "profissionais", "procedimentos", "convenios", "salas"]) };
const pode = (perfil, modulo) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(modulo) : false);
const podeLer = (perfil, modulo) => pode(perfil, modulo) || (PERM_LEITURA[perfil] && PERM_LEITURA[perfil].has(modulo));
const adminsAtivos = () => db.prepare("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1").get().c;

// Colunas reais de cada tabela (do próprio banco). Serve para o CRUD só gravar
// o que existe — e para saber se a tabela tem "criado" antes de carimbá-lo.
const COLS = {};
for (const t of Object.keys(TAB)) COLS[t] = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));

/* ==========================================================================
   MODELOS DE ANAMNESE — fonte única
   Descrevem os formulários das 3 anamneses entregues pela clínica. O mesmo
   objeto monta o formulário na tela E a versão impressa, então acrescentar uma
   pergunta aqui já reflete nos dois lugares e NÃO exige mexer no banco (as
   respostas ficam em anamneses.dados como JSON).

   Tipos de campo: text | textarea | date | number | select | radio | check |
   simnao (par Sim/Não) | matriz (linhas × colunas de caixas) | lista (linhas
   que o usuário acrescenta, com colunas próprias).

   O bloco "Dados pessoais" não entra aqui: ele é preenchido automaticamente com
   o cadastro do paciente (pedido do Dr.) e sai no cabeçalho da ficha.
   ========================================================================== */
const MODELOS_ANAMNESE = {
  psicanalise: {
    titulo: "Anamnese — Psicanálise",
    rotulo: "Psicanálise",
    secoes: [
      { titulo: "Motivo da consulta", campos: [
        ["queixa", "Queixa principal", "textarea"],
        ["tempo", "Há quanto tempo?", "text"],
        ["espera", "O que espera da terapia?", "textarea"],
        ["objetivos", "Objetivos", "textarea"],
      ]},
      { titulo: "História do desenvolvimento", campos: [
        ["gravidez", "Gravidez", "radio", { opcoes: ["Planejada", "Não planejada"] }],
        ["parto", "Parto", "radio", { opcoes: ["Normal", "Cesárea"] }],
        ["amamentacao", "Amamentação", "text"],
        ["fala", "Desenvolvimento da fala", "text"],
        ["motor", "Desenvolvimento motor", "text"],
      ]},
      { titulo: "Dinâmica familiar", campos: [
        ["pai", "Pai", "text"],
        ["mae", "Mãe", "text"],
        ["irmaos", "Irmãos", "text"],
        ["relacionamento", "Relacionamento", "textarea"],
        ["mora_com", "Mora com quem?", "text"],
      ]},
      { titulo: "História médica", campos: [
        ["doencas", "Doenças", "textarea"],
        ["cirurgias", "Cirurgias", "textarea"],
        ["medicamentos", "Medicamentos", "textarea"],
        ["alergias", "Alergias", "textarea"],
        ["psiquiatra", "Acompanhamento psiquiátrico", "simnao"],
        ["ja_terapia", "Já fez terapia?", "simnao"],
        ["terapia_tempo", "Se sim, quanto tempo?", "text"],
        ["terapia_quem", "Com qual profissional?", "check", { opcoes: ["Psicólogo", "Psicanalista"] }],
      ]},
      { titulo: "Saúde emocional", campos: [
        ["ansiedade", "Ansiedade", "radio", { opcoes: ["Nunca", "Às vezes", "Frequente"] }],
        ["depressao", "Depressão", "radio", { opcoes: ["Nunca", "Às vezes", "Frequente"] }],
        ["estresse", "Estresse", "radio", { opcoes: ["Baixo", "Médio", "Alto"] }],
        ["sono", "Sono", "radio", { opcoes: ["Bom", "Regular", "Ruim"] }],
      ]},
      { titulo: "Histórico familiar", tipo: "matriz", campo: "hist_familiar",
        linhas: ["Ansiedade", "Depressão", "Bipolaridade", "Suicídio", "Alcoolismo", "Dependência química"],
        colunas: ["Pai", "Mãe", "Irmãos", "Outros"] },
      { titulo: "Personalidade", campos: [
        ["personalidade", "Traços", "check", { opcoes: ["Introvertido", "Extrovertido", "Ansioso", "Organizado",
          "Impulsivo", "Perfeccionista", "Sensível", "Comunicativo", "Reservado"] }],
      ]},
      { titulo: "Memórias importantes", campos: [
        ["mem_positivas", "Positivas", "textarea"],
        ["mem_negativas", "Negativas", "textarea"],
      ]},
      { titulo: "Complemento", campos: [
        ["mais_info", "Mais informações / objetivos da terapia do paciente", "textarea"],
        ["anotacoes", "Anotações do psicanalista", "textarea"],
      ]},
    ],
  },

  ozonio: {
    titulo: "Anamnese — Ozonioterapia",
    rotulo: "Ozonioterapia",
    secoes: [
      { titulo: "Motivo da consulta", campos: [
        ["queixa", "Queixa principal", "textarea"],
        ["objetivo", "Objetivo do tratamento", "textarea"],
        ["tempo", "Há quanto tempo apresenta o problema?", "text"],
        ["outro_tratamento", "Já fez outro tratamento?", "textarea"],
      ]},
      { titulo: "Check-list médico", tipo: "matriz", campo: "condicoes", colunas: ["Sim", "Não"], exclusivo: true,
        linhas: ["Hipertensão", "Diabetes", "Cardiopatia", "AVC", "Trombose", "Varizes", "Asma", "Bronquite",
          "Doença renal", "Hepatite", "Câncer", "Lúpus", "Osteoporose", "Epilepsia", "Ansiedade", "Depressão"] },
      { titulo: "Contraindicações da ozonioterapia", tipo: "matriz", campo: "contraindicacoes", colunas: ["Sim", "Não"], exclusivo: true,
        linhas: ["Deficiência de G6PD conhecida", "Hipertireoidismo descompensado",
          "Gravidez (quando aplicável ao protocolo)", "Hemorragia ativa", "Uso de anticoagulantes", "Febre"] },
      { titulo: "Medicamentos em uso", tipo: "lista", campo: "medicamentos", colunas: ["Medicamento", "Dose", "Horário"] },
      { titulo: "Hábitos de vida", campos: [
        ["fuma", "Fuma?", "simnao"],
        ["alcool", "Faz uso de álcool?", "simnao"],
        ["atividade", "Pratica atividade física?", "simnao"],
        ["sono", "Dorme bem?", "simnao"],
        ["alimentacao", "Alimentação equilibrada?", "simnao"],
        ["agua", "Bebe água suficiente?", "simnao"],
        ["drogas", "Uso de drogas?", "simnao"],
      ]},
      { titulo: "Histórico familiar", tipo: "matriz", campo: "hist_familiar",
        linhas: ["Diabetes", "Hipertensão", "Câncer", "Cardiopatias", "AVC"],
        colunas: ["Pai", "Mãe", "Irmãos"] },
      { titulo: "Avaliação física", campos: [
        ["pressao", "Pressão arterial", "text"],
        ["fc", "Frequência cardíaca", "text"],
        ["saturacao", "Saturação", "text"],
        ["temperatura", "Temperatura", "text"],
        ["abdominal", "Circunferência abdominal", "text"],
        ["peso", "Peso", "text"],
        ["altura", "Altura", "text"],
        ["imc", "IMC", "text"],
      ]},
      { titulo: "Indicação do tratamento", campos: [
        ["tratamentos", "Aplicar", "check", { opcoes: ["Insuflação retal", "Auricular", "Bag", "Água ozonizada",
          "Óleo ozonizado", "Infiltração", "Ventosa com ozônio",
          "Auto-hemoterapia (quando indicada e conforme regulamentação aplicável)"] }],
        ["observacoes", "Observações", "textarea"],
      ]},
    ],
  },

  integrativas: {
    titulo: "Anamnese — Terapias Integrativas",
    rotulo: "Terapias Integrativas",
    secoes: [
      { titulo: "Motivo da consulta", campos: [
        ["queixa", "Queixa principal", "textarea"],
        ["inicio", "Quando iniciou?", "text"],
        ["dor", "Intensidade da dor (0–10)", "number"],
        ["tratamento_anterior", "Já realizou tratamento?", "textarea"],
        ["objetivo", "Qual seu objetivo?", "textarea"],
      ]},
      { titulo: "Histórico de saúde", tipo: "matriz", campo: "doencas", colunas: ["Sim", "Não"], exclusivo: true,
        linhas: ["Hipertensão", "Diabetes", "Cardiopatia", "AVC", "Trombose", "Câncer", "Hepatite",
          "Doença renal", "Doença hepática", "Problema de tireoide", "Osteoporose", "Artrite",
          "Ansiedade", "Depressão", "Outro"] },
      { titulo: "Cirurgias", tipo: "lista", campo: "cirurgias", colunas: ["Cirurgia", "Ano"] },
      { titulo: "Medicamentos", tipo: "lista", campo: "medicamentos", colunas: ["Nome", "Dose", "Frequência"] },
      { titulo: "Alergias", campos: [
        ["alergia_medicamentos", "Medicamentos", "text"],
        ["alergia_alimentos", "Alimentos", "text"],
        ["alergia_produtos", "Produtos", "text"],
        ["alergia_outras", "Outras", "text"],
      ]},
      { titulo: "Hábitos", campos: [
        ["fuma", "Fuma", "simnao"],
        ["alcool", "Consome álcool", "simnao"],
        ["atividade", "Pratica atividade física", "simnao"],
        ["sono", "Dorme bem", "simnao"],
        ["agua", "Bebe água suficiente", "simnao"],
        ["alimentacao", "Alimentação equilibrada", "simnao"],
      ]},
      { titulo: "Histórico familiar", tipo: "matriz", campo: "hist_familiar",
        linhas: ["Diabetes", "Hipertensão", "Cardiopatias", "Câncer"],
        colunas: ["Pai", "Mãe", "Irmãos"] },
      { titulo: "Contraindicações importantes", tipo: "matriz", campo: "contraindicacoes", colunas: ["Sim", "Não"], exclusivo: true,
        linhas: ["Gravidez", "Marcapasso", "Uso de anticoagulantes", "Infecção ativa", "Febre", "Alergias importantes"] },
      { titulo: "Avaliação", campos: [
        ["imc", "IMC", "text"],
        ["pressao", "Pressão arterial", "text"],
        ["fc", "Frequência cardíaca", "text"],
        ["saturacao", "Saturação", "text"],
      ]},
      { titulo: "Terapias aplicadas", campos: [
        ["terapias", "Terapias", "check", { opcoes: ["Acupuntura", "Ventosaterapia", "Detox Iônico", "Fitoterapia",
          "Homeopatia", "Aromaterapia", "Kinesio Taping", "Terapia Floral"] }],
        ["terapia_outro", "Outro", "text"],
        ["observacoes", "Observações", "textarea"],
      ]},
    ],
  },
};

/* ==========================================================================
   Handler — o server.js chama isto para tudo que casa /restrito
   Retorna true se tratou a requisição.
   ========================================================================== */
function handleRestrito(req, res, pathname) {
  if (pathname !== "/restrito" && !pathname.startsWith("/restrito/")) return false;

  // normaliza /restrito -> /restrito/
  if (pathname === "/restrito") { res.writeHead(302, { Location: "/restrito/" }); res.end(); return true; }

  const rota = pathname.slice("/restrito".length) || "/";   // ex.: "/", "/api/pacientes"

  /* --------------------------- API (JSON) ------------------------------- */
  if (rota.startsWith("/api/")) { rotaApi(req, res, rota.slice(5)).catch((e) => {
    console.error("  ✖ /restrito/api:", e.message); json(res, 500, { error: "Erro interno" });
  }); return true; }

  /* ------------------------- arquivos enviados -------------------------- */
  if (rota.startsWith("/arquivos/")) {
    if (!sessao(req)) { res.writeHead(403); res.end("403"); return true; }
    const nome = path.basename(decodeURIComponent(rota.slice("/arquivos/".length)));
    const arq = path.join(UPLOAD_DIR, nome);
    if (!arq.startsWith(UPLOAD_DIR) || !fs.existsSync(arq)) { res.writeHead(404); res.end("404"); return true; }
    const ext = path.extname(arq).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    fs.createReadStream(arq).pipe(res);
    return true;
  }

  /* ------------------------------ app HTML ------------------------------ */
  if (rota === "/" || rota === "/index.html") {
    const arq = path.join(APP_DIR, "app.html");
    const html = fs.readFileSync(arq, "utf8").replace(/\{\{VERSAO\}\}/g, SISTEMA_VERSION);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_GESTAO });
    res.end(html);
    return true;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
  return true;
}

/* ------------------------------- API ------------------------------------- */
async function rotaApi(req, res, p) {
  const ip = clientIp(req);

  // login
  if (p === "login" && req.method === "POST") {
    if (bloqueado(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde 15 minutos." });
    const { usuario, senha } = await readBody(req);
    const u = db.prepare("SELECT * FROM g_usuarios WHERE email=? AND ativo=1").get(String(usuario || "").trim());
    /* Se o usuário não existe, ainda assim gastamos o mesmo tempo de um scrypt.
       Sem isto, "usuário inexistente" responde em ~1ms e "usuário certo, senha
       errada" em ~100ms — diferença que permite descobrir logins válidos por
       cronômetro antes de atacar a senha. */
    const ok = u ? confereSenha(senha, u.senha_hash) : (confereSenha(senha, HASH_ISCA), false);
    if (!ok) { erroLogin(ip); return json(res, 401, { error: "Usuário ou senha incorretos." }); }
    tentativas.delete(ip);
    const rid = novaSessao(u);
    res.setHeader("Set-Cookie", `rid=${rid}; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=${SESSAO_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    return json(res, 200, { ok: true, nome: u.nome, perfil: u.perfil });
  }

  // daqui para baixo exige sessão
  const s = sessao(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });

  if (p === "me") return json(res, 200, { nome: s.nome, perfil: s.perfil });

  if (p === "logout" && req.method === "POST") {
    sessoes.delete(s.rid);
    res.setHeader("Set-Cookie", "rid=; HttpOnly; Path=/restrito; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (p === "senha" && req.method === "POST") {
    const { atual, nova } = await readBody(req);
    const u = db.prepare("SELECT * FROM g_usuarios WHERE id=?").get(s.userId);
    if (!confereSenha(atual, u.senha_hash)) return json(res, 400, { error: "Senha atual incorreta." });
    if (String(nova || "").length < 8) return json(res, 400, { error: "A nova senha precisa de ao menos 8 caracteres." });
    db.prepare("UPDATE g_usuarios SET senha_hash=? WHERE id=?").run(hashSenha(nova), s.userId);
    for (const [k, v] of sessoes) if (v.userId === s.userId && k !== s.rid) sessoes.delete(k);
    return json(res, 200, { ok: true });
  }

  // painel: números para a home do sistema. O profissional não vê números
  // globais (só a sua agenda e prontuários) — devolve os dele.
  if (p === "painel") {
    const n = (sql) => db.prepare(sql).get().c;
    const hoje = new Date().toISOString().slice(0, 10);
    if (s.perfil === "profissional") {
      return json(res, 200, { profissional: true,
        agendaHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=? AND data=?").get(s.profissionalId, hoje).c,
        agendaTotal: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?").get(s.profissionalId).c,
        prontuarios: db.prepare("SELECT COUNT(*) c FROM prontuario WHERE usuario_id=?").get(s.userId).c });
    }
    return json(res, 200, {
      pacientes: n("SELECT COUNT(*) c FROM pacientes"),
      atendimentosHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE data=?").get(hoje).c,
      confirmadosHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE data=? AND status IN ('Confirmado','Atendido')").get(hoje).c,
      anamneses: n("SELECT COUNT(*) c FROM anamneses"),
      prontuarios: n("SELECT COUNT(*) c FROM prontuario"),
    });
  }

  // modelos de anamnese (fonte única: monta o formulário e a impressão)
  if (p === "modelos") return json(res, 200, MODELOS_ANAMNESE);

  // relatórios: agregações para a tela de indicadores
  if (p === "relatorios") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
    const grupo = (sql) => db.prepare(sql).all();
    const n = (sql) => db.prepare(sql).get().c;
    return json(res, 200, {
      totais: {
        pacientes: n("SELECT COUNT(*) c FROM pacientes"),
        atendimentos: n("SELECT COUNT(*) c FROM atendimentos"),
        atendidos: n("SELECT COUNT(*) c FROM atendimentos WHERE status='Atendido'"),
        faltas: n("SELECT COUNT(*) c FROM atendimentos WHERE status='Faltou'"),
        anamneses: n("SELECT COUNT(*) c FROM anamneses"),
        prontuarios: n("SELECT COUNT(*) c FROM prontuario"),
      },
      porProcedimento: grupo(`SELECT COALESCE(NULLIF(pr.nome,''),'(sem procedimento)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id GROUP BY rotulo ORDER BY total DESC`),
      porProfissional: grupo(`SELECT COALESCE(NULLIF(pf.nome,''),'(sem profissional)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN profissionais pf ON pf.id=a.profissional_id GROUP BY rotulo ORDER BY total DESC`),
      porConvenio: grupo(`SELECT COALESCE(NULLIF(c.nome,''),'(sem convênio)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN convenios c ON c.id=a.convenio_id GROUP BY rotulo ORDER BY total DESC`),
      porStatus: grupo("SELECT COALESCE(NULLIF(status,''),'(sem status)') rotulo, COUNT(*) total FROM atendimentos GROUP BY rotulo ORDER BY total DESC"),
      porMes: grupo("SELECT substr(data,1,7) rotulo, COUNT(*) total FROM atendimentos WHERE data<>'' GROUP BY rotulo ORDER BY rotulo DESC LIMIT 12"),
    });
  }

  // upload de arquivo/foto (fica no diretório privado do /restrito)
  if (p === "upload" && req.method === "POST") {
    const { name, dataUrl } = await readBody(req);
    const m = /^data:(image\/(?:png|jpe?g|webp)|application\/pdf);base64,(.+)$/.exec(dataUrl || "");
    if (!m) return json(res, 400, { error: "Envie imagem (png/jpg/webp) ou PDF." });
    const ext = m[1] === "application/pdf" ? ".pdf" : "." + m[1].split("/")[1].replace("jpeg", "jpg");
    /* Nome do arquivo: só letras/números/._- e nenhuma sequência de pontos (o
       ".." não conseguiria escapar do diretório aqui — gravamos com path.join e
       lemos com path.basename — mas nome de arquivo não é lugar para isso. */
    const safe = String(name || "arq").replace(/[^a-zA-Z0-9._-]/g, "").replace(/\.{2,}/g, ".")
      .replace(/^[.\-]+/, "").slice(0, 40) || "arq";
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${safe}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
    return json(res, 200, { ok: true, path: `/restrito/arquivos/${file}` });
  }

  /* ------- Usuários do sistema (perfis de acesso) — só o admin ---------- */
  if (p === "usuarios" || /^usuarios\/\d+$/.test(p)) {
    if (s.perfil !== "admin") return json(res, 403, { error: "Apenas o administrador gerencia usuários." });
    const idm = p.match(/^usuarios\/(\d+)$/);
    const id = idm ? idm[1] : null;
    // nunca devolvemos o hash da senha
    if (req.method === "GET" && !id) return json(res, 200, db.prepare("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios ORDER BY id").all());
    if (req.method === "GET" && id) return json(res, 200, db.prepare("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios WHERE id=?").get(id) || {});
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      const nome = String(b.nome || "").trim(), email = String(b.email || "").trim(), perfil = String(b.perfil || "secretaria").trim();
      if (!nome || !email) return json(res, 400, { error: "Nome e usuário (login) são obrigatórios." });
      if (!PERFIS.includes(perfil)) return json(res, 400, { error: "Perfil inválido." });
      if (String(b.senha || "").length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." });
      const profId = perfil === "profissional" && b.profissional_id ? Number(b.profissional_id) : null;
      try {
        db.prepare("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,criado) VALUES(?,?,?,?,?,?,?)")
          .run(nome, email, hashSenha(b.senha), perfil, b.ativo === undefined ? 1 : (Number(b.ativo) ? 1 : 0), profId, agora());
      } catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao criar usuário." }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && id) {
      const b = await readBody(req);
      const alvo = db.prepare("SELECT perfil,ativo FROM g_usuarios WHERE id=?").get(id);
      if (!alvo) return json(res, 404, { error: "Usuário não encontrado." });
      // não deixar o único admin ativo se rebaixar a si mesmo ou desativar
      const viraNaoAdmin = b.perfil !== undefined && b.perfil !== "admin";
      const viraInativo = b.ativo !== undefined && !Number(b.ativo);
      if (alvo.perfil === "admin" && alvo.ativo && (viraNaoAdmin || viraInativo) && adminsAtivos() <= 1)
        return json(res, 400, { error: "Não é possível rebaixar ou desativar o único administrador." });
      const sets = [], args = [];
      if (b.nome !== undefined) { sets.push("nome=?"); args.push(String(b.nome).trim()); }
      if (b.email !== undefined) { sets.push("email=?"); args.push(String(b.email).trim()); }
      if (b.perfil !== undefined) { if (!PERFIS.includes(b.perfil)) return json(res, 400, { error: "Perfil inválido." }); sets.push("perfil=?"); args.push(b.perfil); }
      if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); }
      if (b.profissional_id !== undefined) { sets.push("profissional_id=?"); args.push(b.profissional_id ? Number(b.profissional_id) : null); }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." }); sets.push("senha_hash=?"); args.push(hashSenha(b.senha)); }
      if (sets.length) {
        try { db.prepare(`UPDATE g_usuarios SET ${sets.join(",")} WHERE id=?`).run(...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao salvar." }); }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = db.prepare("SELECT perfil,ativo FROM g_usuarios WHERE id=?").get(id);
      if (alvo && alvo.perfil === "admin" && alvo.ativo && adminsAtivos() <= 1) return json(res, 400, { error: "Não é possível excluir o único administrador." });
      db.prepare("DELETE FROM g_usuarios WHERE id=?").run(id);
      return json(res, 200, { ok: true });
    }
  }

  /* Prontuário COMPLETO de um paciente, em ordem cronológica — alimenta a
     impressão do histórico ("1+ ano de tratamento, tudo em sequência").
     Junta, na mesma linha do tempo: anamneses, evoluções e atendimentos. */
  const hm = p.match(/^historico\/(\d+)$/);
  if (hm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario") && !podeLer(s.perfil, "anamneses"))
      return json(res, 403, { error: "Sem permissão." });
    const pid = hm[1];
    const paciente = db.prepare("SELECT * FROM pacientes WHERE id=?").get(pid);
    if (!paciente) return json(res, 404, { error: "Paciente não encontrado." });
    const conv = paciente.convenio_id ? db.prepare("SELECT nome FROM convenios WHERE id=?").get(paciente.convenio_id) : null;
    // o profissional só vê as evoluções que ele mesmo escreveu
    const sóMinhas = s.perfil === "profissional" ? " AND usuario_id=" + Number(s.userId) : "";
    return json(res, 200, {
      paciente: { ...paciente, convenio_nome: conv ? conv.nome : "" },
      anamneses: db.prepare("SELECT * FROM anamneses WHERE paciente_id=? ORDER BY COALESCE(NULLIF(data,''),criado), id").all(pid),
      evolucoes: db.prepare(`SELECT * FROM prontuario WHERE paciente_id=?${sóMinhas} ORDER BY COALESCE(NULLIF(data,''),criado), id`).all(pid),
      atendimentos: db.prepare(`SELECT a.*, pr.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome, cv.nome convenio_nome
        FROM atendimentos a
        LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
        LEFT JOIN profissionais pf ON pf.id=a.profissional_id
        LEFT JOIN salas sa ON sa.id=a.sala_id
        LEFT JOIN convenios cv ON cv.id=a.convenio_id
        WHERE a.paciente_id=? ORDER BY a.data, a.hora, a.id`).all(pid),
    });
  }

  // CRUD genérico: /api/<tabela>[/<id>]
  const m = p.match(/^([a-z_]+)(?:\/(\d+))?$/);
  if (m && TAB[m[1]]) {
    const tabela = m[1], id = m[2], cols = TAB[tabela];
    // leitura precisa de podeLer (o profissional lê pacientes p/ o seletor);
    // qualquer escrita exige acesso pleno ao módulo.
    if (!podeLer(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não tem acesso a este módulo." });
    if (req.method !== "GET" && !pode(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não pode alterar este módulo." });

    /* Recorte do profissional: só os SEUS registros. No prontuário "seu" = quem
       criou (usuario_id); na agenda "seu" = para quem o atendimento é marcado
       (profissional_id, ligado ao usuário). Fora esses dois casos, sem recorte. */
    let donoCol = null, donoVal = null;
    if (s.perfil === "profissional") {
      if (tabela === "prontuario") { donoCol = "usuario_id"; donoVal = s.userId; }
      else if (tabela === "atendimentos") { donoCol = "profissional_id"; donoVal = s.profissionalId; }
    }

    if (req.method === "GET" && !id) {
      const q = new URL(req.url, "http://x").searchParams;
      const busca = (q.get("q") || "").trim();
      const pacFiltro = (q.get("paciente_id") || "").trim();
      let sql = `SELECT * FROM ${tabela}`;
      const cond = [], args = [];
      // busca por nome/CPF nos pacientes; nas demais tabelas, pelo nome
      if (busca && tabela === "pacientes") { cond.push("(nome LIKE ? OR cpf LIKE ? OR codigo LIKE ?)"); args.push("%" + busca + "%", "%" + busca + "%", "%" + busca + "%"); }
      else if (busca && COLS[tabela].has("nome")) { cond.push("nome LIKE ?"); args.push("%" + busca + "%"); }
      // anamneses/prontuário/documentos podem ser filtrados por paciente
      if (pacFiltro && COLS[tabela].has("paciente_id")) { cond.push("paciente_id=?"); args.push(pacFiltro); }
      if (donoCol) { cond.push(donoCol + "=?"); args.push(donoVal); }
      if (cond.length) sql += " WHERE " + cond.join(" AND ");
      // listas de apoio saem na ordem de exibição; o resto, mais novo primeiro
      sql += ["convenios", "procedimentos", "salas"].includes(tabela) ? " ORDER BY sort, id" : " ORDER BY id DESC";
      return json(res, 200, db.prepare(sql).all(...args));
    }
    if (req.method === "GET" && id) {
      const row = db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(id);
      if (!row) return json(res, 404, { error: "Registro não encontrado." });
      if (donoCol && String(row[donoCol]) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." });
      return json(res, 200, row);
    }
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      if (tabela === "prontuario" || tabela === "anamneses") b.usuario_id = s.userId;   // carimba o dono
      if (tabela === "atendimentos" && s.perfil === "profissional") b.profissional_id = s.profissionalId; // marca na própria agenda
      if (tabela === "atendimentos") {
        const e = validarAgenda(b.profissional_id, b.data, b.hora, null, b.hora_fim, b.sala_id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "anamneses") {
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o paciente." });
        if (!MODELOS_ANAMNESE[b.tipo]) return json(res, 400, { error: "Tipo de anamnese inválido." });
        if (typeof b.dados !== "string") b.dados = JSON.stringify(b.dados || {});
      }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? use.concat("criado") : use;
      const valores = temCriado ? use.map((c) => b[c]).concat(agora()) : use.map((c) => b[c]);
      const info = db.prepare(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`).run(...valores);
      return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
    }
    if (req.method === "PUT" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      const b = await readBody(req);
      delete b.usuario_id;                                            // não se troca o dono por aqui
      if (donoCol === "profissional_id") delete b.profissional_id;    // o profissional não reatribui o atendimento
      if (tabela === "atendimentos") {
        const at = db.prepare("SELECT profissional_id,data,hora,hora_fim,sala_id FROM atendimentos WHERE id=?").get(id) || {};
        const e = validarAgenda(b.profissional_id ?? at.profissional_id, b.data ?? at.data, b.hora ?? at.hora, id,
          b.hora_fim ?? at.hora_fim, b.sala_id ?? at.sala_id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "anamneses" && b.dados !== undefined && typeof b.dados !== "string") b.dados = JSON.stringify(b.dados || {});
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      if (use.length) db.prepare(`UPDATE ${tabela} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
      if (tabela === "anamneses" && COLS.anamneses.has("atualizado")) db.prepare("UPDATE anamneses SET atualizado=? WHERE id=?").run(agora(), id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      db.prepare(`DELETE FROM ${tabela} WHERE id=?`).run(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}


module.exports = { handleRestrito };
