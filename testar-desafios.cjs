/* ==========================================================================
   DESAFIOS — do texto colado até a resposta do paciente

       node testar-desafios.cjs

   Duas metades, e a primeira nem toca no banco:

     1. o INTERPRETADOR, em cima do texto de verdade que o cliente mandou (o
        desafio de TDAH sobre adiamento). É a parte que decide o que vira
        campo, e é onde um engano custa um formulário errado na mão de um
        paciente. Aqui ela é conferida rótulo por rótulo;

     2. o CAMINHO INTEIRO: criar pela rota, enviar, abrir o link, responder,
        e conferir que a clínica lê de volta o que foi escrito.

   SOBRE OS DADOS: tudo leva `ZZ QA` e sai APAGADO POR ID no fim — nunca por
   `LIKE`. O banco é o mesmo do cliente.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Q, carregarAmbiente } = require("./pg.js");
const { cifrar } = require("./cripto.js");
const { interpretarDesafio } = require("./desafios.js");

carregarAmbiente(__dirname);

/* Porta própria: 5296 é da suíte de rastreio, 5297 da de campo vazio. Duas
   suítes na mesma porta passam sozinhas e falham juntas. */
const PORTA = Number(process.env.PORTA_TESTE_DESAFIO) || 5298;
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = "zz-qa-desafio-2026";
const EMAIL_ADM = "zz_qa_desafio_adm@qa.local";

/* Fica fora do projeto e é apagado no fim: é estado de teste, não do site.
   O CI passa o caminho por `LIMITES_ARQUIVO`; localmente vai para o temporário
   do sistema. */
const LIMITES = process.env.LIMITES_ARQUIVO || require("node:path").join(
  require("node:os").tmpdir(), "zz-qa-limites-desafio.json");

const CRIADO = { teste_envios: [], testes: [], pacientes: [], g_usuarios: [] };
const ANTES = {};
const TABELAS_CONTADAS = ["teste_envios", "testes", "pacientes", "g_usuarios"];
let passou = 0, falhou = 0; const falhas = [];
let servidor = null, saida = "";

const ok = (c, t, d) => { if (c) { passou++; return true; }
  falhou++; falhas.push(t + (d !== undefined ? "  → " + d : "")); return false; };
const eq = (a, b, t) => ok(a === b, t, `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
const secao = (t) => console.log("\n  " + t);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), sal, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString("hex")}$${dk.toString("hex")}`;
}

/* ==========================================================================
   O TEXTO DO CLIENTE — palavra por palavra

   É o desafio que o cliente colou no pedido. Fica aqui inteiro, e não num
   arquivo ao lado, porque É a especificação: quando a interpretação mudar,
   é este texto que diz se ela melhorou ou piorou.
   ========================================================================== */
const TEXTO_TDAH = `DESAFIO TERAPÊUTICO DA SEMANA

TDAH — OBSERVAR O QUE ACONTECE ANTES DE DEIXAR PARA DEPOIS

Durante esta semana, você não precisa tentar mudar tudo.

A proposta é *observar como o TDAH interfere no seu dia a dia*, principalmente nos momentos em que você sabe que precisa fazer alguma coisa, mas acaba adiando, esquecendo ou se distraindo.

### 1. Escolha uma tarefa por dia

Todos os dias, escolha *apenas uma tarefa que você costuma adiar*.

Pode ser algo simples, como:

* responder uma mensagem;
* organizar alguma coisa;
* pagar uma conta;
* estudar;
* fazer uma atividade doméstica.

### 2. Antes de começar, pare por 1 minuto

Pergunte a si mesmo:

*"Eu sei que preciso fazer isso. O que está me fazendo querer deixar para depois?"*

Não precisa encontrar uma resposta perfeita.

Pode ser:

> "Estou sem vontade."

> "Parece difícil."

> "Não sei por onde começar."

Anote apenas uma frase.

### 3. Faça somente os primeiros 5 minutos

Não pense:

*"Preciso terminar tudo."*

Pense:

*"Vou fazer somente 5 minutos."*

O objetivo desta semana *não é terminar tudo*.

### 4. Observe as distrações

Quando perceber que sua atenção foi embora, não se critique.

Apenas registre:

*"Eu estava fazendo __ e comecei a __."*

Exemplo:

> "Eu estava respondendo os e-mails e comecei a mexer no celular."

### 5. No final do dia, responda três perguntas

*1. O que eu tinha planejado fazer?*

*2. O que realmente aconteceu?*

*3. O que eu senti quando não consegui fazer?*

### REGRA IMPORTANTE

Não transforme esse exercício em mais uma cobrança.

Se esquecer um dia, *não precisa compensar no dia seguinte*.

Apenas retome.

### Para conversarmos na próxima sessão

Traga pelo menos *três situações* que aconteceram durante a semana.

Não precisa trazer uma semana perfeita.`;

/* ========================================================================== */
function navegador() {
  const potes = new Map();
  return {
    potes,
    async vai(caminho, metodo = "GET", corpo) {
      const r = await fetch(BASE + caminho, {
        method: metodo,
        headers: Object.assign(
          { Cookie: [...potes].map(([k, v]) => `${k}=${v}`).join("; ") },
          corpo ? { "Content-Type": "application/json" } : {}),
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      for (const linha of r.headers.getSetCookie?.() || []) {
        const [par] = linha.split(";");
        const i = par.indexOf("=");
        potes.set(par.slice(0, i).trim(), par.slice(i + 1));
      }
      const txt = await r.text();
      let dados; try { dados = JSON.parse(txt); } catch { dados = txt; }
      return { status: r.status, dados };
    },
  };
}

async function subirServidor() {
  servidor = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORTA), NODE_ENV: "test",
      /* Arquivo de trava PRÓPRIO. A suíte erra a data de propósito; gravando
         no arquivo do sistema, cada execução deixaria bloqueio para a
         seguinte até a própria suíte não conseguir mais entrar. */
      LIMITES_ARQUIVO: LIMITES,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  servidor.stdout.on("data", (d) => { saida += d; });
  servidor.stderr.on("data", (d) => { saida += d; });

  const ate = Date.now() + 40_000;
  for (;;) {
    if (servidor.exitCode !== null) throw new Error("o servidor morreu:\n" + saida);
    try {
      /* 503 é o servidor de pé com a gestão ainda subindo — esperar o
         `/restrito` responder é o que evita a corrida de boot. */
      const r = await fetch(BASE + "/restrito/api/me");
      if (r.status !== 503) break;
    } catch { }
    if (Date.now() > ate) throw new Error("o servidor não subiu:\n" + saida);
    await new Promise((s) => setTimeout(s, 250));
  }
}

async function limpar() {
  for (const [tabela, ids] of Object.entries(CRIADO)) {
    for (const id of [...new Set(ids)].reverse()) {
      try { await Q.run(`DELETE FROM ${tabela} WHERE id=?`, id); } catch { }
    }
  }
}

async function rodar() {
  console.log("\n  DESAFIOS — do texto colado até a resposta do paciente\n");

  /* ======================================================================
     PARTE 1 — o interpretador, sem servidor e sem banco
     ====================================================================== */
  secao("1. o interpretador, em cima do texto do cliente");

  const r = interpretarDesafio(TEXTO_TDAH);
  ok(!r.erro, "o texto é aceito", r.erro);
  eq(r.titulo, "DESAFIO TERAPÊUTICO DA SEMANA", "o cabeçalho vira título");
  eq(r.nome, "TDAH — OBSERVAR O QUE ACONTECE ANTES DE DEIXAR PARA DEPOIS",
    "o NOME é a segunda linha — a que diz do que é o desafio");
  ok(r.instrucoes.includes("Durante esta semana"),
    "o texto antes da primeira seção vira a abertura");

  eq(r.abertas.length, 7, "sete campos — nem mais, nem menos");

  const esperados = [
    "Escolha uma tarefa por dia",
    "Eu sei que preciso fazer isso. O que está me fazendo querer deixar para depois?",
    "Eu estava fazendo ____ e comecei a ____.",
    "O que eu tinha planejado fazer?",
    "O que realmente aconteceu?",
    "O que eu senti quando não consegui fazer?",
    "Traga pelo menos três situações que aconteceram durante a semana.",
  ];
  esperados.forEach((e, i) => eq(r.abertas[i], e, `campo ${i + 1}`));

  secao("2. o que NÃO pode virar campo");

  const rotulos = r.abertas.join(" | ");
  ok(!/Estou sem vontade|Parece difícil|Não sei por onde começar/.test(rotulos),
    "as CITAÇÕES são exemplo de resposta, não pergunta");
  ok(!/responder uma mensagem|pagar uma conta|estudar/.test(rotulos),
    "a LISTA é repertório, não questionário");
  ok(!/cobrança|compensar no dia seguinte/.test(rotulos),
    "a seção que só orienta (REGRA IMPORTANTE) não vira campo");
  ok(!/Preciso terminar tudo|Vou fazer somente 5 minutos/.test(rotulos),
    "a seção 3 não pede registro nenhum — e nenhum campo é inventado nela");
  eq(r.abertas.filter((a) => /^\d+\./.test(a)).length, 0,
    "nenhum rótulo carrega a numeração da seção");

  secao("3. armadilhas de marcação");

  ok(r.abertas[2].includes("____"),
    "a LACUNA sobrevive à limpeza do negrito (`__ … __` do markdown)");
  /* Os sublinhados da LACUNA são conteúdo, não marcação — por isso saem da
     conta antes de procurar sobra de markdown. */
  ok(!/[*`]/.test(r.abertas.join("")) &&
     !/_/.test(r.abertas.join("").split("____").join("")),
    "nenhum rótulo carrega marcação de markdown (fora a lacuna)");
  ok(!/^"|"$/.test(r.abertas[1]), "as aspas que abraçam a frase inteira saem");

  const vazio = interpretarDesafio("   \n\n  ");
  ok(!!vazio.erro, "texto vazio é recusado com erro claro");

  const semPergunta = interpretarDesafio("MEDITAÇÃO\n\n### Todo dia\n\nRespire fundo por cinco minutos.");
  eq(semPergunta.abertas.length, 0, "texto que não pede nada não gera campo");
  ok(semPergunta.avisos.some((a) => /sem ter onde responder/.test(a)),
    "e AVISA, em vez de deixar criar um desafio mudo");

  /* O roteiro é a exibição: sem ele o paciente receberia sete perguntas
     soltas, sem a orientação que dá sentido a elas. */
  const secoes = r.roteiro.filter((b) => b.tipo === "secao").length;
  eq(secoes, 7, "as sete seções do texto viram sete seções no roteiro");
  ok(r.roteiro.some((b) => b.tipo === "lista"), "a lista de exemplos é preservada");
  ok(r.roteiro.some((b) => b.tipo === "citacao"), "as citações são preservadas");
  eq(r.roteiro.filter((b) => b.tipo === "campo").length, 7,
    "e os sete campos estão no roteiro, no lugar onde o texto os pede");

  /* ======================================================================
     PARTE 2 — o caminho inteiro
     ====================================================================== */
  await subirServidor();

  for (const t of TABELAS_CONTADAS) {
    ANTES[t] = Number((await Q.get(`SELECT COUNT(*) c FROM ${t}`)).c);
  }

  const admId = await Q.inserir(
    `INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado)
     VALUES(?,?,?,'admin',1,?) RETURNING id`,
    "ZZ QA Desafio Adm", EMAIL_ADM, hashSenha(SENHA), new Date().toISOString());
  CRIADO.g_usuarios.push(admId);

  /* A data de nascimento é a chave da porta do link — sem ela o envio nem é
     aceito. Cifrada na escrita, como qualquer campo protegido. */
  const NASCIMENTO = "1990-03-05";
  const pacId = await Q.inserir(
    `INSERT INTO pacientes(nome, codigo, nascimento, ativo, criado) VALUES(?,?,?,1,?) RETURNING id`,
    "ZZ QA Paciente Desafio", "PAC-9998-99998", cifrar(NASCIMENTO), new Date().toISOString());
  CRIADO.pacientes.push(pacId);

  const adm = navegador();
  await adm.vai("/restrito/api/login", "POST", { usuario: EMAIL_ADM, senha: SENHA });

  secao("4. interpretar NÃO cria nada");

  const antesDeInterpretar = Number((await Q.get("SELECT COUNT(*) c FROM testes")).c);
  const prev = await adm.vai("/restrito/api/desafios/interpretar", "POST", { texto: TEXTO_TDAH });
  eq(prev.status, 200, "a rota de interpretar responde");
  eq(prev.dados.abertas.length, 7, "e devolve os sete campos para a visualização");
  const depoisDeInterpretar = Number((await Q.get("SELECT COUNT(*) c FROM testes")).c);
  eq(depoisDeInterpretar, antesDeInterpretar,
    "e o catálogo continua do mesmo tamanho — visualizar não é criar");

  secao("5. criar, depois de aprovado");

  /* Sem paciente, a rota RECUSA: desafio sem dono não existe. */
  const semDono = await adm.vai("/restrito/api/desafios", "POST", { texto: TEXTO_TDAH, nome: "ZZ QA Sem Dono" });
  eq(semDono.status, 400, "criar desafio SEM paciente é recusado");

  const criado = await adm.vai("/restrito/api/desafios", "POST",
    { texto: TEXTO_TDAH, nome: "ZZ QA Desafio TDAH", paciente_id: pacId, nao_expira: true });
  eq(criado.status, 200, "o desafio é criado");
  eq(criado.dados.campos, 7, "com os sete campos");
  const linhaDesafio = await Q.get("SELECT * FROM testes WHERE chave=?", criado.dados.chave);
  ok(!!linhaDesafio, "e existe no catálogo");
  if (linhaDesafio) CRIADO.testes.push(linhaDesafio.id);
  eq(linhaDesafio && linhaDesafio.tipo, "desafio", "marcado como desafio, não como rastreio");

  eq(linhaDesafio && Number(linhaDesafio.paciente_id), pacId,
    "e com DONO: o desafio é daquele paciente, de mais ninguém");

  /* ====================================================================
     O DESAFIO NÃO ENTRA NO CATÁLOGO.

     Foi escrito olhando para um caso. Oferecê-lo na lista do "Enviar teste"
     seria convidar a mandar a outra pessoa a tarefa pensada para esta — e
     encheria a tela de Cadastros com uma linha por semana por paciente.
     ==================================================================== */
  const catalogo = await adm.vai("/restrito/api/modelos-teste");
  ok(!catalogo.dados.itens.some((t) => t.chave === criado.dados.chave),
    "o desafio NÃO aparece na lista de escolha do envio");
  eq(catalogo.dados.itens.length, 13, "que continua com os treze rastreios, e só");

  const crud = await adm.vai("/restrito/api/testes");
  ok(!crud.dados.some((t) => t.chave === criado.dados.chave),
    "nem no cadastro de Testes");

  /* CRIAR JÁ ENVIA: o desafio existe para ser feito nesta semana, e guardá-lo
     "para depois" só criaria um rascunho perdido no sistema. */
  eq(criado.dados.campos, 7, "com a contagem certa de campos");
  ok(!!criado.dados.codigo, "e já sai com o link do paciente");
  CRIADO.teste_envios.push(criado.dados.envio_id);
  const codigo = criado.dados.codigo;
  const envio = { dados: { id: criado.dados.envio_id, codigo } };

  secao("6. a porta do link — a data de nascimento");

  const anon = navegador();

  /* ====================================================================
     A CONFERÊNCIA VEM ANTES DE QUALQUER CONTEÚDO.

     Não é só sobre as respostas: até aqui o link entregava o NOME DO PACIENTE
     e o NOME DO TESTE a quem quer que o tivesse. "Rastreio de TDAH" é
     diagnóstico, e ele saía antes de qualquer barreira.
     ==================================================================== */
  const fechado = await anon.vai("/api/answer/" + codigo);
  eq(fechado.dados.estado, "verificar", "sem provar quem é, o link pede verificação");
  eq(fechado.dados.tratamento, undefined, "e NÃO entrega o nome do paciente");
  eq(fechado.dados.teste, undefined, "nem o nome do teste — que é diagnóstico");

  const pulando = await anon.vai("/api/answer/" + codigo + "/iniciar", "POST");
  eq(pulando.status, 401, "pular a tela e chamar `iniciar` direto NÃO passa");
  eq(pulando.dados.estado, "verificar", "a porta vale em todas as rotas, não só na primeira");

  const errada = await anon.vai("/api/answer/" + codigo + "/entrar", "POST",
    { nascimento: "01/01/1980" });
  eq(errada.status, 401, "data errada é recusada");
  eq(errada.dados.teste, undefined, "e a recusa não conta nada sobre o envio");

  /* A trava faz esperar depois do erro — é ela que impede varrer as datas.
     Esperar aqui é reconhecer que ela funcionou. */
  await new Promise((s) => setTimeout(s, 2200));

  const certa = await anon.vai("/api/answer/" + codigo + "/entrar", "POST",
    { nascimento: "05/03/1990" });
  eq(certa.status, 200, "a data certa abre — inclusive escrita como dd/mm/aaaa");
  eq(certa.dados.estado, "ok", "e o conteúdo aparece");
  ok(!!anon.potes.get("acesso_" + codigo), "o aparelho recebe o passe e não pergunta de novo");

  const emISO = navegador();
  await emISO.vai("/api/answer/" + codigo + "/entrar", "POST", { nascimento: "1990-03-05" });
  ok(!!emISO.potes.get("acesso_" + codigo),
    "a mesma data em AAAA-MM-DD também abre (o banco guarda assim, o paciente digita ao contrário)");

  secao("7. o desafio REABRE, e o que foi escrito continua lá");

  const estado = await anon.vai("/api/answer/" + codigo);
  eq(estado.dados.estado, "ok", "o link abre");
  eq(estado.dados.tipo, "desafio", "e a página sabe que é um desafio");
  eq(estado.dados.total, 7, "com sete campos a responder");

  const inicio = await anon.vai("/api/answer/" + codigo + "/iniciar", "POST");
  eq(inicio.dados.itens.length, 7, "o formulário chega com os sete campos");
  ok(inicio.dados.roteiro.length > 20,
    "e com o ROTEIRO — a orientação do terapeuta, não só as perguntas");
  ok(inicio.dados.roteiro.some((b) => b.tipo === "citacao"),
    "inclusive os exemplos, que são o que faz a pergunta ser entendida");

  /* ====================================================================
     A SEMANA DO PACIENTE, em três atos: escreve na terça, some, volta na
     quinta e encontra o que escreveu. Sem isto, "reabrir" seria recomeçar —
     e reabrir para recomeçar é pior do que não reabrir.
     ==================================================================== */
  const terca = { a0: "Responder os e-mails do trabalho.", a1: "Medo de começar." };
  const guardou = await anon.vai("/api/answer/" + codigo + "/rascunho", "POST",
    { respostas: terca });
  eq(guardou.status, 200, "o que foi escrito na terça é guardado");
  eq(guardou.dados.guardadas, 2, "dois campos");

  const quinta = await anon.vai("/api/answer/" + codigo);
  eq(quinta.dados.estado, "ok", "na quinta o link ABRE de novo");
  eq(quinta.dados.retomando, true, "e a tela sabe que é uma retomada");
  eq(quinta.dados.respondidas, 2, "dizendo quanto já foi escrito");

  const volta = await anon.vai("/api/answer/" + codigo + "/iniciar", "POST");
  eq(volta.dados.rascunho.a0, terca.a0, "o texto da terça volta para o campo");
  eq(volta.dados.rascunho.a1, terca.a1, "todo ele");

  const estranho = navegador();
  eq((await estranho.vai("/api/answer/" + codigo)).dados.estado, "verificar",
    "quem tem o link mas não o passe continua na porta, mesmo com o desafio em andamento");
  eq((await estranho.vai("/api/answer/" + codigo + "/rascunho", "POST",
    { respostas: { a0: "escrito por outra pessoa" } })).status, 401,
    "e não consegue escrever no rascunho de ninguém");

  /* O rascunho é trabalho em curso; a clínica não pode lê-lo como resposta. */
  const meio = await adm.vai("/restrito/api/teste-envios/" + envio.dados.id);
  eq(meio.dados.situacao, "aberto", "para a clínica ele está ABERTO, não concluído");
  eq(meio.dados.respondidas, 0,
    "e o rascunho NÃO aparece como resposta — o que está pela metade não vira material de sessão");

  secao("8. responder e ler de volta");

  const RESP = {
    a0: "Responder os e-mails do trabalho.",
    a1: "Acho que é medo de começar e ver que é maior do que parece.",
    a2: "Eu estava fazendo o relatório e comecei a arrumar a mesa.",
    a3: "Tinha planejado terminar o relatório de manhã.",
    a4: "Fiz vinte minutos e parei quando chegou uma mensagem.",
    a5: "Fiquei irritado comigo, mas menos do que das outras vezes.",
    a6: "Terça de manhã, quinta à tarde e sábado com as contas.",
  };

  const faltando = await anon.vai("/api/answer/" + codigo + "/concluir", "POST",
    { respostas: { a0: RESP.a0 } });
  /* A rota traduz o erro para `estado` — o mesmo vocabulário que a página do
     paciente já usa para "vencido" e "concluído". */
  eq(faltando.status, 409, "formulário pela metade é recusado NO SERVIDOR");
  eq(faltando.dados.estado, "incompleto", "e diz que está incompleto");
  eq(faltando.dados.faltam, 6, "informando quantos campos faltam");

  const fim = await anon.vai("/api/answer/" + codigo + "/concluir", "POST", { respostas: RESP });
  ok(fim.dados.ok, "respondido por inteiro, conclui");

  const det = await adm.vai("/restrito/api/teste-envios/" + envio.dados.id);
  eq(det.dados.situacao, "concluido", "a clínica vê como concluído");
  eq(det.dados.respondidas, 7, "com as sete respostas");
  eq(det.dados.soma_maxima, 0,
    "e SEM pontuação: desafio não tem escala, e 'NaN pontos' seria o erro fácil aqui");
  eq(det.dados.itens[1].resposta, RESP.a1, "o acento volta íntegro do banco cifrado");
  eq(det.dados.itens[2].pergunta, "Eu estava fazendo ____ e comecei a ____.",
    "e a pergunta lida é a que foi interpretada");

  secao("9. depois de concluído, o link fecha");

  eq((await anon.vai("/api/answer/" + codigo)).dados.estado, "concluido",
    "reabrir depois de concluir não abre mais — o marco de 'terminei' é da clínica");
  eq((await anon.vai("/api/answer/" + codigo + "/rascunho", "POST",
    { respostas: { a0: "mudei de ideia" } })).status, 409,
    "e nem o rascunho aceita mudança depois disso");
  const semRascunho = await Q.get("SELECT rascunho FROM teste_envios WHERE id=?", envio.dados.id);
  eq(semRascunho.rascunho, null,
    "o rascunho é APAGADO ao concluir — duas cópias criariam a pergunta 'qual vale?'");

  secao("10. sem data de nascimento, não há fechadura");

  const semData = await Q.inserir(
    `INSERT INTO pacientes(nome, codigo, ativo, criado) VALUES(?,?,1,?) RETURNING id`,
    "ZZ QA Paciente Sem Data", "PAC-9998-99997", new Date().toISOString());
  CRIADO.pacientes.push(semData);
  const barrado = await adm.vai("/restrito/api/teste-envios", "POST",
    { paciente_id: semData, teste_chave: criado.dados.chave, nao_expira: true });
  eq(barrado.status, 409, "enviar para quem não tem data cadastrada é BARRADO");
  ok(/data de nascimento/i.test(barrado.dados.error || ""),
    "com a frase que diz o que fazer, em vez de um link que ninguém abre");

  secao("11. o desafio não vira rastreio por engano");

  const rastreios = catalogo.dados.itens.filter((t) => t.tipo !== "desafio");
  eq(rastreios.length, 13, "os treze rastreios continuam lá, intocados");
  ok(rastreios.every((t) => t.perguntas > 0), "e todos continuam com suas perguntas");
}

(async () => {
  try {
    await rodar();
  } catch (e) {
    falhou++; falhas.push("EXPLODIU: " + e.message + "\n" + e.stack);
  } finally {
    try { await limpar(); } catch { }
    try { require("node:fs").unlinkSync(LIMITES); } catch { }
    if (servidor) { try { servidor.kill("SIGTERM"); } catch { } }

    /* A contagem é quem denuncia o que a limpeza não anotou. */
    for (const t of TABELAS_CONTADAS) {
      if (ANTES[t] === undefined) continue;
      try {
        const agora = Number((await Q.get(`SELECT COUNT(*) c FROM ${t}`)).c);
        if (agora !== ANTES[t]) {
          falhou++;
          falhas.push(`RESÍDUO em ${t}: antes ${ANTES[t]}, depois ${agora}`);
        }
      } catch { }
    }

    console.log("\n  " + "─".repeat(58) + "\n");
    if (falhou) {
      console.log(`  ✖ ${passou} passaram, ${falhou} falharam:\n`);
      for (const f of falhas) console.log("     · " + f);
      console.log("");
      process.exitCode = 1;
    } else {
      console.log(`  ✔ ${passou}/${passou} — o desafio vai do texto colado à resposta do paciente\n`);
    }
    try { await Q.fechar?.(); } catch { }
    process.exit(process.exitCode || 0);
  }
})();
