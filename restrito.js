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
const { abrirBanco } = require("./db");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
/* Versão do sistema de gestão da clínica (/restrito).
   REGRA DO CLIENTE: feature nova sobe a 2ª casa (1.12.0, 1.13.0, 1.14.0…);
   correção de bug sobe a 3ª (1.14.1, 1.14.2…). A primeira casa NÃO muda —
   houve um deslize em que subi para 2.x e o cliente corrigiu; a numeração
   voltou para a série 1.x, que é a que ele acompanha. */
const SISTEMA_VERSION = "1.18.1";
// CSP das telas do sistema de gestão e do portal — bloqueia script/objeto
// externos; só libera as fontes do Google. 'unsafe-inline' é preciso porque as
// telas usam script/estilo inline. A janela de impressão (about:blank via
// document.write) herda esta política — por isso o print usa <script> inline
// e imagem de mesma origem, ambos permitidos aqui.
const CSP_GESTAO = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const db = abrirBanco(path.join(ROOT, "data", "gestao.db"));

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
  -- hoje pela recepção.
  -- "codigo" (PAC-AAAA-00000) é o identificador PRÓPRIO do paciente, gerado pelo
  -- servidor no cadastro e NUNCA digitado. É por ele — além de nome e CPF — que
  -- se localiza a pessoa no agendamento, prontuário, documentos e anamneses.
  -- Não confundir com o número do PRONTUÁRIO (PR-AAAA-00000): o paciente tem um
  -- código só, e um prontuário para cada procedimento que faz.
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
    consentimento INTEGER DEFAULT 0, observacao TEXT, criado TEXT,
    -- ativo: o paciente ainda frequenta a clínica. Inativo some das telas de
    -- escolha (agenda, anamnese, prontuário) mas NUNCA é excluído: a ficha, o
    -- histórico e os prontuários continuam inteiros e ele volta com um clique.
    -- Não confundir com a ALTA, que é de um prontuário só (o paciente pode ter
    -- alta da ozonioterapia e seguir na psicanálise).
    ativo INTEGER DEFAULT 1, inativo_em TEXT, inativo_motivo TEXT);

  -- Convênios aceitos (Particular, Cartão BemEstarClinic, System Saúde…)
  CREATE TABLE IF NOT EXISTS convenios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, registro TEXT, contato TEXT, observacao TEXT,
    ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Procedimentos: cada linha é "o que se agenda". tipo = Consulta | Sessão |
  -- Procedimento (a agenda filtra por isso). cor identifica na agenda.
  -- ATENÇÃO ao par nome/tipo: "Ozonioterapia" existe duas vezes, uma como
  -- Consulta e outra como Sessão. O que identifica o TRATAMENTO é o "nome" —
  -- é ele que vira a chave do prontuário, não o id da linha. Se a chave fosse o
  -- id, a consulta e a sessão da mesma terapia abririam duas pastas.
  -- anamnese_modelo diz qual formulário de anamnese este procedimento pede
  -- (psicanalise | ozonio | integrativas | vazio = nenhum). É o que faz o
  -- agendamento oferecer o atalho para a anamnese certa.
  CREATE TABLE IF NOT EXISTS procedimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, tipo TEXT DEFAULT 'Consulta', valor TEXT, duracao INTEGER DEFAULT 40,
    cor TEXT, anamnese_modelo TEXT, ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Salas / consultórios
  CREATE TABLE IF NOT EXISTS salas (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, ativo INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, criado TEXT);

  -- Profissionais. "especialidade" guarda um JSON array de procedimentos que ele
  -- realiza; "cor" identifica a agenda dele na visão de todos os profissionais.
  CREATE TABLE IF NOT EXISTS profissionais (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, especialidade TEXT, registro TEXT, contato TEXT,
    cor TEXT, ativo INTEGER DEFAULT 1, criado TEXT);

  /* Agenda de atendimentos.
     Só se agenda para paciente CADASTRADO (paciente_id obrigatório) — é o que
     garante que todo atendimento tenha ficha, código e histórico.
     prontuario_id: o agendamento NÃO cria prontuário. Ele só se liga a um que
     JÁ exista para aquele paciente naquele procedimento. No primeiro
     atendimento não há prontuário ainda; o vínculo acontece depois, quando a
     anamnese é finalizada e a pasta nasce. */
  CREATE TABLE IF NOT EXISTS atendimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, profissional_id INTEGER, sala_id INTEGER, convenio_id INTEGER,
    procedimento_id INTEGER, especialidade TEXT, prontuario_id INTEGER,
    nome_agenda TEXT, celular TEXT,
    data TEXT, hora TEXT, hora_fim TEXT, valor TEXT,
    primeira INTEGER DEFAULT 0, encaixe INTEGER DEFAULT 0,
    lembrete INTEGER DEFAULT 1, nps INTEGER DEFAULT 1,
    status TEXT DEFAULT 'Agendado', observacoes TEXT, criado TEXT);

  /* PRONTUÁRIO = a PASTA do paciente numa especialidade.
     Regra da clínica: um prontuário por paciente + especialidade. Quem faz
     psicanálise e ozonioterapia tem DOIS prontuários; criar um terceiro para a
     mesma especialidade é impedido (índice único abaixo).
     numero (PR-AAAA-00000) identifica a pasta — é o que aparece na anamnese, no
     agendamento e nos documentos daquele paciente.
     status: Ativo | Alta. A alta é DO PRONTUÁRIO: o paciente pode receber alta
     da ozonioterapia e continuar na psicanálise. */
  CREATE TABLE IF NOT EXISTS prontuario (id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT, paciente_id INTEGER NOT NULL, especialidade TEXT NOT NULL,
    profissional TEXT, status TEXT DEFAULT 'Ativo',
    aberto_em TEXT, alta_em TEXT, alta_motivo TEXT,
    observacao TEXT, usuario_id INTEGER, criado TEXT, reativado_em TEXT);

  /* LANÇAMENTOS do prontuário. Cada avaliação, evolução, plano ou
     encaminhamento é uma linha datada — o prontuário de 2 anos de terapia vira
     uma lista longa, e é assim que tem de ser.
     arquivado: some das telas mas NUNCA é excluído (pode ser restaurado). */
  CREATE TABLE IF NOT EXISTS prontuario_registros (id INTEGER PRIMARY KEY AUTOINCREMENT,
    prontuario_id INTEGER NOT NULL, tipo TEXT NOT NULL, texto TEXT,
    data TEXT, profissional TEXT, anexo TEXT,
    arquivado INTEGER DEFAULT 0, arquivado_em TEXT,
    usuario_id INTEGER, criado TEXT, atualizado TEXT);

  /* HISTÓRICO — linha do tempo de cada paciente e de cada prontuário.
     É o que sobrevive quando o paciente sai e volta: a data de cadastro é
     atualizada na reativação, mas tudo o que aconteceu antes continua aqui. */
  CREATE TABLE IF NOT EXISTS historico (id INTEGER PRIMARY KEY AUTOINCREMENT,
    entidade TEXT NOT NULL, entidade_id INTEGER NOT NULL,
    evento TEXT NOT NULL, detalhe TEXT,
    usuario_id INTEGER, usuario_nome TEXT, criado TEXT);

  /* ANAMNESES. Uma linha por anamnese preenchida. "tipo" diz qual formulário
     (psicanalise | ozonio | integrativas) e "dados" guarda as respostas em JSON,
     então acrescentar pergunta no modelo NÃO exige mexer no banco.

     É a anamnese que ABRE o prontuário. Enquanto está sendo preenchida ela fica
     como Rascunho e não cria nada; ao ser FINALIZADA, o sistema abre (ou
     reaproveita) a pasta do par paciente + procedimento e guarda o vínculo aqui
     em prontuario_id. Por isso "procedimento" é obrigatório para finalizar: sem
     ele não há como saber de qual pasta a anamnese faz parte. */
  CREATE TABLE IF NOT EXISTS anamneses (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL, tipo TEXT NOT NULL, dados TEXT,
    procedimento TEXT, status TEXT DEFAULT 'Rascunho', finalizada_em TEXT, prontuario_id INTEGER,
    profissional TEXT, data TEXT, usuario_id INTEGER, criado TEXT, atualizado TEXT);

  -- Documentos por paciente
  CREATE TABLE IF NOT EXISTS documentos_gestao (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, tipo TEXT, titulo TEXT, arquivo TEXT, data TEXT, criado TEXT);

  CREATE INDEX IF NOT EXISTS idx_atend_data ON atendimentos(data);
  CREATE INDEX IF NOT EXISTS idx_atend_pac ON atendimentos(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_pront_pac ON prontuario(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_anam_pac ON anamneses(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_preg_pront ON prontuario_registros(prontuario_id);
  CREATE INDEX IF NOT EXISTS idx_hist_ent ON historico(entidade, entidade_id);
`);


// Migração leve para bancos criados antes destas colunas (o CREATE IF NOT EXISTS
// não altera tabela existente). Ignora o erro se a coluna já existir.
for (const alt of [
  "ALTER TABLE prontuario ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE prontuario ADD COLUMN numero TEXT",
  "ALTER TABLE prontuario ADD COLUMN status TEXT DEFAULT 'Ativo'",
  "ALTER TABLE prontuario ADD COLUMN aberto_em TEXT",
  "ALTER TABLE prontuario ADD COLUMN alta_em TEXT",
  "ALTER TABLE prontuario ADD COLUMN alta_motivo TEXT",
  "ALTER TABLE prontuario ADD COLUMN observacao TEXT",
  "ALTER TABLE prontuario ADD COLUMN reativado_em TEXT",
  "ALTER TABLE pacientes ADD COLUMN reativado_em TEXT",
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
  // vínculo agendamento → prontuário e o fluxo anamnese → prontuário
  "ALTER TABLE atendimentos ADD COLUMN prontuario_id INTEGER",
  "ALTER TABLE anamneses ADD COLUMN procedimento TEXT",
  "ALTER TABLE anamneses ADD COLUMN status TEXT DEFAULT 'Rascunho'",
  "ALTER TABLE anamneses ADD COLUMN finalizada_em TEXT",
  "ALTER TABLE anamneses ADD COLUMN prontuario_id INTEGER",
  "ALTER TABLE procedimentos ADD COLUMN anamnese_modelo TEXT",
  // marca de edição do lançamento clínico (o histórico guarda o que mudou)
  "ALTER TABLE prontuario_registros ADD COLUMN atualizado TEXT",
  // paciente ativo/inativo (some das telas de escolha, nunca é excluído)
  "ALTER TABLE pacientes ADD COLUMN ativo INTEGER DEFAULT 1",
  "ALTER TABLE pacientes ADD COLUMN inativo_em TEXT",
  "ALTER TABLE pacientes ADD COLUMN inativo_motivo TEXT",
]) { try { db.exec(alt); } catch { /* já existe */ } }

/* Fichas criadas antes desta versão não têm `ativo` preenchido — ficariam
   invisíveis nos seletores, que filtram por ativo<>0. Todas nascem ATIVAS. */
try {
  const n = db.prepare("UPDATE pacientes SET ativo=1 WHERE ativo IS NULL").run().changes;
  if (n) console.log(`  · /restrito: ${n} paciente(s) marcados como ativos.`);
} catch { /* coluna ainda não existe num banco muito antigo */ }

/* ==========================================================================
   VÍNCULOS ÓRFÃOS — apontam para um prontuário que não existe mais.
   Versões antigas deixavam apagar a pasta sem soltar o que estava dentro; o
   resultado é uma anamnese com prontuario_id preenchido apontando para o nada.
   Na tela isso aparece como "sem prontuário" na lista (a busca não acha) mas
   com o botão Excluir escondido (o campo está preenchido) — o registro fica
   impossível de apagar sem motivo visível.
   Soltar aqui devolve a anamnese para rascunho e o agendamento para a agenda,
   sem perder nada.
   ========================================================================== */
try {
  const an = db.prepare(`UPDATE anamneses SET prontuario_id=NULL, status='Rascunho', finalizada_em=NULL
     WHERE prontuario_id IS NOT NULL AND prontuario_id NOT IN (SELECT id FROM prontuario)`).run().changes;
  const at = db.prepare(`UPDATE atendimentos SET prontuario_id=NULL
     WHERE prontuario_id IS NOT NULL AND prontuario_id NOT IN (SELECT id FROM prontuario)`).run().changes;
  if (an || at) console.log(`  · /restrito: vínculos órfãos soltos — ${an} anamnese(s), ${at} agendamento(s).`);
} catch (e) { console.error("  ✖ soltar vínculos órfãos:", e.message); }

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
/* ==========================================================================
   HISTÓRICO — registra o que aconteceu com um paciente ou um prontuário.
   É a memória que sobrevive à saída e ao retorno do paciente: a data de
   cadastro é atualizada na reativação, mas a linha do tempo continua inteira.
   ========================================================================== */
function anotar(entidade, entidadeId, evento, detalhe, sessao) {
  if (!entidadeId) return;
  db.prepare("INSERT INTO historico(entidade,entidade_id,evento,detalhe,usuario_id,usuario_nome,criado) VALUES(?,?,?,?,?,?,?)")
    .run(entidade, entidadeId, evento, detalhe || "", sessao ? sessao.userId : null, sessao ? sessao.nome : "", agora());
}

/* ==========================================================================
   O QUE MUDOU NUM TEXTO — para o histórico dizer não só "foi editado", mas
   MOSTRAR o trecho.

   O caso normal no prontuário é ACRESCENTAR ao final (o profissional abre a
   evolução e escreve mais um parágrafo). Comparando o começo e o fim iguais dos
   dois textos, o que sobra no meio é exatamente o que entrou (e o que saiu, se
   algo foi apagado). Não é um diff palavra a palavra — é o suficiente para
   quem lê o histórico entender o que aconteceu sem abrir o registro.
   ========================================================================== */
const recortar = (t, n = 120) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};
function trechoAlterado(antes, depois) {
  const a = String(antes || ""), b = String(depois || "");
  if (a === b) return "";
  let i = 0;                                     // quanto o começo tem de igual
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;                                     // quanto o fim tem de igual
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  let entrou = b.slice(i, b.length - j).trim();
  let saiu   = a.slice(i, a.length - j).trim();
  /* SUBSTITUIÇÃO (mexeu no meio do texto): alarga o recorte até as bordas das
     palavras, senão "melhora" → "piora" sairia como trocou "melh" por "pi" — o
     "ora" final é comum aos dois e o corte cai no meio da palavra.
     Só vale aqui: em acréscimo ou remoção puros o recorte já bate certo, e
     alargar transformaria "acrescentou" num "trocou" confuso. */
  if (entrou && saiu) {
    const ehBorda = (c) => c === undefined || /\s/.test(c);
    while (i > 0 && !ehBorda(a[i - 1])) i--;
    while (j > 0 && !ehBorda(a[a.length - j])) j--;
    entrou = b.slice(i, b.length - j).trim();
    saiu   = a.slice(i, a.length - j).trim();
  }
  if (entrou && !saiu) return `acrescentou: "${recortar(entrou)}"`;
  if (saiu && !entrou) return `removeu: "${recortar(saiu)}"`;
  if (entrou && saiu)  return `trocou "${recortar(saiu, 60)}" por "${recortar(entrou, 60)}"`;
  // só mudou espaçamento/quebra de linha
  return `texto reformatado (${b.length} caracteres)`;
}

/* Hash descartável usado só para gastar o mesmo tempo quando o login digitado
   não existe — ver o comentário no /api/login. Nunca confere com senha alguma. */
const HASH_ISCA = hashSenha(crypto.randomBytes(16).toString("hex"));
const getC = (k) => db.prepare("SELECT value FROM g_config WHERE key=?").get(k)?.value;
const setC = (k, v) => db.prepare("INSERT INTO g_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* ==========================================================================
   NUMERAÇÃO SEQUENCIAL — PR-AAAA-00001 (prontuário) e PAC-AAAA-00001 (paciente)
   Sequencial por ANO, único e NUNCA reaproveitado. É por esses números que a
   clínica localiza e controla o registro (busca, arquivo físico, encaminhamento).

   Por que um contador guardado em g_config e não "o maior número da tabela":
   se o último registro for excluído, o maior da tabela cai — e o próximo
   herdaria um número que já circulou impresso. O contador só sobe.
   Ele é comparado com o maior do banco a cada emissão, então também se
   recupera sozinho se o g_config for perdido.

   Roda AQUI, depois das migrações (a coluna precisa existir) e depois de
   getC/setC (o contador depende deles).
   ========================================================================== */
try {
  // última linha de defesa: nem um backup restaurado por cima duplica número
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pront_numero ON prontuario(numero) WHERE numero IS NOT NULL");
  /* A REGRA da clínica gravada no banco: um prontuário por paciente+procedimento.
     Mesmo que a tela falhe, o banco recusa o segundo.
     (a coluna se chama `especialidade` por herança; o que ela guarda é o NOME do
     procedimento — ver o comentário da tabela procedimentos) */
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pront_pac_esp ON prontuario(paciente_id, especialidade)");
  // o código do paciente também não pode repetir
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pac_codigo ON pacientes(codigo) WHERE codigo IS NOT NULL AND codigo <> ''");
} catch (e) { console.error("  ✖ índices de numeração:", e.message); }

/* O motor por trás dos dois números. `tabela`/`coluna` dizem onde procurar o
   maior já emitido; `chave` é o contador em g_config. */
function proximoSequencial(prefixo, chave, tabela, coluna, ano) {
  const y = ano || new Date().getFullYear();
  const inicio = `${prefixo}-${y}-`;
  const chaveAno = `${chave}_${y}`;
  const guardado = Number(getC(chaveAno) || 0);
  const r = db.prepare(`SELECT MAX(CAST(substr(${coluna}, ?) AS INTEGER)) m FROM ${tabela} WHERE ${coluna} LIKE ?`)
    .get(inicio.length + 1, inicio + "%");
  const noBanco = (r && r.m) ? Number(r.m) : 0;
  const seq = Math.max(guardado, noBanco) + 1;
  setC(chaveAno, seq);                     // marca como usado, mesmo se falhar depois
  return inicio + String(seq).padStart(5, "0");
}
/* Grava o número, tentando de novo se colidir (backup restaurado por cima). */
function emitirSequencial(prefixo, chave, tabela, coluna, id, ano) {
  for (let i = 0; i < 20; i++) {
    const n = proximoSequencial(prefixo, chave, tabela, coluna, ano);
    try { db.prepare(`UPDATE ${tabela} SET ${coluna}=? WHERE id=?`).run(n, id); return n; }
    catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; }
  }
  throw new Error(`Não consegui gerar o número em ${tabela}.`);
}

/* Os quatro tipos de lançamento que compõem o prontuário. Cada um vira uma
   área própria na tela, com a sua lista de registros datados. */
const TIPOS_REGISTRO = ["avaliacao", "evolucao", "plano", "encaminhamento"];
const ROTULO_TIPO = { avaliacao: "Avaliação", evolucao: "Evolução", plano: "Plano terapêutico", encaminhamento: "Encaminhamento" };
const rotuloTipo = (t) => ROTULO_TIPO[t] || t;

const emitirNumeroProntuario = (id, ano) => emitirSequencial("PR", "pront_seq", "prontuario", "numero", id, ano);
const emitirCodigoPaciente   = (id, ano) => emitirSequencial("PAC", "pac_seq", "pacientes", "codigo", id, ano);
/* Registros anteriores a esta versão recebem número uma única vez, na ordem de
   cadastro e respeitando o ano de cada um. Vale para os dois números. */
for (const [tabela, coluna, emitir, rotulo] of [
  ["prontuario", "numero", emitirNumeroProntuario, "prontuário(s) antigo(s) receberam número"],
  ["pacientes", "codigo", emitirCodigoPaciente, "paciente(s) antigo(s) receberam código"],
]) {
  const antigos = db.prepare(`SELECT id, criado FROM ${tabela} WHERE ${coluna} IS NULL OR ${coluna}='' ORDER BY id`).all();
  for (const r of antigos) {
    const ano = Number(String(r.criado || "").slice(0, 4)) || new Date().getFullYear();
    emitir(r.id, ano);
  }
  if (antigos.length) console.log(`  · /restrito: ${antigos.length} ${rotulo}.`);
}

/* ==========================================================================
   QUAL ANAMNESE CADA PROCEDIMENTO PEDE
   Semeado uma única vez a partir do mapa abaixo e depois EDITÁVEL no cadastro
   de Procedimentos — procedimento novo não obriga a mexer no código.
   É esse vínculo que faz o agendamento oferecer "Preencher anamnese" já no
   formulário certo.
   ========================================================================== */
const ANAMNESE_POR_PROCEDIMENTO = {
  "Psicanálise Individual": "psicanalise",
  "Psicanálise Casal": "psicanalise",
  "Protocolo Integrativo — Ozônio e Detox": "ozonio",
  "Ozonioterapia": "ozonio",
  "Detox Iônico": "ozonio",
  "Acupuntura": "integrativas",
  "Aromaterapia": "integrativas",
  "Terapia Floral": "integrativas",
  "Exame de Biorressonância": "integrativas",
  "Ventosaterapia": "integrativas",
  "Kinesioterapia": "integrativas",
};
if (getC("anamnese_modelo_seed") !== "1") {
  const up = db.prepare("UPDATE procedimentos SET anamnese_modelo=? WHERE nome=? AND (anamnese_modelo IS NULL OR anamnese_modelo='')");
  let n = 0;
  for (const [nome, modelo] of Object.entries(ANAMNESE_POR_PROCEDIMENTO)) n += up.run(modelo, nome).changes;
  setC("anamnese_modelo_seed", "1");
  if (n) console.log(`  · /restrito: ${n} procedimento(s) ligados ao seu modelo de anamnese.`);
}

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
/* Cores OFICIAIS da clínica — extraídas do documento "AGENDA PRA O CADASTRO DA
   CLÍNICA.docx", onde cada procedimento estava escrito na sua cor. A cor é por
   FAMÍLIA: consulta e sessão do mesmo procedimento usam a mesma. */
const CORES_PROCEDIMENTO = {
  "Psicanálise Individual": "#FF0000",
  "Psicanálise Casal": "#0000CC",
  "Protocolo Integrativo — Ozônio e Detox": "#4472C4",
  "Ozonioterapia": "#538135",
  "Detox Iônico": "#FFC000",
  "Acupuntura": "#C00000",
  "Aromaterapia": "#7030A0",
  "Terapia Floral": "#FF0066",
  "Exame de Biorressonância": "#00FF00",
  "Ventosaterapia": "#FFFF00",
  "Kinesioterapia": "#00CCFF",
};
if (db.prepare("SELECT COUNT(*) c FROM procedimentos").get().c === 0) {
  [["Psicanálise Individual", "Consulta"], ["Psicanálise Individual", "Sessão"],
   ["Psicanálise Casal", "Consulta"], ["Psicanálise Casal", "Sessão"],
   ["Protocolo Integrativo — Ozônio e Detox", "Consulta"], ["Protocolo Integrativo — Ozônio e Detox", "Sessão"],
   ["Ozonioterapia", "Consulta"], ["Ozonioterapia", "Sessão"],
   ["Detox Iônico", "Consulta"], ["Detox Iônico", "Sessão"],
   ["Acupuntura", "Consulta"], ["Acupuntura", "Sessão"],
   ["Aromaterapia", "Consulta"],
   ["Terapia Floral", "Consulta"],
   ["Exame de Biorressonância", "Procedimento"],
   ["Ventosaterapia", "Consulta"], ["Ventosaterapia", "Sessão"],
   ["Kinesioterapia", "Consulta"], ["Kinesioterapia", "Sessão"]]
    .forEach((p, i) => db.prepare("INSERT INTO procedimentos(nome,tipo,cor,duracao,ativo,sort,criado) VALUES(?,?,?,40,1,?,?)")
      .run(p[0], p[1], CORES_PROCEDIMENTO[p[0]] || "#5B4FD8", i, AGORA_SEED));
}
/* Bancos que já nasceram com as cores provisórias recebem as oficiais UMA vez.
   A trava em g_config garante que, se a clínica trocar uma cor depois, o deploy
   seguinte não desfaça a escolha dela. */
if (getC("cores_oficiais") !== "1") {
  const upd = db.prepare("UPDATE procedimentos SET cor=? WHERE nome=?");
  for (const [nome, cor] of Object.entries(CORES_PROCEDIMENTO)) upd.run(cor, nome);
  setC("cores_oficiais", "1");
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
/* ==========================================================================
   VÍNCULO AGENDAMENTO → PRONTUÁRIO
   O agendamento NUNCA cria pasta. Ele só se pendura numa que já exista para
   aquele paciente naquele procedimento. No primeiro atendimento não há pasta
   ainda e o campo fica vazio — é a anamnese finalizada que a abre, e nesse
   momento os atendimentos soltos daquele par são recolhidos para dentro dela.
   ========================================================================== */

/* O NOME do procedimento é a chave da pasta — não o id da linha, porque
   "Ozonioterapia (Consulta)" e "(Sessão)" são linhas diferentes do mesmo
   tratamento e pertencem ao mesmo prontuário. */
function nomeProcedimento(linha) {
  if (linha && linha.procedimento_id) {
    const p = db.prepare("SELECT nome FROM procedimentos WHERE id=?").get(linha.procedimento_id);
    if (p && p.nome) return p.nome;
  }
  return (linha && linha.especialidade) || "";
}
/* Barra o registro NOVO em nome de quem já saiu da clínica. Devolve a mensagem
   de erro, ou "" se pode seguir. Editar o que já existe continua liberado — o
   passado não se mexe por causa da situação de hoje. */
function pacienteInativo(pacienteId) {
  const pc = db.prepare("SELECT nome, ativo FROM pacientes WHERE id=?").get(pacienteId);
  if (!pc || Number(pc.ativo) !== 0) return "";
  return `${pc.nome} está INATIVO. Reative a ficha dele em Cadastros → Pacientes para voltar a registrar atendimentos.`;
}
function prontuarioDoPar(pacienteId, procedimento) {
  if (!pacienteId || !procedimento) return null;
  return db.prepare("SELECT id,numero,especialidade,status FROM prontuario WHERE paciente_id=? AND especialidade=?")
    .get(pacienteId, procedimento) || null;
}
/* Acerta o vínculo de UM atendimento.
   - sem vínculo  → pendura na pasta do procedimento, se existir;
   - com vínculo  → só refaz se o procedimento MUDOU nesta edição (senão um
     vínculo feito à mão dentro do prontuário seria desfeito sem querer). */
function sincronizarProntuarioDoAtendimento(id, antes) {
  const a = db.prepare("SELECT id,paciente_id,procedimento_id,especialidade,prontuario_id FROM atendimentos WHERE id=?").get(id);
  if (!a) return null;
  const nome = nomeProcedimento(a);
  if (a.prontuario_id) {
    const mudou = antes && nomeProcedimento(antes) !== nome;
    if (!mudou) return db.prepare("SELECT id,numero,especialidade FROM prontuario WHERE id=?").get(a.prontuario_id) || null;
  }
  const pasta = prontuarioDoPar(a.paciente_id, nome);
  const novo = pasta ? pasta.id : null;
  if (String(a.prontuario_id || "") !== String(novo || ""))
    db.prepare("UPDATE atendimentos SET prontuario_id=? WHERE id=?").run(novo, id);
  return pasta;
}
/* Recolhe para a pasta recém-aberta os atendimentos daquele par que ainda
   estavam sem vínculo — tipicamente o primeiro atendimento, marcado antes de a
   anamnese existir. Devolve quantos entraram. */
function recolherAtendimentosSoltos(prontuarioId, pacienteId, procedimento) {
  const soltos = db.prepare(
    `SELECT a.id FROM atendimentos a
       LEFT JOIN procedimentos p ON p.id = a.procedimento_id
      WHERE a.paciente_id = ? AND a.prontuario_id IS NULL
        AND COALESCE(NULLIF(p.nome,''), a.especialidade) = ?`).all(pacienteId, procedimento);
  for (const s of soltos) db.prepare("UPDATE atendimentos SET prontuario_id=? WHERE id=?").run(prontuarioId, s.id);
  return soltos.length;
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
  // "codigo" NÃO entra: é gerado pelo servidor no cadastro e não se digita
  pacientes: ["nome", "nome_contato", "foto", "juridica", "estrangeiro", "cpf", "rg", "sexo",
    "nascimento", "naturalidade", "estado_civil", "convenio_id", "religiao", "profissao", "escolaridade",
    "altura", "peso", "cor_pele", "prioridade", "sangue", "cep", "endereco", "numero", "bairro", "cidade",
    "complemento", "celular", "telefone", "email", "canal", "mae", "pai", "tag", "indicacao", "avisos",
    "resp_nome", "resp_cpf", "resp_rg", "resp_nascimento", "consentimento", "observacao", "ativo"],
  convenios: ["nome", "registro", "contato", "observacao", "ativo", "sort"],
  procedimentos: ["nome", "tipo", "valor", "duracao", "cor", "anamnese_modelo", "ativo", "sort"],
  salas: ["nome", "ativo", "sort"],
  profissionais: ["nome", "especialidade", "registro", "contato", "cor", "ativo"],
  // "prontuario_id" NÃO entra: quem liga o agendamento à pasta é o servidor
  atendimentos: ["paciente_id", "profissional_id", "sala_id", "convenio_id", "procedimento_id", "especialidade",
    "nome_agenda", "celular", "data", "hora", "hora_fim", "valor", "primeira", "encaixe", "lembrete", "nps",
    "status", "observacoes"],
  // "numero", "status", "alta_*" NÃO entram: são do servidor, nunca do cliente
  prontuario: ["paciente_id", "especialidade", "profissional", "aberto_em", "observacao", "usuario_id"],
  prontuario_registros: ["prontuario_id", "tipo", "texto", "data", "profissional", "anexo", "usuario_id"],
  // "status"/"finalizada_em"/"prontuario_id" são do fluxo de finalizar, no servidor
  anamneses: ["paciente_id", "tipo", "dados", "procedimento", "profissional", "data", "usuario_id"],
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
  profissional: new Set(["atendimentos", "prontuario", "prontuario_registros", "anamneses", "historico"]),
};
const PERM_LEITURA = { profissional: new Set(["pacientes", "profissionais", "procedimentos", "convenios", "salas"]) };
const pode = (perfil, modulo) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(modulo) : false);
const podeLer = (perfil, modulo) => pode(perfil, modulo) || (PERM_LEITURA[perfil] && PERM_LEITURA[perfil].has(modulo));
const adminsAtivos = () => db.prepare("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1").get().c;

/* ==========================================================================
   VÍNCULOS E HISTÓRICO
   Cadastro que já foi usado em atendimento/prontuário/anamnese NÃO pode ser
   apagado — apagar reescreveria o passado (a agenda antiga ficaria sem
   profissional, o prontuário impresso sem procedimento). O caminho certo é
   BLOQUEAR: some dos seletores, mas o histórico continua íntegro.
   ========================================================================== */
const conta = (sql, ...args) => db.prepare(sql).get(...args).c;
function vinculosDe(tabela, id) {
  const v = [];
  const somar = (n, rotulo) => { if (n > 0) v.push(`${n} ${rotulo}${n > 1 ? "s" : ""}`); };
  if (tabela === "profissionais") {
    const p = db.prepare("SELECT nome FROM profissionais WHERE id=?").get(id);
    somar(conta("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?", id), "atendimento");
    if (p) {
      somar(conta("SELECT COUNT(*) c FROM prontuario WHERE profissional=?", p.nome), "evolução de prontuário");
      somar(conta("SELECT COUNT(*) c FROM anamneses WHERE profissional=?", p.nome), "anamnese");
    }
    somar(conta("SELECT COUNT(*) c FROM g_usuarios WHERE profissional_id=?", id), "acesso ao sistema");
  }
  if (tabela === "pacientes") {
    somar(conta("SELECT COUNT(*) c FROM atendimentos WHERE paciente_id=?", id), "atendimento");
    somar(conta("SELECT COUNT(*) c FROM prontuario WHERE paciente_id=?", id), "evolução de prontuário");
    somar(conta("SELECT COUNT(*) c FROM anamneses WHERE paciente_id=?", id), "anamnese");
    somar(conta("SELECT COUNT(*) c FROM documentos_gestao WHERE paciente_id=?", id), "documento");
  }
  if (tabela === "procedimentos") somar(conta("SELECT COUNT(*) c FROM atendimentos WHERE procedimento_id=?", id), "atendimento");
  if (tabela === "convenios") {
    somar(conta("SELECT COUNT(*) c FROM atendimentos WHERE convenio_id=?", id), "atendimento");
    somar(conta("SELECT COUNT(*) c FROM pacientes WHERE convenio_id=?", id), "paciente");
  }
  if (tabela === "salas") somar(conta("SELECT COUNT(*) c FROM atendimentos WHERE sala_id=?", id), "atendimento");
  /* Prontuário com LANÇAMENTO não se apaga: ali está o registro clínico, e
     apagar a pasta o deixaria órfão no banco — invisível, mas presente. Quem
     encerra um tratamento dá ALTA.

     Anamnese e agendamento NÃO entram nesta conta de propósito. Eles não são
     conteúdo da pasta, são coisas ARQUIVADAS nela — e continuam existindo
     sozinhos se ela sair. Se contassem, uma anamnese finalizada por engano
     ficaria presa para sempre: a anamnese não se apaga por estar vinculada, e a
     pasta não se apagaria por ter a anamnese. Do jeito que está, apagar a pasta
     (enquanto ainda não tem lançamento) SOLTA os dois e permite recomeçar. */
  if (tabela === "prontuario")
    somar(conta("SELECT COUNT(*) c FROM prontuario_registros WHERE prontuario_id=?", id), "lançamento");
  return v;
}

/* --------------- Acesso do profissional ao sistema ----------------------
   Cadastrar profissional JÁ cria o login dele (pedido da clínica) — e a
   secretaria pode fazer isso. Mas por aqui só nasce conta de perfil
   "profissional": promover alguém a admin continua sendo exclusividade do
   módulo Usuários do Sistema, que só o admin abre. */
function salvarAcessoProfissional(profId, b, quemPerfil) {
  const login = String(b.acesso_login || "").trim().toLowerCase();
  const senha = String(b.acesso_senha || "");
  const jaTem = db.prepare("SELECT * FROM g_usuarios WHERE profissional_id=?").get(profId);
  const prof = db.prepare("SELECT nome,ativo FROM profissionais WHERE id=?").get(profId);
  if (!prof) return null;
  const ativo = Number(prof.ativo) === 0 ? 0 : 1;   // bloquear o profissional bloqueia o login

  if (!login) {                                     // sem login informado: só espelha o bloqueio
    if (jaTem && jaTem.ativo !== ativo) {
      db.prepare("UPDATE g_usuarios SET ativo=? WHERE id=?").run(ativo, jaTem.id);
      if (!ativo) derrubarSessoesDoUsuario(jaTem.id);
    }
    return null;
  }
  // login não pode colidir com outro usuário
  const colide = db.prepare("SELECT id FROM g_usuarios WHERE email=? AND profissional_id IS NOT ?").get(login, profId);
  if (colide && (!jaTem || colide.id !== jaTem.id)) return "Este login já está em uso por outro usuário.";

  if (jaTem) {
    db.prepare("UPDATE g_usuarios SET nome=?, email=?, ativo=? WHERE id=?").run(prof.nome, login, ativo, jaTem.id);
    if (senha) {
      if (senha.length < 8) return "A senha do profissional precisa ter ao menos 8 caracteres.";
      db.prepare("UPDATE g_usuarios SET senha_hash=? WHERE id=?").run(hashSenha(senha), jaTem.id);
    }
    if (!ativo) derrubarSessoesDoUsuario(jaTem.id);
  } else {
    if (!senha) return "Defina uma senha para o acesso do profissional.";
    if (senha.length < 8) return "A senha do profissional precisa ter ao menos 8 caracteres.";
    db.prepare("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,criado) VALUES(?,?,?,'profissional',?,?,?)")
      .run(prof.nome, login, hashSenha(senha), ativo, profId, agora());
  }
  return null;
}
function derrubarSessoesDoUsuario(userId) {
  for (const [k, v] of sessoes) if (v.userId === userId) sessoes.delete(k);
}
/* Junta ao profissional o login dele (nunca a senha) para a tela mostrar
   se ele já tem acesso e qual é o usuário. */
function anexarAcesso(prof) {
  const u = db.prepare("SELECT email, ativo FROM g_usuarios WHERE profissional_id=?").get(prof.id);
  prof.acesso_login = u ? u.email : "";
  prof.acesso_ativo = u ? u.ativo : null;
  return prof;
}

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
const rotuloModelo = (t) => (MODELOS_ANAMNESE[t] && MODELOS_ANAMNESE[t].rotulo) || t || "Anamnese";

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

  /* Quem está logado. Devolve também o PROFISSIONAL vinculado (id e nome como
     está no cadastro) — é com ele que a tela pré-preenche "Profissional
     responsável" na anamnese. O nome do login pode ser diferente do nome no
     cadastro de profissionais, por isso vai o do cadastro. */
  if (p === "me") {
    let profissional_nome = "";
    if (s.profissionalId) {
      const pf = db.prepare("SELECT nome FROM profissionais WHERE id=?").get(s.profissionalId);
      if (pf) profissional_nome = pf.nome;
    }
    return json(res, 200, { nome: s.nome, perfil: s.perfil, profissional_id: s.profissionalId || null, profissional_nome });
  }

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
  /* RELATÓRIOS — aceita recorte por período (?de=AAAA-MM-DD&ate=AAAA-MM-DD).
     Os dois lados são opcionais: só `de` = daí em diante, só `ate` = até ali.
     O corte roda no SQL (é onde estão os números), não na tela.
     A data usada é a do FATO: `data` no atendimento e na anamnese, `criado` no
     cadastro do paciente e na abertura do prontuário. */
  if (p === "relatorios") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
    const q = new URL(req.url, "http://x").searchParams;
    const soData = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    const de = soData(q.get("de")), ate = soData(q.get("ate"));
    /* Monta o recorte para uma coluna. Fica como texto porque as datas já
       passaram pelo crivo do formato acima — nada do usuário entra cru. */
    const corte = (col, alias) => {
      const c = alias ? `${alias}.${col}` : col;
      const p = [`${c} IS NOT NULL`, `${c} <> ''`];
      if (de) p.push(`substr(${c},1,10) >= '${de}'`);
      if (ate) p.push(`substr(${c},1,10) <= '${ate}'`);
      return (de || ate) ? p.join(" AND ") : "1=1";
    };
    const onde = (col, alias) => ` WHERE ${corte(col, alias)}`;
    const e = (col, alias) => ` AND ${corte(col, alias)}`;
    const grupo = (sql) => db.prepare(sql).all();
    const n = (sql) => db.prepare(sql).get().c;
    return json(res, 200, {
      periodo: { de, ate },
      totais: {
        pacientes: n("SELECT COUNT(*) c FROM pacientes" + onde("criado")),
        atendimentos: n("SELECT COUNT(*) c FROM atendimentos" + onde("data")),
        atendidos: n("SELECT COUNT(*) c FROM atendimentos WHERE status='Atendido'" + e("data")),
        faltas: n("SELECT COUNT(*) c FROM atendimentos WHERE status='Faltou'" + e("data")),
        anamneses: n("SELECT COUNT(*) c FROM anamneses" + onde("data")),
        prontuarios: n("SELECT COUNT(*) c FROM prontuario" + onde("aberto_em")),
      },
      porProcedimento: grupo(`SELECT COALESCE(NULLIF(pr.nome,''),'(sem procedimento)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porProfissional: grupo(`SELECT COALESCE(NULLIF(pf.nome,''),'(sem profissional)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN profissionais pf ON pf.id=a.profissional_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porConvenio: grupo(`SELECT COALESCE(NULLIF(c.nome,''),'(sem convênio)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN convenios c ON c.id=a.convenio_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porStatus: grupo("SELECT COALESCE(NULLIF(status,''),'(sem status)') rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY total DESC"),
      porMes: grupo("SELECT substr(data,1,7) rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY rotulo DESC LIMIT 12"),
    });
  }

  /* ==========================================================================
     RELAÇÃO DE PACIENTES ATIVOS / INATIVOS
     Uma linha por paciente com o que a clínica precisa para ligar ou visitar:
     nome, endereço completo, WhatsApp, quem o assiste e em quê.

     "Quem assiste" vem de dois lugares e é somado: o profissional RESPONSÁVEL
     por cada prontuário e quem de fato ATENDEU na agenda — um paciente pode ter
     sido atendido por alguém que não é o responsável pela pasta, e para uma
     relação de contato os dois importam.
     A "especialidade" é o procedimento: dos prontuários e também dos
     atendimentos, senão quem ainda não tem pasta aberta sairia sem nada.
     ?ativo=1|0 recorta; sem o parâmetro, vêm todos.
     ========================================================================== */
  if (p === "relatorios/pacientes") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
    const q = new URL(req.url, "http://x").searchParams;
    const at = (q.get("ativo") || "").trim();
    const cond = at === "1" ? " WHERE COALESCE(ativo,1)<>0" : at === "0" ? " WHERE COALESCE(ativo,1)=0" : "";
    const pacs = db.prepare(`SELECT * FROM pacientes${cond} ORDER BY nome`).all();

    const pastasDe = db.prepare("SELECT numero, especialidade, profissional, status FROM prontuario WHERE paciente_id=? ORDER BY status, especialidade");
    const profsDe = db.prepare(`SELECT DISTINCT pf.nome FROM atendimentos a JOIN profissionais pf ON pf.id=a.profissional_id
                                 WHERE a.paciente_id=? AND pf.nome<>''`);
    const procsDe = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(pr.nome,''), a.especialidade) nome FROM atendimentos a
                                 LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
                                 WHERE a.paciente_id=? AND COALESCE(NULLIF(pr.nome,''), a.especialidade) IS NOT NULL`);
    const conv = db.prepare("SELECT nome FROM convenios WHERE id=?");
    const juntar = (lista) => [...new Set(lista.filter((x) => x && String(x).trim()))].sort();

    for (const pc of pacs) {
      const pastas = pastasDe.all(pc.id);
      pc.prontuarios = pastas;
      pc.especialidades = juntar([...pastas.map((x) => x.especialidade), ...procsDe.all(pc.id).map((x) => x.nome)]);
      pc.profissionais = juntar([...pastas.map((x) => x.profissional), ...profsDe.all(pc.id).map((x) => x.nome)]);
      pc.convenio_nome = pc.convenio_id ? (conv.get(pc.convenio_id) || {}).nome || "" : "";
      // em tratamento = tem pasta sem alta; serve para a coluna Situação da relação
      pc.emTratamento = pastas.filter((x) => x.status !== "Alta").length;
    }
    return json(res, 200, {
      filtro: at === "1" ? "Ativos" : at === "0" ? "Inativos" : "Todos",
      total: pacs.length,
      ativos: pacs.filter((x) => Number(x.ativo ?? 1) !== 0).length,
      pacientes: pacs,
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
    // o profissional só vê os lançamentos que ele mesmo escreveu
    const sóMeus = s.perfil === "profissional" ? " AND r.usuario_id=" + Number(s.userId) : "";
    // as pastas do paciente e, dentro de cada uma, os lançamentos em ordem
    const pastas = db.prepare("SELECT * FROM prontuario WHERE paciente_id=? ORDER BY status, especialidade, id").all(pid);
    for (const pasta of pastas) {
      pasta.registros = db.prepare(
        `SELECT r.* FROM prontuario_registros r WHERE r.prontuario_id=?${sóMeus}
         ORDER BY COALESCE(NULLIF(r.data,''),r.criado), r.id`).all(pasta.id);
      // os vínculos da pasta, para sair na tela e na impressão
      pasta.anamneses = db.prepare(
        "SELECT id,tipo,procedimento,status,data,profissional,finalizada_em FROM anamneses WHERE prontuario_id=? ORDER BY COALESCE(NULLIF(data,''),criado), id").all(pasta.id);
      pasta.atendimentos = db.prepare(
        `SELECT a.id,a.data,a.hora,a.hora_fim,a.status,a.valor, pr.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome
           FROM atendimentos a
           LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
           LEFT JOIN salas sa ON sa.id=a.sala_id
          WHERE a.prontuario_id=? ORDER BY a.data, a.hora, a.id`).all(pasta.id);
    }
    return json(res, 200, {
      paciente: { ...paciente, convenio_nome: conv ? conv.nome : "" },
      prontuarios: pastas,
      historico: db.prepare("SELECT * FROM historico WHERE entidade='paciente' AND entidade_id=? ORDER BY criado, id").all(pid),
      anamneses: db.prepare("SELECT * FROM anamneses WHERE paciente_id=? ORDER BY COALESCE(NULLIF(data,''),criado), id").all(pid),
      atendimentos: db.prepare(`SELECT a.*, pr.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome, cv.nome convenio_nome
        FROM atendimentos a
        LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
        LEFT JOIN profissionais pf ON pf.id=a.profissional_id
        LEFT JOIN salas sa ON sa.id=a.sala_id
        LEFT JOIN convenios cv ON cv.id=a.convenio_id
        WHERE a.paciente_id=? ORDER BY a.data, a.hora, a.id`).all(pid),
    });
  }

  /* ---------------- Alta e reabertura do prontuário --------------------
     A alta é DO PRONTUÁRIO: o paciente pode receber alta da ozonioterapia e
     seguir na psicanálise. Nada é apagado — muda o status e fica no histórico. */
  const am = p.match(/^prontuario\/(\d+)\/(alta|reabrir)$/);
  if (am && req.method === "POST") {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const id = am[1], acao = am[2];
    const pr = db.prepare("SELECT * FROM prontuario WHERE id=?").get(id);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    const b = await readBody(req);
    if (acao === "alta") {
      const quando = b.data || new Date().toISOString().slice(0, 10);
      db.prepare("UPDATE prontuario SET status='Alta', alta_em=?, alta_motivo=? WHERE id=?").run(quando, b.motivo || "", id);
      anotar("prontuario", id, "Alta", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      anotar("paciente", pr.paciente_id, "Alta em " + pr.especialidade, pr.numero || "", s);
    } else {
      // reabrir: o paciente voltou. Data de reativação atualizada, histórico intacto.
      const quando = agora();
      db.prepare("UPDATE prontuario SET status='Ativo', alta_em=NULL, alta_motivo=NULL, reativado_em=? WHERE id=?").run(quando, id);
      db.prepare("UPDATE pacientes SET reativado_em=? WHERE id=?").run(quando, pr.paciente_id);
      anotar("prontuario", id, "Prontuário reaberto", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      anotar("paciente", pr.paciente_id, "Retornou ao tratamento", pr.especialidade, s);
    }
    return json(res, 200, { ok: true });
  }

  /* ---------------- Ativar / inativar o PACIENTE -----------------------
     Inativar é o "arquivar" da ficha: o paciente some das telas de escolha
     (agenda, anamnese, prontuário) e para de aparecer na lista de ativos, mas
     nada é apagado — ficha, prontuários e histórico continuam inteiros.
     É diferente da ALTA, que vale para UM prontuário: quem tem alta da
     ozonioterapia pode seguir ativo na psicanálise. Inativar é a pessoa
     deixando a clínica. */
  const pm3 = p.match(/^pacientes\/(\d+)\/(inativar|reativar)$/);
  if (pm3 && req.method === "POST") {
    if (!pode(s.perfil, "pacientes")) return json(res, 403, { error: "Sem permissão." });
    const id = pm3[1], inativar = pm3[2] === "inativar";
    const pac = db.prepare("SELECT id,nome,codigo FROM pacientes WHERE id=?").get(id);
    if (!pac) return json(res, 404, { error: "Paciente não encontrado." });
    const b = await readBody(req);
    if (inativar) {
      const abertos = conta("SELECT COUNT(*) c FROM prontuario WHERE paciente_id=? AND status<>'Alta'", id);
      db.prepare("UPDATE pacientes SET ativo=0, inativo_em=?, inativo_motivo=? WHERE id=?")
        .run(agora(), b.motivo || "", id);
      anotar("paciente", id, "Paciente inativado", b.motivo || "", s);
      /* Avisa se ficou tratamento em aberto — não impede (a pessoa pode
         simplesmente ter parado de vir), mas quem inativa precisa saber. */
      return json(res, 200, { ok: true, prontuariosAbertos: abertos });
    }
    db.prepare("UPDATE pacientes SET ativo=1, inativo_em=NULL, inativo_motivo=NULL, reativado_em=? WHERE id=?").run(agora(), id);
    anotar("paciente", id, "Paciente reativado", b.motivo || "", s);
    return json(res, 200, { ok: true });
  }

  /* ============ FINALIZAR A ANAMNESE — é ela que abre o prontuário ========
     Enquanto está sendo preenchida a anamnese é um Rascunho e não cria nada.
     Ao FINALIZAR:
       1. abre a pasta do par paciente + procedimento (ou reaproveita a que já
          existir — a regra é uma só por par);
       2. guarda o vínculo dos dois lados;
       3. recolhe para dentro dela os atendimentos daquele par que ainda estavam
          soltos — na prática, o primeiro agendamento, marcado antes de a pasta
          existir.
     Finalizar de novo não duplica: reaproveita a pasta e devolve o mesmo nº. */
  const fm = p.match(/^anamneses\/(\d+)\/finalizar$/);
  if (fm && req.method === "POST") {
    if (!pode(s.perfil, "anamneses")) return json(res, 403, { error: "Sem permissão." });
    const id = fm[1];
    const an = db.prepare("SELECT * FROM anamneses WHERE id=?").get(id);
    if (!an) return json(res, 404, { error: "Anamnese não encontrada." });
    const b = await readBody(req);
    const procedimento = String(b.procedimento || an.procedimento || "").trim();
    if (!an.paciente_id) return json(res, 400, { error: "Anamnese sem paciente." });
    if (!procedimento) return json(res, 400, { error: "Escolha o procedimento antes de finalizar — é ele que define de qual prontuário esta anamnese faz parte." });

    let pasta = prontuarioDoPar(an.paciente_id, procedimento);
    let criada = false;
    if (!pasta) {
      const prof = an.profissional || (s.perfil === "profissional" ? s.nome : "");
      const info = db.prepare(
        "INSERT INTO prontuario(paciente_id,especialidade,profissional,status,aberto_em,usuario_id,criado) VALUES(?,?,?,'Ativo',?,?,?)"
      ).run(an.paciente_id, procedimento, prof, (an.data || new Date().toISOString().slice(0, 10)), s.userId, agora());
      const novoId = Number(info.lastInsertRowid);
      const numero = emitirNumeroProntuario(novoId);
      pasta = { id: novoId, numero, especialidade: procedimento, status: "Ativo" };
      criada = true;
      anotar("prontuario", novoId, "Prontuário aberto pela anamnese", `${numero} · ${procedimento}`, s);
      anotar("paciente", an.paciente_id, "Prontuário aberto", `${numero} · ${procedimento}`, s);
    }
    db.prepare("UPDATE anamneses SET status='Finalizada', finalizada_em=?, prontuario_id=?, procedimento=?, atualizado=? WHERE id=?")
      .run(agora(), pasta.id, procedimento, agora(), id);
    const recolhidos = recolherAtendimentosSoltos(pasta.id, an.paciente_id, procedimento);
    anotar("prontuario", pasta.id, "Anamnese finalizada", rotuloModelo(an.tipo) + (recolhidos ? ` · ${recolhidos} agendamento(s) vinculado(s)` : ""), s);
    anotar("paciente", an.paciente_id, "Anamnese finalizada", `${rotuloModelo(an.tipo)} · ${pasta.numero}`, s);
    return json(res, 200, { ok: true, prontuario: pasta, criada, atendimentosVinculados: recolhidos });
  }

  /* Reabrir a anamnese para correção. O prontuário criado NÃO é desfeito: ele
     já pode ter lançamentos e agendamentos pendurados. */
  const rvm = p.match(/^anamneses\/(\d+)\/reabrir$/);
  if (rvm && req.method === "POST") {
    if (!pode(s.perfil, "anamneses")) return json(res, 403, { error: "Sem permissão." });
    const an = db.prepare("SELECT * FROM anamneses WHERE id=?").get(rvm[1]);
    if (!an) return json(res, 404, { error: "Anamnese não encontrada." });
    db.prepare("UPDATE anamneses SET status='Rascunho', atualizado=? WHERE id=?").run(agora(), rvm[1]);
    if (an.prontuario_id) anotar("prontuario", an.prontuario_id, "Anamnese reaberta para correção", rotuloModelo(an.tipo), s);
    return json(res, 200, { ok: true });
  }

  /* ---- Vincular / desvincular um agendamento à pasta, pela tela do prontuário
     É o caminho para o PRIMEIRO atendimento, marcado antes de a pasta existir,
     e para corrigir um vínculo à mão. -------------------------------------- */
  const vm = p.match(/^prontuario\/(\d+)\/atendimentos\/(\d+)$/);
  if (vm && (req.method === "POST" || req.method === "DELETE")) {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = db.prepare("SELECT * FROM prontuario WHERE id=?").get(vm[1]);
    const at = db.prepare("SELECT * FROM atendimentos WHERE id=?").get(vm[2]);
    if (!pr || !at) return json(res, 404, { error: "Prontuário ou agendamento não encontrado." });
    if (req.method === "POST") {
      // a pasta é do paciente: não se pendura o atendimento de outra pessoa
      if (String(at.paciente_id) !== String(pr.paciente_id))
        return json(res, 400, { error: "Este agendamento é de outro paciente." });
      db.prepare("UPDATE atendimentos SET prontuario_id=? WHERE id=?").run(pr.id, at.id);
      anotar("prontuario", pr.id, "Agendamento vinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    } else {
      db.prepare("UPDATE atendimentos SET prontuario_id=NULL WHERE id=?").run(at.id);
      anotar("prontuario", pr.id, "Agendamento desvinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    }
    return json(res, 200, { ok: true });
  }

  /* Agendamentos do paciente que ainda não estão em pasta nenhuma — é a lista
     que a tela do prontuário oferece para vincular. */
  const dm = p.match(/^prontuario\/(\d+)\/disponiveis$/);
  if (dm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = db.prepare("SELECT * FROM prontuario WHERE id=?").get(dm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    return json(res, 200, db.prepare(
      `SELECT a.*, p.nome procedimento_nome, pf.nome profissional_nome
         FROM atendimentos a
         LEFT JOIN procedimentos p ON p.id = a.procedimento_id
         LEFT JOIN profissionais pf ON pf.id = a.profissional_id
        WHERE a.paciente_id = ? AND a.prontuario_id IS NULL
        ORDER BY a.data DESC, a.hora DESC, a.id DESC`).all(pr.paciente_id));
  }

  /* -------- Arquivar / restaurar lançamento (nunca excluir) ------------- */
  const rm = p.match(/^prontuario_registros\/(\d+)\/(arquivar|restaurar)$/);
  if (rm && req.method === "POST") {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const id = rm[1], arq = rm[2] === "arquivar";
    const reg = db.prepare("SELECT * FROM prontuario_registros WHERE id=?").get(id);
    if (!reg) return json(res, 404, { error: "Lançamento não encontrado." });
    if (s.perfil === "profissional" && String(reg.usuario_id) !== String(s.userId))
      return json(res, 403, { error: "Lançamento de outro profissional." });
    db.prepare("UPDATE prontuario_registros SET arquivado=?, arquivado_em=? WHERE id=?")
      .run(arq ? 1 : 0, arq ? agora() : null, id);
    anotar("prontuario", reg.prontuario_id, (arq ? "Lançamento arquivado: " : "Lançamento restaurado: ") + rotuloTipo(reg.tipo), "", s);
    return json(res, 200, { ok: true });
  }

  /* --------- Linha do tempo de um paciente ou de um prontuário ---------- */
  const hm2 = p.match(/^historico\/(paciente|prontuario)\/(\d+)$/);
  if (hm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    return json(res, 200, db.prepare(
      "SELECT * FROM historico WHERE entidade=? AND entidade_id=? ORDER BY criado DESC, id DESC"
    ).all(hm2[1], hm2[2]));
  }

  /* ------- Prontuários de um paciente, com a contagem dos seus vínculos ---
     As contagens alimentam os "chips" que aparecem na anamnese, no agendamento
     e no prontuário — é assim que a tela mostra a que a pasta está ligada. */
  const pm2 = p.match(/^pacientes\/(\d+)\/prontuarios$/);
  if (pm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    return json(res, 200, db.prepare(`SELECT pr.*,
        (SELECT COUNT(*) FROM prontuario_registros r WHERE r.prontuario_id=pr.id AND r.arquivado=0) lancamentos,
        (SELECT COUNT(*) FROM anamneses an WHERE an.prontuario_id=pr.id) anamneses,
        (SELECT COUNT(*) FROM atendimentos at WHERE at.prontuario_id=pr.id) atendimentos
      FROM prontuario pr WHERE pr.paciente_id=? ORDER BY pr.status, pr.especialidade`).all(pm2[1]));
  }

  /* ------- O que está pendurado numa pasta (tela do prontuário) --------- */
  const vlm = p.match(/^prontuario\/(\d+)\/vinculos$/);
  if (vlm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = db.prepare("SELECT * FROM prontuario WHERE id=?").get(vlm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    return json(res, 200, {
      prontuario: pr,
      anamneses: db.prepare(
        "SELECT id,tipo,procedimento,status,data,profissional,finalizada_em FROM anamneses WHERE prontuario_id=? ORDER BY COALESCE(NULLIF(data,''),criado) DESC, id DESC").all(pr.id),
      atendimentos: db.prepare(
        `SELECT a.*, pr2.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome
           FROM atendimentos a
           LEFT JOIN procedimentos pr2 ON pr2.id=a.procedimento_id
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
           LEFT JOIN salas sa ON sa.id=a.sala_id
          WHERE a.prontuario_id=? ORDER BY a.data DESC, a.hora DESC, a.id DESC`).all(pr.id),
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
    /* Recorte do profissional. A PASTA do prontuário é visível a todos (ele
       precisa achar o paciente), mas os LANÇAMENTOS só o autor lê — é ali que
       está a anotação clínica. Na agenda, só os atendimentos dele. */
    let donoCol = null, donoVal = null;
    if (s.perfil === "profissional") {
      if (tabela === "prontuario_registros") { donoCol = "usuario_id"; donoVal = s.userId; }
      else if (tabela === "atendimentos") { donoCol = "profissional_id"; donoVal = s.profissionalId; }
    }

    if (req.method === "GET" && !id) {
      const q = new URL(req.url, "http://x").searchParams;
      const busca = (q.get("q") || "").trim();
      const pacFiltro = (q.get("paciente_id") || "").trim();
      let sql = `SELECT * FROM ${tabela}`;
      const cond = [], args = [];
      /* Paciente se acha por NOME, CÓDIGO ou CPF — e o CPF casa digitado com ou
         sem máscara, dos dois lados: tira a pontuação do que foi digitado e
         também da coluna, então "123.456.789-00" acha "12345678900".
         Mínimo de 3 dígitos (mesma regra do combobox): com um só, qualquer CPF
         casaria e a busca devolveria a clínica inteira. */
      const digitos = busca.replace(/\D+/g, "");
      const buscaPorDigitos = digitos.length >= 3;
      const CPF_LIMPO = "REPLACE(REPLACE(REPLACE(cpf,'.',''),'-',''),' ','')";
      if (busca && tabela === "pacientes") {
        const ors = ["nome LIKE ?", "codigo LIKE ?", "cpf LIKE ?"];
        args.push("%" + busca + "%", "%" + busca + "%", "%" + busca + "%");
        if (buscaPorDigitos) { ors.push(`${CPF_LIMPO} LIKE ?`); args.push("%" + digitos + "%"); }
        cond.push("(" + ors.join(" OR ") + ")");
      }
      /* Prontuário se acha pelo NÚMERO da pasta, pelo procedimento, pelo
         profissional — e também pelo PACIENTE (nome, código ou CPF), que é como
         a recepção procura na prática. */
      else if (busca && tabela === "prontuario") {
        const ors = ["numero LIKE ?", "especialidade LIKE ?", "profissional LIKE ?",
          "paciente_id IN (SELECT id FROM pacientes WHERE nome LIKE ? OR codigo LIKE ? OR cpf LIKE ?)"];
        for (let i = 0; i < 6; i++) args.push("%" + busca + "%");
        if (buscaPorDigitos) { ors.push(`paciente_id IN (SELECT id FROM pacientes WHERE ${CPF_LIMPO} LIKE ?)`); args.push("%" + digitos + "%"); }
        cond.push("(" + ors.join(" OR ") + ")");
      }
      else if (busca && COLS[tabela].has("nome")) { cond.push("nome LIKE ?"); args.push("%" + busca + "%"); }
      // anamneses/prontuário/documentos podem ser filtrados por paciente
      if (pacFiltro && COLS[tabela].has("paciente_id")) { cond.push("paciente_id=?"); args.push(pacFiltro); }
      // lançamentos são sempre lidos dentro de um prontuário
      const prFiltro = (q.get("prontuario_id") || "").trim();
      if (prFiltro && COLS[tabela].has("prontuario_id")) { cond.push("prontuario_id=?"); args.push(prFiltro); }
      // por padrão os arquivados ficam fora; ?arquivados=1 mostra também
      if (tabela === "prontuario_registros" && q.get("arquivados") !== "1") cond.push("arquivado=0");
      // relação de ativos / inativos (com alta)
      const st = (q.get("status") || "").trim();
      if (st && COLS[tabela].has("status")) { cond.push("status=?"); args.push(st); }
      // ?ativo=1|0 — relação de pacientes ativos ou inativos
      const at = (q.get("ativo") || "").trim();
      if ((at === "0" || at === "1") && COLS[tabela].has("ativo")) {
        cond.push(at === "1" ? "COALESCE(ativo,1)<>0" : "COALESCE(ativo,1)=0");
      }
      if (donoCol) { cond.push(donoCol + "=?"); args.push(donoVal); }
      if (cond.length) sql += " WHERE " + cond.join(" AND ");
      /* Ordem de cada lista:
         · listas de apoio, na ordem de exibição escolhida pela clínica;
         · AGENDA, por dia e horário — é assim que a recepção lê o dia;
         · o resto, mais novo primeiro. */
      sql += ["convenios", "procedimentos", "salas"].includes(tabela) ? " ORDER BY sort, id"
           : tabela === "atendimentos" ? " ORDER BY data, hora, id"
           : tabela === "prontuario" ? " ORDER BY status, especialidade, id"
           : tabela === "prontuario_registros" ? " ORDER BY data DESC, id DESC"
           : " ORDER BY id DESC";
      const linhas = db.prepare(sql).all(...args);
      if (tabela === "profissionais") linhas.forEach(anexarAcesso);
      return json(res, 200, linhas);
    }
    if (req.method === "GET" && id) {
      const row = db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(id);
      if (!row) return json(res, 404, { error: "Registro não encontrado." });
      if (donoCol && String(row[donoCol]) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." });
      if (tabela === "profissionais") anexarAcesso(row);
      // a tela avisa quando o registro tem histórico e por isso não pode ser excluído
      if (["profissionais", "pacientes", "procedimentos", "convenios", "salas", "prontuario"].includes(tabela))
        row._vinculos = vinculosDe(tabela, id);
      /* A pasta a que esta anamnese pertence, RESOLVIDA no servidor. É por ela
         que a tela decide mostrar ou não o Excluir — não pelo campo
         prontuario_id, que pode ter sobrado apontando para pasta apagada, nem
         pelo cache do navegador, que a recepção nem carrega. */
      if (tabela === "anamneses") {
        row._prontuario = row.prontuario_id
          ? db.prepare("SELECT id,numero,especialidade,status FROM prontuario WHERE id=?").get(row.prontuario_id) || null
          : null;
      }
      return json(res, 200, row);
    }
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      if (tabela === "prontuario" || tabela === "anamneses" || tabela === "prontuario_registros") b.usuario_id = s.userId;
      /* Um prontuário por paciente + especialidade. A checagem aqui devolve uma
         mensagem que o recepcionista entende; o índice único no banco é a rede
         de segurança caso duas telas salvem ao mesmo tempo. */
      if (tabela === "prontuario") {
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o paciente." });
        const e0 = pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        if (!b.especialidade) return json(res, 400, { error: "Selecione o procedimento deste prontuário." });
        const ja = db.prepare("SELECT numero FROM prontuario WHERE paciente_id=? AND especialidade=?")
          .get(b.paciente_id, b.especialidade);
        if (ja) return json(res, 409, { error: `Este paciente já tem prontuário de ${b.especialidade} (nº ${ja.numero}). Abra o existente — cada procedimento tem um único prontuário.` });
        if (!b.aberto_em) b.aberto_em = new Date().toISOString().slice(0, 10);
      }
      if (tabela === "prontuario_registros") {
        if (!b.prontuario_id) return json(res, 400, { error: "Lançamento sem prontuário." });
        if (!TIPOS_REGISTRO.includes(b.tipo)) return json(res, 400, { error: "Tipo de lançamento inválido." });
        if (!b.data) b.data = new Date().toISOString().slice(0, 10);
      }
      if (tabela === "atendimentos" && s.perfil === "profissional") b.profissional_id = s.profissionalId; // marca na própria agenda
      if (tabela === "atendimentos") {
        // só se agenda para quem tem ficha: é o que garante código e histórico
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o paciente. Só é possível agendar para paciente cadastrado." });
        const e0 = pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        const e = validarAgenda(b.profissional_id, b.data, b.hora, null, b.hora_fim, b.sala_id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "anamneses") {
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o paciente." });
        const e0 = pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        if (!MODELOS_ANAMNESE[b.tipo]) return json(res, 400, { error: "Tipo de anamnese inválido." });
        if (typeof b.dados !== "string") b.dados = JSON.stringify(b.dados || {});
      }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? use.concat("criado") : use;
      const valores = temCriado ? use.map((c) => b[c]).concat(agora()) : use.map((c) => b[c]);
      const info = db.prepare(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`).run(...valores);
      const novoId = Number(info.lastInsertRowid);
      // toda pasta de prontuário nasce com o seu número de controle
      if (tabela === "prontuario") {
        const numero = emitirNumeroProntuario(novoId);
        anotar("prontuario", novoId, "Prontuário aberto", `${numero} · ${b.especialidade}`, s);
        anotar("paciente", b.paciente_id, "Prontuário aberto", `${numero} · ${b.especialidade}`, s);
        return json(res, 200, { ok: true, id: novoId, numero });
      }
      if (tabela === "prontuario_registros") {
        const pr = db.prepare("SELECT paciente_id,numero FROM prontuario WHERE id=?").get(b.prontuario_id) || {};
        anotar("prontuario", b.prontuario_id, "Lançamento: " + rotuloTipo(b.tipo), (b.texto || "").slice(0, 120), s);
        if (pr.paciente_id) anotar("paciente", pr.paciente_id, "Lançamento no prontuário " + (pr.numero || ""), rotuloTipo(b.tipo), s);
      }
      // todo paciente nasce com o seu código próprio, gerado aqui
      if (tabela === "pacientes") {
        const codigo = emitirCodigoPaciente(novoId);
        anotar("paciente", novoId, "Cadastro criado", `${codigo} · ${b.nome || ""}`, s);
        return json(res, 200, { ok: true, id: novoId, codigo });
      }
      // o agendamento se pendura na pasta do procedimento, se ela já existir
      if (tabela === "atendimentos") {
        const pasta = sincronizarProntuarioDoAtendimento(novoId);
        return json(res, 200, { ok: true, id: novoId, prontuario: pasta || null });
      }
      // cadastrar profissional já cria o acesso dele ao sistema
      if (tabela === "profissionais") {
        const e = salvarAcessoProfissional(novoId, b, s.perfil);
        if (e) return json(res, 200, { ok: true, id: novoId, aviso: e });
      }
      return json(res, 200, { ok: true, id: novoId });
    }
    if (req.method === "PUT" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      const b = await readBody(req);
      delete b.usuario_id;                                            // não se troca o dono por aqui
      if (donoCol === "profissional_id") delete b.profissional_id;    // o profissional não reatribui o atendimento
      // guardado ANTES do update: é como sabemos se o procedimento mudou nesta
      // edição — e só nesse caso o vínculo com o prontuário é refeito
      let antesAtend = null;
      if (tabela === "atendimentos") {
        antesAtend = db.prepare("SELECT profissional_id,data,hora,hora_fim,sala_id,procedimento_id,especialidade FROM atendimentos WHERE id=?").get(id) || {};
        if ("paciente_id" in b && !b.paciente_id) return json(res, 400, { error: "Selecione o paciente. Só é possível agendar para paciente cadastrado." });
        const e = validarAgenda(b.profissional_id ?? antesAtend.profissional_id, b.data ?? antesAtend.data, b.hora ?? antesAtend.hora, id,
          b.hora_fim ?? antesAtend.hora_fim, b.sala_id ?? antesAtend.sala_id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "anamneses" && b.dados !== undefined && typeof b.dados !== "string") b.dados = JSON.stringify(b.dados || {});
      /* Lançamento do prontuário: guarda o estado ANTERIOR para o histórico
         poder dizer o que mudou. Registro clínico editado precisa deixar
         rastro — quem leu a evolução ontem tem de conseguir ver que ela foi
         complementada hoje, e com o quê. */
      let antesReg = null;
      if (tabela === "prontuario_registros")
        antesReg = db.prepare("SELECT prontuario_id,tipo,texto,data,profissional FROM prontuario_registros WHERE id=?").get(id) || null;

      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      if (use.length) db.prepare(`UPDATE ${tabela} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
      if (tabela === "anamneses" && COLS.anamneses.has("atualizado")) db.prepare("UPDATE anamneses SET atualizado=? WHERE id=?").run(agora(), id);

      if (antesReg) {
        const depois = db.prepare("SELECT texto,data,profissional FROM prontuario_registros WHERE id=?").get(id) || {};
        const mudancas = [];
        const t = trechoAlterado(antesReg.texto, depois.texto);
        if (t) mudancas.push(t);
        if (String(antesReg.data || "") !== String(depois.data || ""))
          mudancas.push(`data ${antesReg.data || "—"} → ${depois.data || "—"}`);
        if (String(antesReg.profissional || "") !== String(depois.profissional || ""))
          mudancas.push(`profissional ${antesReg.profissional || "—"} → ${depois.profissional || "—"}`);
        if (mudancas.length) {
          db.prepare("UPDATE prontuario_registros SET atualizado=? WHERE id=?").run(agora(), id);
          const rot = "Lançamento atualizado: " + rotuloTipo(antesReg.tipo);
          anotar("prontuario", antesReg.prontuario_id, rot, mudancas.join(" · "), s);
          const pr = db.prepare("SELECT paciente_id,numero FROM prontuario WHERE id=?").get(antesReg.prontuario_id) || {};
          if (pr.paciente_id) anotar("paciente", pr.paciente_id, rot + (pr.numero ? " (" + pr.numero + ")" : ""), mudancas.join(" · "), s);
        }
      }
      if (tabela === "atendimentos") {
        const pasta = sincronizarProntuarioDoAtendimento(id, antesAtend);
        return json(res, 200, { ok: true, prontuario: pasta || null });
      }
      // editar profissional também mantém o acesso dele em dia (login/senha/bloqueio)
      if (tabela === "profissionais") {
        const e = salvarAcessoProfissional(id, b, s.perfil);
        if (e) return json(res, 200, { ok: true, aviso: e });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      /* Cadastro com histórico não se apaga — bloqueia-se. Apagar deixaria a
         agenda antiga sem profissional e o prontuário impresso sem procedimento. */
      if (["profissionais", "pacientes", "procedimentos", "convenios", "salas", "prontuario"].includes(tabela)) {
        const v = vinculosDe(tabela, id);
        if (v.length) {
          const podeBloquear = COLS[tabela].has("ativo");
          const saida = tabela === "prontuario"
            ? "Use Dar alta — a pasta sai da lista de tratamentos ativos e todo o registro continua intacto."
            : (podeBloquear ? "Use Bloquear — ele some das telas de escolha, mas o histórico continua intacto."
                            : "Excluir apagaria parte do histórico do paciente.");
          return json(res, 409, { error: `Não dá para excluir: este registro já tem histórico (${v.join(", ")}). ${saida}`, vinculos: v });
        }
      }
      /* Anamnese só se apaga enquanto NÃO estiver vinculada a um prontuário.
         Depois de vinculada ela é parte do registro clínico daquela pasta —
         foi ela que a abriu — e apagá-la deixaria o prontuário sem a origem.
         Vale mesmo se a anamnese tiver sido reaberta para correção: o vínculo
         permanece, então o Excluir continua fora. */
      if (tabela === "anamneses") {
        const an = db.prepare("SELECT prontuario_id FROM anamneses WHERE id=?").get(id);
        /* O que barra é o prontuário EXISTIR — não o campo estar preenchido.
           Um id apontando para pasta apagada é lixo, não vínculo, e não pode
           deixar a anamnese impossível de excluir. */
        const pr = an && an.prontuario_id
          ? db.prepare("SELECT numero, especialidade FROM prontuario WHERE id=?").get(an.prontuario_id) : null;
        if (pr) {
          return json(res, 409, { error: `Não dá para excluir: esta anamnese está vinculada ao prontuário ${pr.numero || ""}`
            + `${pr.especialidade ? " (" + pr.especialidade + ")" : ""} e faz parte do registro clínico dele.` });
        }
        // vínculo morto: solta antes de apagar, para não deixar rastro estranho
        if (an && an.prontuario_id) db.prepare("UPDATE anamneses SET prontuario_id=NULL WHERE id=?").run(id);
      }
      // profissional sem histórico: o acesso dele vai junto
      if (tabela === "profissionais") db.prepare("DELETE FROM g_usuarios WHERE profissional_id=?").run(id);

      /* Apagar a pasta SOLTA o que estava arquivado nela, sem destruir nada:
         a anamnese volta a ser rascunho (e aí sim pode ser excluída ou
         refinalizada no procedimento certo) e o agendamento volta a ficar sem
         prontuário, seguindo normalmente na agenda. É o caminho de volta de
         quem finalizou a anamnese errada. */
      let soltos = null;
      if (tabela === "prontuario") {
        const pr = db.prepare("SELECT numero, paciente_id, especialidade FROM prontuario WHERE id=?").get(id) || {};
        const nAn = db.prepare("UPDATE anamneses SET prontuario_id=NULL, status='Rascunho', finalizada_em=NULL WHERE prontuario_id=?").run(id).changes;
        const nAt = db.prepare("UPDATE atendimentos SET prontuario_id=NULL WHERE prontuario_id=?").run(id).changes;
        soltos = { anamneses: nAn, atendimentos: nAt };
        if (pr.paciente_id) {
          const det = [nAn ? `${nAn} anamnese(s) voltaram a rascunho` : "", nAt ? `${nAt} agendamento(s) sem prontuário` : ""]
            .filter(Boolean).join(" · ");
          anotar("paciente", pr.paciente_id, `Prontuário excluído${pr.numero ? " " + pr.numero : ""}`,
            [pr.especialidade, det].filter(Boolean).join(" — "), s);
        }
      }
      db.prepare(`DELETE FROM ${tabela} WHERE id=?`).run(id);
      return json(res, 200, soltos ? { ok: true, soltos } : { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}


module.exports = { handleRestrito };
