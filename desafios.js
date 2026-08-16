/* ==========================================================================
   DESAFIOS — ler o texto que o terapeuta escreveu e montar o formulário

   O PROBLEMA, em uma frase: cada paciente recebe um desafio diferente, feito
   para a realidade dele. Um catálogo fixo como o dos 13 rastreios não serve —
   o terapeuta escreve o texto na hora, cola aqui, e o sistema precisa
   descobrir sozinho o que é ORIENTAÇÃO para ler e o que é CAMPO para
   responder.

   ---------------------------------------------------------------------------
   POR QUE NÃO RENDERIZAR MARKDOWN

   O texto chega colado — de um Word, do WhatsApp, de um ChatGPT — e vai ser
   exibido numa PÁGINA PÚBLICA (`/answer/<código>`), aberta sem login. Passar
   isso por um renderizador de HTML seria pôr texto de terceiro na tela de
   quem quer que tenha o link.

   Então aqui o texto é REDUZIDO A ESTRUTURA: título, parágrafo, lista,
   citação, campo. Nada de HTML atravessa. O `*` e o `#` do markdown servem só
   para eu saber o que é cada linha; depois disso são jogados fora e sobra
   texto puro, que a página escapa na hora de mostrar.

   ---------------------------------------------------------------------------
   O QUE VIRA CAMPO — e o que deliberadamente NÃO vira

   Interpretar é achar o que o texto PEDE, não inventar pergunta que ele não
   fez. Três regras, em ordem de confiança:

     1. a linha é uma PERGUNTA (termina em "?") → campo;
     2. a linha traz uma LACUNA (`__`) → campo, com a frase de modelo no rótulo;
     3. o título ou o corpo da seção mandam REGISTRAR alguma coisa ("anote",
        "escolha", "traga", "registre"…) → um campo com o título da seção.

   E o que NÃO vira campo, por decisão:

     · CITAÇÃO (`>`) — no texto do terapeuta ela é sempre EXEMPLO de resposta
       ("Estou sem vontade."). Virar campo criaria oito caixas para o paciente
       preencher oito exemplos que eram só ilustração;
     · LISTA (`*`, `-`) — mesma coisa: "pode ser algo simples, como: responder
       uma mensagem; organizar alguma coisa…" é repertório, não questionário;
     · seção que só orienta ("REGRA IMPORTANTE: não transforme isso em mais
       uma cobrança") — não pede resposta nenhuma, e forçar um campo ali faria
       o paciente achar que devia escrever algo.

   A regra 3 só entra se a seção ainda não gerou campo pelas regras 1 e 2 —
   sem isso, "No final do dia, RESPONDA três perguntas" viraria quatro campos:
   as três perguntas e mais um pelo verbo do título.

   ---------------------------------------------------------------------------
   E SE EU ERRAR

   Erro de interpretação é esperado — texto humano não tem gramática. Por isso
   nada é criado direto: o `/restrito` mostra a VISUALIZAÇÃO do formulário como
   o paciente vai vê-lo, e só cria depois que o terapeuta aprova. Este arquivo
   ainda devolve `avisos` — o que ele percebeu que pode ter entendido errado —
   para a tela dizer em voz alta em vez de deixar a pessoa procurar.
   ========================================================================== */
"use strict";

/* Verbos que, num título ou numa frase solta, significam "escreva alguma
   coisa aqui". A lista é curta de propósito: cada verbo a mais é um campo a
   mais criado por engano num texto que só orientava. */
const VERBOS_DE_REGISTRO = [
  "anote", "anotar", "registre", "registrar", "escreva", "escrever",
  "responda", "responder", "descreva", "descrever", "liste", "listar",
  "traga", "trazer", "escolha", "escolher", "marque", "marcar",
  "preencha", "preencher", "conte", "relate", "relatar",
];

/* ==========================================================================
   LIMPEZA DE MARCAÇÃO

   Tira o que é enfeite (`*negrito*`, `_itálico_`, `` `código` ``) e as aspas
   que envolvem a frase inteira. Preserva acento, pontuação e o resto do texto
   como veio — o objetivo é o rótulo ficar legível, não virar outro texto.
   ========================================================================== */
const MARCA_LACUNA = "\u0001LACUNA\u0001";

function limpar(linha) {
  let t = String(linha || "");

  /* ====================================================================
     A LACUNA TEM DE SER PROTEGIDA ANTES DO NEGRITO

     "Eu estava fazendo __ e comecei a __." é uma frase com DUAS lacunas para
     o paciente completar. Para o markdown, porém, `__ … __` é negrito — e a
     limpeza devolvia "Eu estava fazendo e comecei a .", que não é frase nem
     lacuna: some o campo e sobra uma orientação sem sentido.

     A diferença entre os dois casos é o espaço: negrito é `__grudado__`,
     lacuna tem espaço (ou fim de frase) logo depois. Aqui a lacuna vira uma
     marca que o negrito não reconhece, e volta a ser sublinhado no fim.
     ==================================================================== */
  t = t.replace(/_{2,}(?=\s|$|[.,;:!?)"”'])/g, MARCA_LACUNA);

  t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  t = t.replace(/__(.+?)__/g, "$1").replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2");
  t = t.replace(/`(.+?)`/g, "$1");
  t = t.split(MARCA_LACUNA).join("____");
  t = t.replace(/\s+/g, " ").trim();
  /* Aspas que abraçam a frase INTEIRA. Só nesse caso: aspas no meio são parte
     do que a pessoa escreveu e sair tirando mudaria o sentido. */
  const par = [['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"]];
  for (const [a, b] of par) {
    if (t.length > 1 && t.startsWith(a) && t.endsWith(b)) { t = t.slice(1, -1).trim(); break; }
  }
  return t;
}

/* "1. O que eu tinha planejado fazer?" → "O que eu tinha planejado fazer?"
   O número serve para eu reconhecer a lista de perguntas; no rótulo ele só
   competiria com a numeração que a própria tela do paciente já põe. */
const semNumero = (t) => t.replace(/^\(?\d{1,2}[.)°º]?\s+/, "").trim();

const ehPergunta = (t) => /\?\s*$/.test(t);
const temLacuna = (t) => /_{2,}/.test(t);
const pedeRegistro = (t) => {
  const s = t.toLowerCase();
  return VERBOS_DE_REGISTRO.some((v) => new RegExp(`(^|[^a-zà-ú])${v}([^a-zà-ú]|$)`, "i").test(s));
};

/* Título sem `###`: uma linha curta, TODA EM MAIÚSCULAS e sem ponto final.
   É como o texto de exemplo escreve "DESAFIO TERAPÊUTICO DA SEMANA" e
   "REGRA IMPORTANTE" — cabeçalho de quem não usa markdown. */
function pareceTituloSolto(t) {
  if (t.length > 80 || /[.:;?]$/.test(t)) return false;
  const letras = t.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letras.length < 3) return false;
  return letras === letras.toUpperCase();
}

/* ==========================================================================
   FATIAR EM LINHAS COM TIPO

   Um passo só de classificação, antes de qualquer decisão sobre campos. Fica
   separado porque é a parte que eu quero poder ler e conferir sozinha quando
   um texto novo sair diferente do esperado.
   ========================================================================== */
function classificar(texto) {
  const linhas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
  const saida = [];

  for (const bruta of linhas) {
    const crua = bruta.trim();
    if (!crua) { saida.push({ tipo: "vazio" }); continue; }

    /* Separador de markdown (`---`, `***`): não é conteúdo. */
    if (/^([-*_])\1{2,}$/.test(crua.replace(/\s/g, ""))) continue;

    const cab = /^(#{1,6})\s+(.*)$/.exec(crua);
    if (cab) { saida.push({ tipo: "titulo", nivel: cab[1].length, texto: limpar(cab[2]) }); continue; }

    if (/^>\s?/.test(crua)) {
      saida.push({ tipo: "citacao", texto: limpar(crua.replace(/^>\s?/, "")) });
      continue;
    }

    const item = /^[*+-]\s+(.*)$/.exec(crua);
    if (item) { saida.push({ tipo: "item", texto: limpar(item[1]) }); continue; }

    const numerado = /^\(?(\d{1,2})[.)]\s+(.*)$/.exec(crua);
    if (numerado) {
      saida.push({ tipo: "numerado", numero: Number(numerado[1]), texto: limpar(numerado[2]) });
      continue;
    }

    const t = limpar(crua);
    if (!t) continue;
    /* Um `*1. pergunta?*` vira, depois da limpeza, "1. pergunta?" — que é
       numerado. Reconhecer aqui evita perder a numeração por causa do itálico. */
    const numDepois = /^\(?(\d{1,2})[.)]\s+(.*)$/.exec(t);
    if (numDepois) {
      saida.push({ tipo: "numerado", numero: Number(numDepois[1]), texto: limpar(numDepois[2]) });
      continue;
    }
    saida.push({ tipo: pareceTituloSolto(t) ? "titulo-solto" : "paragrafo", texto: t });
  }
  return saida;
}

/* ==========================================================================
   INTERPRETAR — a função que a rota chama

   Devolve tudo o que o resto do sistema precisa:

     nome        → como o desafio aparece no catálogo
     instrucoes  → o texto de abertura, antes da primeira seção
     roteiro     → a ordem de exibição na página do paciente
     abertas     → SÓ os rótulos dos campos, na ordem — é este array que o
                   resto do sistema já sabe manipular (contar, salvar, imprimir,
                   mostrar no prontuário), exatamente como nos 13 rastreios
     avisos      → o que eu percebi que pode estar errado
   ========================================================================== */
function interpretarDesafio(texto) {
  const linhas = classificar(texto);
  const avisos = [];

  if (!linhas.some((l) => l.tipo !== "vazio")) {
    return { erro: "O texto do desafio está vazio." };
  }

  /* ---------------------------------------------------------------- título */
  let i = 0;
  while (i < linhas.length && linhas[i].tipo === "vazio") i++;
  const primeira = linhas[i];
  let titulo = "", subtitulo = "";
  if (primeira && (primeira.tipo === "titulo" || primeira.tipo === "titulo-solto"
    || primeira.tipo === "paragrafo")) {
    titulo = primeira.texto; i++;
  }
  while (i < linhas.length && linhas[i].tipo === "vazio") i++;
  /* Uma SEGUNDA linha de cabeçalho logo abaixo é o assunto do desafio
     ("TDAH — observar o que acontece antes de deixar para depois"), e é ela
     que identifica este desafio entre outros vinte com o mesmo cabeçalho
     genérico "DESAFIO TERAPÊUTICO DA SEMANA". */
  if (linhas[i] && (linhas[i].tipo === "titulo" || linhas[i].tipo === "titulo-solto")) {
    subtitulo = linhas[i].texto; i++;
  }

  const nome = subtitulo || titulo || "Desafio";

  /* ------------------------------------------------- abertura e as seções */
  const roteiro = [];
  const abertas = [];
  const aberturaTextos = [];

  /* Campo criado a partir de um rótulo. Devolve o índice em `abertas`, que é
     o que amarra o roteiro (exibição) ao formulário (resposta). */
  const criarCampo = (rotulo, dica) => {
    const r = String(rotulo || "").trim();
    if (!r) return -1;
    /* Rótulo repetido não vira campo repetido: o mesmo texto duas vezes no
       corpo é reforço do terapeuta, não duas perguntas. */
    const jaTem = abertas.indexOf(r);
    if (jaTem >= 0) return jaTem;
    abertas.push(r);
    roteiro.push({ tipo: "campo", aberta: abertas.length - 1, rotulo: r, dica: dica || "" });
    return abertas.length - 1;
  };

  let secaoAberta = null;      // { titulo, camposAntes }
  let emAbertura = true;

  const fecharSecao = () => {
    /* REGRA 3, aplicada no FIM da seção: se ela pediu registro e nada dentro
       dela virou campo, o campo é a seção inteira. Rodar isto no fim (e não
       ao ver o título) é o que impede "responda três perguntas" de gerar
       quatro campos. */
    if (!secaoAberta) return;
    const gerouCampo = abertas.length > secaoAberta.camposAntes;
    if (!gerouCampo && secaoAberta.pedeRegistro) {
      /* QUAL FRASE VIRA O RÓTULO
         · o TÍTULO, quando ele próprio é a instrução ("Escolha uma tarefa por
           dia") — é curto e já diz o que fazer;
         · a FRASE do corpo, quando o título não pede nada ("Para conversarmos
           na próxima sessão") e quem pede é uma linha lá dentro ("Traga pelo
           menos três situações que aconteceram durante a semana").
         Sem esta segunda metade o paciente lê um cabeçalho de agenda no lugar
         da tarefa, e não sabe o que escrever.

         `semNumero` porque a seção vem numerada pelo terapeuta e a página do
         paciente numera de novo — o rótulo sairia "Pergunta 1 — 1. Escolha…". */
      const rotulo = secaoAberta.tituloPede
        ? semNumero(secaoAberta.titulo)
        : (secaoAberta.frasePedido || semNumero(secaoAberta.titulo));
      criarCampo(rotulo, "Escreva aqui a sua resposta desta etapa.");
    }
    secaoAberta = null;
  };

  for (; i < linhas.length; i++) {
    const l = linhas[i];
    if (l.tipo === "vazio") continue;

    if (l.tipo === "titulo" || l.tipo === "titulo-solto") {
      fecharSecao();
      emAbertura = false;
      secaoAberta = {
        titulo: l.texto,
        camposAntes: abertas.length,
        pedeRegistro: pedeRegistro(l.texto),
        tituloPede: pedeRegistro(l.texto),
        frasePedido: "",
      };
      roteiro.push({ tipo: "secao", titulo: l.texto });
      continue;
    }

    if (emAbertura) {
      /* Antes da primeira seção é a apresentação do desafio. Vai para
         `instrucoes`, que é onde o resto do sistema já procura o texto de
         abertura de um teste — inclusive a página do paciente. */
      const t = l.tipo === "item" ? "• " + l.texto : l.texto;
      aberturaTextos.push(t);
      continue;
    }

    /* --------------------------------------------- dentro de uma seção */
    if (l.tipo === "citacao") { roteiro.push({ tipo: "citacao", texto: l.texto }); continue; }

    if (l.tipo === "item") {
      const ultimo = roteiro[roteiro.length - 1];
      if (ultimo && ultimo.tipo === "lista") ultimo.itens.push(l.texto);
      else roteiro.push({ tipo: "lista", itens: [l.texto] });
      continue;
    }

    const t = l.texto;

    if (ehPergunta(t)) { criarCampo(semNumero(t)); continue; }
    if (temLacuna(t)) {
      criarCampo(semNumero(t), "Complete a frase com o que aconteceu com você.");
      continue;
    }
    if (l.tipo === "numerado") {
      /* Numerado que não é pergunta nem lacuna é enumeração de orientação —
         "1. Escolha uma tarefa" já virou seção; aqui sobra o texto corrido. */
      roteiro.push({ tipo: "paragrafo", texto: l.numero + ". " + t });
      continue;
    }
    roteiro.push({ tipo: "paragrafo", texto: t });
    if (pedeRegistro(t)) {
      secaoAberta.pedeRegistro = true;
      /* A PRIMEIRA frase que pede alguma coisa fica guardada como candidata a
         rótulo — as seguintes não sobrescrevem, porque num texto de terapeuta
         a primeira é o pedido e as demais costumam ser o abrandamento
         ("Não precisa trazer uma semana perfeita"). */
      if (!secaoAberta.frasePedido) secaoAberta.frasePedido = t;
    }
  }
  fecharSecao();

  /* -------------------------------------------------------------- avisos */
  if (!abertas.length) {
    avisos.push("Não encontrei nenhuma pergunta ou pedido de registro no texto. " +
      "Do jeito que está, o paciente vai ler o desafio sem ter onde responder.");
  }
  if (abertas.length > 30) {
    avisos.push(`Interpretei ${abertas.length} campos — é muita coisa para responder de uma vez. ` +
      "Confira se algum exemplo virou pergunta por engano.");
  }
  if (!subtitulo && titulo && /^desafio/i.test(titulo)) {
    avisos.push("O título é genérico. Vale dar um nome que diga do que é o desafio, " +
      "para você o encontrar na lista daqui a um mês.");
  }
  const gigantes = abertas.filter((a) => a.length > 160);
  if (gigantes.length) {
    avisos.push("Um rótulo de campo ficou muito longo — provavelmente um parágrafo " +
      "inteiro virou pergunta. Confira na visualização abaixo.");
  }

  return {
    nome: nome.slice(0, 120),
    titulo,
    subtitulo,
    instrucoes: aberturaTextos.join("\n").slice(0, 4000),
    roteiro,
    abertas,
    avisos,
  };
}

/* ==========================================================================
   O MODELO, no mesmo formato dos 13 rastreios

   É esta função que faz o desafio atravessar o sistema inteiro sem ninguém
   precisar saber que ele é um desafio: `secoes` vazio (não há escala para
   somar), `abertas` com os campos, `terapeuta` vazio. Quem lê modelo de teste
   continua lendo modelo de teste.
   ========================================================================== */
function modeloDoDesafio(chave, estrutura, nome, instrucoes) {
  const e = estrutura || {};
  return {
    chave,
    sigla: "",
    nome: nome || e.nome || "Desafio",
    instrucoes: instrucoes || e.instrucoes || "",
    tipo: "desafio",
    escala: [],
    secoes: [],
    abertas: Array.isArray(e.abertas) ? e.abertas : [],
    roteiro: Array.isArray(e.roteiro) ? e.roteiro : [],
    terapeuta: [],
  };
}

module.exports = { interpretarDesafio, modeloDoDesafio, classificar, _limpar: limpar };
