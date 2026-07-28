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
const { Q, config: configPg } = require("./pg");
const { cifrar, chaveConfigurada, erroChave, digitos: soDigitos } = require("./cripto");
const { migrar: migrarEsquema } = require("./migrar");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
/* Versão do sistema de gestão da clínica (/restrito).
   REGRA DO CLIENTE: feature nova sobe a 2ª casa (1.12.0, 1.13.0, 1.14.0…);
   correção de bug sobe a 3ª (1.14.1, 1.14.2…). A primeira casa NÃO muda —
   houve um deslize em que subi para 2.x e o cliente corrigiu; a numeração
   voltou para a série 1.x, que é a que ele acompanha. */
const SISTEMA_VERSION = "1.25.1";

/* ==========================================================================
   HISTÓRICO DE VERSÕES — o que alimenta a tela "Sobre o sistema"

   Fica AQUI, e não num arquivo à parte, porque a versão que a tela mostra
   (SISTEMA_VERSION, logo acima) e a lista de mudanças precisam andar juntas.
   Separadas em dois lugares, uma hora a tela anuncia uma versão cujo texto
   ficou para trás.

   A primeira entrada é sempre a versão ATUAL. Ao subir a versão: mude a
   constante acima e acrescente a entrada nova no TOPO desta lista.

   Reconstruído a partir do git (a versão gravada em cada commit) e do registro
   do projeto. Algumas versões saíram entre commits e estão descritas junto da
   que as entregou.
   ========================================================================== */
const HISTORICO_VERSOES = [
  { versao: "1.24.0", data: "2026-07-28", titulo: "Atalho para o painel do site", mudancas: [
    "Novo menu de atalhos no topo, ao lado do menu da conta",
    "Painel do site abre em nova aba, já autenticado (só administrador)",
    "Site da clínica abre em nova aba",
    "Sair do sistema encerra também a sessão do painel do site neste navegador",
    "Correção: valores saíam picados em tiras verticais nas impressões e em Profissionais",
  ] },
  { versao: "1.23.0", data: "2026-07-28", titulo: "Editor de texto e melhorias de uso", mudancas: [
    "Editor com formatação (negrito, itálico, listas) nos textos do prontuário",
    "Observação da pasta, avaliações, evoluções, planos e encaminhamentos aceitam formatação",
    "A formatação aparece também nas impressões",
    "Botões mostram que estão trabalhando e travam a tela até concluir, evitando duplicidade",
    "Ações das tabelas com mais de um botão reunidas num menu de três pontos",
    "Nas telas de ação única, o botão Abrir virou ícone de lupa",
  ] },
  { versao: "1.22.0", data: "2026-07-28", titulo: "Auditoria", mudancas: [
    "Nova tela com a trilha de tudo que acontece no sistema",
    "Registra entradas, saídas, telas abertas, cadastros, edições e exclusões",
    "Guarda data, hora, IP, quem fez e o que foi feito",
    "Clique na linha abre o detalhe: em edições, campo a campo o antes e o depois",
    "Filtros por período, pessoa, ação e tela",
    "Exclusiva do administrador",
  ] },
  { versao: "1.21.0", data: "2026-07-28", titulo: "Dados sensíveis criptografados", mudancas: [
    "CPF, RG, endereço, telefone, e-mail e contatos gravados cifrados no banco",
    "Anamneses, lançamentos do prontuário e histórico também cifrados",
    "Backup sai cifrado: só é legível em servidor com a chave",
    "Tela e impressões continuam mostrando tudo por extenso",
    "Busca por nome, código e CPF funciona como antes, inclusive por parte do número",
  ] },
  { versao: "1.20.0", data: "2026-07-28", titulo: "Tela Sobre o sistema", mudancas: [
    "Nova tela com versão, histórico de atualizações, tecnologias e banco ativo",
    "Histórico de versões anteriores em sanfona",
    "Exclusiva do administrador",
  ] },
  { versao: "1.19.0", data: "2026-07-28", titulo: "Banco de dados PostgreSQL", mudancas: [
    "Sistema de gestão migrado do SQLite para o PostgreSQL",
    "Estrutura do banco controlada por migrations versionadas",
    "Backup do banco pelo painel, em arquivo SQL completo",
    "Uma falha no banco não derruba mais o site da clínica",
    "Correção: procedimentos sem modelo de anamnese em instalação nova",
  ] },
  { versao: "1.18.1", data: "2026-07-28", titulo: "Procedimento que não aparece na agenda", mudancas: [
    "A busca de procedimento explica quando ele existe mas o profissional escolhido não o realiza",
  ] },
  { versao: "1.18.0", data: "2026-07-27", titulo: "Paginação e vínculos órfãos", mudancas: [
    "Paginação em todas as tabelas: 10, 15, 30, 50 ou 100 por página",
    "Correção: anamneses ligadas a prontuário excluído voltam a rascunho",
  ] },
  { versao: "1.17.1", data: "2026-07-27", titulo: "Correções de agenda e exclusão", mudancas: [
    "Hora de término sempre recalculada a partir do início e da duração",
    "Anamnese só pode ser excluída quando não tem prontuário",
    "Excluir uma pasta de prontuário solta o que estava arquivado nela",
  ] },
  { versao: "1.17.0", data: "2026-07-27", titulo: "Relatórios em submenu", mudancas: [
    "Relatórios virou submenu: movimento da clínica e pacientes ativos/inativos",
    "Relação com endereço, WhatsApp, quem assiste e especialidades",
    "Impressão da relação em paisagem",
  ] },
  { versao: "1.16.0", data: "2026-07-27", titulo: "Paciente ativo e inativo", mudancas: [
    "Ativar e inativar paciente sem apagar a ficha",
    "Inativo some das telas de escolha e volta com um clique",
    "Filtro Todos / Ativos / Inativos na lista",
  ] },
  { versao: "1.15.0", data: "2026-07-27", titulo: "Rastro das edições no prontuário", mudancas: [
    "Editar um lançamento grava no histórico o trecho que mudou",
    "A lista mostra quando o registro foi editado",
  ] },
  { versao: "1.14.0", data: "2026-07-27", titulo: "Prontuário como tela do sistema", mudancas: [
    "Prontuário aberto virou tela com menu e barra do topo",
    "Filtro por período em Anamneses, Agenda e Relatórios",
    "Anamneses passou a ser um item único de menu",
    "Cabeçalho das impressões com CNPJ, e-mail, telefone e site em linhas",
  ] },
  { versao: "1.13.0", data: "2026-07-26", titulo: "Regra de negócio ponta a ponta", mudancas: [
    "Código próprio do paciente (PAC-AAAA-00000), gerado pelo sistema",
    "Busca por código, CPF ou nome em todos os módulos",
    "Agendamento exige paciente cadastrado",
    "Finalizar a anamnese é o que abre o prontuário",
  ] },
  { versao: "1.12.0", data: "2026-07-26", titulo: "Redesenho do prontuário", mudancas: [
    "Prontuário virou pasta por paciente e especialidade",
    "Avaliações, evoluções, planos e encaminhamentos viraram lançamentos datados",
    "Alta e reabertura da pasta",
    "Histórico por paciente e por prontuário",
  ] },
  { versao: "1.11.0", data: "2026-07-26", titulo: "Backup automático", mudancas: [
    "Cópia de segurança diária, com conferência de integridade",
    "Restauração assistida por script",
  ] },
  { versao: "1.7.0", data: "2026-07-26", titulo: "Ajustes de agenda", mudancas: [
    "Horário de início e término obrigatórios",
    "Agenda ordenada por data e hora",
  ] },
  { versao: "1.6.0", data: "2026-07-26", titulo: "Número de controle do prontuário", mudancas: [
    "Numeração PR-AAAA-00000, sequencial por ano e nunca reaproveitada",
    "O número aparece nas listas e nas impressões",
  ] },
  { versao: "1.5.0", data: "2026-07-26", titulo: "Impressões", mudancas: [
    "Escolha entre retrato e paisagem em todas as impressões",
    "Impressão de uma evolução isolada",
    "Cabeçalho e rodapé do navegador removidos do papel",
  ] },
  { versao: "1.4.0", data: "2026-07-26", titulo: "Busca de CEP", mudancas: [
    "CEP preenche endereço, bairro e cidade no cadastro de paciente",
  ] },
  { versao: "1.3.0", data: "2026-07-26", titulo: "Acesso do profissional", mudancas: [
    "Cadastrar profissional já cria o login dele",
    "Bloquear e desbloquear acesso, derrubando a sessão aberta",
    "Cadastro com histórico não pode ser excluído, só bloqueado",
  ] },
  { versao: "1.2.0", data: "2026-07-26", titulo: "Cores e ficha do paciente", mudancas: [
    "Ficha do paciente dentro do prontuário",
    "Cores oficiais dos procedimentos na agenda",
    "Busca de procedimento separada por consulta, sessão e procedimento",
    "Agenda de um profissional por vez",
  ] },
  { versao: "1.1.0", data: "2026-07-24", titulo: "Impressões e busca", mudancas: [
    "Marca d'água da clínica nas impressões",
    "Busca de paciente por CPF, com ou sem máscara",
  ] },
  { versao: "1.0.0", data: "2026-07-24", titulo: "Primeira versão", mudancas: [
    "Cadastros: pacientes, profissionais, convênios, procedimentos e salas",
    "Agenda de atendimentos com controle de choque de horário e sala",
    "Anamneses em três modelos, com impressão em papel timbrado",
    "Prontuário, documentos e relatórios",
    "Perfis de acesso: administrador, secretaria e profissional",
  ] },
];

/* ==========================================================================
   O QUE É GRAVADO CIFRADO

   Estes campos vão para o banco em texto cifrado (ver cripto.js) e voltam
   decifrados na leitura. Na tela e na impressão nada muda; no banco, num dump
   ou num backup vazado, não há nada legível.

   POR QUE `nome` E `codigo` FICAM DE FORA — é uma escolha, não um esquecimento:
   são as chaves de BUSCA e de ORDENAÇÃO das listas. Cifrados, o banco não
   conseguiria mais ordenar por nome nem procurar por parte dele, e cada
   listagem teria de trazer a clínica inteira para a memória antes de mostrar a
   primeira linha. O que protege de verdade é o conjunto: um nome sozinho, sem
   CPF, sem endereço, sem telefone e sem prontuário, é o que já aparece na
   agenda impressa em cima do balcão.

   Também ficam de fora as colunas que o SQL precisa comparar: datas usadas em
   filtro de período, status, ids e os liga/desliga.
   ========================================================================== */
const CAMPOS_PROTEGIDOS = {
  pacientes: ["cpf", "rg", "nascimento", "naturalidade", "estado_civil", "religiao",
    "profissao", "escolaridade", "altura", "peso", "cor_pele", "sangue",
    "cep", "endereco", "numero", "bairro", "cidade", "complemento",
    "celular", "telefone", "email", "canal", "mae", "pai", "indicacao",
    "nome_contato", "foto", "observacao", "inativo_motivo",
    "resp_nome", "resp_cpf", "resp_rg", "resp_nascimento"],
  // as respostas da anamnese (queixa, medicamentos, histórico de saúde)
  anamneses: ["dados"],
  // o registro clínico em si — avaliação, evolução, plano, encaminhamento
  prontuario_registros: ["texto", "anexo"],
  prontuario: ["observacao", "alta_motivo"],
  // o histórico guarda TRECHOS do que foi editado no prontuário
  historico: ["detalhe"],
  atendimentos: ["nome_agenda", "celular", "observacoes"],
  documentos_gestao: ["titulo", "arquivo"],
  profissionais: ["contato", "registro"],
  // a trilha de auditoria guarda O QUE foi feito — inclui nome, CPF e trechos
  // de prontuário. Cifrado pelo mesmo motivo do histórico.
  auditoria: ["resumo", "detalhe"],
};

/* ==========================================================================
   HIGIENIZAÇÃO DO HTML DO PRONTUÁRIO

   Os campos de registro clínico passaram a aceitar formatação. Isso significa
   que o sistema GRAVA HTML e depois o DEVOLVE para dentro da página e da
   janela de impressão — que é a definição de XSS armazenado se ninguém filtrar.

   O perigo aqui não é teórico nem é só "invasor": basta alguém colar um trecho
   de página da internet dentro de uma evolução para entrar script, iframe e
   estilo que quebram a impressão do prontuário.

   A regra é LISTA DE PERMITIDOS, e não lista de proibidos: só o que está aqui
   passa, o resto vira texto. Lista de proibidos sempre esquece alguma coisa —
   e a que esquecer é justamente a que vai ser usada.

   Nada de atributo: sem `style`, sem `class`, sem `on*`, sem `href`. Para
   negrito, itálico, sublinhado e lista, atributo nenhum é necessário — e é
   dentro deles que mora quase todo ataque.
   ========================================================================== */
const TAGS_PERMITIDAS = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "div", "span"]);

function htmlLimpo(valor) {
  if (valor === null || valor === undefined) return valor;
  let s = String(valor);
  if (!s.includes("<")) return s;                    // texto puro: nada a fazer

  /* Fora antes de tudo: o conteúdo destas tags some junto com elas. Remover só
     a tag deixaria o código do script solto como texto visível na tela. */
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[^>]*\/?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  /* Agora cada tag restante: se estiver na lista, volta SEM atributo nenhum;
     se não estiver, é descartada (o texto interno permanece). */
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, nome) => {
    const n = nome.toLowerCase();
    if (!TAGS_PERMITIDAS.has(n)) return "";
    return tag.startsWith("</") ? `</${n}>` : (n === "br" ? "<br>" : `<${n}>`);
  });
  return s;
}

/* Onde o HTML é aceito. Só o registro clínico — em nome, CPF ou endereço,
   marcação não tem função nenhuma e só serviria para esconder conteúdo. */
const CAMPOS_HTML = {
  prontuario: ["observacao"],
  prontuario_registros: ["texto"],
};

function limparHtmlDoRegistro(tabela, obj) {
  const campos = CAMPOS_HTML[tabela];
  if (!campos || !obj) return obj;
  for (const c of campos) if (c in obj) obj[c] = htmlLimpo(obj[c]);
  return obj;
}

/* Cifra os campos protegidos de um objeto ANTES de gravar. Recebe e devolve o
   objeto com os mesmos nomes de campo — quem chama não precisa saber quais são
   sensíveis. */
function proteger(tabela, obj) {
  const campos = CAMPOS_PROTEGIDOS[tabela];
  if (!campos || !obj) return obj;
  for (const c of campos) if (c in obj) obj[c] = cifrar(obj[c]);
  return obj;
}

/* ==========================================================================
   AUDITORIA — quem fez o quê, quando e de onde

   Diferente do `historico`, que conta a vida de UM paciente e aparece para a
   equipe dentro do prontuário. A auditoria olha o sistema inteiro, do ponto de
   vista de quem operou, e é exclusiva do administrador.

   TRÊS DECISÕES QUE MOLDAM ESTA FUNÇÃO:

   1. Ela NUNCA derruba a operação auditada. Todo o corpo vive num try/catch
      que só escreve no log do servidor. Se a auditoria falhar (disco cheio,
      coluna faltando), o cadastro do paciente tem de ser salvo assim mesmo —
      perder o atendimento para preservar o registro de que ele existiu seria
      trocar o certo pelo acessório.

   2. Ela não é esperada (`await`). Gravar a trilha não pode somar latência a
      cada clique da recepção. A promessa é solta com um catch próprio, porque
      promessa rejeitada e não tratada derruba o processo no Node.

   3. O `detalhe` guarda JSON com o ANTES e o DEPOIS. É o que a tela abre no
      modal quando o usuário clica na linha. Vai cifrado (ver CAMPOS_PROTEGIDOS).
   ========================================================================== */
const ACOES_ROTULO = {
  login: "Entrou no sistema", login_falhou: "Tentativa de login sem sucesso",
  logout: "Saiu do sistema", acesso: "Abriu a tela",
  criar: "Cadastrou", editar: "Alterou", excluir: "Excluiu",
  imprimir: "Imprimiu", backup: "Baixou backup do banco",
  senha: "Trocou a senha", bloquear: "Bloqueou acesso", desbloquear: "Liberou acesso",
  alta: "Deu alta", reabrir: "Reabriu", finalizar: "Finalizou",
  inativar: "Inativou", reativar: "Reativou",
  arquivar: "Arquivou", restaurar: "Restaurou",
  vincular: "Vinculou", desvincular: "Desvinculou",
};

/* Nome da tela como o usuário a conhece. A tabela se chama
   `documentos_gestao`; para quem lê a auditoria, aquilo é "Documentos". */
const MODULO_ROTULO = {
  pacientes: "Pacientes", profissionais: "Profissionais", convenios: "Convênios",
  procedimentos: "Procedimentos", salas: "Salas", atendimentos: "Agendamento",
  prontuario: "Prontuário", prontuario_registros: "Lançamentos do prontuário",
  anamneses: "Anamneses", documentos_gestao: "Documentos", historico: "Histórico",
  usuarios: "Usuários do Sistema", relatorios: "Relatórios",
  relatorios_pacientes: "Pacientes ativos/inativos", painel: "Painel",
  auditoria: "Auditoria", sobre: "Sobre o sistema", conta: "Minha conta",
};
const rotuloModulo = (t) => MODULO_ROTULO[t] || t;

/* Como identificar o registro numa linha de auditoria. Sem isto a trilha diria
   "alterou o registro 41", e ninguém saberia de quem se trata sem ir ao banco. */
function rotuloRegistro(tabela, r) {
  if (!r) return "";
  if (tabela === "prontuario") return [r.numero, r.especialidade].filter(Boolean).join(" · ") || `#${r.id || ""}`;
  if (tabela === "prontuario_registros") return rotuloTipo(r.tipo) + (r.data ? ` de ${r.data}` : "");
  if (tabela === "anamneses") return [rotuloModelo(r.tipo), r.procedimento].filter(Boolean).join(" · ");
  if (tabela === "atendimentos") return [r.data, r.hora, r.especialidade].filter(Boolean).join(" ");
  if (tabela === "documentos_gestao") return r.titulo || r.tipo || `#${r.id || ""}`;
  return r.nome || r.codigo || r.numero || `#${r.id || ""}`;
}

function auditar({ req, sessao: s, acao, modulo, entidadeId, resumo, detalhe }) {
  Promise.resolve().then(async () => {
    await Q.run(
      `INSERT INTO auditoria(criado,ip,usuario_id,usuario_nome,perfil,acao,modulo,entidade_id,resumo,detalhe,rota,metodo)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      agora(),
      req ? clientIp(req) : null,
      s ? s.userId : null,
      s ? s.nome : "",
      s ? s.perfil : "",
      acao,
      modulo || null,
      entidadeId || null,
      cifrar(resumo || ""),
      cifrar(detalhe ? JSON.stringify(detalhe) : ""),
      req ? String(req.url || "").slice(0, 300) : null,
      req ? req.method : null,
    );
  }).catch((e) => console.error("  ✖ auditoria não gravada:", e.message));
}

/* ==========================================================================
   ACESSO DE TELA — registrar sem afogar a trilha

   Uma tela do sistema não faz uma leitura, faz várias: a lista principal, os
   seletores, o cache de apoio, mais uma releitura a cada busca digitada.
   Registrar toda leitura encheria a auditoria de milhares de linhas por dia e,
   pior, esconderia o que importa — um "excluiu paciente" perdido no meio de
   dez mil "consultou".

   Então guardamos apenas a PRIMEIRA visita de cada pessoa a cada tela dentro de
   uma janela de tempo. Fica "a recepção abriu Pacientes às 14h03", que é o que
   alguém realmente vai querer saber, sem o ruído.

   A janela vive em memória: reiniciar o serviço faz o próximo acesso ser
   registrado de novo. É o comportamento certo — reinício é evento raro, e um
   registro a mais não atrapalha ninguém.
   ========================================================================== */
const ACESSO_JANELA_MIN = 15;
const acessosRecentes = new Map();     // "userId:modulo" -> timestamp

function registrarAcesso(req, s, modulo) {
  const chave = `${s.userId}:${modulo}`;
  const antes = acessosRecentes.get(chave);
  if (antes && Date.now() - antes < ACESSO_JANELA_MIN * 60_000) return;
  acessosRecentes.set(chave, Date.now());
  auditar({ req, sessao: s, acao: "acesso", modulo,
    resumo: `${s.nome} abriu a tela ${rotuloModulo(modulo)}` });
}
/* Sem esta limpeza o mapa cresceria para sempre num servidor que fica meses no
   ar — pouca coisa por vez, mas é vazamento de memória do mesmo jeito. */
setInterval(() => {
  const limite = Date.now() - ACESSO_JANELA_MIN * 60_000;
  for (const [k, t] of acessosRecentes) if (t < limite) acessosRecentes.delete(k);
}, 30 * 60_000).unref();

/* Compara o registro antes e depois de uma edição e devolve só o que mudou.
   É isto que o modal da auditoria mostra — e é o que torna a trilha útil:
   "alterou o paciente" não diz nada; "trocou o celular de X para Y" diz. */
function diferencas(antes, depois, tabela) {
  const mudou = {};
  if (!antes || !depois) return mudou;
  const protegidos = new Set(CAMPOS_PROTEGIDOS[tabela] || []);
  for (const campo of Object.keys(depois)) {
    if (campo === "id" || campo === "criado") continue;
    const de = antes[campo], para = depois[campo];
    if (de === para) continue;
    // "" e null são a mesma coisa para o usuário: campo em branco
    if ((de === null || de === undefined || de === "") && (para === null || para === undefined || para === "")) continue;
    if (String(de ?? "") === String(para ?? "")) continue;
    mudou[campo] = {
      de: recortar(de ?? "", 400),
      para: recortar(para ?? "", 400),
      protegido: protegidos.has(campo),
    };
  }
  return mudou;
}

/* As tecnologias do SISTEMA DE GESTÃO. O site da clínica é outro projeto, com
   outra pilha (e outro banco) — não entra aqui. */
const TECNOLOGIAS = [
  { nome: "Node.js", papel: "Servidor da aplicação", detalhe: process.version },
  { nome: "PostgreSQL", papel: "Banco de dados do sistema", detalhe: "acesso pelo driver pg" },
  { nome: "JavaScript, HTML e CSS", papel: "Interface", detalhe: "sem framework — tela única" },
  { nome: "Migrations em SQL", papel: "Controle da estrutura do banco", detalhe: "cada mudança é um arquivo versionado" },
  { nome: "scrypt", papel: "Proteção das senhas", detalhe: "com sal individual por senha" },
  { nome: "pg_dump", papel: "Backup", detalhe: "cópia diária automática e sob demanda" },
];
// CSP das telas do sistema de gestão e do portal — bloqueia script/objeto
// externos; só libera as fontes do Google. 'unsafe-inline' é preciso porque as
// telas usam script/estilo inline. A janela de impressão (about:blank via
// document.write) herda esta política — por isso o print usa <script> inline
// e imagem de mesma origem, ambos permitidos aqui.
const CSP_GESTAO = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";

/* ==========================================================================
   O ESQUEMA NÃO MORA MAIS AQUI.

   Até a v1.18.1 este arquivo abria o SQLite e, a cada boot, executava um
   CREATE TABLE IF NOT EXISTS gigante seguido de ~30 ALTER TABLE dentro de
   try/catch vazios. Funcionava, mas escondia erro: um ALTER escrito errado era
   engolido junto com o "coluna já existe", e ninguém ficava sabendo.

   Agora o esquema vive em migrations/*.sql, aplicadas uma vez cada e
   registradas em schema_migrations. Mudança de esquema = arquivo novo.
   Migração que falha PARA o boot, em vez de sumir.
   ========================================================================== */
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
async function anotar(entidade, entidadeId, evento, detalhe, sessao) {
  if (!entidadeId) return;
  /* `detalhe` é cifrado: ele carrega TRECHOS do que foi escrito no prontuário
     (a v1.15.0 passou a registrar o que mudou numa evolução). Sem isto, o
     histórico viraria a porta dos fundos do registro clínico — o texto estaria
     protegido no lançamento e em claro aqui do lado.
     O `evento` fica legível: são rótulos fixos ("Alta", "Prontuário aberto"),
     sem conteúdo de paciente, e é por ele que a tela agrupa a linha do tempo. */
  await Q.run("INSERT INTO historico(entidade,entidade_id,evento,detalhe,usuario_id,usuario_nome,criado) VALUES(?,?,?,?,?,?,?)",
    entidade, entidadeId, evento, cifrar(detalhe || ""), sessao ? sessao.userId : null, sessao ? sessao.nome : "", agora());
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
/* Os parênteses em volta do await NÃO são enfeite: sem eles, `await Q.get()?.value`
   aplicaria o `?.value` na Promise (que não tem .value) antes de esperar — e o
   resultado seria undefined em silêncio, que é o pior erro possível aqui. */
const getC = async (k) => (await Q.get("SELECT value FROM g_config WHERE key=?", k))?.value;
const setC = (k, v) => Q.run("INSERT INTO g_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));

/* ==========================================================================
   NUMERAÇÃO SEQUENCIAL — PR-AAAA-00001 (prontuário) e PAC-AAAA-00001 (paciente)
   Sequencial por ANO, único e NUNCA reaproveitado. É por esses números que a
   clínica localiza e controla o registro (busca, arquivo físico, encaminhamento).

   Por que um contador guardado em g_config e não "o maior número da tabela":
   se o último registro for excluído, o maior da tabela cai — e o próximo
   herdaria um número que já circulou impresso. O contador só sobe.
   Ele é comparado com o maior do banco a cada emissão, então também se
   recupera sozinho se o g_config for perdido.

   Os três índices únicos que sustentam essas regras (número do prontuário não
   repete, um prontuário por paciente+procedimento, código de paciente não
   repete) saíram daqui e passaram para migrations/001_esquema_inicial.sql —
   é lá que mora o esquema agora. Antes eles eram criados a cada boot dentro
   de um try/catch: se o banco já tivesse uma duplicata, o índice simplesmente
   não nascia e a regra deixava de existir, em silêncio.
   ========================================================================== */

/* O motor por trás dos dois números. `tabela`/`coluna` dizem onde procurar o
   maior já emitido; `chave` é o contador em g_config. */
async function proximoSequencial(prefixo, chave, tabela, coluna, ano) {
  const y = ano || new Date().getFullYear();
  const inicio = `${prefixo}-${y}-`;
  const chaveAno = `${chave}_${y}`;
  const guardado = Number((await getC(chaveAno)) || 0);
  const r = await Q.get(`SELECT MAX(CAST(substr(${coluna}, ?) AS INTEGER)) m FROM ${tabela} WHERE ${coluna} LIKE ?`, inicio.length + 1, inicio + "%");
  const noBanco = (r && r.m) ? Number(r.m) : 0;
  const seq = Math.max(guardado, noBanco) + 1;
  await setC(chaveAno, seq);               // marca como usado, mesmo se falhar depois
  return inicio + String(seq).padStart(5, "0");
}
/* Grava o número, tentando de novo se colidir (backup restaurado por cima). */
async function emitirSequencial(prefixo, chave, tabela, coluna, id, ano) {
  for (let i = 0; i < 20; i++) {
    const n = await proximoSequencial(prefixo, chave, tabela, coluna, ano);
    try { await Q.run(`UPDATE ${tabela} SET ${coluna}=? WHERE id=?`, n, id); return n; }
    /* Colisão de número é a ÚNICA falha que se tenta de novo. No SQLite a
       mensagem trazia "UNIQUE"; o Postgres diz "duplicate key value violates
       unique constraint" e carrega o código 23505. Testar pelo código é o certo
       — mensagem muda com a versão e com o idioma do servidor, e se este teste
       falhar o laço engole um erro real 20 vezes antes de desistir. */
    catch (e) { if (e.code !== "23505") throw e; }
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
const PROCEDIMENTOS_SEED = [
  ["Psicanálise Individual", "Consulta"], ["Psicanálise Individual", "Sessão"],
  ["Psicanálise Casal", "Consulta"], ["Psicanálise Casal", "Sessão"],
  ["Protocolo Integrativo — Ozônio e Detox", "Consulta"], ["Protocolo Integrativo — Ozônio e Detox", "Sessão"],
  ["Ozonioterapia", "Consulta"], ["Ozonioterapia", "Sessão"],
  ["Detox Iônico", "Consulta"], ["Detox Iônico", "Sessão"],
  ["Acupuntura", "Consulta"], ["Acupuntura", "Sessão"],
  ["Aromaterapia", "Consulta"],
  ["Terapia Floral", "Consulta"],
  ["Exame de Biorressonância", "Procedimento"],
  ["Ventosaterapia", "Consulta"], ["Ventosaterapia", "Sessão"],
  ["Kinesioterapia", "Consulta"], ["Kinesioterapia", "Sessão"],
];

/* ==========================================================================
   INICIALIZAÇÃO — o que antes rodava solto no topo do arquivo

   Com o SQLite, abrir o banco era síncrono: dava para criar tabela e semear
   dado durante o `require`. Com o Postgres, conectar é assíncrono — não existe
   "banco pronto" no meio de um require.

   Então todo o boot virou esta função, que o server.js AGUARDA antes de abrir
   a porta. É melhor assim: enquanto isto não terminar, ninguém entra num
   sistema meio inicializado. Se falhar, o processo não sobe — em vez de subir
   e atender errado.

   É seguro rodar a cada boot: cada passo ou é idempotente (só semeia tabela
   vazia) ou tem trava em g_config.
   ========================================================================== */
const COLS = {};

async function iniciarRestrito() {
  /* 0. a chave dos dados sensíveis.

     Sem ela o sistema NÃO sobe. A alternativa seria subir e gravar CPF,
     endereço e prontuário em texto puro — com a clínica trabalhando normal e
     ninguém percebendo que a proteção parou de existir. Uma falha silenciosa
     aqui é pior que o serviço fora do ar: o primeiro a notar seria quem
     recebesse o vazamento. */
  if (!chaveConfigurada()) {
    throw new Error(
      "chave dos dados sensíveis ausente ou inválida — " + erroChave() +
      "\n    Gere com: openssl rand -base64 32" +
      "\n    E grave como DADOS_CHAVE em /etc/bemestar.env" +
      "\n    ATENÇÃO: perder essa chave torna os dados já gravados ilegíveis.");
  }

  /* 1. esquema em dia. As migrations rodam antes de qualquer consulta. */
  await migrarEsquema({ silencioso: true });

  /* 2. quais colunas cada tabela tem de verdade.
     No SQLite isto vinha do `PRAGMA table_info`. O equivalente padrão do
     Postgres é o information_schema — e é ele que diz o que o CRUD genérico
     pode gravar. Uma coluna que exista no código mas não no banco é filtrada
     aqui, e não vira erro de SQL na cara do usuário. */
  for (const t of Object.keys(TAB)) {
    const cols = await Q.all(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?", t);
    COLS[t] = new Set(cols.map((c) => c.column_name));
    if (!COLS[t].size) console.error(`  ✖ /restrito: a tabela "${t}" não existe no banco — migration faltando?`);
  }

  /* 3. fichas antigas sem `ativo` ficariam invisíveis nos seletores, que
     filtram por ativo<>0. Todas nascem ATIVAS. */
  const nAtivos = (await Q.run("UPDATE pacientes SET ativo=1 WHERE ativo IS NULL")).changes;
  if (nAtivos) console.log(`  · /restrito: ${nAtivos} paciente(s) marcados como ativos.`);

  /* 4. VÍNCULOS ÓRFÃOS — apontam para um prontuário que não existe mais.
     Versões antigas deixavam apagar a pasta sem soltar o que estava dentro; o
     resultado é uma anamnese com prontuario_id preenchido apontando para o
     nada. Na tela isso aparecia como "sem prontuário" na lista MAS com o botão
     Excluir escondido — registro impossível de apagar, sem motivo visível.
     Soltar aqui devolve a anamnese para rascunho e o agendamento para a
     agenda, sem perder nada. */
  const an = (await Q.run(`UPDATE anamneses SET prontuario_id=NULL, status='Rascunho', finalizada_em=NULL
     WHERE prontuario_id IS NOT NULL AND prontuario_id NOT IN (SELECT id FROM prontuario)`)).changes;
  const at = (await Q.run(`UPDATE atendimentos SET prontuario_id=NULL
     WHERE prontuario_id IS NOT NULL AND prontuario_id NOT IN (SELECT id FROM prontuario)`)).changes;
  if (an || at) console.log(`  · /restrito: vínculos órfãos soltos — ${an} anamnese(s), ${at} agendamento(s).`);

  /* 5. registros anteriores à numeração recebem número uma única vez, na ordem
     de cadastro e respeitando o ano de cada um. Vale para os dois números. */
  for (const [tabela, coluna, emitir, rotulo] of [
    ["prontuario", "numero", emitirNumeroProntuario, "prontuário(s) antigo(s) receberam número"],
    ["pacientes", "codigo", emitirCodigoPaciente, "paciente(s) antigo(s) receberam código"],
  ]) {
    const antigos = await Q.all(`SELECT id, criado FROM ${tabela} WHERE ${coluna} IS NULL OR ${coluna}='' ORDER BY id`);
    for (const r of antigos) {
      const ano = Number(String(r.criado || "").slice(0, 4)) || new Date().getFullYear();
      await emitir(r.id, ano);
    }
    if (antigos.length) console.log(`  · /restrito: ${antigos.length} ${rotulo}.`);
  }

  /* 6. sementes dos cadastros. Só rodam com a tabela VAZIA — o que o cliente
     editar depois nunca é sobrescrito. */
  const AGORA_SEED = new Date().toISOString();

  if ((await Q.get("SELECT COUNT(*) c FROM g_usuarios")).c === 0) {
    await Q.run("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      "Administrador", "admin", hashSenha("bemestar-gestao"), "admin", AGORA_SEED);
    console.log("  · /restrito: sistema de gestão criado. Login: admin · senha: bemestar-gestao");
  }
  if ((await Q.get("SELECT COUNT(*) c FROM convenios")).c === 0) {
    const lista = ["Particular", "Cartão BemEstarClinic", "Efycard", "Forms Fitness Academia",
      "Pad Saúde", "Prosmed", "São Gabriel", "System Saúde"];
    for (let i = 0; i < lista.length; i++)
      await Q.run("INSERT INTO convenios(nome,ativo,sort,criado) VALUES(?,1,?,?)", lista[i], i, AGORA_SEED);
  }
  if ((await Q.get("SELECT COUNT(*) c FROM salas")).c === 0) {
    const lista = ["Consultório 01", "Consultório 02", "Consultório 03"];
    for (let i = 0; i < lista.length; i++)
      await Q.run("INSERT INTO salas(nome,ativo,sort,criado) VALUES(?,1,?,?)", lista[i], i, AGORA_SEED);
  }
  if ((await Q.get("SELECT COUNT(*) c FROM procedimentos")).c === 0) {
    for (let i = 0; i < PROCEDIMENTOS_SEED.length; i++) {
      const p = PROCEDIMENTOS_SEED[i];
      await Q.run("INSERT INTO procedimentos(nome,tipo,cor,duracao,ativo,sort,criado) VALUES(?,?,?,40,1,?,?)",
        p[0], p[1], CORES_PROCEDIMENTO[p[0]] || "#5B4FD8", i, AGORA_SEED);
    }
  }
  /* Bancos que nasceram com as cores provisórias recebem as oficiais UMA vez.
     A trava em g_config garante que, se a clínica trocar uma cor depois, o
     deploy seguinte não desfaça a escolha dela. */
  if ((await getC("cores_oficiais")) !== "1") {
    for (const [nome, cor] of Object.entries(CORES_PROCEDIMENTO))
      await Q.run("UPDATE procedimentos SET cor=? WHERE nome=?", cor, nome);
    await setC("cores_oficiais", "1");
  }
  if ((await Q.get("SELECT COUNT(*) c FROM profissionais")).c === 0) {
    for (const p of [["Dr. Ronalldo JM", "#5B4FD8"], ["Dr. Samuel Teixdan", "#0E8F7E"]])
      await Q.run("INSERT INTO profissionais(nome,especialidade,cor,ativo,criado) VALUES(?,'[]',?,1,?)", p[0], p[1], AGORA_SEED);
  }

  /* 7. qual anamnese cada procedimento pede — semeado uma vez, editável depois.

     DEPOIS de semear os procedimentos, e não antes. Este passo é um UPDATE:
     num banco recém-criado ele não encontrava linha nenhuma, atualizava zero e
     mesmo assim gravava a trava em g_config — deixando TODOS os procedimentos
     sem modelo de anamnese, para sempre, e o atalho "Preencher anamnese" do
     agendamento sem funcionar.

     O erro estava aqui desde o início; nunca apareceu porque o banco de
     produção nunca esteve vazio quando a rotina rodou. Só ficou visível ao
     montar o Postgres do zero. */
  if ((await getC("anamnese_modelo_seed")) !== "1") {
    const SQL_MODELO = "UPDATE procedimentos SET anamnese_modelo=? WHERE nome=? AND (anamnese_modelo IS NULL OR anamnese_modelo='')";
    let n = 0;
    for (const [nome, modelo] of Object.entries(ANAMNESE_POR_PROCEDIMENTO)) n += (await Q.run(SQL_MODELO, modelo, nome)).changes;
    await setC("anamnese_modelo_seed", "1");
    if (n) console.log(`  · /restrito: ${n} procedimento(s) ligados ao seu modelo de anamnese.`);
  }
}

/* ------------------------------- sessões --------------------------------- */
const SESSAO_HORAS = 8;
const sessoes = new Map();   // rid -> { userId, perfil, nome, ts }

/* ==========================================================================
   ENCERRAR A SESSÃO DO PAINEL DO SITE

   A sessão do /admin vive no server.js, não aqui — os dois sistemas são
   separados de propósito. Mas o server.js é quem CARREGA este arquivo; se
   fôssemos buscar lá de dentro, os dois passariam a exigir um ao outro para
   carregar (dependência circular), e um dos dois receberia o outro pela
   metade.

   Então o caminho é o inverso: o server.js REGISTRA aqui a função que sabe
   encerrar a sessão dele. Enquanto ninguém registrar, o valor é nulo e o
   logout daqui simplesmente segue sem mexer no painel — o /restrito continua
   funcionando isolado, como sempre funcionou.
   ========================================================================== */
let encerrarPainelDoSite = null;
const registrarEncerrarPainel = (fn) => { encerrarPainelDoSite = fn; };
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
async function validarAgenda(profissionalId, data, hora, excluirId, horaFim, salaId) {
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
    ? Q.all(`SELECT hora,hora_fim FROM atendimentos WHERE ${col}=? AND data=? AND hora<>'' AND status<>'Cancelado' AND id<>?`, val, data, excluirId)
    : Q.all(`SELECT hora,hora_fim FROM atendimentos WHERE ${col}=? AND data=? AND hora<>'' AND status<>'Cancelado'`, val, data);

  if (profissionalId) { const e = choque(await busca("profissional_id", profissionalId), "este profissional"); if (e) return e; }
  if (salaId) { const e = choque(await busca("sala_id", salaId), "esta sala"); if (e) return e; }
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
async function nomeProcedimento(linha) {
  if (linha && linha.procedimento_id) {
    const p = await Q.get("SELECT nome FROM procedimentos WHERE id=?", linha.procedimento_id);
    if (p && p.nome) return p.nome;
  }
  return (linha && linha.especialidade) || "";
}
/* Barra o registro NOVO em nome de quem já saiu da clínica. Devolve a mensagem
   de erro, ou "" se pode seguir. Editar o que já existe continua liberado — o
   passado não se mexe por causa da situação de hoje. */
async function pacienteInativo(pacienteId) {
  const pc = await Q.get("SELECT nome, ativo FROM pacientes WHERE id=?", pacienteId);
  if (!pc || Number(pc.ativo) !== 0) return "";
  return `${pc.nome} está INATIVO. Reative a ficha dele em Cadastros → Pacientes para voltar a registrar atendimentos.`;
}
async function prontuarioDoPar(pacienteId, procedimento) {
  if (!pacienteId || !procedimento) return null;
  return await Q.get("SELECT id,numero,especialidade,status FROM prontuario WHERE paciente_id=? AND especialidade=?", pacienteId, procedimento) || null;
}
/* Acerta o vínculo de UM atendimento.
   - sem vínculo  → pendura na pasta do procedimento, se existir;
   - com vínculo  → só refaz se o procedimento MUDOU nesta edição (senão um
     vínculo feito à mão dentro do prontuário seria desfeito sem querer). */
async function sincronizarProntuarioDoAtendimento(id, antes) {
  const a = await Q.get("SELECT id,paciente_id,procedimento_id,especialidade,prontuario_id FROM atendimentos WHERE id=?", id);
  if (!a) return null;
  const nome = await nomeProcedimento(a);
  if (a.prontuario_id) {
    const mudou = antes && await nomeProcedimento(antes) !== nome;
    if (!mudou) return await Q.get("SELECT id,numero,especialidade FROM prontuario WHERE id=?", a.prontuario_id) || null;
  }
  const pasta = await prontuarioDoPar(a.paciente_id, nome);
  const novo = pasta ? pasta.id : null;
  if (String(a.prontuario_id || "") !== String(novo || ""))
    await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", novo, id);
  return pasta;
}
/* Recolhe para a pasta recém-aberta os atendimentos daquele par que ainda
   estavam sem vínculo — tipicamente o primeiro atendimento, marcado antes de a
   anamnese existir. Devolve quantos entraram. */
async function recolherAtendimentosSoltos(prontuarioId, pacienteId, procedimento) {
  const soltos = await Q.all(`SELECT a.id FROM atendimentos a
       LEFT JOIN procedimentos p ON p.id = a.procedimento_id
      WHERE a.paciente_id = ? AND a.prontuario_id IS NULL
        AND COALESCE(NULLIF(p.nome,''), a.especialidade) = ?`, pacienteId, procedimento);
  for (const s of soltos) await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", prontuarioId, s.id);
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
const adminsAtivos = async () => Number((await Q.get("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1")).c);

/* ==========================================================================
   VÍNCULOS E HISTÓRICO
   Cadastro que já foi usado em atendimento/prontuário/anamnese NÃO pode ser
   apagado — apagar reescreveria o passado (a agenda antiga ficaria sem
   profissional, o prontuário impresso sem procedimento). O caminho certo é
   BLOQUEAR: some dos seletores, mas o histórico continua íntegro.
   ========================================================================== */
/* O Postgres devolve COUNT(*) como string (bigint não cabe em Number com
   segurança, então o driver entrega texto). Sem o Number() aqui, "0" seria
   verdadeiro e todo `if (await conta(...))` passaria a disparar com zero vínculos. */
const conta = async (sql, ...args) => Number((await Q.get(sql, ...args)).c);
async function vinculosDe(tabela, id) {
  const v = [];
  const somar = (n, rotulo) => { if (n > 0) v.push(`${n} ${rotulo}${n > 1 ? "s" : ""}`); };
  if (tabela === "profissionais") {
    const p = await Q.get("SELECT nome FROM profissionais WHERE id=?", id);
    somar(await conta("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?", id), "atendimento");
    if (p) {
      somar(await conta("SELECT COUNT(*) c FROM prontuario WHERE profissional=?", p.nome), "evolução de prontuário");
      somar(await conta("SELECT COUNT(*) c FROM anamneses WHERE profissional=?", p.nome), "anamnese");
    }
    somar(await conta("SELECT COUNT(*) c FROM g_usuarios WHERE profissional_id=?", id), "acesso ao sistema");
  }
  if (tabela === "pacientes") {
    somar(await conta("SELECT COUNT(*) c FROM atendimentos WHERE paciente_id=?", id), "atendimento");
    somar(await conta("SELECT COUNT(*) c FROM prontuario WHERE paciente_id=?", id), "evolução de prontuário");
    somar(await conta("SELECT COUNT(*) c FROM anamneses WHERE paciente_id=?", id), "anamnese");
    somar(await conta("SELECT COUNT(*) c FROM documentos_gestao WHERE paciente_id=?", id), "documento");
  }
  if (tabela === "procedimentos") somar(await conta("SELECT COUNT(*) c FROM atendimentos WHERE procedimento_id=?", id), "atendimento");
  if (tabela === "convenios") {
    somar(await conta("SELECT COUNT(*) c FROM atendimentos WHERE convenio_id=?", id), "atendimento");
    somar(await conta("SELECT COUNT(*) c FROM pacientes WHERE convenio_id=?", id), "paciente");
  }
  if (tabela === "salas") somar(await conta("SELECT COUNT(*) c FROM atendimentos WHERE sala_id=?", id), "atendimento");
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
    somar(await conta("SELECT COUNT(*) c FROM prontuario_registros WHERE prontuario_id=?", id), "lançamento");
  return v;
}

/* --------------- Acesso do profissional ao sistema ----------------------
   Cadastrar profissional JÁ cria o login dele (pedido da clínica) — e a
   secretaria pode fazer isso. Mas por aqui só nasce conta de perfil
   "profissional": promover alguém a admin continua sendo exclusividade do
   módulo Usuários do Sistema, que só o admin abre. */
async function salvarAcessoProfissional(profId, b, quemPerfil) {
  const login = String(b.acesso_login || "").trim().toLowerCase();
  const senha = String(b.acesso_senha || "");
  const jaTem = await Q.get("SELECT * FROM g_usuarios WHERE profissional_id=?", profId);
  const prof = await Q.get("SELECT nome,ativo FROM profissionais WHERE id=?", profId);
  if (!prof) return null;
  const ativo = Number(prof.ativo) === 0 ? 0 : 1;   // bloquear o profissional bloqueia o login

  if (!login) {                                     // sem login informado: só espelha o bloqueio
    if (jaTem && jaTem.ativo !== ativo) {
      await Q.run("UPDATE g_usuarios SET ativo=? WHERE id=?", ativo, jaTem.id);
      if (!ativo) derrubarSessoesDoUsuario(jaTem.id);
    }
    return null;
  }
  /* Login não pode colidir com outro usuário.

     `IS DISTINCT FROM` e não `IS NOT` / `<>`:
     · o `IS NOT ?` que estava aqui é sintaxe do SQLite — lá ele compara com
       QUALQUER valor tratando NULL como um valor comum. No Postgres, `IS NOT`
       só aceita NULL/TRUE/FALSE, e com um parâmetro dá erro de sintaxe.
     · trocar por `<>` seria PIOR que errado: em SQL, `NULL <> 5` não é
       verdadeiro, é NULO — então um usuário sem profissional vinculado
       (profissional_id NULL) escaparia da checagem e dois logins iguais
       passariam.
     `IS DISTINCT FROM` é o operador que compara tratando NULL como valor,
     que é exatamente o que o SQLite fazia. */
  const colide = await Q.get("SELECT id FROM g_usuarios WHERE email=? AND profissional_id IS DISTINCT FROM ?", login, profId);
  if (colide && (!jaTem || colide.id !== jaTem.id)) return "Este login já está em uso por outro usuário.";

  if (jaTem) {
    await Q.run("UPDATE g_usuarios SET nome=?, email=?, ativo=? WHERE id=?", prof.nome, login, ativo, jaTem.id);
    if (senha) {
      if (senha.length < 8) return "A senha do profissional precisa ter ao menos 8 caracteres.";
      await Q.run("UPDATE g_usuarios SET senha_hash=? WHERE id=?", hashSenha(senha), jaTem.id);
    }
    if (!ativo) derrubarSessoesDoUsuario(jaTem.id);
  } else {
    if (!senha) return "Defina uma senha para o acesso do profissional.";
    if (senha.length < 8) return "A senha do profissional precisa ter ao menos 8 caracteres.";
    await Q.run("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,criado) VALUES(?,?,?,'profissional',?,?,?)", prof.nome, login, hashSenha(senha), ativo, profId, agora());
  }
  return null;
}
function derrubarSessoesDoUsuario(userId) {
  for (const [k, v] of sessoes) if (v.userId === userId) sessoes.delete(k);
}
/* Junta ao profissional o login dele (nunca a senha) para a tela mostrar
   se ele já tem acesso e qual é o usuário. */
async function anexarAcesso(prof) {
  const u = await Q.get("SELECT email, ativo FROM g_usuarios WHERE profissional_id=?", prof.id);
  prof.acesso_login = u ? u.email : "";
  prof.acesso_ativo = u ? u.ativo : null;
  return prof;
}

// As colunas reais de cada tabela (COLS) são lidas do information_schema
// dentro de iniciarRestrito(). Servem para o CRUD só gravar o que existe — e
// para saber se a tabela tem "criado" antes de carimbá-lo.

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

/* ==========================================================================
   DUMP SQL DA GESTÃO (pg_dump) — usado pelo botão "Backup do banco"

   Sai em texto puro, comprimido em gzip pelo próprio Node quando o navegador
   aceita — um dump de prontuários é quase todo texto e encolhe muito.

   O arquivo NÃO é gravado em disco no caminho do site: ele é transmitido
   direto para quem pediu. Gravar num diretório servido pelo servidor web seria
   deixar o prontuário da clínica inteira a um palpite de URL de distância.
   ========================================================================== */
function dumpSql(res, sessaoAdmin) {
  const { spawn } = require("node:child_process");
  const cfg = configPg();
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
  const nome = `bemestar-gestao-${carimbo}.sql`;

  /* --no-owner / --no-privileges: o dump precisa restaurar em QUALQUER
     servidor, inclusive num de teste onde o usuário "bemestar" não existe.
     Sem isso, o restore falharia em cada GRANT e cada OWNER TO. */
  const args = ["--no-owner", "--no-privileges", "--clean", "--if-exists",
    "-h", cfg.host || "127.0.0.1", "-p", String(cfg.port || 5432),
    "-U", cfg.user, "-d", cfg.database];

  const pg_dump = process.env.PG_DUMP || "pg_dump";
  const filho = spawn(pg_dump, args, {
    env: { ...process.env, PGPASSWORD: cfg.password || "" },
    windowsHide: true,
  });

  let cabecalhoEnviado = false;
  const enviarCabecalho = () => {
    if (cabecalhoEnviado) return;
    cabecalhoEnviado = true;
    res.writeHead(200, {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
  };

  let erro = "";
  filho.stderr.on("data", (d) => { erro += d.toString(); });

  /* O cabeçalho só vai quando o primeiro byte de dump chega. Assim, se o
     pg_dump falhar de cara (binário ausente, senha errada), ainda dá tempo de
     responder um JSON de erro em vez de entregar um arquivo vazio com nome
     bonito — que o usuário guardaria achando que tem backup. */
  filho.stdout.on("data", (bloco) => { enviarCabecalho(); res.write(bloco); });

  filho.on("error", (e) => {
    console.error("  ✖ pg_dump não executou:", e.message);
    if (!cabecalhoEnviado) json(res, 500, {
      error: e.code === "ENOENT"
        ? "O pg_dump não está instalado neste servidor (pacote postgresql-client)."
        : "Não consegui gerar o backup.",
    });
    else res.end();
  });

  filho.on("close", (codigo) => {
    if (codigo === 0) {
      console.log(`  · /restrito: backup SQL baixado por ${sessaoAdmin.nome} (${nome})`);
      enviarCabecalho();
      return res.end();
    }
    console.error(`  ✖ pg_dump saiu com código ${codigo}: ${erro.trim().slice(0, 400)}`);
    if (!cabecalhoEnviado) return json(res, 500, { error: "Não consegui gerar o backup. Veja o log do servidor." });
    /* Já mandamos bytes: não dá para trocar o status. Encerrar de forma abrupta
       é o que faz o navegador marcar o download como FALHOU — melhor um
       download quebrado e visível do que um .sql pela metade que parece bom. */
    res.destroy();
  });
}

/* ------------------------------- API ------------------------------------- */
async function rotaApi(req, res, p) {
  const ip = clientIp(req);

  // login
  if (p === "login" && req.method === "POST") {
    if (bloqueado(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde 15 minutos." });
    const { usuario, senha } = await readBody(req);
    const u = await Q.get("SELECT * FROM g_usuarios WHERE email=? AND ativo=1", String(usuario || "").trim());
    /* Se o usuário não existe, ainda assim gastamos o mesmo tempo de um scrypt.
       Sem isto, "usuário inexistente" responde em ~1ms e "usuário certo, senha
       errada" em ~100ms — diferença que permite descobrir logins válidos por
       cronômetro antes de atacar a senha. */
    const ok = u ? confereSenha(senha, u.senha_hash) : (confereSenha(senha, HASH_ISCA), false);
    if (!ok) {
      erroLogin(ip);
      /* A tentativa SEM SUCESSO é a linha mais importante desta trilha: é ela
         que revela alguém tentando entrar. Guardamos o login digitado — não a
         senha, nunca, nem parte dela. */
      auditar({ req, sessao: null, acao: "login_falhou",
        resumo: `Tentativa de entrar como "${String(usuario || "").slice(0, 60)}"`,
        detalhe: { usuario_informado: String(usuario || "").slice(0, 60), existe: !!u } });
      return json(res, 401, { error: "Usuário ou senha incorretos." });
    }
    tentativas.delete(ip);
    const rid = novaSessao(u);
    res.setHeader("Set-Cookie", `rid=${rid}; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=${SESSAO_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    auditar({ req, sessao: { userId: u.id, nome: u.nome, perfil: u.perfil }, acao: "login",
      resumo: `${u.nome} entrou no sistema` });
    return json(res, 200, { ok: true, nome: u.nome, perfil: u.perfil });
  }

  // daqui para baixo exige sessão
  const s = sessao(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });

  /* ==========================================================================
     BACKUP DO BANCO — baixa o dump SQL completo da gestão

     Só o ADMIN. Este arquivo contém a clínica inteira: CPF, endereço, anamnese
     e prontuário de todo mundo. É o dado mais sensível que existe aqui, e sai
     do servidor pelo navegador de quem clicou.

     O dump sai do próprio pg_dump, no formato SQL de texto — o mesmo que o
     `psql` restaura. Não inventamos formato: um backup que só o nosso código
     sabe ler não é backup.

     Segurança do processo: o pg_dump é chamado por spawn com os argumentos em
     ARRAY e sem shell. Nada do que o usuário digita entra na linha de comando
     (não há o que digitar — a rota não recebe parâmetro), e a senha vai por
     variável de ambiente, nunca por argumento (argumento aparece no `ps` para
     qualquer usuário da máquina).
     ========================================================================== */
  if (p === "backup/sql" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Só o administrador pode baixar o backup." });
    auditar({ req, sessao: s, acao: "backup", resumo: `${s.nome} baixou o backup completo do banco` });
    return dumpSql(res, s);
  }

  /* ==========================================================================
     SOBRE O SISTEMA — versão, histórico, tecnologias e banco ativo

     Só o admin. Não por sigilo (nada aqui é segredo), mas porque a tela
     descreve a INFRAESTRUTURA: versão do banco, do Node, nome da base. Para a
     recepção e o profissional isso é ruído; para quem sonda o sistema, é mapa.

     O banco é consultado AO VIVO, e não escrito à mão numa constante: assim a
     tela responde "qual banco está rodando" com o que está de fato conectado
     naquele instante, não com o que alguém supôs ao escrever o texto.
     ========================================================================== */
  /* ==========================================================================
     AUDITORIA — a trilha completa, só para o administrador

     ESTA É A ÚNICA LISTA DO SISTEMA QUE PAGINA NO SERVIDOR. Todas as outras
     devolvem tudo e deixam a tela fatiar, porque são listas de tamanho humano:
     pacientes, procedimentos, salas. A auditoria não — ela ganha uma linha a
     cada ação de cada pessoa, todos os dias, para sempre. Em um ano são
     centenas de milhares. Mandar isso inteiro para o navegador travaria a tela
     e carregaria dado sensível à toa para a memória do cliente.
     ========================================================================== */
  if (p === "auditoria" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "A auditoria é exclusiva do administrador." });
    const q = new URL(req.url, "http://x").searchParams;

    const cond = [], args = [];
    const soData = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    let de = soData(q.get("de")), ate = soData(q.get("ate"));
    if (de && ate && de > ate) { const t = de; de = ate; ate = t; }   // datas invertidas
    if (de) { cond.push("substr(criado,1,10) >= ?"); args.push(de); }
    if (ate) { cond.push("substr(criado,1,10) <= ?"); args.push(ate); }

    const uid = (q.get("usuario") || "").trim();
    if (/^\d+$/.test(uid)) { cond.push("usuario_id=?"); args.push(Number(uid)); }
    const acao = (q.get("acao") || "").trim();
    if (acao && ACOES_ROTULO[acao]) { cond.push("acao=?"); args.push(acao); }
    const mod = (q.get("modulo") || "").trim();
    if (mod && /^[a-z_]+$/.test(mod)) { cond.push("modulo=?"); args.push(mod); }

    const onde = cond.length ? " WHERE " + cond.join(" AND ") : "";
    const total = (await Q.get(`SELECT COUNT(*) c FROM auditoria${onde}`, ...args)).c;

    const porPagina = Math.min(Math.max(Number(q.get("por")) || 30, 5), 200);
    const pagina = Math.max(Number(q.get("pagina")) || 1, 1);
    const linhas = await Q.all(
      `SELECT * FROM auditoria${onde} ORDER BY criado DESC, id DESC LIMIT ? OFFSET ?`,
      ...args, porPagina, (pagina - 1) * porPagina);

    /* O `detalhe` (o JSON pesado do antes/depois) NÃO vai na listagem — só o
       resumo. A tela busca o detalhe de uma linha só quando o usuário clica.
       Assim a tabela é leve e o dado sensível não trafega sem necessidade. */
    for (const l of linhas) { l.tem_detalhe = !!(l.detalhe && l.detalhe.length > 2); delete l.detalhe; }

    return json(res, 200, {
      total, pagina, porPagina,
      paginas: Math.max(Math.ceil(total / porPagina), 1),
      linhas,
      rotulos: ACOES_ROTULO,
      modulos: MODULO_ROTULO,
      /* Quem já apareceu na trilha — alimenta o filtro por pessoa sem precisar
         listar usuários excluídos ou que nunca usaram o sistema. */
      usuarios: await Q.all(`SELECT DISTINCT usuario_id id, usuario_nome nome FROM auditoria
                              WHERE usuario_id IS NOT NULL ORDER BY usuario_nome`),
    });
  }

  const audm = p.match(/^auditoria\/(\d+)$/);
  if (audm && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "A auditoria é exclusiva do administrador." });
    const linha = await Q.get("SELECT * FROM auditoria WHERE id=?", audm[1]);
    if (!linha) return json(res, 404, { error: "Registro não encontrado." });
    let detalhe = null;
    try { detalhe = linha.detalhe ? JSON.parse(linha.detalhe) : null; } catch { detalhe = { texto: linha.detalhe }; }
    return json(res, 200, { ...linha, detalhe, rotulo: ACOES_ROTULO[linha.acao] || linha.acao, modulo_rotulo: rotuloModulo(linha.modulo) });
  }

  if (p === "sobre" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Tela exclusiva do administrador." });

    let banco = { motor: "PostgreSQL", conectado: false };
    try {
      const v = await Q.get(`SELECT version() v, current_database() d, current_user u,
                                    pg_size_pretty(pg_database_size(current_database())) tam`);
      /* version() devolve uma linha longa ("PostgreSQL 16.4 on x86_64-pc-linux-gnu,
         compiled by gcc..."). Para a tela basta o número. */
      const num = /PostgreSQL\s+([\d.]+)/.exec(v.v);
      const m = await Q.all("SELECT versao FROM schema_migrations ORDER BY versao");
      banco = {
        motor: "PostgreSQL",
        versao: num ? num[1] : "",
        base: v.d,
        usuario: v.u,
        tamanho: v.tam,
        migrations: m.length,
        ultimaMigration: m.length ? m[m.length - 1].versao : "",
        conectado: true,
      };
    } catch (e) {
      banco.erro = e.message.split("\n")[0];
    }

    return json(res, 200, {
      sistema: "Sistema de Gestão — BemEstarClinic",
      versao: SISTEMA_VERSION,
      historico: HISTORICO_VERSOES,
      tecnologias: TECNOLOGIAS,
      banco,
    });
  }

  /* Quem está logado. Devolve também o PROFISSIONAL vinculado (id e nome como
     está no cadastro) — é com ele que a tela pré-preenche "Profissional
     responsável" na anamnese. O nome do login pode ser diferente do nome no
     cadastro de profissionais, por isso vai o do cadastro. */
  if (p === "me") {
    let profissional_nome = "";
    if (s.profissionalId) {
      const pf = await Q.get("SELECT nome FROM profissionais WHERE id=?", s.profissionalId);
      if (pf) profissional_nome = pf.nome;
    }
    return json(res, 200, { nome: s.nome, perfil: s.perfil, profissional_id: s.profissionalId || null, profissional_nome });
  }

  if (p === "logout" && req.method === "POST") {
    sessoes.delete(s.rid);
    const cookies = ["rid=; HttpOnly; Path=/restrito; Max-Age=0"];

    /* Sair do sistema de gestão SAI TAMBÉM do painel do site.

       Quem entrou no /admin pelo atalho de 9 pontos não digitou senha nenhuma
       — a porta foi aberta pela credencial daqui. Se essa credencial for
       embora e a outra ficar, o computador da recepção fica com o painel do
       site destrancado depois que a pessoa "saiu". Numa clínica, onde o mesmo
       computador atende o balcão o dia inteiro, é o cenário provável, não o
       raro.

       Encerra só a sessão DESTE navegador (a do cookie que veio na
       requisição), e não todas: derrubar as demais tiraria do ar quem estivesse
       trabalhando no painel de outra máquina, sem nenhum aviso. */
    let saiuDoPainel = false;
    if (typeof encerrarPainelDoSite === "function") {
      const fora = encerrarPainelDoSite(req);
      if (fora) { saiuDoPainel = true; cookies.push("sid=; HttpOnly; Path=/; Max-Age=0"); }
    }

    auditar({ req, sessao: s, acao: "logout",
      resumo: `${s.nome} saiu do sistema${saiuDoPainel ? " (e do painel do site)" : ""}` });
    res.setHeader("Set-Cookie", cookies);
    return json(res, 200, { ok: true, painelEncerrado: saiuDoPainel });
  }

  if (p === "senha" && req.method === "POST") {
    const { atual, nova } = await readBody(req);
    const u = await Q.get("SELECT * FROM g_usuarios WHERE id=?", s.userId);
    if (!confereSenha(atual, u.senha_hash)) return json(res, 400, { error: "Senha atual incorreta." });
    if (String(nova || "").length < 8) return json(res, 400, { error: "A nova senha precisa de ao menos 8 caracteres." });
    await Q.run("UPDATE g_usuarios SET senha_hash=? WHERE id=?", hashSenha(nova), s.userId);
    // a senha em si NUNCA entra na trilha, nem cifrada
    auditar({ req, sessao: s, acao: "senha", resumo: `${s.nome} trocou a própria senha` });
    for (const [k, v] of sessoes) if (v.userId === s.userId && k !== s.rid) sessoes.delete(k);
    return json(res, 200, { ok: true });
  }

  // painel: números para a home do sistema. O profissional não vê números
  // globais (só a sua agenda e prontuários) — devolve os dele.
  if (p === "painel") {
    const n = async (sql, ...args) => (await Q.get(sql, ...args)).c;
    const hoje = new Date().toISOString().slice(0, 10);
    if (s.perfil === "profissional") {
      return json(res, 200, { profissional: true,
        agendaHoje: await n("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=? AND data=?", s.profissionalId, hoje),
        agendaTotal: await n("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?", s.profissionalId),
        prontuarios: await n("SELECT COUNT(*) c FROM prontuario WHERE usuario_id=?", s.userId) });
    }
    return json(res, 200, {
      pacientes: await n("SELECT COUNT(*) c FROM pacientes"),
      atendimentosHoje: await n("SELECT COUNT(*) c FROM atendimentos WHERE data=?", hoje),
      confirmadosHoje: await n("SELECT COUNT(*) c FROM atendimentos WHERE data=? AND status IN ('Confirmado','Atendido')", hoje),
      anamneses: await n("SELECT COUNT(*) c FROM anamneses"),
      prontuarios: await n("SELECT COUNT(*) c FROM prontuario"),
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
    const grupo = (sql) => Q.all(sql);
    const n = async (sql) => (await Q.get(sql)).c;
    return json(res, 200, {
      periodo: { de, ate },
      totais: {
        pacientes: await n("SELECT COUNT(*) c FROM pacientes" + onde("criado")),
        atendimentos: await n("SELECT COUNT(*) c FROM atendimentos" + onde("data")),
        atendidos: await n("SELECT COUNT(*) c FROM atendimentos WHERE status='Atendido'" + e("data")),
        faltas: await n("SELECT COUNT(*) c FROM atendimentos WHERE status='Faltou'" + e("data")),
        anamneses: await n("SELECT COUNT(*) c FROM anamneses" + onde("data")),
        prontuarios: await n("SELECT COUNT(*) c FROM prontuario" + onde("aberto_em")),
      },
      porProcedimento: await grupo(`SELECT COALESCE(NULLIF(pr.nome,''),'(sem procedimento)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porProfissional: await grupo(`SELECT COALESCE(NULLIF(pf.nome,''),'(sem profissional)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN profissionais pf ON pf.id=a.profissional_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porConvenio: await grupo(`SELECT COALESCE(NULLIF(c.nome,''),'(sem convênio)') rotulo, COUNT(*) total
        FROM atendimentos a LEFT JOIN convenios c ON c.id=a.convenio_id${onde("data", "a")} GROUP BY rotulo ORDER BY total DESC`),
      porStatus: await grupo("SELECT COALESCE(NULLIF(status,''),'(sem status)') rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY total DESC"),
      porMes: await grupo("SELECT substr(data,1,7) rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY rotulo DESC LIMIT 12"),
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
    const pacs = await Q.all(`SELECT * FROM pacientes${cond} ORDER BY nome`);

    const SQL_PASTAS = "SELECT numero, especialidade, profissional, status FROM prontuario WHERE paciente_id=? ORDER BY status, especialidade";
    const SQL_PROFS = `SELECT DISTINCT pf.nome FROM atendimentos a JOIN profissionais pf ON pf.id=a.profissional_id
                        WHERE a.paciente_id=? AND pf.nome<>''`;
    const SQL_PROCS = `SELECT DISTINCT COALESCE(NULLIF(pr.nome,''), a.especialidade) nome FROM atendimentos a
                        LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
                        WHERE a.paciente_id=? AND COALESCE(NULLIF(pr.nome,''), a.especialidade) IS NOT NULL`;
    const juntar = (lista) => [...new Set(lista.filter((x) => x && String(x).trim()))].sort();
    /* O convênio de um paciente repete muito na relação inteira; buscar uma vez
       por paciente seria uma ida ao banco por linha à toa. */
    const convenios = new Map((await Q.all("SELECT id, nome FROM convenios")).map((c) => [Number(c.id), c.nome]));

    for (const pc of pacs) {
      const pastas = await Q.all(SQL_PASTAS, pc.id);
      pc.prontuarios = pastas;
      pc.especialidades = juntar([...pastas.map((x) => x.especialidade), ...(await Q.all(SQL_PROCS, pc.id)).map((x) => x.nome)]);
      pc.profissionais = juntar([...pastas.map((x) => x.profissional), ...(await Q.all(SQL_PROFS, pc.id)).map((x) => x.nome)]);
      pc.convenio_nome = pc.convenio_id ? (convenios.get(Number(pc.convenio_id)) || "") : "";
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
    if (req.method === "GET" && !id) return json(res, 200, await Q.all("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios ORDER BY id"));
    if (req.method === "GET" && id) return json(res, 200, await Q.get("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios WHERE id=?", id) || {});
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      const nome = String(b.nome || "").trim(), email = String(b.email || "").trim(), perfil = String(b.perfil || "secretaria").trim();
      if (!nome || !email) return json(res, 400, { error: "Nome e usuário (login) são obrigatórios." });
      if (!PERFIS.includes(perfil)) return json(res, 400, { error: "Perfil inválido." });
      if (String(b.senha || "").length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." });
      const profId = perfil === "profissional" && b.profissional_id ? Number(b.profissional_id) : null;
      try {
        await Q.run("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,criado) VALUES(?,?,?,?,?,?,?)", nome, email, hashSenha(b.senha), perfil, b.ativo === undefined ? 1 : (Number(b.ativo) ? 1 : 0), profId, agora());
      } catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao criar usuário." }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && id) {
      const b = await readBody(req);
      const alvo = await Q.get("SELECT perfil,ativo FROM g_usuarios WHERE id=?", id);
      if (!alvo) return json(res, 404, { error: "Usuário não encontrado." });
      // não deixar o único admin ativo se rebaixar a si mesmo ou desativar
      const viraNaoAdmin = b.perfil !== undefined && b.perfil !== "admin";
      const viraInativo = b.ativo !== undefined && !Number(b.ativo);
      if (alvo.perfil === "admin" && alvo.ativo && (viraNaoAdmin || viraInativo) && await adminsAtivos() <= 1)
        return json(res, 400, { error: "Não é possível rebaixar ou desativar o único administrador." });
      const sets = [], args = [];
      if (b.nome !== undefined) { sets.push("nome=?"); args.push(String(b.nome).trim()); }
      if (b.email !== undefined) { sets.push("email=?"); args.push(String(b.email).trim()); }
      if (b.perfil !== undefined) { if (!PERFIS.includes(b.perfil)) return json(res, 400, { error: "Perfil inválido." }); sets.push("perfil=?"); args.push(b.perfil); }
      if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); }
      if (b.profissional_id !== undefined) { sets.push("profissional_id=?"); args.push(b.profissional_id ? Number(b.profissional_id) : null); }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." }); sets.push("senha_hash=?"); args.push(hashSenha(b.senha)); }
      if (sets.length) {
        try { await Q.run(`UPDATE g_usuarios SET ${sets.join(",")} WHERE id=?`, ...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao salvar." }); }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = await Q.get("SELECT perfil,ativo FROM g_usuarios WHERE id=?", id);
      if (alvo && alvo.perfil === "admin" && alvo.ativo && await adminsAtivos() <= 1) return json(res, 400, { error: "Não é possível excluir o único administrador." });
      await Q.run("DELETE FROM g_usuarios WHERE id=?", id);
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
    const paciente = await Q.get("SELECT * FROM pacientes WHERE id=?", pid);
    if (!paciente) return json(res, 404, { error: "Paciente não encontrado." });
    const conv = paciente.convenio_id ? await Q.get("SELECT nome FROM convenios WHERE id=?", paciente.convenio_id) : null;
    // o profissional só vê os lançamentos que ele mesmo escreveu
    const sóMeus = s.perfil === "profissional" ? " AND r.usuario_id=" + Number(s.userId) : "";
    // as pastas do paciente e, dentro de cada uma, os lançamentos em ordem
    const pastas = await Q.all("SELECT * FROM prontuario WHERE paciente_id=? ORDER BY status, especialidade, id", pid);
    for (const pasta of pastas) {
      pasta.registros = await Q.all(`SELECT r.* FROM prontuario_registros r WHERE r.prontuario_id=?${sóMeus}
         ORDER BY COALESCE(NULLIF(r.data,''),r.criado), r.id`, pasta.id);
      // os vínculos da pasta, para sair na tela e na impressão
      pasta.anamneses = await Q.all("SELECT id,tipo,procedimento,status,data,profissional,finalizada_em FROM anamneses WHERE prontuario_id=? ORDER BY COALESCE(NULLIF(data,''),criado), id", pasta.id);
      pasta.atendimentos = await Q.all(`SELECT a.id,a.data,a.hora,a.hora_fim,a.status,a.valor, pr.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome
           FROM atendimentos a
           LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
           LEFT JOIN salas sa ON sa.id=a.sala_id
          WHERE a.prontuario_id=? ORDER BY a.data, a.hora, a.id`, pasta.id);
    }
    return json(res, 200, {
      paciente: { ...paciente, convenio_nome: conv ? conv.nome : "" },
      prontuarios: pastas,
      historico: await Q.all("SELECT * FROM historico WHERE entidade='paciente' AND entidade_id=? ORDER BY criado, id", pid),
      anamneses: await Q.all("SELECT * FROM anamneses WHERE paciente_id=? ORDER BY COALESCE(NULLIF(data,''),criado), id", pid),
      atendimentos: await Q.all(`SELECT a.*, pr.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome, cv.nome convenio_nome
        FROM atendimentos a
        LEFT JOIN procedimentos pr ON pr.id=a.procedimento_id
        LEFT JOIN profissionais pf ON pf.id=a.profissional_id
        LEFT JOIN salas sa ON sa.id=a.sala_id
        LEFT JOIN convenios cv ON cv.id=a.convenio_id
        WHERE a.paciente_id=? ORDER BY a.data, a.hora, a.id`, pid),
    });
  }

  /* ---------------- Alta e reabertura do prontuário --------------------
     A alta é DO PRONTUÁRIO: o paciente pode receber alta da ozonioterapia e
     seguir na psicanálise. Nada é apagado — muda o status e fica no histórico. */
  const am = p.match(/^prontuario\/(\d+)\/(alta|reabrir)$/);
  if (am && req.method === "POST") {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const id = am[1], acao = am[2];
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", id);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    const b = await readBody(req);
    if (acao === "alta") {
      const quando = b.data || new Date().toISOString().slice(0, 10);
      await Q.run("UPDATE prontuario SET status='Alta', alta_em=?, alta_motivo=? WHERE id=?", quando, b.motivo || "", id);
      await anotar("prontuario", id, "Alta", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      auditar({ req, sessao: s, acao: "alta", modulo: "prontuario", entidadeId: Number(id),
        resumo: `Deu alta no prontuário ${pr.numero || ""} · ${pr.especialidade}`,
        detalhe: { numero: pr.numero, especialidade: pr.especialidade, motivo: b.motivo || "" } });
      await anotar("paciente", pr.paciente_id, "Alta em " + pr.especialidade, pr.numero || "", s);
    } else {
      // reabrir: o paciente voltou. Data de reativação atualizada, histórico intacto.
      const quando = agora();
      await Q.run("UPDATE prontuario SET status='Ativo', alta_em=NULL, alta_motivo=NULL, reativado_em=? WHERE id=?", quando, id);
      await Q.run("UPDATE pacientes SET reativado_em=? WHERE id=?", quando, pr.paciente_id);
      await anotar("prontuario", id, "Prontuário reaberto", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      auditar({ req, sessao: s, acao: "reabrir", modulo: "prontuario", entidadeId: Number(id),
        resumo: `Reabriu o prontuário ${pr.numero || ""} · ${pr.especialidade}`,
        detalhe: { numero: pr.numero, especialidade: pr.especialidade, motivo: b.motivo || "" } });
      await anotar("paciente", pr.paciente_id, "Retornou ao tratamento", pr.especialidade, s);
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
    const pac = await Q.get("SELECT id,nome,codigo FROM pacientes WHERE id=?", id);
    if (!pac) return json(res, 404, { error: "Paciente não encontrado." });
    const b = await readBody(req);
    if (inativar) {
      const abertos = await conta("SELECT COUNT(*) c FROM prontuario WHERE paciente_id=? AND status<>'Alta'", id);
      await Q.run("UPDATE pacientes SET ativo=0, inativo_em=?, inativo_motivo=? WHERE id=?", agora(), b.motivo || "", id);
      await anotar("paciente", id, "Paciente inativado", b.motivo || "", s);
      auditar({ req, sessao: s, acao: "inativar", modulo: "pacientes", entidadeId: Number(id),
        resumo: `Inativou o paciente ${pac.nome || ""} (${pac.codigo || ""})`,
        detalhe: { motivo: b.motivo || "", prontuarios_em_tratamento: abertos } });
      /* Avisa se ficou tratamento em aberto — não impede (a pessoa pode
         simplesmente ter parado de vir), mas quem inativa precisa saber. */
      return json(res, 200, { ok: true, prontuariosAbertos: abertos });
    }
    await Q.run("UPDATE pacientes SET ativo=1, inativo_em=NULL, inativo_motivo=NULL, reativado_em=? WHERE id=?", agora(), id);
    await anotar("paciente", id, "Paciente reativado", b.motivo || "", s);
    auditar({ req, sessao: s, acao: "reativar", modulo: "pacientes", entidadeId: Number(id),
      resumo: `Reativou o paciente ${pac.nome || ""} (${pac.codigo || ""})`, detalhe: { motivo: b.motivo || "" } });
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
    const an = await Q.get("SELECT * FROM anamneses WHERE id=?", id);
    if (!an) return json(res, 404, { error: "Anamnese não encontrada." });
    const b = await readBody(req);
    const procedimento = String(b.procedimento || an.procedimento || "").trim();
    if (!an.paciente_id) return json(res, 400, { error: "Anamnese sem paciente." });
    if (!procedimento) return json(res, 400, { error: "Escolha o procedimento antes de finalizar — é ele que define de qual prontuário esta anamnese faz parte." });

    let pasta = await prontuarioDoPar(an.paciente_id, procedimento);
    let criada = false;
    if (!pasta) {
      const prof = an.profissional || (s.perfil === "profissional" ? s.nome : "");
      /* Q.inserir (e não Q.run) porque o id novo é preciso na hora. No SQLite
         vinha de lastInsertRowid; no Postgres só existe com RETURNING, que o
         Q.inserir acrescenta. */
      const novoId = await Q.inserir("INSERT INTO prontuario(paciente_id,especialidade,profissional,status,aberto_em,usuario_id,criado) VALUES(?,?,?,'Ativo',?,?,?)", an.paciente_id, procedimento, prof, (an.data || new Date().toISOString().slice(0, 10)), s.userId, agora());
      const numero = await emitirNumeroProntuario(novoId);
      pasta = { id: novoId, numero, especialidade: procedimento, status: "Ativo" };
      criada = true;
      await anotar("prontuario", novoId, "Prontuário aberto pela anamnese", `${numero} · ${procedimento}`, s);
      await anotar("paciente", an.paciente_id, "Prontuário aberto", `${numero} · ${procedimento}`, s);
    }
    await Q.run("UPDATE anamneses SET status='Finalizada', finalizada_em=?, prontuario_id=?, procedimento=?, atualizado=? WHERE id=?", agora(), pasta.id, procedimento, agora(), id);
    const recolhidos = await recolherAtendimentosSoltos(pasta.id, an.paciente_id, procedimento);
    await anotar("prontuario", pasta.id, "Anamnese finalizada", rotuloModelo(an.tipo) + (recolhidos ? ` · ${recolhidos} agendamento(s) vinculado(s)` : ""), s);
    await anotar("paciente", an.paciente_id, "Anamnese finalizada", `${rotuloModelo(an.tipo)} · ${pasta.numero}`, s);
    return json(res, 200, { ok: true, prontuario: pasta, criada, atendimentosVinculados: recolhidos });
  }

  /* Reabrir a anamnese para correção. O prontuário criado NÃO é desfeito: ele
     já pode ter lançamentos e agendamentos pendurados. */
  const rvm = p.match(/^anamneses\/(\d+)\/reabrir$/);
  if (rvm && req.method === "POST") {
    if (!pode(s.perfil, "anamneses")) return json(res, 403, { error: "Sem permissão." });
    const an = await Q.get("SELECT * FROM anamneses WHERE id=?", rvm[1]);
    if (!an) return json(res, 404, { error: "Anamnese não encontrada." });
    await Q.run("UPDATE anamneses SET status='Rascunho', atualizado=? WHERE id=?", agora(), rvm[1]);
    if (an.prontuario_id) await anotar("prontuario", an.prontuario_id, "Anamnese reaberta para correção", rotuloModelo(an.tipo), s);
    return json(res, 200, { ok: true });
  }

  /* ---- Vincular / desvincular um agendamento à pasta, pela tela do prontuário
     É o caminho para o PRIMEIRO atendimento, marcado antes de a pasta existir,
     e para corrigir um vínculo à mão. -------------------------------------- */
  const vm = p.match(/^prontuario\/(\d+)\/atendimentos\/(\d+)$/);
  if (vm && (req.method === "POST" || req.method === "DELETE")) {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", vm[1]);
    const at = await Q.get("SELECT * FROM atendimentos WHERE id=?", vm[2]);
    if (!pr || !at) return json(res, 404, { error: "Prontuário ou agendamento não encontrado." });
    if (req.method === "POST") {
      // a pasta é do paciente: não se pendura o atendimento de outra pessoa
      if (String(at.paciente_id) !== String(pr.paciente_id))
        return json(res, 400, { error: "Este agendamento é de outro paciente." });
      await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", pr.id, at.id);
      await anotar("prontuario", pr.id, "Agendamento vinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    } else {
      await Q.run("UPDATE atendimentos SET prontuario_id=NULL WHERE id=?", at.id);
      await anotar("prontuario", pr.id, "Agendamento desvinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    }
    return json(res, 200, { ok: true });
  }

  /* Agendamentos do paciente que ainda não estão em pasta nenhuma — é a lista
     que a tela do prontuário oferece para vincular. */
  const dm = p.match(/^prontuario\/(\d+)\/disponiveis$/);
  if (dm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", dm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    return json(res, 200, await Q.all(`SELECT a.*, p.nome procedimento_nome, pf.nome profissional_nome
         FROM atendimentos a
         LEFT JOIN procedimentos p ON p.id = a.procedimento_id
         LEFT JOIN profissionais pf ON pf.id = a.profissional_id
        WHERE a.paciente_id = ? AND a.prontuario_id IS NULL
        ORDER BY a.data DESC, a.hora DESC, a.id DESC`, pr.paciente_id));
  }

  /* -------- Arquivar / restaurar lançamento (nunca excluir) ------------- */
  const rm = p.match(/^prontuario_registros\/(\d+)\/(arquivar|restaurar)$/);
  if (rm && req.method === "POST") {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const id = rm[1], arq = rm[2] === "arquivar";
    const reg = await Q.get("SELECT * FROM prontuario_registros WHERE id=?", id);
    if (!reg) return json(res, 404, { error: "Lançamento não encontrado." });
    if (s.perfil === "profissional" && String(reg.usuario_id) !== String(s.userId))
      return json(res, 403, { error: "Lançamento de outro profissional." });
    await Q.run("UPDATE prontuario_registros SET arquivado=?, arquivado_em=? WHERE id=?", arq ? 1 : 0, arq ? agora() : null, id);
    await anotar("prontuario", reg.prontuario_id, (arq ? "Lançamento arquivado: " : "Lançamento restaurado: ") + rotuloTipo(reg.tipo), "", s);
    return json(res, 200, { ok: true });
  }

  /* --------- Linha do tempo de um paciente ou de um prontuário ---------- */
  const hm2 = p.match(/^historico\/(paciente|prontuario)\/(\d+)$/);
  if (hm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    return json(res, 200, await Q.all("SELECT * FROM historico WHERE entidade=? AND entidade_id=? ORDER BY criado DESC, id DESC", hm2[1], hm2[2]));
  }

  /* ------- Prontuários de um paciente, com a contagem dos seus vínculos ---
     As contagens alimentam os "chips" que aparecem na anamnese, no agendamento
     e no prontuário — é assim que a tela mostra a que a pasta está ligada. */
  const pm2 = p.match(/^pacientes\/(\d+)\/prontuarios$/);
  if (pm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    return json(res, 200, await Q.all(`SELECT pr.*,
        (SELECT COUNT(*) FROM prontuario_registros r WHERE r.prontuario_id=pr.id AND r.arquivado=0) lancamentos,
        (SELECT COUNT(*) FROM anamneses an WHERE an.prontuario_id=pr.id) anamneses,
        (SELECT COUNT(*) FROM atendimentos at WHERE at.prontuario_id=pr.id) atendimentos
      FROM prontuario pr WHERE pr.paciente_id=? ORDER BY pr.status, pr.especialidade`, pm2[1]));
  }

  /* ------- O que está pendurado numa pasta (tela do prontuário) --------- */
  const vlm = p.match(/^prontuario\/(\d+)\/vinculos$/);
  if (vlm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", vlm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    return json(res, 200, {
      prontuario: pr,
      anamneses: await Q.all("SELECT id,tipo,procedimento,status,data,profissional,finalizada_em FROM anamneses WHERE prontuario_id=? ORDER BY COALESCE(NULLIF(data,''),criado) DESC, id DESC", pr.id),
      atendimentos: await Q.all(`SELECT a.*, pr2.nome procedimento_nome, pf.nome profissional_nome, sa.nome sala_nome
           FROM atendimentos a
           LEFT JOIN procedimentos pr2 ON pr2.id=a.procedimento_id
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
           LEFT JOIN salas sa ON sa.id=a.sala_id
          WHERE a.prontuario_id=? ORDER BY a.data DESC, a.hora DESC, a.id DESC`, pr.id),
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

    // abrir uma tela é uma listagem: registra "fulano abriu Pacientes"
    if (req.method === "GET" && !id) registrarAcesso(req, s, tabela);

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
      /* ====================================================================
         BUSCA POR CPF DEPOIS DA CRIPTOGRAFIA

         Antes, o CPF era comparado no SQL (`cpf LIKE ?`, com e sem máscara).
         Isso deixou de funcionar: cada CPF é gravado cifrado com um vetor
         aleatório próprio, então o mesmo número tem texto diferente em cada
         linha — não há o que comparar no banco.

         A busca por CPF passou a acontecer na APLICAÇÃO, depois de decifrar.
         Isso preserva o comportamento exato que a recepção já conhece,
         inclusive a busca por PARTE do número (o que uma "impressão digital"
         de igualdade não permitiria). É viável porque estas listas já eram
         devolvidas inteiras — quem pagina é a tela, não o SQL.

         O nome e o código continuam filtrados no banco, que é onde estão os
         volumes. Só o recorte por CPF sobe para cá.
         ==================================================================== */
      const digitos = soDigitos(busca);
      const buscaPorDigitos = digitos.length >= 3;   // com 1 dígito, qualquer CPF casa
      let filtrarCpfNaMemoria = false;
      let idsPorCpf = null;

      if (busca && tabela === "pacientes") {
        /* Sem condição de CPF no SQL: as linhas cujo ÚNICO casamento fosse o
           CPF seriam descartadas aqui e nunca chegariam ao filtro em memória.
           Por isso a busca de paciente é resolvida inteira na aplicação. */
        filtrarCpfNaMemoria = true;
      }
      else if (busca && tabela === "prontuario") {
        /* Aqui dá para manter o SQL fazendo o trabalho: primeiro descobrimos
           QUAIS pacientes casam (nome, código ou CPF), o que é uma lista curta,
           e só então filtramos as pastas por esses ids. */
        const todos = await Q.all("SELECT id, nome, codigo, cpf FROM pacientes");
        const alvo = busca.toLowerCase();
        idsPorCpf = todos.filter((p) =>
          String(p.nome || "").toLowerCase().includes(alvo) ||
          String(p.codigo || "").toLowerCase().includes(alvo) ||
          String(p.cpf || "").toLowerCase().includes(alvo) ||
          (buscaPorDigitos && soDigitos(p.cpf).includes(digitos))
        ).map((p) => Number(p.id));

        const ors = ["numero LIKE ?", "especialidade LIKE ?", "profissional LIKE ?"];
        for (let i = 0; i < 3; i++) args.push("%" + busca + "%");
        if (idsPorCpf.length) {
          ors.push(`paciente_id IN (${idsPorCpf.map(() => "?").join(",")})`);
          args.push(...idsPorCpf);
        }
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
      let linhas = await Q.all(sql, ...args);

      /* Recorte por nome / código / CPF do paciente, agora que as linhas já
         voltaram decifradas. Mesmas regras de antes: casa em qualquer parte do
         texto, ignora maiúsculas, e o CPF casa com ou sem máscara nos dois
         lados (compara só os dígitos). */
      if (filtrarCpfNaMemoria) {
        const alvo = busca.toLowerCase();
        linhas = linhas.filter((p) =>
          String(p.nome || "").toLowerCase().includes(alvo) ||
          String(p.codigo || "").toLowerCase().includes(alvo) ||
          String(p.cpf || "").toLowerCase().includes(alvo) ||
          (buscaPorDigitos && soDigitos(p.cpf).includes(digitos))
        );
      }

      /* Promise.all e não forEach: `forEach` ignora o valor devolvido pelo
         callback, então com uma função assíncrona ele dispara todas e segue em
         frente sem esperar nenhuma — a resposta sairia antes de os logins serem
         anexados, e a coluna chegaria vazia na tela sem erro nenhum. */
      if (tabela === "profissionais") await Promise.all(linhas.map(anexarAcesso));
      return json(res, 200, linhas);
    }
    if (req.method === "GET" && id) {
      const row = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id);
      if (!row) return json(res, 404, { error: "Registro não encontrado." });
      if (donoCol && String(row[donoCol]) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." });
      if (tabela === "profissionais") await anexarAcesso(row);
      // a tela avisa quando o registro tem histórico e por isso não pode ser excluído
      if (["profissionais", "pacientes", "procedimentos", "convenios", "salas", "prontuario"].includes(tabela))
        row._vinculos = await vinculosDe(tabela, id);
      /* A pasta a que esta anamnese pertence, RESOLVIDA no servidor. É por ela
         que a tela decide mostrar ou não o Excluir — não pelo campo
         prontuario_id, que pode ter sobrado apontando para pasta apagada, nem
         pelo cache do navegador, que a recepção nem carrega. */
      if (tabela === "anamneses") {
        row._prontuario = row.prontuario_id
          ? await Q.get("SELECT id,numero,especialidade,status FROM prontuario WHERE id=?", row.prontuario_id) || null
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
        const e0 = await pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        if (!b.especialidade) return json(res, 400, { error: "Selecione o procedimento deste prontuário." });
        const ja = await Q.get("SELECT numero FROM prontuario WHERE paciente_id=? AND especialidade=?", b.paciente_id, b.especialidade);
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
        const e0 = await pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        const e = await validarAgenda(b.profissional_id, b.data, b.hora, null, b.hora_fim, b.sala_id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "anamneses") {
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o paciente." });
        const e0 = await pacienteInativo(b.paciente_id);
        if (e0) return json(res, 400, { error: e0 });
        if (!MODELOS_ANAMNESE[b.tipo]) return json(res, 400, { error: "Tipo de anamnese inválido." });
        if (typeof b.dados !== "string") b.dados = JSON.stringify(b.dados || {});
      }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      /* Cópia em texto claro ANTES de cifrar — é o que a auditoria registra.
         Depois de proteger(), `b` carrega texto cifrado, e a trilha guardaria
         um monte de "enc:1:..." em vez do que foi realmente cadastrado. */
      limparHtmlDoRegistro(tabela, b);     // HTML do prontuário sai higienizado
      const comoVeio = {}; for (const c of use) comoVeio[c] = b[c];
      /* Cifra os campos sensíveis logo antes de montar os valores. Feito aqui,
         no CRUD, porque é por onde passam TODAS as gravações de paciente,
         anamnese, prontuário e agenda. */
      proteger(tabela, b);
      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? use.concat("criado") : use;
      const valores = temCriado ? use.map((c) => b[c]).concat(agora()) : use.map((c) => b[c]);
      const novoId = await Q.inserir(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`, ...valores);
      auditar({ req, sessao: s, acao: "criar", modulo: tabela, entidadeId: novoId,
        resumo: `Cadastrou em ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, comoVeio)}`,
        detalhe: { campos: comoVeio } });
      // toda pasta de prontuário nasce com o seu número de controle
      if (tabela === "prontuario") {
        const numero = await emitirNumeroProntuario(novoId);
        await anotar("prontuario", novoId, "Prontuário aberto", `${numero} · ${b.especialidade}`, s);
        await anotar("paciente", b.paciente_id, "Prontuário aberto", `${numero} · ${b.especialidade}`, s);
        return json(res, 200, { ok: true, id: novoId, numero });
      }
      if (tabela === "prontuario_registros") {
        const pr = await Q.get("SELECT paciente_id,numero FROM prontuario WHERE id=?", b.prontuario_id) || {};
        await anotar("prontuario", b.prontuario_id, "Lançamento: " + rotuloTipo(b.tipo), (b.texto || "").slice(0, 120), s);
        if (pr.paciente_id) await anotar("paciente", pr.paciente_id, "Lançamento no prontuário " + (pr.numero || ""), rotuloTipo(b.tipo), s);
      }
      // todo paciente nasce com o seu código próprio, gerado aqui
      if (tabela === "pacientes") {
        const codigo = await emitirCodigoPaciente(novoId);
        await anotar("paciente", novoId, "Cadastro criado", `${codigo} · ${b.nome || ""}`, s);
        return json(res, 200, { ok: true, id: novoId, codigo });
      }
      // o agendamento se pendura na pasta do procedimento, se ela já existir
      if (tabela === "atendimentos") {
        const pasta = await sincronizarProntuarioDoAtendimento(novoId);
        return json(res, 200, { ok: true, id: novoId, prontuario: pasta || null });
      }
      // cadastrar profissional já cria o acesso dele ao sistema
      if (tabela === "profissionais") {
        const e = await salvarAcessoProfissional(novoId, b, s.perfil);
        if (e) return json(res, 200, { ok: true, id: novoId, aviso: e });
      }
      return json(res, 200, { ok: true, id: novoId });
    }
    if (req.method === "PUT" && id) {
      if (donoCol) { const dono = await Q.get(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`, id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      const b = await readBody(req);
      delete b.usuario_id;                                            // não se troca o dono por aqui
      if (donoCol === "profissional_id") delete b.profissional_id;    // o profissional não reatribui o atendimento
      // guardado ANTES do update: é como sabemos se o procedimento mudou nesta
      // edição — e só nesse caso o vínculo com o prontuário é refeito
      let antesAtend = null;
      if (tabela === "atendimentos") {
        antesAtend = await Q.get("SELECT profissional_id,data,hora,hora_fim,sala_id,procedimento_id,especialidade FROM atendimentos WHERE id=?", id) || {};
        if ("paciente_id" in b && !b.paciente_id) return json(res, 400, { error: "Selecione o paciente. Só é possível agendar para paciente cadastrado." });
        const e = await validarAgenda(b.profissional_id ?? antesAtend.profissional_id, b.data ?? antesAtend.data, b.hora ?? antesAtend.hora, id,
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
        antesReg = await Q.get("SELECT prontuario_id,tipo,texto,data,profissional FROM prontuario_registros WHERE id=?", id) || null;

      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      /* Estado ANTES da edição, já decifrado (o Q devolve em claro). É a metade
         de trás do que a auditoria vai mostrar no modal: de X para Y. */
      const antesTudo = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id) || {};
      limparHtmlDoRegistro(tabela, b);     // HTML do prontuário sai higienizado
      const comoVeio = {}; for (const c of use) comoVeio[c] = b[c];

      proteger(tabela, b);          // mesma cifragem do INSERT
      if (use.length) await Q.run(`UPDATE ${tabela} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`, ...use.map((c) => b[c]), id);

      const mudou = diferencas(antesTudo, comoVeio, tabela);
      const nomesMudados = Object.keys(mudou);
      /* Salvar sem mexer em nada não vira linha na auditoria — senão a trilha
         encheria de "alterou" toda vez que alguém abrisse e fechasse a ficha. */
      if (nomesMudados.length) {
        auditar({ req, sessao: s, acao: "editar", modulo: tabela, entidadeId: Number(id),
          resumo: `Alterou em ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, antesTudo)} — ${nomesMudados.length} campo(s): ${nomesMudados.slice(0, 4).join(", ")}${nomesMudados.length > 4 ? "…" : ""}`,
          detalhe: { alteracoes: mudou } });
      }
      if (tabela === "anamneses" && COLS.anamneses.has("atualizado")) await Q.run("UPDATE anamneses SET atualizado=? WHERE id=?", agora(), id);

      if (antesReg) {
        const depois = await Q.get("SELECT texto,data,profissional FROM prontuario_registros WHERE id=?", id) || {};
        const mudancas = [];
        const t = trechoAlterado(antesReg.texto, depois.texto);
        if (t) mudancas.push(t);
        if (String(antesReg.data || "") !== String(depois.data || ""))
          mudancas.push(`data ${antesReg.data || "—"} → ${depois.data || "—"}`);
        if (String(antesReg.profissional || "") !== String(depois.profissional || ""))
          mudancas.push(`profissional ${antesReg.profissional || "—"} → ${depois.profissional || "—"}`);
        if (mudancas.length) {
          await Q.run("UPDATE prontuario_registros SET atualizado=? WHERE id=?", agora(), id);
          const rot = "Lançamento atualizado: " + rotuloTipo(antesReg.tipo);
          await anotar("prontuario", antesReg.prontuario_id, rot, mudancas.join(" · "), s);
          const pr = await Q.get("SELECT paciente_id,numero FROM prontuario WHERE id=?", antesReg.prontuario_id) || {};
          if (pr.paciente_id) await anotar("paciente", pr.paciente_id, rot + (pr.numero ? " (" + pr.numero + ")" : ""), mudancas.join(" · "), s);
        }
      }
      if (tabela === "atendimentos") {
        const pasta = await sincronizarProntuarioDoAtendimento(id, antesAtend);
        return json(res, 200, { ok: true, prontuario: pasta || null });
      }
      // editar profissional também mantém o acesso dele em dia (login/senha/bloqueio)
      if (tabela === "profissionais") {
        const e = await salvarAcessoProfissional(id, b, s.perfil);
        if (e) return json(res, 200, { ok: true, aviso: e });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (donoCol) { const dono = await Q.get(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`, id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      /* Cadastro com histórico não se apaga — bloqueia-se. Apagar deixaria a
         agenda antiga sem profissional e o prontuário impresso sem procedimento. */
      if (["profissionais", "pacientes", "procedimentos", "convenios", "salas", "prontuario"].includes(tabela)) {
        const v = await vinculosDe(tabela, id);
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
        const an = await Q.get("SELECT prontuario_id FROM anamneses WHERE id=?", id);
        /* O que barra é o prontuário EXISTIR — não o campo estar preenchido.
           Um id apontando para pasta apagada é lixo, não vínculo, e não pode
           deixar a anamnese impossível de excluir. */
        const pr = an && an.prontuario_id
          ? await Q.get("SELECT numero, especialidade FROM prontuario WHERE id=?", an.prontuario_id) : null;
        if (pr) {
          return json(res, 409, { error: `Não dá para excluir: esta anamnese está vinculada ao prontuário ${pr.numero || ""}`
            + `${pr.especialidade ? " (" + pr.especialidade + ")" : ""} e faz parte do registro clínico dele.` });
        }
        // vínculo morto: solta antes de apagar, para não deixar rastro estranho
        if (an && an.prontuario_id) await Q.run("UPDATE anamneses SET prontuario_id=NULL WHERE id=?", id);
      }
      // profissional sem histórico: o acesso dele vai junto
      if (tabela === "profissionais") await Q.run("DELETE FROM g_usuarios WHERE profissional_id=?", id);

      /* Apagar a pasta SOLTA o que estava arquivado nela, sem destruir nada:
         a anamnese volta a ser rascunho (e aí sim pode ser excluída ou
         refinalizada no procedimento certo) e o agendamento volta a ficar sem
         prontuário, seguindo normalmente na agenda. É o caminho de volta de
         quem finalizou a anamnese errada. */
      let soltos = null;
      if (tabela === "prontuario") {
        const pr = await Q.get("SELECT numero, paciente_id, especialidade FROM prontuario WHERE id=?", id) || {};
        const nAn = (await Q.run("UPDATE anamneses SET prontuario_id=NULL, status='Rascunho', finalizada_em=NULL WHERE prontuario_id=?", id)).changes;
        const nAt = (await Q.run("UPDATE atendimentos SET prontuario_id=NULL WHERE prontuario_id=?", id)).changes;
        soltos = { anamneses: nAn, atendimentos: nAt };
        if (pr.paciente_id) {
          const det = [nAn ? `${nAn} anamnese(s) voltaram a rascunho` : "", nAt ? `${nAt} agendamento(s) sem prontuário` : ""]
            .filter(Boolean).join(" · ");
          await anotar("paciente", pr.paciente_id, `Prontuário excluído${pr.numero ? " " + pr.numero : ""}`,
            [pr.especialidade, det].filter(Boolean).join(" — "), s);
        }
      }
      /* Lê o registro INTEIRO antes de apagar. Numa exclusão, a auditoria é a
         única coisa que sobra: se ninguém guardar o que havia ali, não há como
         responder depois "o que foi apagado?". */
      const apagado = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id) || {};
      await Q.run(`DELETE FROM ${tabela} WHERE id=?`, id);
      auditar({ req, sessao: s, acao: "excluir", modulo: tabela, entidadeId: Number(id),
        resumo: `Excluiu de ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, apagado)}`,
        detalhe: { registro_excluido: apagado, soltos: soltos || undefined } });
      return json(res, 200, soltos ? { ok: true, soltos } : { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}


module.exports = { handleRestrito, iniciarRestrito, SISTEMA_VERSION, CAMPOS_PROTEGIDOS, sessao, auditar, registrarEncerrarPainel };
