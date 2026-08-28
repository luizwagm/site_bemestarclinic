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
/* As perguntas dos 13 rastreios. Arquivo próprio, e não uma constante aqui
   dentro: são 36 KB de enunciado que ninguém precisa rolar para chegar às
   rotas — e o MODELOS_ANAMNESE logo abaixo já mostra o quanto isso incomoda. */
const { MODELOS_TESTE } = require("./testes-modelos");
/* O desafio é o teste que a clínica escreve na hora: mesmo envio, mesmo link,
   mesmas telas — só que as perguntas nascem de um texto colado, e não deste
   repositório. Ver desafios.js. */
const { interpretarDesafio, modeloDoDesafio } = require("./desafios");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
/* Versão do sistema de gestão da clínica (/restrito).
   REGRA DO CLIENTE: feature nova sobe a 2ª casa (1.12.0, 1.13.0, 1.14.0…);
   correção de bug sobe a 3ª (1.14.1, 1.14.2…). A primeira casa NÃO muda —
   houve um deslize em que subi para 2.x e o cliente corrigiu; a numeração
   voltou para a série 1.x, que é a que ele acompanha. */
const SISTEMA_VERSION = "1.41.0";

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
  { versao: "1.41.0", data: "2026-08-26", titulo: "Ver o teste ou desafio antes de o paciente responder", mudancas: [
    "Visualizar agora mostra as perguntas, as orientações e o texto do desafio mesmo sem resposta",
    "Antes só aparecia a frase \"ainda sem respostas\" — quem acabou de escrever um desafio não conseguia reler o que enviou",
    "Com a resposta, tudo continua igual: o que muda é só a linha da resposta em cada pergunta",
  ] },
  { versao: "1.40.0", data: "2026-08-24", titulo: "Arquivar saiu da tela (o recurso continua guardado)", mudancas: [
    "Os botões de arquivar e restaurar saíram de pacientes, prontuários e lançamentos",
    "O item Arquivados saiu do menu da conta",
    "Nada foi removido do sistema — a clínica optou por não usar; religar é uma chave",
  ] },
  { versao: "1.39.0", data: "2026-08-23", titulo: "Reunião por vídeo no chat da equipe", mudancas: [
    "O chat ganhou chamada de vídeo e reunião de equipe, de dentro da conversa",
    "O /restrito libera câmera, microfone e partilha de tela para o chat (o site público segue fechado)",
    "Link curto de reunião para convidados (bemestarclinic.com/call/código)",
  ] },
  { versao: "1.38.0", data: "2026-08-20", titulo: "Novo desafio já vem no modelo padrão da clínica", mudancas: [
    "A caixa do novo desafio abre preenchida: título DESAFIO DA SEMANA, mensagem de boas-vindas oficial e as perguntas 1-, 2-, 3- para completar",
    "Tudo pode ser alterado — e colar um desafio escrito do zero continua funcionando como antes",
    "As linhas numeradas com traço sob o cabeçalho DESAFIO viram perguntas mesmo sem interrogação",
    "O título e a mensagem de boas-vindas escritos no texto já chegam preenchidos na tela de conferência",
  ] },
  { versao: "1.37.0", data: "2026-08-18", titulo: "Resultado do teste sem o card de pontuação", mudancas: [
    "O resultado do teste deixou de mostrar o card com a soma dos pontos",
    "A soma também saiu da impressão — a leitura dos testes é clínica, não numérica",
  ] },
  { versao: "1.36.0", data: "2026-08-17", titulo: "Uma conversa por pessoa no chat", mudancas: [
    "Remover e recriar o usuário de um profissional não parte mais a conversa em duas",
    "O chat passou a reconhecer a pessoa pelo profissional, e não pela conta de acesso",
    "As conversas que já tinham se partido são juntadas por ferramenta, com relatório antes",
  ] },
  { versao: "1.35.0", data: "2026-08-17", titulo: "Foto no cadastro e o aviso sonoro do chat", mudancas: [
    "O cadastro de usuário aceita foto de perfil, com prévia redonda",
    "A foto aparece no chat da equipe: na lista de pessoas e nas conversas",
    "Trocar a foto apaga a anterior do servidor, sem deixar arquivo solto",
    "Cada pessoa troca a própria foto; o administrador troca a de qualquer um",
    "A foto é recortada em círculo e reduzida no servidor, sem os metadados",
    "O aviso de mensagem nova passou a ser o toque escolhido pela clínica, mais alto",
  ] },
  /* ATENÇÃO — o histórico salta de 1.29.0 para 1.35.0.
     As versões 1.30 a 1.34 (chat da equipe, elenco vivo e os desafios por
     paciente) foram entregues sem entrada aqui. A tela "Sobre o sistema" mostra
     a versão certa, mas não conta ao cliente o que mudou justamente nas
     novidades que ele mais percebe. Preencher essas cinco linhas é uma
     pendência conhecida, não um esquecimento novo. */
  { versao: "1.29.0", data: "2026-08-14", titulo: "Testes de rastreio enviados ao paciente", mudancas: [
    "13 questionários de rastreio prontos, em Cadastros → Testes",
    "Nova tela Enviar testes, abaixo de Prontuário",
    "O paciente responde por um link próprio, no celular, sem senha",
    "Situação de cada teste: criado, enviado, aberto, vencido e concluído",
    "Envio pelo WhatsApp com a mensagem já escrita",
    "Bloco Testes e desafios dentro da pasta do prontuário",
    "Respostas guardadas cifradas e impressas no papel timbrado",
    "O sistema avisa que está iniciando em vez de dar erro nos primeiros segundos",
    "A lista de testes se atualiza sozinha quando o paciente abre ou responde",
  ] },
  { versao: "1.28.0", data: "2026-08-09", titulo: "Arquivar paciente e prontuário", mudancas: [
    "Arquivar tira o paciente da lista sem apagar nada",
    "Arquivar tira o prontuário da tela, com o tratamento inteiro guardado",
    "Nova tela Arquivados, no menu da conta, com uma aba para cada área",
    "Restaurar devolve o registro à lista de origem com um clique",
    "Arquivar NÃO é inativar nem dar alta: essas duas continuam à vista",
    "Quem arquivou e quando ficam registrados na linha do tempo",
  ] },
  { versao: "1.27.1", data: "2026-08-09", titulo: "Campo de número em branco", mudancas: [
    "Salvar com um campo de número vazio deixa de dar erro interno",
    "O campo em branco vira “não informado”, ou volta ao valor padrão",
    "Campo obrigatório em branco passa a dizer QUAL falta, em vez de erro",
    "Vale para as 32 colunas numéricas de todos os cadastros e da agenda",
  ] },
  { versao: "1.26.0", data: "2026-07-28", titulo: "Prontuário e anamnese só do profissional", mudancas: [
    "O profissional passa a ver apenas os prontuários e as anamneses dele",
    "Vale em todas as telas, no prontuário completo impresso e no histórico",
    "Dar alta, reabrir e finalizar só na própria pasta",
    "Administrador e secretaria seguem com o acesso de antes",
  ] },
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
  /* As respostas do rastreio são sintoma relatado — ansiedade, humor, ideação —
     de alguém cujo nome e CPF estão no mesmo banco. Mesmo peso da anamnese.
     `avaliacao` é o que o TERAPEUTA concluiu a partir delas, o que é ainda
     mais sensível. As mensagens de boas-vindas e de agradecimento entram
     porque são escritas à mão e costumam chamar o paciente pelo nome. */
  /* `rascunho` entra com o mesmo peso de `respostas`: é o mesmo conteúdo, só
     que ainda sendo escrito ao longo da semana. */
  teste_envios: ["respostas", "rascunho", "avaliacao", "msg_boas_vindas", "msg_agradecimento"],
  /* O DESAFIO é escrito para UMA pessoa e diz do que ela sofre: "TDAH —
     observar o que acontece antes de deixar para depois" é diagnóstico em
     texto puro para quem abrir um dump. O `nome` fica legível porque é como a
     clínica acha o desafio na lista; o corpo inteiro, não. */
  testes: ["estrutura"],
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
   O QUE O PROFISSIONAL PODE VER

   REGRA DA CLÍNICA: o profissional vê APENAS os prontuários e as anamneses
   dele. Nunca, em nenhuma tela, os de outro profissional.

   Antes desta versão o recorte era mais frouxo: a PASTA do prontuário era
   visível a todos (só os lançamentos eram privados) e a anamnese era visível a
   todos os profissionais. A clínica reviu isso.

   TODA decisão de "isto é dele?" passa por aqui — e não espalhada por dezenas
   de consultas. São oito caminhos que entregam prontuário ou anamnese (lista,
   registro, histórico do paciente, vínculos, atendimentos disponíveis, chips
   da pasta, prontuário completo impresso e relatórios). Se cada um tivesse a
   sua própria versão da regra, bastaria um ficar para trás — e um vazamento de
   prontuário não avisa, não dá erro, e ninguém descobre até ser tarde.

   `admin` e `secretaria` não são afetados: a secretaria já não abre prontuário
   nem anamnese (barrado por PERM), e o admin vê tudo por função.
   ========================================================================== */
const soDoProfissional = (s) => s && s.perfil === "profissional";

/* Condição SQL. Quando não há profissional vinculado ao login, devolve algo
   que não casa com nada: sem vínculo não há como dizer o que é dele, e o lado
   seguro do erro é não mostrar nada. */
function filtroDono(s, coluna = "profissional_id") {
  if (!soDoProfissional(s)) return { sql: "", args: [] };
  if (!s.profissionalId) return { sql: ` AND 1=0`, args: [] };
  return { sql: ` AND ${coluna}=?`, args: [s.profissionalId] };
}

/* Guarda de UM registro já lido. Devolve a mensagem de recusa ou null. */
function recusaPorDono(s, registro) {
  if (!soDoProfissional(s)) return null;
  if (!registro) return null;                       // quem trata "não existe" é o chamador
  if (!s.profissionalId) return "Seu acesso não está vinculado a um profissional. Fale com o administrador.";
  if (String(registro.profissional_id || "") !== String(s.profissionalId))
    return "Este registro pertence a outro profissional.";
  return null;
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
  testes: "Testes", teste_envios: "Envio de testes",
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

/* ==========================================================================
   O /restrito SÓ ATENDE DEPOIS DE PRONTO

   `iniciarRestrito()` é assíncrono: aplica migrations, lê o
   `information_schema` para montar o COLS e semeia os cadastros. O servidor,
   porém, começa a escutar a porta ANTES de tudo isso terminar — e é o certo,
   senão o site inteiro ficaria fora do ar esperando a gestão subir.

   O problema aparecia na janela entre uma coisa e outra: um POST que chegasse
   ali encontrava `COLS` ainda vazio e morria em
   `COLS[tabela].has(...)` de `undefined` — HTTP 500, com uma mensagem que não
   diz nada sobre a causa. Raro no dia a dia e garantido em dois momentos: logo
   depois de um `systemctl restart`, e nas suítes, que sobem o servidor e
   disparam o primeiro pedido em seguida.

   A janela CRESCEU quando a versão 1.29.0 acrescentou uma migration e a
   semeadura de treze testes ao boot. Foi assim que ela deixou de ser teórica.

   Agora a resposta é 503 com `Retry-After`: "ainda não, tente já já" — que é a
   verdade, e é o que um cliente HTTP sabe tratar.
   ========================================================================== */
let restritoPronto = false;

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
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name=?`, t);
    COLS[t] = new Set(cols.map((c) => c.column_name));
    /* O TIPO de cada coluna, para decidir o destino do campo em branco — ver
       `prepararCampos`. Lido uma vez no boot, do próprio banco: uma lista
       escrita à mão aqui envelheceria na primeira migration. */
    TIPOS[t] = Object.fromEntries(cols.map((c) => [c.column_name,
      { tipo: c.data_type, nulavel: c.is_nullable === "YES", padrao: c.column_default != null }]));
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

  /* 8. o catálogo de testes, a partir dos modelos do arquivo.

     SEM TRAVA em g_config, ao contrário do passo 7 — e isso é a diferença que
     importa. Aquele é um UPDATE que a clínica pode desfazer editando; este é
     um INSERT de linha que ou existe ou não existe, e a chave é UNIQUE. Rodar
     de novo não repete nada, e um teste NOVO acrescentado ao arquivo JS entra
     sozinho no próximo boot. Com trava, ele nunca entraria.

     `nome` e `instrucoes` NÃO são atualizados quando a linha já existe: a
     clínica pode ter reescrito os dois pela tela, e o boot não pode desfazer
     isso toda vez que o serviço reinicia. */
  {
    let n = 0, i = 0;
    for (const m of MODELOS_TESTE) {
      const r = await Q.run(
        `INSERT INTO testes(chave, sigla, nome, instrucoes, ativo, sort, criado)
         VALUES(?,?,?,?,1,?,?) ON CONFLICT (chave) DO NOTHING`,
        m.chave, m.sigla, m.nome, m.instrucoes, (i += 10), AGORA_SEED);
      n += r.changes;
    }
    if (n) console.log(`  · /restrito: ${n} teste(s) de rastreio no catálogo.`);
  }

  /* ÚLTIMA LINHA, e tem de continuar sendo: a partir daqui o /restrito passa a
     responder. Qualquer passo novo entra ACIMA — abaixo, ele rodaria com a
     porta já aberta e o problema voltaria com outro nome. */
  restritoPronto = true;
}

/* ==========================================================================
   QUEM ESTÁ COM A TELA ABERTA

   Conexões SSE vivas. `avisar()` escreve o ASSUNTO em todas — nunca o dado.

   Escrever numa conexão já morta lança, e um `throw` aqui dentro derrubaria o
   aviso para os OUTROS ouvintes da lista. Por isso cada escrita é protegida e
   o ouvinte problemático sai da lista na hora.
   ========================================================================== */
const ouvintes = new Set();
function avisar(assunto) {
  for (const c of [...ouvintes]) {
    try { c.res.write(`event: ${assunto}\ndata: 1\n\n`); }
    catch { ouvintes.delete(c); }
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
/* FREIO CONTRA ADIVINHAÇÃO DE SENHA — ver limitador.js.

   Este login é MULTIUSUÁRIO, e é onde o balde por conta pesa mais: antes,
   contando só por IP, dava para martelar a conta de UMA pessoa a partir de
   vários endereços sem disparar nada. Agora as tentativas contra cada pessoa
   são somadas separadamente — e travar a conta de uma não atrapalha as
   outras. Aqui dentro há prontuário: é o login mais sensível dos três sites.

   Arquivo próprio, e não o do server.js: os dois módulos guardam o estado em
   memória e gravam tudo de uma vez, então dividir o mesmo arquivo faria um
   apagar o que o outro acabou de escrever. */
const { criarLimitador } = require("./limitador");
const limite = criarLimitador({ arquivo: path.join(ROOT, "data", "limites-restrito.json") });
limite.carregar();
process.on("exit", () => limite.gravar());
setInterval(() => limite.limpar(), 10 * 60_000).unref();


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
const agora = () => new Date().toISOString();

/* ==========================================================================
   TESTES DE RASTREIO — as peças que as rotas usam
   ========================================================================== */

/* Data de HOJE em AAAA-MM-DD, pelos componentes LOCAIS.
   `toISOString().slice(0,10)` converte para UTC antes de cortar: às 21h de
   Caruaru já é o dia seguinte em Greenwich, e um teste que expira "hoje"
   apareceria vencido durante a noite inteira de quem tenta responder. */
function hojeISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
}

/* O ALFABETO do código: 62 símbolos, como pedido (números, maiúsculas e
   minúsculas). Nada é removido para "evitar confusão" — 0/O e 1/l ficam,
   porque ninguém DIGITA este código: ele vai por link no WhatsApp. Tirar
   símbolos só encolheria o espaço de busca. */
const ALFABETO_CODIGO = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/* `crypto.randomInt` e não `Math.random()`: este código é a única barreira
   entre a internet e a resposta de um paciente identificado. `Math.random`
   é previsível a partir de saídas anteriores — quem recebesse dois links
   legítimos poderia derivar os próximos. */
function sortearCodigo() {
  const n = 8 + crypto.randomInt(4);          // 8 a 11 caracteres
  let c = "";
  for (let i = 0; i < n; i++) c += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
  return c;
}

/* Sorteia até achar um que ninguém tem. Colisão em 62^8 é remotíssima, mas
   "remoto" não é "impossível", e a coluna é UNIQUE: sem esta conferência a
   colisão viraria erro 500 na cara de quem estava criando o teste. */
async function codigoInedito() {
  for (let i = 0; i < 12; i++) {
    const c = sortearCodigo();
    if (!(await Q.get("SELECT id FROM teste_envios WHERE codigo=?", c))) return c;
  }
  throw new Error("não consegui gerar um código livre");
}

/* A SITUAÇÃO — calculada, nunca lida de coluna.
   "vencido" é o relógio andando, não alguém clicando. Como coluna, dependeria
   de uma rotina passando marcar linha, e no dia em que ela falhasse um teste
   vencido continuaria abrindo. Concluído vem ANTES de vencido de propósito:
   quem respondeu no prazo não vira "vencido" quando a data passa. */
function situacaoDoEnvio(e) {
  if (e.status === "concluido") return "concluido";
  if (e.expira_em && e.expira_em < hojeISO()) return "vencido";
  return e.status;                       // criado | enviado | aberto
}

/* ==========================================================================
   QUANDO O LINK ABRE — e por que a resposta é diferente para os dois

   RASTREIO: abre em `criado` e `enviado`, e fecha depois de aberto. É a regra
   do cliente, e faz sentido para um questionário respondido de uma sentada.

   DESAFIO: reabre enquanto não estiver CONCLUÍDO. Ele é feito ao longo da
   semana — escolhe a tarefa na segunda, anota a distração na terça, responde
   as três perguntas todo fim de dia. Fechar no primeiro acesso transformaria
   um exercício de sete dias num formulário para preencher de memória no
   domingo à noite, que é justamente o que o desafio combate.

   Vencido fecha os dois: o prazo é o prazo. E concluído fecha os dois — o
   marco de "terminei" é o que a clínica lê como fim do exercício.
   ========================================================================== */
function envioAbrivel(e, ehDesafio) {
  const sit = situacaoDoEnvio(e);
  if (ehDesafio) return ["criado", "enviado", "aberto"].includes(sit);
  return ["criado", "enviado"].includes(sit);
}

function contarPerguntas(m) {
  return m.secoes.reduce((a, s) => a + s.itens.length, 0) + m.abertas.length;
}

/* ==========================================================================
   O MODELO DE UM ENVIO — venha ele do código ou do banco

   Os 13 rastreios vivem em `testes-modelos.js`, porque pergunta de rastreio é
   estrutura. O DESAFIO vive no banco, porque é escrito para um paciente e uma
   semana — não há como estar no código.

   Esta função é a única que sabe dessa diferença. Do lado de fora, quem
   precisa do modelo pede o modelo: envio, link do paciente, prontuário e
   impressão continuam iguais, e é isso que faz o desafio herdar de graça
   tudo o que o rastreio já tinha.

   `linha` é a linha de `testes` quando quem chama já a leu — evita uma
   segunda consulta na tela que lista o catálogo inteiro.
   ========================================================================== */
async function modeloDe(chave, linha) {
  const m = MODELOS_TESTE.find((x) => x.chave === chave);
  if (m) return m;

  const t = linha || await Q.get(
    "SELECT chave, nome, instrucoes, tipo, estrutura FROM testes WHERE chave=?", chave);
  if (!t || t.tipo !== "desafio") return null;
  return modeloDoDesafio(t.chave, lerJson(t.estrutura), t.nome, t.instrucoes);
}

/* A soma máxima de um DESAFIO é zero, e o cálculo precisa dizer isso em vez
   de estourar: sem escala, `Math.max(...[])` é -Infinity, e `0 * -Infinity`
   é NaN — que atravessaria o JSON e apareceria na tela como "NaN pontos". */
function somaMaxima(m) {
  if (!m || !m.escala?.length) return 0;
  const itens = m.secoes.reduce((a, sc) => a + sc.itens.length, 0);
  return itens * Math.max(...m.escala.map((x) => x.v));
}

/* A CHAVE DE CADA PERGUNTA. Precisa ser estável entre o envio e a leitura, e
   não pode ser o texto (que a clínica pode corrigir depois, deixando a
   resposta órfã). Posição dentro do modelo: seção e índice. */
const chaveItem = (si, ii) => `s${si}_${ii}`;
const chaveAberta = (i) => `a${i}`;

/* Uma linha da lista. Não leva resposta nenhuma: a lista é vista por quem
   pode e por quem não pode ler conteúdo clínico. */
function resumoDoEnvio(l) {
  return {
    id: l.id, codigo: l.codigo,
    paciente_id: l.paciente_id, paciente_nome: l.paciente_nome,
    paciente_codigo: l.paciente_codigo, paciente_celular: l.paciente_celular,
    teste_chave: l.teste_chave, teste_nome: l.teste_nome || l.teste_chave,
    teste_sigla: l.teste_sigla || "",
    /* Rastreio ou desafio. Na pasta os dois aparecem juntos, e a diferença
       muda o que a pessoa espera: um foi respondido de uma vez, o outro está
       sendo preenchido ao longo da semana. */
    teste_tipo: l.teste_tipo || "teste",
    prontuario_id: l.prontuario_id, pasta_numero: l.pasta_numero || null,
    situacao: situacaoDoEnvio(l),
    expira_em: l.expira_em, criado: l.criado, enviado_em: l.enviado_em,
    aberto_em: l.aberto_em, concluido_em: l.concluido_em,
    /* As regras de botão saem do SERVIDOR, não da tela. Se cada uma decidisse
       por conta, a tela poderia oferecer "apagar" onde a rota recusa — e o
       usuário levaria um erro depois de já ter confirmado. */
    pode_apagar: !["concluido", "vencido"].includes(situacaoDoEnvio(l)),
    /* VENCIDO também não se envia: o link já não abre, e o paciente receberia
       uma mensagem da clínica que morre num "o prazo terminou". Para ele, o
       caminho é Recriar — que exige um prazo novo. */
    pode_enviar: !["concluido", "vencido"].includes(situacaoDoEnvio(l)),
    /* A tela precisa saber se o prazo já passou para pedir um novo ao recriar. */
    prazo_vencido: situacaoDoEnvio(l) === "vencido",
  };
}

/* O envio COM as perguntas e as respostas casadas, para a modal de
   visualização. Monta pergunta+resposta aqui, no servidor, porque é o mesmo
   par que vai para a impressão e para o prontuário: duas montagens seriam
   duas chances de o papel discordar da tela. */
async function envioCompleto(id) {
  const l = await Q.get(
    `SELECT e.*, pa.nome paciente_nome, pa.codigo paciente_codigo, pa.celular paciente_celular,
            pa.nascimento paciente_nascimento,
            t.nome teste_nome, t.sigla teste_sigla, t.instrucoes teste_instrucoes,
            pr.numero pasta_numero, u.nome criado_por_nome
       FROM teste_envios e
       JOIN pacientes pa ON pa.id = e.paciente_id
       LEFT JOIN testes t ON t.chave = e.teste_chave
       LEFT JOIN prontuario pr ON pr.id = e.prontuario_id
       LEFT JOIN g_usuarios u ON u.id = e.criado_por
      WHERE e.id=?`, id);
  if (!l) return null;

  const m = await modeloDe(l.teste_chave);
  const resp = lerJson(l.respostas);
  const base = resumoDoEnvio(l);

  const itens = [];
  let soma = 0, respondidas = 0;
  if (m) {
    m.secoes.forEach((sec, si) => sec.itens.forEach((texto, ii) => {
      const k = chaveItem(si, ii);
      const v = resp[k];
      const ponto = m.escala.find((x) => String(x.v) === String(v));
      if (ponto) { soma += Number(ponto.v); respondidas++; }
      itens.push({ chave: k, secao: sec.titulo || "", numero: itens.length + 1,
        pergunta: texto, resposta: ponto ? ponto.r : null, valor: ponto ? ponto.v : null });
    }));
    m.abertas.forEach((texto, i) => {
      const k = chaveAberta(i);
      const v = String(resp[k] || "").trim();
      if (v) respondidas++;
      /* Num DESAFIO os campos são o formulário inteiro; chamá-los de
         "Perguntas abertas" faria a leitura do prontuário sugerir que existe
         uma parte fechada que não veio. */
      itens.push({ chave: k, secao: m.tipo === "desafio" ? "" : "Perguntas abertas",
        numero: itens.length + 1,
        pergunta: texto, resposta: v || null, valor: null, aberta: true });
    });
  }

  return Object.assign(base, {
    teste_instrucoes: l.teste_instrucoes || (m ? m.instrucoes : ""),
    paciente_nascimento: l.paciente_nascimento, criado_por_nome: l.criado_por_nome || "",
    msg_boas_vindas: l.msg_boas_vindas || "", msg_agradecimento: l.msg_agradecimento || "",
    escala: m ? m.escala : [],
    blocos_terapeuta: m ? m.terapeuta : [],
    avaliacao: lerJson(l.avaliacao),
    itens,
    total_perguntas: m ? contarPerguntas(m) : 0,
    respondidas,
    /* SOMA BRUTA, e nada além dela. Nenhum destes treze documentos traz ponto
       de corte; inventar "acima de 40 é grave" seria criar critério clínico
       do nada e colocá-lo num papel assinado pela clínica. */
    soma_bruta: soma,
    soma_maxima: somaMaxima(m),
    tipo: m ? (m.tipo || "teste") : "teste",
    roteiro: m && m.roteiro ? m.roteiro : [],
  });
}

/* O campo vem CIFRADO do banco e a camada já o decifra na leitura; aqui só
   sobra o JSON. `{}` no lugar de estourar: um envio recém-criado tem
   `respostas` nulo, que é o caso comum, não uma anomalia. */
function lerJson(txt) {
  if (!txt) return {};
  try { const o = JSON.parse(txt); return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
}

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
/* ==========================================================================
   CAMPO DE NÚMERO DEIXADO EM BRANCO

   O navegador não sabe mandar `null`: campo numérico vazio chega como STRING
   VAZIA. O SQLite engolia calado (guardava `""` numa coluna INTEGER); o
   PostgreSQL recusa —

       invalid input syntax for type integer: ""

   — e o salvar devolve 500. Apareceu junto com a mudança de banco, e está em
   TODA tela cujo formulário tenha número opcional: são 32 colunas graváveis
   pelo formulário, em 8 módulos (agenda, ficha do paciente, convênio,
   procedimento, sala, prontuário, anamnese, documento).

   O tratamento fica AQUI, na beira do banco, e não em cada tela: tela se
   esquece, e a próxima coluna numérica que alguém acrescentar já nasceria com
   o mesmo defeito.

   TRÊS DESTINOS, E A ORDEM ENTRE ELES IMPORTA:

   1. coluna com valor PADRÃO  → SAI da instrução, e o padrão vale.
   2. coluna que aceita nulo   → NULL, que é o que "não informado" significa.
   3. obrigatória sem padrão   → 400 dizendo QUAL campo falta, nunca 500.

   O PADRÃO VEM ANTES DO NULO, e é a parte que erra fácil. `pacientes.ativo` é
   `INTEGER DEFAULT 1` e ACEITA NULO — as duas coisas. Testando o nulo
   primeiro, um `ativo` em branco viraria NULL; e como toda lista e todo
   seletor filtram `WHERE ativo=1`, o paciente sumiria do sistema inteiro sem
   nada avisar. O padrão existe justamente para dizer o que vale quando
   ninguém informou: é ele a resposta certa para a ausência.
   ========================================================================== */
const TIPO_NAO_TEXTO = /^(integer|bigint|smallint|numeric|real|double|boolean|date|timestamp|time)/i;
const TIPOS = {};

function destinoDoVazio(tabela, coluna) {
  const meta = TIPOS[tabela] && TIPOS[tabela][coluna];
  if (!meta || !TIPO_NAO_TEXTO.test(meta.tipo)) return "texto";   // em texto, "" é valor legítimo
  if (meta.padrao) return "omitir";
  if (meta.nulavel) return "nulo";
  return "obrigatorio";
}

/* Coluna → rótulo legível: a mensagem é para quem preenche o formulário, não
   para quem lê o banco. */
const rotuloColuna = (c) => String(c).replace(/_id$/, "").replace(/_/g, " ");

/* `atualizando` muda o que "omitir" significa, e a diferença é visível para
   quem usa:

   · No CADASTRO, deixar de citar a coluna faz o padrão valer. É o certo.
   · Na EDIÇÃO, deixar de citá-la faria o valor ANTIGO permanecer — a pessoa
     limpa a duração do procedimento, salva, e o número volta sozinho. Fica
     parecendo que o sistema ignorou o que ela fez, e da segunda vez ela
     desconfia de tudo o que salvou antes.

   Por isso, na edição, a coluna com padrão é escrita como `= DEFAULT`
   (instrução do próprio PostgreSQL): limpar o campo devolve o valor de
   fábrica, que é o mesmo resultado do cadastro. `literais` carrega essas
   colunas separadas porque elas entram na instrução SEM `?` — não há valor a
   enviar, quem resolve é o banco. */
function prepararCampos(tabela, colunas, b, atualizando) {
  const usar = [], valores = [], faltando = [], literais = [];
  for (const c of colunas) {
    if (b[c] !== "") { usar.push(c); valores.push(b[c]); continue; }
    switch (destinoDoVazio(tabela, c)) {
      case "omitir":
        if (atualizando) literais.push(c);         // volta ao valor de fábrica
        break;                                     // no cadastro, o padrão vale sozinho
      case "nulo": usar.push(c); valores.push(null); break;
      case "obrigatorio": faltando.push(rotuloColuna(c)); break;
      default: usar.push(c); valores.push(b[c]);
    }
  }
  return { usar, valores, faltando, literais };
}

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
  /* "profissional_id" entra porque é o DONO do registro — é por ele que o
     recorte do perfil profissional funciona. O servidor o preenche a partir do
     nome escolhido (ou do próprio profissional logado); não é campo de tela. */
  prontuario: ["paciente_id", "especialidade", "profissional", "profissional_id", "aberto_em", "observacao", "usuario_id"],
  prontuario_registros: ["prontuario_id", "tipo", "texto", "data", "profissional", "anexo", "usuario_id"],
  // "status"/"finalizada_em"/"prontuario_id" são do fluxo de finalizar, no servidor
  anamneses: ["paciente_id", "tipo", "dados", "procedimento", "profissional", "profissional_id", "data", "usuario_id"],
  documentos_gestao: ["paciente_id", "tipo", "titulo", "arquivo", "data"],
  /* Catálogo: a clínica edita nome, instrução, situação e ordem. As PERGUNTAS
     não estão aqui nem no banco — vivem em `testes-modelos.js`. */
  testes: ["nome", "instrucoes", "ativo", "sort"],
  /* `teste_envios` NÃO tem entrada nesta lista de propósito. Código, situação,
     datas e respostas são todos do SERVIDOR: se o CRUD genérico pudesse gravá-
     los, um PUT com `{status:"concluido"}` daria por respondido um teste que
     ninguém abriu. Todo envio passa por rota própria, mais abaixo. */
};

/* ==========================================================================
   O QUE PODE SER ARQUIVADO

   Arquivar é decisão de ORGANIZAÇÃO da tela: "tire isto da minha frente". Não
   diz que a pessoa deixou a clínica (para isso existe `ativo`) nem que o
   tratamento terminou (para isso existe `status = Alta`). Some da lista,
   continua no banco, volta num clique.

   As três tabelas usam a MESMA dupla de colunas (`arquivado` 0/1 e
   `arquivado_em`), o mesmo parâmetro de consulta e a mesma rota — foi o que
   permitiu que `prontuario_registros`, que já arquivava, entrasse nesta lista
   sem mudar de comportamento.
   ========================================================================== */
const TEM_ARQUIVO = new Set(["pacientes", "prontuario", "prontuario_registros"]);

const UPLOAD_DIR = path.join(ROOT, "restrito", "arquivos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* O tratamento de imagem é OPCIONAL (o `sharp` é módulo nativo e pode não
   instalar no servidor). O módulo já cuida disso sozinho — sem ele, a foto de
   perfil é recusada com mensagem, em vez de o processo cair. */
const IMG = require("./imagem");

/* ==========================================================================
   APAGAR A FOTO ANTIGA DO DISCO

   Chamada depois de trocar ou remover a foto de um usuário. Três travas, e
   nenhuma é paranoia: o caminho vem de uma COLUNA do banco, e coluna de texto
   é exatamente o lugar onde um valor estranho sobrevive a uma migração mal
   feita ou a uma restauração de backup antigo.

     · só apaga o que está sob `/restrito/arquivos/`;
     · resolve o caminho e confere que continua DENTRO da pasta (um `..` no
       nome não escapa);
     · nunca apaga o arquivo que acabou de entrar (`novo`), para o caso de a
       tela mandar duas vezes o mesmo caminho.

   Falha em silêncio de propósito: um arquivo que já não existe não pode
   impedir alguém de trocar a própria foto.
   ========================================================================== */
function apagarFotoAntiga(caminho, novo) {
  try {
    const c = String(caminho || "");
    if (!c || c === novo) return;
    if (!/^\/restrito\/arquivos\/[A-Za-z0-9._-]+$/.test(c)) return;
    const alvo = path.resolve(UPLOAD_DIR, path.basename(c));
    if (!alvo.startsWith(path.resolve(UPLOAD_DIR))) return;
    fs.unlinkSync(alvo);
  } catch { /* já não estava lá */ }
}

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
  /* A secretaria ENVIA teste e acompanha a situação — é trabalho de recepção,
     como marcar consulta. O que ela NÃO faz é abrir a resposta: o conteúdo é
     do mesmo nível da anamnese, e o recorte fica na rota de visualizar. */
  secretaria: new Set(["pacientes", "profissionais", "atendimentos", "documentos_gestao",
    "convenios", "procedimentos", "salas", "relatorios", "teste_envios"]),
  // profissional: sua agenda, seus prontuários e as anamneses dos pacientes.
  // Lê pacientes/profissionais/procedimentos só como apoio (nomes e seletores).
  profissional: new Set(["atendimentos", "prontuario", "prontuario_registros", "anamneses", "historico",
    "teste_envios"]),
};
const PERM_LEITURA = {
  profissional: new Set(["pacientes", "profissionais", "procedimentos", "convenios", "salas", "testes"]),
  secretaria: new Set(["testes"]),   // precisa da lista para escolher o que enviar
};
const pode = (perfil, modulo) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(modulo) : false);
const podeLer = (perfil, modulo) => pode(perfil, modulo) || (PERM_LEITURA[perfil] && PERM_LEITURA[perfil].has(modulo));
const adminsAtivos = async () => Number((await Q.get("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1")).c);

/* ==========================================================================
   QUEM ESCREVE UM DESAFIO — e por que não é a mesma permissão do catálogo

   Editar o CATÁLOGO é mexer nos 13 rastreios: renomear, desligar, reordenar.
   É administração, e continua sendo só do admin.

   Escrever um DESAFIO é trabalho clínico: o terapeuta olha o caso, escreve o
   texto para aquela pessoa naquela semana e manda. Exigir que ele peça ao
   administrador para cadastrar significaria, na prática, que ninguém manda
   desafio — ou que todo profissional vira admin, que é pior.

   A secretária fica de fora dos dois: ela precisa LER a lista para escolher o
   que enviar, e isso `PERM_LEITURA` já dá.
   ========================================================================== */
const podeCriarDesafio = (perfil) => perfil === "admin" || perfil === "profissional";

/* ==========================================================================
   "A EQUIPE MUDOU" — aviso para quem estiver interessado (hoje: o chat)

   A gestão não conhece o chat, e é assim que fica: ela anuncia o fato, quem
   quiser que escute. Sem isto, o `server.js` teria de adivinhar pela URL da
   requisição que um usuário foi criado — e adivinhar por URL erra em silêncio
   no dia em que alguém acrescentar outra rota que mexe em `g_usuarios`
   (a de acesso do profissional, por exemplo, que não tem "usuarios" no
   caminho).

   O aviso é disparado DEPOIS da escrita e não é esperado (`void`): o cadastro
   do funcionário não pode ficar lento nem falhar porque um ouvinte demorou.
   ========================================================================== */
const ouvintesDaEquipe = [];
function aoMudarEquipe(fn) { if (typeof fn === "function") ouvintesDaEquipe.push(fn); }
function equipeMudou(motivo) {
  for (const fn of ouvintesDaEquipe) {
    try { Promise.resolve(fn(motivo)).catch(() => { }); } catch { }
  }
}

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
  /* ==========================================================================
     TESTE OU DESAFIO COM ENVIO PENDURADO

     Aprendido quebrando: apagar a linha do catálogo deixa o envio apontando
     para o vazio, e o paciente com um link que pede a data de nascimento,
     aceita a data — e então diz "não encontrado, fale com a clínica". O
     defeito aparece do lado de quem está com o celular na mão, uma semana
     depois de alguém ter feito faxina no cadastro.

     As perguntas de um teste vivem no código, mas as de um DESAFIO vivem
     nesta linha: apagá-la é apagar o formulário que o paciente está
     respondendo.
     ========================================================================== */
  if (tabela === "testes") {
    const t = await Q.get("SELECT chave FROM testes WHERE id=?", id);
    if (t) somar(await conta("SELECT COUNT(*) c FROM teste_envios WHERE teste_chave=?", t.chave),
      "envio a paciente");
  }
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
      equipeMudou("profissional bloqueado/liberado");
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
  equipeMudou("acesso de profissional");
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
  if (rota.startsWith("/api/")) {
    /* Antes de qualquer rota: o sistema está pronto? Ver `restritoPronto`.
       503 e não 500 — a diferença importa para quem lê o log e para quem
       recebe: 500 é "quebrou", 503 com Retry-After é "espere um segundo". */
    if (!restritoPronto) {
      res.setHeader("Retry-After", "2");
      json(res, 503, { error: "O sistema de gestão ainda está iniciando. Tente de novo em instantes." });
      return true;
    }
    rotaApi(req, res, rota.slice(5)).catch((e) => {
      console.error("  ✖ /restrito/api:", e.message); json(res, 500, { error: "Erro interno" });
    });
    return true;
  }

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
    const { usuario, senha } = await readBody(req);
    /* A conta entra na contagem pelo que foi DIGITADO, exista ou não: contar
       só as reais deixaria o atacante varrer nomes de graça. */
    const conta = String(usuario || "").trim().toLowerCase();
    const v = limite.verificar("restrito", ip, conta);
    if (!v.ok) { res.setHeader("Retry-After", String(v.esperar)); return json(res, 429, { error: v.mensagem }); }

    const u = await Q.get("SELECT * FROM g_usuarios WHERE email=? AND ativo=1", conta);
    /* Se o usuário não existe, ainda assim gastamos o mesmo tempo de um scrypt.
       Sem isto, "usuário inexistente" responde em ~1ms e "usuário certo, senha
       errada" em ~100ms — diferença que permite descobrir logins válidos por
       cronômetro antes de atacar a senha. */
    const ok = u ? confereSenha(senha, u.senha_hash) : (confereSenha(senha, HASH_ISCA), false);
    if (!ok) {
      limite.errou("restrito", ip, conta);
      /* A tentativa SEM SUCESSO é a linha mais importante desta trilha: é ela
         que revela alguém tentando entrar. Guardamos o login digitado — não a
         senha, nunca, nem parte dela. */
      auditar({ req, sessao: null, acao: "login_falhou",
        resumo: `Tentativa de entrar como "${String(usuario || "").slice(0, 60)}"`,
        detalhe: { usuario_informado: String(usuario || "").slice(0, 60), existe: !!u } });
      return json(res, 401, { error: "Usuário ou senha incorretos." });
    }
    limite.acertou("restrito", ip, conta);
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
     TEMPO REAL — o que mudou, não o que mudou PARA

     Um teste é respondido no celular do paciente, em casa, e a recepção está
     com a tela aberta olhando para "Enviado". Sem isto, ela só descobre
     apertando Atualizar — e não tem motivo para apertar, porque nada indica
     que houve novidade.

     SSE e não WebSocket: o tráfego é de mão única (servidor → tela), o
     EventSource reconecta sozinho quando a rede cai, e passa por qualquer
     proxy HTTP sem configuração especial. WebSocket aqui seria uma segunda
     pilha para resolver um problema que ela não tem.

     A MENSAGEM É SÓ O ASSUNTO — "testes", "pacientes". Nenhum dado de
     paciente trafega por este canal: quem recebe o aviso vai buscar pela API
     de sempre, com o recorte de perfil de sempre. Assim um canal aberto na
     recepção nunca entrega conteúdo clínico que ela não poderia ler.
     ========================================================================== */
  if (p === "eventos" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      /* O nginx da frente guarda a resposta em buffer por padrão, e um fluxo
         que nunca "termina" ficaria preso lá — a tela não receberia nada e o
         defeito só apareceria em produção. Este cabeçalho desliga isso sem
         precisar mexer no vhost. */
      "X-Accel-Buffering": "no",
    });
    res.write(": conectado\n\n");
    const cliente = { res, perfil: s.perfil };
    ouvintes.add(cliente);
    /* Pulso a cada 25s. Proxy e operadora derrubam conexão parada em 30–60s, e
       sem ele a tela ficaria "conectada" a um cano morto — o EventSource só
       reconecta quando percebe a queda. */
    const pulso = setInterval(() => { try { res.write(": pulso\n\n"); } catch { /* já foi */ } }, 25_000);
    const encerrar = () => { clearInterval(pulso); ouvintes.delete(cliente); };
    req.on("close", encerrar);
    req.on("error", encerrar);
    return;
  }

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
    /* Aqui também se adivinha senha: este endereço recebe a senha ATUAL.
       Sem freio, quem chegasse a um cookie de sessão poderia testá-la à
       vontade por aqui, contornando o login. A conta é a de quem está logado. */
    const vS = limite.verificar("troca-senha", ip, String(s.userId));
    if (!vS.ok) { res.setHeader("Retry-After", String(vS.esperar)); return json(res, 429, { error: vS.mensagem }); }
    const { atual, nova } = await readBody(req);
    const u = await Q.get("SELECT * FROM g_usuarios WHERE id=?", s.userId);
    if (!confereSenha(atual, u.senha_hash)) {
      limite.errou("troca-senha", ip, String(s.userId));
      return json(res, 400, { error: "Senha atual incorreta." });
    }
    limite.acertou("troca-senha", ip, String(s.userId));
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

  /* ==========================================================================
     A FOTO DE PERFIL DE QUEM USA O SISTEMA

     Rota SEPARADA do `/upload` genérico, e não um parâmetro nele, porque as
     duas fazem coisas diferentes com o arquivo: aquela guarda o documento como
     veio (um PDF de encaminhamento precisa chegar inteiro ao destinatário);
     esta RECORTA em 256×256 para o círculo do chat.

     Misturar as duas num só endpoint com um `?tipo=avatar` significaria uma
     função com dois comportamentos e um `if` no meio — e o dia em que alguém
     mexesse no recorte, o anexo do prontuário sairia cortado.

     Quem pode: qualquer pessoa logada, para a PRÓPRIA foto; o admin, para a de
     qualquer um. Ninguém troca a foto de outra pessoa — no chat, a foto é como
     a pessoa se apresenta aos colegas.
     ========================================================================== */
  const fotoM = p.match(/^usuarios\/(\d+)\/foto$/);
  if (fotoM && req.method === "POST") {
    const alvo = Number(fotoM[1]);
    if (s.perfil !== "admin" && alvo !== Number(s.userId))
      return json(res, 403, { error: "Você só pode trocar a própria foto." });

    const { dataUrl } = await readBody(req);
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl || "");
    if (!m) return json(res, 400, { error: "Envie uma imagem PNG, JPG ou WEBP." });

    const bruto = Buffer.from(m[2], "base64");
    /* Teto ANTES de o sharp abrir. Uma imagem de 200 MP cabe em poucos KB
       comprimidos e estoura a memória ao ser decodificada — é a "bomba de
       descompressão". 8 MB de entrada é folgado para foto de celular. */
    if (bruto.length > 8 * 1024 * 1024)
      return json(res, 400, { error: "Imagem muito grande — o limite é 8 MB." });

    const r = await IMG.tratarAvatar(bruto, "." + m[1].replace("jpeg", "jpg"));
    if (!r.buffer) return json(res, 400, { error: "Não consegui ler essa imagem." });

    const arquivo = `perfil-${alvo}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}${r.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, arquivo), r.buffer);
    const caminho = `/restrito/arquivos/${arquivo}`;

    /* A FOTO ANTIGA É APAGADA DO DISCO. Sem isso, cada troca deixaria um
       arquivo órfão para sempre — e num sistema de clínica, arquivo órfão com
       rosto de gente é o tipo de resto que ninguém sabe explicar numa
       auditoria de LGPD. */
    const antes = await Q.get("SELECT foto FROM g_usuarios WHERE id=?", alvo);
    await Q.run("UPDATE g_usuarios SET foto=? WHERE id=?", caminho, alvo);
    apagarFotoAntiga(antes && antes.foto, caminho);

    equipeMudou("foto de usuário");
    return json(res, 200, { ok: true, foto: caminho, tratada: r.tratada, motivo: r.motivo });
  }

  if (fotoM && req.method === "DELETE") {
    const alvo = Number(fotoM[1]);
    if (s.perfil !== "admin" && alvo !== Number(s.userId))
      return json(res, 403, { error: "Você só pode remover a própria foto." });
    const antes = await Q.get("SELECT foto FROM g_usuarios WHERE id=?", alvo);
    await Q.run("UPDATE g_usuarios SET foto='' WHERE id=?", alvo);
    apagarFotoAntiga(antes && antes.foto, null);
    equipeMudou("foto removida");
    return json(res, 200, { ok: true });
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
    if (req.method === "GET" && !id) return json(res, 200, await Q.all("SELECT id,nome,email,perfil,ativo,profissional_id,foto FROM g_usuarios ORDER BY id"));
    if (req.method === "GET" && id) return json(res, 200, await Q.get("SELECT id,nome,email,perfil,ativo,profissional_id,foto FROM g_usuarios WHERE id=?", id) || {});
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
      equipeMudou("usuário criado");
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
      /* A FOTO SÓ ACEITA CAMINHO DE ARQUIVO NOSSO.
         O valor chega da tela depois do upload, mas o corpo da requisição é
         escrito pelo cliente: sem esta trava, alguém gravaria `https://…` de
         terceiro e o chat da equipe passaria a delatar, a cada abertura, quem
         está online para o dono daquele servidor. Vazio limpa a foto. */
      if (b.foto !== undefined) {
        const f = String(b.foto || "").trim();
        if (f && !/^\/restrito\/arquivos\/[A-Za-z0-9._-]+$/.test(f))
          return json(res, 400, { error: "Foto inválida — envie pelo próprio formulário." });
        sets.push("foto=?"); args.push(f);
      }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." }); sets.push("senha_hash=?"); args.push(hashSenha(b.senha)); }
      if (sets.length) {
        try { await Q.run(`UPDATE g_usuarios SET ${sets.join(",")} WHERE id=?`, ...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao salvar." }); }
        equipeMudou("usuário editado");
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = await Q.get("SELECT perfil,ativo FROM g_usuarios WHERE id=?", id);
      if (alvo && alvo.perfil === "admin" && alvo.ativo && await adminsAtivos() <= 1) return json(res, 400, { error: "Não é possível excluir o único administrador." });
      /* A foto sai do disco junto. Excluir o usuário e deixar o rosto dele na
         pasta é o mesmo resto órfão que a troca de foto já evita. */
      const comFoto = await Q.get("SELECT foto FROM g_usuarios WHERE id=?", id);
      await Q.run("DELETE FROM g_usuarios WHERE id=?", id);
      apagarFotoAntiga(comFoto && comFoto.foto, null);
      equipeMudou("usuário excluído");
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
    /* …e só as PASTAS dele. Este endpoint alimenta o "prontuário completo"
       impresso — se o recorte falhasse aqui, o profissional imprimiria o
       histórico clínico inteiro do paciente, incluindo o de outros
       profissionais. É o caminho mais perigoso dos oito. */
    const dono = filtroDono(s);
    const pastas = await Q.all(`SELECT * FROM prontuario WHERE paciente_id=?${dono.sql}
       ORDER BY status, especialidade, id`, pid, ...dono.args);
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
      /* O histórico do paciente narra o que aconteceu nas pastas — inclusive
         trechos de evolução (ver `anotar`). Para o profissional ele fica de
         fora: seria a porta dos fundos do recorte que acabamos de aplicar. */
      historico: soDoProfissional(s) ? []
        : await Q.all("SELECT * FROM historico WHERE entidade='paciente' AND entidade_id=? ORDER BY criado, id", pid),
      anamneses: await Q.all(`SELECT * FROM anamneses WHERE paciente_id=?${dono.sql}
        ORDER BY COALESCE(NULLIF(data,''),criado), id`, pid, ...dono.args),
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
    /* Dar alta ou reabrir é MEXER no tratamento de alguém. Sem esta guarda, um
       profissional encerraria o acompanhamento conduzido por outro. */
    const recusaAlta = recusaPorDono(s, pr);
    if (recusaAlta) return json(res, 403, { error: recusaAlta });
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

  /* ======================================================================
     TESTES DE RASTREIO — o catálogo e os envios

     Fluxo: escolhe paciente e teste → nasce um ENVIO com código próprio →
     manda o link → o paciente responde → a resposta entra no prontuário.

     As perguntas vêm de `MODELOS_TESTE`; a tabela `testes` só diz quais a
     clínica usa e como se chamam na tela.
     ====================================================================== */

  /* O que a tela precisa para desenhar o formulário e a visualização.
     Devolve o CATÁLOGO junto com o MODELO de cada um — a tela nunca monta a
     lista de perguntas por conta própria, senão haveria duas versões do
     RTA-20: a do servidor, que corrige a resposta, e a da tela, que a coletou. */
  /* ======================================================================
     DESAFIO — INTERPRETAR o texto colado, e NÃO criar nada

     Duas rotas em vez de uma, e a separação é o pedido do cliente em código:
     "antes de dar o formulário como criado, deve mostrar para o usuário se
     está correto com visualização; estando correto, o usuário aprova".

     Esta aqui só lê e devolve o que entendeu. Nada é gravado, nada é enviado
     a paciente nenhum. É o que permite ao terapeuta colar, olhar, voltar,
     corrigir o texto e colar de novo quantas vezes precisar — que é o único
     jeito honesto de trabalhar com interpretação de texto humano, que erra.
     ====================================================================== */
  if (p === "desafios/interpretar" && req.method === "POST") {
    if (!podeCriarDesafio(s.perfil)) return json(res, 403, { error: "Sem permissão." });
    const b = await readBody(req);
    const texto = String(b.texto || "");
    if (!texto.trim()) return json(res, 400, { error: "Cole o texto do desafio." });
    if (texto.length > 60_000) {
      return json(res, 400, { error: "O texto do desafio é grande demais (máximo 60 mil caracteres)." });
    }
    const r = interpretarDesafio(texto);
    if (r.erro) return json(res, 400, { error: r.erro });
    return json(res, 200, r);
  }

  /* ======================================================================
     DESAFIO — CRIAR, depois de aprovado na tela

     O texto vem DE NOVO e é interpretado DE NOVO aqui. Parece desperdício e
     não é: aceitar o roteiro que a tela mandou seria deixar o navegador
     escolher que perguntas existem no formulário do paciente. A tela mostra;
     quem decide o que vale é o servidor, com a mesma função que gerou a
     visualização — então o que foi aprovado é exatamente o que é criado.

     `nome` a tela PODE mudar (é como o desafio aparece no catálogo daqui a
     seis meses, e o título do texto costuma ser genérico). As perguntas, não.
     ====================================================================== */
  if (p === "desafios" && req.method === "POST") {
    if (!podeCriarDesafio(s.perfil)) return json(res, 403, { error: "Sem permissão." });
    const b = await readBody(req);
    const texto = String(b.texto || "");
    if (!texto.trim()) return json(res, 400, { error: "Cole o texto do desafio." });

    /* ====================================================================
       O DESAFIO NASCE COM DONO, e já enviado

       Não existe desafio "no catálogo, para usar depois": ele foi escrito
       olhando para um caso, naquela semana. Sem paciente, a rota recusa — e
       a tela nem oferece o botão fora do prontuário.

       Criar e ENVIAR no mesmo passo é a consequência: separar as duas coisas
       criaria o estado "desafio escrito e nunca mandado", que só serviria
       para alguém encontrá-lo meses depois sem saber para quem era.
       ==================================================================== */
    const pacienteId = Number(b.paciente_id) || 0;
    if (!pacienteId) return json(res, 400, { error: "O desafio é de um paciente — escolha de quem." });
    const dono = await Q.get("SELECT id, nome, nascimento, ativo FROM pacientes WHERE id=?", pacienteId);
    if (!dono) return json(res, 404, { error: "Paciente não encontrado." });
    const inativo = await pacienteInativo(pacienteId);
    if (inativo) return json(res, 409, { error: inativo });
    if (soDigitos(dono.nascimento).length !== 8) {
      return json(res, 409, {
        error: "Cadastre a data de nascimento do paciente antes — " +
          "é ela que protege o link, e sem ela ninguém consegue abrir.",
      });
    }

    const r = interpretarDesafio(texto);
    if (r.erro) return json(res, 400, { error: r.erro });
    if (!r.abertas.length) {
      return json(res, 400, {
        error: "Não encontrei nenhuma pergunta ou pedido de registro no texto — " +
          "o paciente receberia um desafio sem onde responder.",
      });
    }

    const nome = String(b.nome || r.nome || "").trim().slice(0, 120);
    if (!nome) return json(res, 400, { error: "Dê um nome ao desafio." });

    /* A CHAVE é a identidade do item para o envio e para o link do paciente,
       e é UNIQUE. Nasce do nome, para ficar legível num log, com um sufixo
       sorteado — dois desafios de TDAH na mesma semana são a regra, não a
       exceção, e "desafio-tdah" colidiria no segundo. */
    const base = "desafio-" + nome.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    let chave = "";
    for (let i = 0; i < 12 && !chave; i++) {
      const tentativa = `${base || "desafio"}-${crypto.randomBytes(3).toString("hex")}`;
      if (!(await Q.get("SELECT 1 FROM testes WHERE chave=?", tentativa))) chave = tentativa;
    }
    if (!chave) return json(res, 500, { error: "Não consegui gerar um código para o desafio." });

    const maiorSort = await Q.get("SELECT COALESCE(MAX(sort),0) m FROM testes");
    const id = await Q.inserir(
      `INSERT INTO testes(chave, sigla, nome, instrucoes, tipo, estrutura, paciente_id,
                          ativo, sort, criado, atualizado, criado_por)
       VALUES(?,?,?,?, 'desafio', ?, ?, 1, ?, ?, ?, ?) RETURNING id`,
      chave, "", nome, r.instrucoes,
      /* O TEXTO ORIGINAL vai junto com o formulário interpretado. Sem ele,
         corrigir uma interpretação seis meses depois exigiria reescrever o
         desafio inteiro do zero — e o terapeuta já não lembra o que escreveu. */
      cifrar(JSON.stringify({ texto, roteiro: r.roteiro, abertas: r.abertas })),
      pacienteId, Number(maiorSort?.m || 0) + 1, agora(), agora(), s.userId);

    /* --------------------------------------------------------------------
       E JÁ VAI PARA O PACIENTE.

       Prazo e mensagens vêm do mesmo formulário da tela, com os mesmos
       cuidados do envio comum: data no passado nasceria vencida.
       -------------------------------------------------------------------- */
    let expira = null;
    if (!b.nao_expira) {
      expira = String(b.expira_em || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expira)) {
        return json(res, 400, { error: "Informe a data de expiração ou marque \"não expirar\"." });
      }
      if (expira < hojeISO()) return json(res, 400, { error: "A data de expiração já passou." });
    }

    const codigo = await codigoInedito();
    const envioId = await Q.inserir(
      `INSERT INTO teste_envios(codigo, paciente_id, teste_chave, prontuario_id, status,
                                expira_em, msg_boas_vindas, msg_agradecimento, criado, criado_por)
       VALUES(?,?,?,?, 'criado', ?,?,?,?,?) RETURNING id`,
      codigo, pacienteId, chave, Number(b.prontuario_id) || null, expira,
      cifrar(String(b.msg_boas_vindas || "").slice(0, 2000)),
      cifrar(String(b.msg_agradecimento || "").slice(0, 2000)),
      agora(), s.userId);

    await auditar(req, s, "criar", "testes", id, `Desafio para ${dono.nome}: ${nome}`);
    await auditar(req, s, "criar", "teste_envios", envioId, `Desafio: ${nome}`);
    avisar("testes");
    return json(res, 200, {
      ok: true, id, chave, nome, campos: r.abertas.length,
      envio_id: envioId, codigo,
    });
  }

  if (p === "modelos-teste" && req.method === "GET") {
    if (!podeLer(s.perfil, "testes")) return json(res, 403, { error: "Sem permissão." });
    /* SÓ RASTREIO. Esta rota alimenta o catálogo e a lista do "Enviar teste",
       e desafio ali seria oferecer a alguém a tarefa escrita para outra
       pessoa. O desafio aparece no prontuário do dono dele, e só. */
    const cat = await Q.all(
      "SELECT * FROM testes WHERE COALESCE(tipo,'teste')='teste' ORDER BY sort, nome");
    const itens = [];
    for (const t of cat) {
      /* A LINHA vai junto: para um desafio o modelo É a linha, e sem passá-la
         aqui cada item da lista dispararia uma segunda consulta ao banco só
         para reler o que já está na mão. */
      const m = await modeloDe(t.chave, t);
      const { estrutura, ...semEstrutura } = t;   // o corpo do desafio não vai para a lista
      itens.push(Object.assign(semEstrutura, {
        /* Nome e instrução vêm da TABELA (a clínica pode ter reescrito);
           perguntas e escala vêm do MODELO. Cada coisa de uma fonte só. */
        escala: m ? m.escala : [],
        secoes: m ? m.secoes : [],
        abertas: m ? m.abertas : [],
        terapeuta: m ? m.terapeuta : [],
        roteiro: m && m.roteiro ? m.roteiro : [],
        perguntas: m ? contarPerguntas(m) : 0,
        tipo: t.tipo || "teste",
        orfao: !m,   // linha no banco sem modelo no código: a tela avisa
      }));
    }
    return json(res, 200, { itens });
  }

  /* ---------------------------------------------------- lista de envios */
  if (p === "teste-envios" && req.method === "GET") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const u = new URL(req.url, "http://x");
    const onde = ["1=1"], args = [];
    const pac = Number(u.searchParams.get("paciente_id")) || null;
    if (pac) { onde.push("e.paciente_id=?"); args.push(pac); }
    const pasta = Number(u.searchParams.get("prontuario_id")) || null;
    if (pasta) { onde.push("e.prontuario_id=?"); args.push(pasta); }

    const linhas = await Q.all(
      `SELECT e.*, pa.nome paciente_nome, pa.codigo paciente_codigo, pa.celular paciente_celular,
              t.nome teste_nome, t.sigla teste_sigla, t.tipo teste_tipo, pr.numero pasta_numero
         FROM teste_envios e
         JOIN pacientes pa ON pa.id = e.paciente_id
         LEFT JOIN testes t ON t.chave = e.teste_chave
         LEFT JOIN prontuario pr ON pr.id = e.prontuario_id
        WHERE ${onde.join(" AND ")}
        ORDER BY e.id DESC`, ...args);

    const filtro = String(u.searchParams.get("situacao") || "");
    const itens = linhas.map(resumoDoEnvio)
      .filter((x) => !filtro || x.situacao === filtro);
    return json(res, 200, { itens });
  }

  /* ------------------------------------------------------- criar envio */
  if (p === "teste-envios" && req.method === "POST") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const b = await readBody(req);
    const pacienteId = Number(b.paciente_id) || 0;
    const chave = String(b.teste_chave || "").trim();
    if (!pacienteId) return json(res, 400, { error: "Escolha o paciente." });
    if (!chave) return json(res, 400, { error: "Escolha o teste." });

    const pac = await Q.get("SELECT id, nome, ativo FROM pacientes WHERE id=?", pacienteId);
    if (!pac) return json(res, 404, { error: "Paciente não encontrado." });
    /* Mesma regra do agendamento e da anamnese: registro NOVO para quem saiu
       da clínica não se cria — reativar primeiro. */
    const barrado = await pacienteInativo(pacienteId);
    if (barrado) return json(res, 409, { error: barrado });

    const cat = await Q.get("SELECT * FROM testes WHERE chave=? AND ativo=1", chave);
    if (!cat) return json(res, 404, { error: "Teste ou desafio não encontrado ou desativado." });
    const modelo = await modeloDe(chave, cat);
    if (!modelo || !contarPerguntas(modelo)) {
      return json(res, 409, {
        error: "Este item está no catálogo mas não tem perguntas no sistema.",
      });
    }

    /* Data de expiração: ou existe, ou a caixa "não expirar" foi marcada.
       Uma data no PASSADO nasceria vencida — o paciente receberia um link que
       já não abre, e ninguém entenderia por quê. */
    let expira = null;
    if (!b.nao_expira) {
      expira = String(b.expira_em || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expira)) {
        return json(res, 400, { error: "Informe a data de expiração ou marque \"não expirar\"." });
      }
      if (expira < hojeISO()) return json(res, 400, { error: "A data de expiração já passou." });
    }

    /* ====================================================================
       SEM DATA DE NASCIMENTO, NÃO HÁ FECHADURA

       A data é o que protege o link (ver `abrirComNascimento`). Um paciente
       sem data cadastrada geraria um link que ninguém consegue abrir — ou,
       pior, um link que abre para qualquer um porque não há o que conferir.

       Barrar aqui, com a frase que diz o que fazer, custa dez segundos de
       cadastro. Deixar passar custaria o silêncio: a clínica só descobriria
       ao receber a ligação de um paciente que não consegue entrar.
       ==================================================================== */
    const pacData = await Q.get("SELECT nascimento FROM pacientes WHERE id=?", pacienteId);
    if (String(pacData?.nascimento || "").replace(/\D+/g, "").length !== 8) {
      return json(res, 409, {
        error: "Cadastre a data de nascimento do paciente antes de enviar — " +
          "é ela que protege o link, e sem ela ninguém consegue abrir.",
      });
    }

    const codigo = await codigoInedito();
    const id = await Q.inserir(
      `INSERT INTO teste_envios(codigo, paciente_id, teste_chave, prontuario_id, status,
                                expira_em, msg_boas_vindas, msg_agradecimento, criado, criado_por)
       VALUES(?,?,?,?, 'criado', ?,?,?,?,?) RETURNING id`,
      codigo, pacienteId, chave, Number(b.prontuario_id) || null, expira,
      cifrar(String(b.msg_boas_vindas || "").slice(0, 2000)),
      cifrar(String(b.msg_agradecimento || "").slice(0, 2000)),
      agora(), s.userId);

    await anotar("paciente", pacienteId, "Teste criado", `${cat.sigla} — ${cat.nome}`, s);
    auditar({ req, sessao: s, acao: "criar", modulo: "teste_envios", entidadeId: Number(id),
      resumo: `Criou o teste ${cat.sigla} para ${pac.nome}`,
      detalhe: { teste: cat.nome, paciente: pac.nome, expira_em: expira || "não expira" } });
    avisar("testes");
    return json(res, 201, { ok: true, id, codigo });
  }

  /* ---------------------------------- um envio, com perguntas e respostas */
  const tem = p.match(/^teste-envios\/(\d+)$/);
  if (tem && req.method === "GET") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await envioCompleto(tem[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });
    /* A SECRETARIA acompanha a situação mas não lê a resposta: o conteúdo é do
       mesmo nível da anamnese, que ela também não vê. A lista já lhe mostra
       paciente, teste, data e situação — que é o de que a recepção precisa. */
    if (s.perfil === "secretaria") {
      delete e.respostas; delete e.avaliacao; delete e.itens;
      e.oculto = "As respostas são visíveis para o profissional e o administrador.";
    }
    return json(res, 200, e);
  }

  /* --------------------------------------------- marcar como enviado */
  const tenv = p.match(/^teste-envios\/(\d+)\/enviar$/);
  if (tenv && req.method === "POST") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await Q.get("SELECT * FROM teste_envios WHERE id=?", tenv[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });
    if (e.status === "concluido") return json(res, 409, { error: "Este teste já foi respondido." });
    /* Só ANDA para "enviado" quem ainda está em "criado". Reenviar um teste já
       aberto não pode fazer a situação VOLTAR — a tela mostraria "enviado"
       depois de o paciente ter começado a responder. */
    if (e.status === "criado") {
      await Q.run("UPDATE teste_envios SET status='enviado', enviado_em=? WHERE id=?", agora(), e.id);
    }
    const pac = await Q.get("SELECT nome FROM pacientes WHERE id=?", e.paciente_id);
    auditar({ req, sessao: s, acao: "enviar", modulo: "teste_envios", entidadeId: Number(e.id),
      resumo: `Enviou o teste ${e.teste_chave} para ${pac ? pac.nome : "paciente"}`, detalhe: { codigo: e.codigo } });
    await anotar("paciente", e.paciente_id, "Teste enviado", e.teste_chave, s);
    avisar("testes");
    return json(res, 200, { ok: true });
  }

  /* ------------------------------------------------------ recriar (zerar) */
  const trec = p.match(/^teste-envios\/(\d+)\/recriar$/);
  if (trec && req.method === "POST") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await Q.get("SELECT * FROM teste_envios WHERE id=?", trec[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });
    const corpo = (await readBody(req)) || {};

    /* O PRAZO tem de ser resolvido aqui. Recriar um teste vencido mantendo a
       data velha devolveria uma linha "criada" que já nasce vencida de novo —
       o botão funcionaria, a etiqueta mudaria por um instante e o link não
       abriria. Se o prazo passou, a clínica informa um novo ou marca que não
       expira; nos outros casos, a data combinada continua valendo. */
    let expira = e.expira_em;
    if ("nao_expira" in corpo || corpo.expira_em) {
      expira = corpo.nao_expira ? null : String(corpo.expira_em || "").slice(0, 10);
      if (expira !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expira)) {
        return json(res, 400, { error: "Data de expiração inválida." });
      }
      if (expira !== null && expira < hojeISO()) {
        return json(res, 400, { error: "A data de expiração já passou." });
      }
    } else if (expira && expira < hojeISO()) {
      return json(res, 400, {
        error: "Este teste está vencido. Informe um novo prazo (ou marque que não expira) para recriá-lo.",
        precisaPrazo: true });
    }

    /* CÓDIGO NOVO, e não o mesmo zerado. O link antigo já saiu por WhatsApp e
       pode estar aberto no celular de alguém; reaproveitá-lo deixaria aquela
       aba viva sobre um teste que a clínica considera reiniciado. Trocando o
       código, o link velho morre junto com a resposta que ele carregava. */
    const codigo = await codigoInedito();
    await Q.run(
      `UPDATE teste_envios SET codigo=?, status='criado', respostas=NULL, avaliacao=NULL,
              expira_em=?, enviado_em=NULL, aberto_em=NULL, concluido_em=NULL WHERE id=?`,
      codigo, expira, e.id);

    await anotar("paciente", e.paciente_id, "Teste recriado", `${e.teste_chave} — respostas anteriores descartadas`, s);
    auditar({ req, sessao: s, acao: "recriar", modulo: "teste_envios", entidadeId: Number(e.id),
      resumo: `Recriou o teste ${e.teste_chave}`,
      detalhe: { codigo_antigo: e.codigo, codigo_novo: codigo, tinha_resposta: !!e.respostas } });
    avisar("testes");
    return json(res, 200, { ok: true, codigo });
  }

  /* ------------------------------------------------------------- apagar */
  if (tem && req.method === "DELETE") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await Q.get("SELECT * FROM teste_envios WHERE id=?", tem[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });

    /* SÓ APAGA EM criado, enviado ou aberto — regra do cliente. Concluído e
       vencido ficam: um é resposta de paciente, que é registro clínico; o
       outro é a prova de que o prazo passou sem retorno, e essa ausência é
       informação. A situação é CALCULADA, então o vencido também cai aqui. */
    const sit = situacaoDoEnvio(e);
    if (sit === "concluido" || sit === "vencido") {
      return json(res, 409, {
        error: sit === "concluido"
          ? "Teste respondido não se apaga — é registro do paciente. Use Recriar para zerar."
          : "Teste vencido não se apaga: a falta de resposta no prazo também é informação. Use Recriar." });
    }

    await Q.run("DELETE FROM teste_envios WHERE id=?", e.id);
    auditar({ req, sessao: s, acao: "excluir", modulo: "teste_envios", entidadeId: Number(e.id),
      resumo: `Excluiu o envio do teste ${e.teste_chave}`, detalhe: { codigo: e.codigo, situacao: sit } });
    avisar("testes");
    return json(res, 200, { ok: true });
  }

  /* ------------------------------------ pendurar o envio numa pasta */
  const tpas = p.match(/^teste-envios\/(\d+)\/pasta$/);
  if (tpas && req.method === "PUT") {
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await Q.get("SELECT * FROM teste_envios WHERE id=?", tpas[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });
    const corpo = (await readBody(req)) || {};
    const pastaId = Number(corpo.prontuario_id) || null;

    if (pastaId) {
      const pr = await Q.get("SELECT id, paciente_id, numero FROM prontuario WHERE id=?", pastaId);
      if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
      /* A pasta tem de ser DO MESMO paciente. Sem esta conferência, um id
         digitado errado penduraria o questionário de uma pessoa no prontuário
         de outra — e ninguém acharia o erro pela tela. */
      if (Number(pr.paciente_id) !== Number(e.paciente_id)) {
        return json(res, 400, { error: "Esta pasta é de outro paciente." });
      }
      await Q.run("UPDATE teste_envios SET prontuario_id=? WHERE id=?", pastaId, e.id);
      await anotar("prontuario", pastaId, "Teste vinculado", e.teste_chave, s);
    } else {
      await Q.run("UPDATE teste_envios SET prontuario_id=NULL WHERE id=?", e.id);
    }
    auditar({ req, sessao: s, acao: "editar", modulo: "teste_envios", entidadeId: Number(e.id),
      resumo: pastaId ? `Vinculou o teste ${e.teste_chave} a um prontuário`
                      : `Soltou o teste ${e.teste_chave} do prontuário` });
    avisar("testes");
    return json(res, 200, { ok: true });
  }

  /* --------------------------- o que o TERAPEUTA conclui a partir da resposta */
  const tav = p.match(/^teste-envios\/(\d+)\/avaliacao$/);
  if (tav && req.method === "PUT") {
    /* Aqui a secretaria NÃO entra, nem com `teste_envios` liberado: este é o
       parecer clínico, o "área de uso exclusivo do terapeuta" do papel. */
    if (s.perfil === "secretaria") return json(res, 403, { error: "Sem permissão." });
    if (!pode(s.perfil, "teste_envios")) return json(res, 403, { error: "Sem permissão." });
    const e = await Q.get("SELECT * FROM teste_envios WHERE id=?", tav[1]);
    if (!e) return json(res, 404, { error: "Envio não encontrado." });
    const b = await readBody(req);
    await Q.run("UPDATE teste_envios SET avaliacao=? WHERE id=?",
      cifrar(JSON.stringify(b.avaliacao || {})), e.id);
    auditar({ req, sessao: s, acao: "editar", modulo: "teste_envios", entidadeId: Number(e.id),
      resumo: `Registrou a avaliação do teste ${e.teste_chave}` });
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
    /* Finalizar ABRE o prontuário. Feito na anamnese de outro profissional,
       criaria uma pasta clínica em nome dele. */
    const recusaFin = recusaPorDono(s, an);
    if (recusaFin) return json(res, 403, { error: recusaFin });
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
      /* A pasta nasce com o MESMO dono da anamnese que a abriu — é o vínculo
         que faz o profissional continuar vendo o que acabou de criar. */
      const donoId = an.profissional_id || (soDoProfissional(s) ? s.profissionalId : null);
      const novoId = await Q.inserir(
        "INSERT INTO prontuario(paciente_id,especialidade,profissional,profissional_id,status,aberto_em,usuario_id,criado) VALUES(?,?,?,?,'Ativo',?,?,?)",
        an.paciente_id, procedimento, prof, donoId, (an.data || new Date().toISOString().slice(0, 10)), s.userId, agora());
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
    const recusaReab = recusaPorDono(s, an);
    if (recusaReab) return json(res, 403, { error: recusaReab });
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
    /* Vincular ou soltar um agendamento é mexer no conteúdo da pasta. */
    const recusaVinc = recusaPorDono(s, pr);
    if (recusaVinc) return json(res, 403, { error: recusaVinc });
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
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
    return json(res, 200, await Q.all(`SELECT a.*, p.nome procedimento_nome, pf.nome profissional_nome
         FROM atendimentos a
         LEFT JOIN procedimentos p ON p.id = a.procedimento_id
         LEFT JOIN profissionais pf ON pf.id = a.profissional_id
        WHERE a.paciente_id = ? AND a.prontuario_id IS NULL
        ORDER BY a.data DESC, a.hora DESC, a.id DESC`, pr.paciente_id));
  }

  /* ======================================================================
     ARQUIVAR E RESTAURAR — paciente, pasta e lançamento pela MESMA rota

     Uma rota para as três, porque é a mesma operação: `arquivado` vira 1, a
     linha some das listas e volta num clique. Três rotas parecidas
     divergiriam — e a que ficasse para trás esqueceria de registrar no
     histórico, que é o que responde "quem tirou isto da tela".

     NADA É APAGADO. Arquivar é organização, não exclusão: o registro continua
     inteiro no banco, sai nos backups e é lido pela tela de Arquivados.

     PERMISSÃO POR TABELA, não uma só para todas: a recepção organiza a lista
     de pacientes mas não entra no prontuário; o profissional organiza as
     pastas DELE e não mexe na lista de pacientes.
     ====================================================================== */
  const ARQUIVAVEIS = {
    pacientes: { perm: "pacientes", oQue: "Paciente", entidade: "paciente" },
    prontuario: { perm: "prontuario", oQue: "Prontuário", entidade: "prontuario" },
    prontuario_registros: { perm: "prontuario", oQue: "Lançamento", entidade: "prontuario" },
  };
  const rm = p.match(/^(pacientes|prontuario|prontuario_registros)\/(\d+)\/(arquivar|restaurar)$/);
  if (rm && req.method === "POST") {
    const def = ARQUIVAVEIS[rm[1]];
    if (!pode(s.perfil, def.perm)) return json(res, 403, { error: "Sem permissão." });
    const id = rm[2], arq = rm[3] === "arquivar";
    const linha = await Q.get(`SELECT * FROM ${rm[1]} WHERE id=?`, id);
    if (!linha) return json(res, 404, { error: def.oQue + " não encontrado." });

    /* O RECORTE DO PROFISSIONAL vale aqui como vale na leitura: ele só
       organiza o que é dele. Sem isto, quem não pode nem VER a pasta de outro
       poderia fazê-la sumir da tela de todo mundo. */
    if (s.perfil === "profissional") {
      if (rm[1] === "prontuario_registros" && String(linha.usuario_id) !== String(s.userId))
        return json(res, 403, { error: "Lançamento de outro profissional." });
      if (rm[1] === "prontuario") {
        const recusa = recusaPorDono(s, linha);
        if (recusa) return json(res, 403, { error: recusa });
      }
    }

    await Q.run(`UPDATE ${rm[1]} SET arquivado=?, arquivado_em=? WHERE id=?`,
      arq ? 1 : 0, arq ? agora() : null, id);

    /* Quem arquivou e quando entram na linha do tempo. Arquivar tira da vista
       — e "sumiu da lista" sem registro é a diferença entre um sistema que se
       explica e um que faz alguém desconfiar do banco. */
    const alvoHist = rm[1] === "prontuario_registros" ? linha.prontuario_id : linha.id;
    const nome = rm[1] === "prontuario_registros" ? rotuloTipo(linha.tipo)
               : rm[1] === "prontuario" ? (linha.numero || linha.especialidade || "")
               : (linha.nome || linha.codigo || "");
    await anotar(def.entidade, alvoHist,
      def.oQue + (arq ? " arquivado" : " restaurado") + (nome ? ": " + nome : ""), "", s);
    return json(res, 200, { ok: true, arquivado: arq ? 1 : 0 });
  }

  /* --------- Linha do tempo de um paciente ou de um prontuário ---------- */
  const hm2 = p.match(/^historico\/(paciente|prontuario)\/(\d+)$/);
  if (hm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    /* O histórico guarda TRECHOS do que foi escrito nas evoluções (ver
       `anotar`). Para o profissional, só o da pasta DELE — e o do paciente
       fica fora por inteiro, porque reúne o que aconteceu em todas as pastas,
       de todos os profissionais. Sem isto, o recorte teria uma porta dos
       fundos: bastaria pedir o histórico para ler o que a tela escondeu. */
    if (soDoProfissional(s)) {
      if (hm2[1] === "paciente") return json(res, 200, []);
      const pr = await Q.get("SELECT profissional_id FROM prontuario WHERE id=?", hm2[2]);
      if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
      const recusa = recusaPorDono(s, pr);
      if (recusa) return json(res, 403, { error: recusa });
    }
    return json(res, 200, await Q.all("SELECT * FROM historico WHERE entidade=? AND entidade_id=? ORDER BY criado DESC, id DESC", hm2[1], hm2[2]));
  }

  /* ------- Prontuários de um paciente, com a contagem dos seus vínculos ---
     As contagens alimentam os "chips" que aparecem na anamnese, no agendamento
     e no prontuário — é assim que a tela mostra a que a pasta está ligada. */
  const pm2 = p.match(/^pacientes\/(\d+)\/prontuarios$/);
  if (pm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const dono = filtroDono(s, "pr.profissional_id");
    return json(res, 200, await Q.all(`SELECT pr.*,
        (SELECT COUNT(*) FROM prontuario_registros r WHERE r.prontuario_id=pr.id AND r.arquivado=0) lancamentos,
        (SELECT COUNT(*) FROM anamneses an WHERE an.prontuario_id=pr.id) anamneses,
        (SELECT COUNT(*) FROM atendimentos at WHERE at.prontuario_id=pr.id) atendimentos
      FROM prontuario pr WHERE pr.paciente_id=?${dono.sql} ORDER BY pr.status, pr.especialidade`, pm2[1], ...dono.args));
  }

  /* ------- O que está pendurado numa pasta (tela do prontuário) --------- */
  const vlm = p.match(/^prontuario\/(\d+)\/vinculos$/);
  if (vlm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", vlm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
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
    /* Recorte do profissional — o que é "dele" em cada tabela:
         · prontuario e anamneses  → profissional_id (o responsável)
         · prontuario_registros    → usuario_id (o AUTOR do lançamento; um
           lançamento é a anotação de quem escreveu, e continua privada mesmo
           dentro de uma pasta compartilhada)
         · atendimentos            → profissional_id (para quem foi marcado)
       Fora dessas quatro, sem recorte.

       O profissional SEM vínculo a um cadastro de profissional não vê nada
       dessas tabelas: sem o vínculo não há como dizer o que é dele, e o lado
       seguro do erro é não mostrar. O `-1` nunca casa com um id real. */
    let donoCol = null, donoVal = null;
    if (s.perfil === "profissional") {
      if (tabela === "prontuario_registros") { donoCol = "usuario_id"; donoVal = s.userId; }
      else if (tabela === "prontuario" || tabela === "anamneses" || tabela === "atendimentos") {
        donoCol = "profissional_id"; donoVal = s.profissionalId || -1;
      }
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
      /* ================================================================
         ARQUIVADO SOME DA LISTA

         Um parâmetro, três valores — e não dois parâmetros parecidos, que é
         como alguém acaba usando o errado:

             (ausente)          só o que NÃO está arquivado   ← o dia a dia
             ?arquivados=1      inclui os arquivados          ← já era assim
                                                                nos lançamentos
             ?arquivados=so     SÓ os arquivados              ← a tela nova

         `so` é o que a tela de Arquivados pede. Sem ele, ela teria de trazer
         tudo e filtrar no navegador — e a clínica inteira viajaria pelo fio
         para mostrar os três registros que foram arquivados.
         ================================================================ */
      if (TEM_ARQUIVO.has(tabela)) {
        const modo = q.get("arquivados");
        if (modo === "so") cond.push("arquivado=1");
        else if (modo !== "1") cond.push("arquivado=0");
      }
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
      /* O catálogo mostra QUANTAS perguntas cada teste tem, e esse número não
         está no banco — as perguntas vivem no arquivo de modelos. Anexado aqui
         para a tela não precisar cruzar duas listas: `orfao` é a linha que
         ficou sem modelo (teste tirado do código com a linha ainda no banco),
         e ela precisa aparecer, senão sumiria em silêncio. */
      if (tabela === "testes") {
        /* O CATÁLOGO É SÓ DOS RASTREIOS.

           Desafio é de um paciente e mora no prontuário dele. Listá-lo aqui
           encheria a tela de Cadastros com uma linha por semana por paciente
           — e, pior, colocaria o nome do desafio ("TDAH — observar o que
           acontece antes de deixar para depois") numa lista que a secretaria
           abre para escolher o que enviar. */
        linhas = linhas.filter((l) => (l.tipo || "teste") === "teste");
        for (const l of linhas) {
          const m = await modeloDe(l.chave, l);
          l.perguntas = m ? contarPerguntas(m) : 0;
          l.orfao = !m;
          l.tipo = l.tipo || "teste";
          delete l.estrutura;
        }
        linhas.sort((a, b) => (a.sort - b.sort) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
      }
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
      /* Carimba o DONO. Sem isto o profissional criaria a pasta e, no instante
         seguinte, deixaria de enxergá-la — o recorte da leitura não acharia
         dono nenhum. Ele nunca escolhe outro profissional: o registro é dele.
         Admin e secretaria continuam definindo pelo campo do formulário. */
      if (tabela === "prontuario" || tabela === "anamneses") {
        if (soDoProfissional(s)) { b.profissional_id = s.profissionalId; b.profissional = s.nome; }
        else if (b.profissional && !b.profissional_id) {
          const pf = await Q.get("SELECT id FROM profissionais WHERE LOWER(TRIM(nome))=LOWER(TRIM(?))", b.profissional);
          if (pf) b.profissional_id = pf.id;
        }
      }
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
      /* Campo em branco tratado pelo que a COLUNA aceita — ver prepararCampos. */
      const pronto = prepararCampos(tabela, use, b);
      if (pronto.faltando.length)
        return json(res, 400, { error: "Preencha: " + pronto.faltando.join(", ") + "." });

      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? pronto.usar.concat("criado") : pronto.usar;
      const valores = temCriado ? pronto.valores.concat(agora()) : pronto.valores;
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

      /* Campo em branco tratado pelo que a COLUNA aceita — ver prepararCampos. */
      const pronto = prepararCampos(tabela, use, b, true);
      if (pronto.faltando.length)
        return json(res, 400, { error: "Preencha: " + pronto.faltando.join(", ") + "." });

      const atribuicoes = pronto.usar.map((c) => c + "=?").concat(pronto.literais.map((c) => c + "=DEFAULT"));
      if (atribuicoes.length)
        await Q.run(`UPDATE ${tabela} SET ${atribuicoes.join(",")} WHERE id=?`, ...pronto.valores, id);

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


/* `prepararCampos` e `TIPOS` saem para a suíte poder testar o ramo
   "obrigatória sem padrão" DIRETO. Pela rota ele é inalcançável hoje: toda
   coluna NOT NULL sem padrão que o formulário grava já tem uma conferência
   própria antes ("Selecione o paciente", "Lançamento sem prontuário"), que
   responde com uma frase melhor. O ramo é REDE — vale para a próxima coluna
   obrigatória que alguém acrescentar sem lembrar de escrever a conferência.
   Rede que nunca foi testada não é rede. */
/* ==========================================================================
   O LADO DE FORA — o paciente respondendo pelo link

   Esta parte não tem sessão, não tem cookie e não tem login: quem chega é
   alguém com um link no WhatsApp. Por isso ela mora AQUI, junto do resto do
   sistema de gestão, e não no server.js — as três funções abaixo são a
   ÚNICA porta de entrada, e é aqui que estão as regras de quem pode abrir.

   O server.js só as chama e devolve o JSON.
   ========================================================================== */

/* ==========================================================================
   A PORTA DO LINK — a data de nascimento do paciente

   O QUE ISTO PROTEGE, e o que não protege.

   O código do link tem 8 a 11 caracteres sorteados de 62 símbolos: ninguém o
   adivinha. O risco real nunca foi adivinhação — é o link ENCAMINHADO. A
   mensagem vai por WhatsApp, e ela é encaminhada, o celular fica na mão de
   outra pessoa, a conversa é aberta num aparelho compartilhado.

   Contra isso, a data de nascimento é uma barreira HONESTA mas limitada: quem
   convive com o paciente costuma saber a data. Foi a escolha do cliente, com
   a fraqueza dita na hora, e a razão é boa — não exige combinar nada com o
   paciente, que é o que faz uma senha nova morrer na primeira semana.

   O QUE ELA PROTEGE DE VERDADE, e vale registrar: até aqui o link mostrava o
   NOME DO PACIENTE e o NOME DO TESTE antes de qualquer barreira. "Rastreio
   Terapêutico de TDAH Adulto" é diagnóstico. Agora nada disso sai antes da
   conferência — por isso ela vem antes do estado, e não depois.

   SEM A TRAVA DE TENTATIVAS ISTO NÃO VALERIA NADA: são poucas dezenas de
   milhares de datas plausíveis, e um robô as percorre em minutos. O balde por
   CÓDIGO (no server.js) é o que fecha essa porta — e ele é justamente o balde
   que o comentário do login diz ser inútil contra adivinhação de código. Os
   dois estão certos: lá o atacante troca de código a cada tentativa e o balde
   nunca enche; aqui ele tem UM código e troca a data, então o balde é a
   defesa inteira.
   ========================================================================== */

/* O passe do aparelho. Assinado com a chave dos dados — quem não a tem não
   forja um; quem a tem já lê o banco inteiro e não precisa forjar nada.
   Amarrado ao CÓDIGO: um passe emitido para um envio não abre outro. */
function passeDoAcesso(codigo, ate) {
  return crypto.createHmac("sha256", String(process.env.DADOS_CHAVE || ""))
    .update(`answer|${codigo}|${ate}`).digest("base64url");
}

const VALIDADE_ACESSO_MS = 45 * 24 * 60 * 60 * 1000;   // cobre o prazo mais longo com folga

function emitirAcesso(codigo) {
  const ate = Date.now() + VALIDADE_ACESSO_MS;
  return `${ate}.${passeDoAcesso(codigo, ate)}`;
}

function acessoValido(codigo, valor) {
  const [ate, assinatura] = String(valor || "").split(".");
  if (!ate || !assinatura) return false;
  if (!/^\d+$/.test(ate) || Number(ate) < Date.now()) return false;
  const esperado = passeDoAcesso(codigo, ate);
  /* Comparação de tempo constante: comparar com `===` vaza, pelo tempo, quantos
     caracteres iniciais bateram — e com isso a assinatura se descobre byte a
     byte, sem precisar da chave. */
  const a = Buffer.from(assinatura), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ==========================================================================
   NORMALIZAR A DATA — e por que comparar dígitos crus não serve

   O banco guarda `1990-03-05` (AAAA-MM-DD) e o paciente digita `05/03/1990`.
   Tirando a pontuação, isso vira `19900305` de um lado e `05031990` do outro:
   a MESMA data, duas cadeias diferentes. Comparar dígitos crus recusava todo
   mundo — e o erro na tela seria "a data não confere", que manda a pessoa
   conferir a própria certidão de nascimento.

   Aqui as duas pontas viram AAAAMMDD antes de se encontrarem. Com oito
   dígitos sem separador, quem manda é o começo: `1990…` só pode ser ano.
   ========================================================================== */
function nascimentoNormal(v) {
  const d = soDigitos(v);
  if (d.length !== 8) return "";
  const comoISO = d.slice(0, 4);
  /* Ano plausível na frente → já está em AAAAMMDD. Ninguém nasce no ano 0512,
     e ninguém tem dia 19. */
  if (Number(comoISO) >= 1900 && Number(comoISO) <= 2100) return d;
  return d.slice(4) + d.slice(2, 4) + d.slice(0, 2);   // ddmmaaaa → aaaammdd
}

/* Confere e, acertando, devolve o passe do aparelho.
   NÃO diz se o código existe, se o teste venceu ou de quem ele é: quem erra a
   data recebe sempre a mesma resposta. */
async function abrirComNascimento(codigo, informado) {
  if (!/^[0-9A-Za-z]{8,11}$/.test(String(codigo || ""))) return { ok: false };
  const e = await Q.get("SELECT * FROM teste_envios WHERE codigo=?", codigo);
  if (!e) return { ok: false };

  const pac = await Q.get("SELECT nascimento FROM pacientes WHERE id=?", e.paciente_id);
  const guardada = nascimentoNormal(pac && pac.nascimento);
  /* Paciente sem data cadastrada não deveria chegar aqui — o envio é barrado
     na criação. Se chegou (envio antigo, cadastro esvaziado depois), recusar é
     o certo: abrir "porque não há o que conferir" transformaria um cadastro
     incompleto em porta destrancada, em silêncio. */
  if (guardada.length !== 8) return { ok: false, semData: true };

  if (nascimentoNormal(informado) !== guardada) return { ok: false };

  if (!e.acesso_em) await Q.run("UPDATE teste_envios SET acesso_em=? WHERE id=?", agora(), e.id);
  return { ok: true, passe: emitirAcesso(codigo) };
}

/* Estado do link, sem revelar nada além do necessário.
   Código inexistente e código vencido respondem coisas DIFERENTES de
   propósito: não há segredo a proteger entre esses dois casos (quem tem o
   link já tem o link), e mandar "não encontrado" para um teste vencido faria
   o paciente achar que digitou errado e procurar a clínica por nada. */
async function estadoDoLink(codigo, passe) {
  if (!/^[0-9A-Za-z]{8,11}$/.test(String(codigo || ""))) return { estado: "inexistente" };
  const e = await Q.get("SELECT * FROM teste_envios WHERE codigo=?", codigo);
  if (!e) return { estado: "inexistente" };

  /* ====================================================================
     A CONFERÊNCIA VEM ANTES DO ESTADO, e isso é de propósito.

     Se viesse depois, quem tem o link saberia — sem provar nada — que existe
     um teste para aquela pessoa e que ele venceu, foi respondido ou está
     aberto. Já é informação de saúde: diz que fulano está em tratamento.

     Por isso a resposta aqui é a MESMA para vencido, concluído e em aberto:
     "prove que é você". Só depois disso o estado real aparece.
     ==================================================================== */
  if (!acessoValido(codigo, passe)) return { estado: "verificar", pede: "nascimento" };

  const cat = await Q.get(
    "SELECT nome, instrucoes, tipo, estrutura, chave FROM testes WHERE chave=?", e.teste_chave);
  const m = await modeloDe(e.teste_chave, cat);
  if (!m) return { estado: "inexistente" };

  const ehDesafio = (m.tipo || "teste") === "desafio";
  const sit = situacaoDoEnvio(e);
  if (!envioAbrivel(e, ehDesafio)) return { estado: sit };

  const pac = await Q.get("SELECT nome, nome_contato FROM pacientes WHERE id=?", e.paciente_id);
  const rascunho = lerJson(e.rascunho);

  return {
    estado: "ok",
    /* Já respondeu alguma coisa: a tela troca "Começar" por "Continuar" e diz
       quanto falta. Sem isso, quem volta na quarta-feira encontra a mesma tela
       de boas-vindas do primeiro dia e acha que perdeu tudo o que escreveu. */
    retomando: ehDesafio && Object.keys(rascunho).length > 0,
    respondidas: Object.keys(rascunho).length,
    /* O NOME DO PACIENTE, como a clínica o chama.
       `nome_contato` na frente porque é exatamente o campo "como prefere ser
       chamado" do cadastro: quem se registrou como "Maria das Graças Silva" e
       pediu para ser chamada de "Graça" lê o próprio apelido, não o nome de
       documento. Sem ele, o nome completo. */
    tratamento: (pac && (String(pac.nome_contato || "").trim() || String(pac.nome || "").trim())) || "",
    teste: cat ? cat.nome : m.nome,
    instrucoes: (cat && cat.instrucoes) || m.instrucoes,
    boas_vindas: e.msg_boas_vindas || "",
    expira_em: e.expira_em,
    total: contarPerguntas(m),
    /* A tela do paciente muda de vocabulário conforme o que ele recebeu:
       um rastreio se "responde", um desafio se "faz durante a semana". */
    tipo: m.tipo || "teste",
  };
}

/* COMEÇAR — é aqui que o teste vira "aberto", e não no carregamento da página.
   A diferença é concreta: o WhatsApp busca a URL sozinho para montar a
   prévia do link. Se abrir a página marcasse "aberto", o teste morreria no
   instante em que a mensagem fosse entregue, antes de o paciente tocar nela. */
async function iniciarTeste(codigo, passe) {
  const e = await Q.get("SELECT * FROM teste_envios WHERE codigo=?", codigo);
  if (!e) return { erro: "inexistente" };
  /* A porta vale em TODAS as rotas do link, não só na primeira. Sem esta
     linha, bastaria pular a tela de conferência e chamar `iniciar` direto —
     e a barreira seria enfeite de navegador. */
  if (!acessoValido(codigo, passe)) return { erro: "verificar" };

  const m = await modeloDe(e.teste_chave);
  if (!m) return { erro: "inexistente" };
  if (!envioAbrivel(e, (m.tipo || "teste") === "desafio")) return { erro: situacaoDoEnvio(e) };

  if (e.status !== "aberto") {
    await Q.run("UPDATE teste_envios SET status='aberto', aberto_em=? WHERE id=?", agora(), e.id);
    /* O paciente ABRIU. Quem está com a lista na tela vê a etiqueta virar
       "Aberto" na hora — e é essa a informação que diz "ele recebeu e começou",
       que a clínica hoje só teria por telefone. */
    avisar("testes");
  }

  const itens = [];
  m.secoes.forEach((sec, si) => sec.itens.forEach((texto, ii) =>
    itens.push({ chave: chaveItem(si, ii), secao: sec.titulo || "", pergunta: texto, aberta: false })));
  m.abertas.forEach((texto, i) =>
    itens.push({ chave: chaveAberta(i),
      secao: m.tipo === "desafio" ? "" : "Para pensar com calma",
      pergunta: texto, aberta: true }));

  /* O ROTEIRO é o desafio como ele foi escrito: seção, orientação, exemplo e,
     no meio, os campos. A tela do paciente segue esta ordem em vez de listar
     sete perguntas soltas — sem as orientações no lugar certo, o formulário
     deixa de ser o desafio e vira um questionário sem contexto.

     Vazio nos rastreios, e aí a tela usa o layout de sempre. */
  return { ok: true, escala: m.escala, itens, tipo: m.tipo || "teste",
    roteiro: m.roteiro || [],
    /* O que ele já escreveu nos dias anteriores. A tela devolve cada valor ao
       seu campo — é isto que faz "reabrir" significar continuar, e não
       recomeçar. */
    rascunho: lerJson(e.rascunho) };
}

/* ==========================================================================
   GUARDAR O QUE ESTÁ SENDO ESCRITO — só desafio

   Chamado pela tela do paciente enquanto ele digita, com folga entre uma
   gravação e outra. Guarda em `rascunho`, NUNCA em `respostas`: o que está
   pela metade não pode aparecer no prontuário como se fosse o que ele
   entregou.

   Não muda a situação do envio nem avisa a clínica em tempo real: "está
   escrevendo" não é informação que a clínica precise acompanhar ao vivo, e
   transformar cada tecla em evento na tela de quem trabalha seria ruído.
   ========================================================================== */
async function salvarRascunho(codigo, respostas, passe) {
  const e = await Q.get("SELECT * FROM teste_envios WHERE codigo=?", codigo);
  if (!e) return { erro: "inexistente" };
  if (!acessoValido(codigo, passe)) return { erro: "verificar" };
  if (e.status === "concluido") return { erro: "concluido" };

  const m = await modeloDe(e.teste_chave);
  if (!m) return { erro: "inexistente" };
  if ((m.tipo || "teste") !== "desafio") return { erro: "sem_rascunho" };
  if (!envioAbrivel(e, true)) return { erro: situacaoDoEnvio(e) };

  /* A MESMA peneira do concluir. O rascunho vem da internet aberta como tudo
     mais: só chave que existe no modelo entra, e cada valor tem teto. */
  const limpo = {};
  m.abertas.forEach((_, i) => {
    const k = chaveAberta(i);
    const v = String((respostas || {})[k] ?? "").trim().slice(0, 4000);
    if (v) limpo[k] = v;
  });
  m.secoes.forEach((sec, si) => sec.itens.forEach((_, ii) => {
    const k = chaveItem(si, ii);
    const v = String((respostas || {})[k] ?? "");
    if (m.escala.some((x) => String(x.v) === v)) limpo[k] = Number(v);
  }));

  await Q.run("UPDATE teste_envios SET rascunho=?, rascunho_em=? WHERE id=?",
    cifrar(JSON.stringify(limpo)), agora(), e.id);
  return { ok: true, guardadas: Object.keys(limpo).length };
}

/* CONCLUIR. Duas conferências que a tela também faz, e que precisam existir
   aqui: barra de progresso é enfeite do navegador, e um POST direto passaria
   por cima dela com o formulário pela metade. */
async function concluirTeste(codigo, respostas, passe) {
  const e = await Q.get("SELECT * FROM teste_envios WHERE codigo=?", codigo);
  if (!e) return { erro: "inexistente" };
  if (!acessoValido(codigo, passe)) return { erro: "verificar" };
  if (e.status === "concluido") return { erro: "concluido" };
  /* Vencido durante o preenchimento: quem começou às 23h59 do último dia
     termina. Recusar aqui jogaria fora um formulário inteiro já digitado, e o
     prazo é da clínica com o paciente, não do relógio com o formulário. */
  if (e.status !== "aberto") return { erro: situacaoDoEnvio(e) };

  const m = await modeloDe(e.teste_chave);
  if (!m) return { erro: "inexistente" };

  const limpo = {};
  const valores = new Set(m.escala.map((x) => String(x.v)));
  let faltam = 0;
  m.secoes.forEach((sec, si) => sec.itens.forEach((_, ii) => {
    const k = chaveItem(si, ii);
    const v = String((respostas || {})[k] ?? "");
    /* Só valor QUE EXISTE na escala entra. Sem esta peneira, um POST à mão
       gravaria "9" numa escala de 0 a 4 e a soma bruta ficaria impossível de
       explicar seis meses depois. */
    if (valores.has(v)) limpo[k] = Number(v); else faltam++;
  }));
  m.abertas.forEach((_, i) => {
    const k = chaveAberta(i);
    const v = String((respostas || {})[k] ?? "").trim().slice(0, 4000);
    if (v) limpo[k] = v; else faltam++;
  });
  if (faltam) return { erro: "incompleto", faltam };

  /* O rascunho é APAGADO na conclusão. Ele foi promovido a `respostas`, e
     manter as duas cópias criaria a pergunta "qual delas vale?" — que é a
     pergunta errada para se fazer diante do prontuário de alguém. */
  await Q.run(
    "UPDATE teste_envios SET status='concluido', concluido_em=?, respostas=?, rascunho=NULL WHERE id=?",
    agora(), cifrar(JSON.stringify(limpo)), e.id);

  /* Quem respondeu foi o PACIENTE, não um usuário do sistema. Passar `null`
     deixaria a linha do histórico sem autor, do lado de linhas que dizem
     "Dr. Fulano deu alta" — e a leitura seria "não se sabe quem fez". */
  await anotar("paciente", e.paciente_id, "Teste respondido", e.teste_chave,
    { userId: null, nome: "o próprio paciente" });
  /* O AVISO QUE MOTIVA TODO O CANAL: o paciente terminou, em casa, no celular.
     Sem isto a recepção continuaria vendo "Aberto" por tempo indeterminado —
     e não teria motivo nenhum para apertar Atualizar. */
  avisar("testes");
  return { ok: true, agradecimento: e.msg_agradecimento || "" };
}

/* O primeiro nome ainda é usado na mensagem do WhatsApp, que é conversa
   ("Olá, Maria!"). Na página do teste o tratamento é o nome do cadastro — ver
   `estadoDoLink`. */
const primeiroNome = (n) => String(n || "").trim().split(/\s+/)[0] || "";

module.exports = { handleRestrito, iniciarRestrito, SISTEMA_VERSION, CAMPOS_PROTEGIDOS, sessao, auditar, registrarEncerrarPainel,
  estadoDoLink, iniciarTeste, concluirTeste, salvarRascunho, abrirComNascimento, aoMudarEquipe,
  _paraTeste: { prepararCampos, destinoDoVazio, TIPOS, sortearCodigo, situacaoDoEnvio, hojeISO } };
