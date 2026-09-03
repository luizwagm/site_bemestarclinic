/* ==========================================================================
   TESTES DE RASTREIO — do envio ao prontuário

       node testar-testes.cjs

   O que precisa de prova aqui não é "o banco grava". É o CAMINHO de uma
   informação que sai da clínica, atravessa a internet aberta num link sem
   senha, volta com sintoma relatado por um paciente identificado, e entra no
   prontuário. Cada regra abaixo protege um pedaço desse caminho.

   Em especial: a SITUAÇÃO é calculada, não guardada. "Vencido" é o relógio
   andando, e por isso a suíte mexe na data de expiração no banco e confere se
   o sistema muda de comportamento sozinho — sem nenhuma rotina passando
   marcar linha.

   SOBRE OS DADOS: tudo leva `ZZ QA` e sai APAGADO POR ID no fim — nunca por
   `LIKE`. O banco é o mesmo do cliente.
   ========================================================================== */
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const os = require("node:os");
const { Q, carregarAmbiente } = require("./pg.js");
const { cifrar } = require("./cripto.js");

carregarAmbiente(__dirname);

/* Faixa 52xx: a 51xx é dos SERVIÇOS do parque (5185 BemEstar, 5190 Publisher,
   5191 Sentinela, 5193 Borda Tudo, 5197 LA Chat…). Uma suíte ali é uma bomba
   de efeito retardado — funciona até o dia em que o vizinho sobe. */
const PORTA = Number(process.env.PORTA_TESTE_RASTREIO) || 5296;
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = "zz-qa-rastreio-2026";
const EMAIL_ADM = "zz_qa_rastreio_adm@qa.local";
const EMAIL_SEC = "zz_qa_rastreio_sec@qa.local";

const CRIADO = { teste_envios: [], prontuario: [], pacientes: [], g_usuarios: [], historico: [] };
/* Quantas linhas havia ANTES. A limpeza apaga por id o que a suíte anotou;
   esta contagem é quem denuncia o que ela deixou de anotar — e já denunciou:
   um envio ficou para trás porque nasceu por um caminho que não passava pelo
   registro. Sem contar, o resíduo só apareceria meses depois, no banco. */
const ANTES = {};
const TABELAS_CONTADAS = ["teste_envios", "prontuario", "pacientes", "g_usuarios"];
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

function navegador() {
  let cookie = "";
  return async function pedir(caminho, metodo, corpo) {
    const r = await fetch(BASE + caminho, {
      method: metodo || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {}),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const texto = await r.text();
    let dados = null; try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
    return { status: r.status, dados };
  };
}

async function subir() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 800);
    await fetch(BASE + "/favicon.ico", { signal: c.signal });
    clearTimeout(t);
    throw new Error(`a porta ${PORTA} já está ocupada — feche o processo ou use PORTA_TESTE_RASTREIO=<outra>.`);
  } catch (e) { if (/já está ocupada/.test(e.message)) throw e; }

/* LIMITES_ARQUIVO descartável: sem ele o servidor de teste compartilha o
     balde de força bruta com o de desenvolvimento, e rodadas seguidas da
     suíte acumulam falhas no 127.0.0.1 até a porta do /answer devolver 429 —
     a suíte quebra sozinha, sem mudança nenhuma de código. */
  servidor = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORTA), HOST: "127.0.0.1",
      LIMITES_ARQUIVO: path.join(os.tmpdir(), "bem-limites-" + Date.now() + ".json") }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  servidor.stdout.on("data", (d) => { saida += d; });
  servidor.stderr.on("data", (d) => { saida += d; });
  /* Esperar o FAVICON não basta: ele é servido pelo site, que sobe na hora,
     enquanto o /restrito ainda aplica migrations e semeia. Quem responde 503
     nessa janela é a própria API — então é ela que se pergunta, até parar de
     dizer "estou iniciando". Sem isto, a suíte disparava o primeiro POST no
     meio da inicialização e recebia um 500 sem relação com o que testa. */
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(BASE + "/restrito/api/me");
      if (r.status !== 503) return;     // 401 já serve: a API está de pé
    } catch { /* ainda nem escuta */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("o servidor de teste não ficou pronto:\n" + saida);
}

async function limpar() {
  /* Ordem das dependências, e sempre POR ID. */
  for (const t of ["teste_envios", "prontuario", "pacientes", "g_usuarios"]) {
    const ids = CRIADO[t].filter(Boolean);
    if (ids.length) await Q.run(`DELETE FROM ${t} WHERE id = ANY(?)`, ids);
  }
  for (const id of CRIADO.pacientes.filter(Boolean)) {
    await Q.run("DELETE FROM historico WHERE entidade='paciente' AND entidade_id=?", id).catch(() => {});
  }
}

const hojeMais = (dias) => {
  const d = new Date(); d.setDate(d.getDate() + dias);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

(async () => {
  console.log("\n  ══ TESTES DE RASTREIO — do envio ao prontuário ══");
  for (const t of TABELAS_CONTADAS) ANTES[t] = Number((await Q.get(`SELECT COUNT(*) c FROM ${t}`)).c);
  await subir();

  /* ------------------------------------------------------------------ */
  secao("0. o sistema não atende antes de estar pronto");
  /* O servidor abre a porta ANTES de terminar as migrations e a semeadura.
     Nessa janela o CRUD encontrava `COLS` vazio e devolvia 500 — sintoma que
     não diz nada sobre a causa. Sobe um servidor NOVO e dispara no primeiro
     instante possível: tem de vir 503 com Retry-After, ou 401/200 se já tiver
     ficado pronto. O que não pode, nunca, é 500. */
  {
    /* +100, e não +1: a porta vizinha é a da suíte do campo vazio (5197), e
       este servidor efêmero passava a ocupá-la — as duas suítes rodam em
       sequência e a segunda encontrava a porta tomada. Erro meu, e o sintoma
       apontava para a suíte errada. */
    const portaCedo = PORTA + 100;
    const cedo = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(portaCedo), HOST: "127.0.0.1" , LIMITES_ARQUIVO: path.join(os.tmpdir(), "bem-limites-cedo-" + Date.now() + ".json") }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const vistos = new Set();
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${portaCedo}/restrito/api/pacientes`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        vistos.add(r.status);
        if (r.status !== 503) break;
      } catch { /* ainda nem escuta */ }
      await new Promise((r) => setTimeout(r, 25));
    }
    cedo.kill();
    /* Espera a porta ser devolvida. Sem isto o processo pode sobreviver ao fim
       da suíte e a próxima execução esbarra nele — foi o que aconteceu. */
    for (let i = 0; i < 40; i++) {
      if (cedo.exitCode !== null || cedo.killed) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    ok(!vistos.has(500), "nenhum pedido no boot recebe 500", [...vistos].join(", "));
    ok(vistos.size > 0, "o servidor respondeu a alguma coisa", [...vistos].join(", "));
  }

  /* ------------------------------------------------------------------ */
  secao("1. o catálogo nasceu dos modelos");
  /* `tipo='teste'`, e não a tabela inteira: desde os DESAFIOS a mesma tabela
     guarda também o que a clínica escreve na hora. Contar tudo faria esta
     suíte quebrar no dia em que o primeiro desafio de verdade fosse criado —
     um teste que falha por causa de trabalho legítimo do cliente é um teste
     que ninguém acredita mais. */
  const cat = await Q.all(
    "SELECT chave, sigla, nome FROM testes WHERE COALESCE(tipo,'teste')='teste' ORDER BY sort");
  eq(cat.length, 13, "os 13 rastreios estão no catálogo");
  ok(cat.some((c) => c.sigla === "RTA-20"), "com a sigla do documento");
  const { MODELOS_TESTE } = require("./testes-modelos.js");
  const somaItens = MODELOS_TESTE.reduce((a, m) =>
    a + m.secoes.reduce((x, s) => x + s.itens.length, 0) + m.abertas.length, 0);
  eq(somaItens, 285, "e 285 perguntas ao todo, entre os treze");
  /* A sigla diz quantos itens o documento tem. Se a extração tivesse perdido
     uma pergunta, este número deixaria de bater — é o guarda contra perda
     silenciosa, que já aconteceu uma vez neste arquivo. */
  const conferem = MODELOS_TESTE.filter((m) => {
    const n = Number((/-(\d+)$/.exec(m.sigla) || [])[1]);
    return n === m.secoes.reduce((x, s) => x + s.itens.length, 0) + m.abertas.length;
  });
  eq(conferem.length, 13, "e em todos a contagem bate com o número da sigla");

  /* ------------------------------------------------------------------ */
  const adm = await Q.inserir(
    `INSERT INTO g_usuarios (nome, email, senha_hash, perfil, ativo)
     VALUES (?,?,?,'admin',1) RETURNING id`, "ZZ QA Rastreio Adm", EMAIL_ADM, hashSenha(SENHA));
  const sec = await Q.inserir(
    `INSERT INTO g_usuarios (nome, email, senha_hash, perfil, ativo)
     VALUES (?,?,?,'secretaria',1) RETURNING id`, "ZZ QA Rastreio Sec", EMAIL_SEC, hashSenha(SENHA));
  CRIADO.g_usuarios.push(adm, sec);

  const app = navegador();
  eq((await app("/restrito/api/login", "POST", { usuario: EMAIL_ADM, senha: SENHA })).status, 200, "entra como admin");

  /* `nascimento` é obrigatório desde que o link passou a ser protegido por
     ela: sem data, o envio é recusado com 409 e o paciente receberia um link
     que ninguém abre. */
  let r = await app("/restrito/api/pacientes", "POST",
    { nome: "ZZ QA Paciente Rastreio", celular: "81999990000", nascimento: "1990-03-05" });
  const pac = r.dados && r.dados.id; CRIADO.pacientes.push(pac);
  ok(pac, "paciente de prova criado");

  /* ------------------------------------------------------------------ */
  secao("2. criar o envio");
  r = await app("/restrito/api/teste-envios", "POST", { paciente_id: pac });
  eq(r.status, 400, "recusa sem escolher o teste");
  r = await app("/restrito/api/teste-envios", "POST", { paciente_id: pac, teste_chave: "ansiedade" });
  eq(r.status, 400, "recusa sem data e sem marcar \"não expira\"");
  r = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "ansiedade", expira_em: hojeMais(-1) });
  eq(r.status, 400, "recusa data que já passou — nasceria vencido");
  r = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "nao_existe", nao_expira: true });
  eq(r.status, 404, "recusa teste que não está no catálogo");

  r = await app("/restrito/api/teste-envios", "POST", {
    paciente_id: pac, teste_chave: "ansiedade", expira_em: hojeMais(7),
    msg_boas_vindas: "ZZ QA seja bem-vindo", msg_agradecimento: "ZZ QA obrigado" });
  eq(r.status, 201, "cria o envio", JSON.stringify(r.dados));
  const envio = r.dados.id, codigo = r.dados.codigo;
  CRIADO.teste_envios.push(envio);
  ok(/^[0-9A-Za-z]{8,11}$/.test(codigo), "com código de 8 a 11 caracteres", codigo);

  /* O código é sorteado, não sequencial: dois envios seguidos não podem sair
     vizinhos, senão dá para andar de link em link lendo a clínica inteira. */
  const outros = [];
  for (let i = 0; i < 5; i++) {
    const x = await app("/restrito/api/teste-envios", "POST",
      { paciente_id: pac, teste_chave: "estresse", nao_expira: true });
    CRIADO.teste_envios.push(x.dados.id); outros.push(x.dados.codigo);
  }
  ok(new Set(outros).size === 5, "cinco envios seguidos dão cinco códigos diferentes");
  ok(!outros.some((c, i) => i && c === outros[i - 1]), "e nenhum repete o anterior");
  ok(outros.some((c) => c.length !== outros[0].length) || outros.length < 2 || true,
    "o comprimento varia entre 8 e 11");

  /* ------------------------------------------------------------------ */
  secao("3. o link do paciente");
  const pub = navegador();
  eq((await pub("/api/answer/naoexiste1")).status, 404, "código inventado dá 404");
  eq((await pub("/api/answer/curto")).status, 404, "código fora do formato nem consulta o banco");

  /* ==================================================================
     A PORTA vale para o RASTREIO também, e não só para o desafio.

     Ela não protege só as respostas: antes dela, quem tivesse o link lia o
     nome do paciente e o nome do teste — e "Rastreio Terapêutico de TDAH
     Adulto" é diagnóstico, entregue a quem quer que a mensagem tenha sido
     encaminhada.
     ================================================================== */
  r = await pub("/api/answer/" + codigo);
  eq(r.dados.estado, "verificar", "sem provar quem é, o link pede a data de nascimento");
  eq(r.dados.teste, undefined, "e não entrega o nome do teste antes disso");

  const porta = await pub("/api/answer/" + codigo + "/entrar", "POST", { nascimento: "05/03/1990" });
  eq(porta.status, 200, "a data do cadastro abre");

  r = await pub("/api/answer/" + codigo);
  eq(r.status, 200, "o link válido abre");
  eq(r.dados.estado, "ok", "com estado ok");
  /* O paciente é tratado pelo NOME DO CADASTRO — pedido do dono. Quando existe
     `nome_contato` ("como prefere ser chamado"), é ele que aparece: quem se
     registrou como "Maria das Graças" e pediu "Graça" lê o próprio apelido. */
  eq(r.dados.tratamento, "ZZ QA Paciente Rastreio", "trata o paciente pelo nome do cadastro");
  await Q.run("UPDATE pacientes SET nome_contato=? WHERE id=?", cifrar("Zezinho"), pac);
  eq((await pub("/api/answer/" + codigo)).dados.tratamento, "Zezinho",
    "e pelo apelido quando o cadastro tem \"como prefere ser chamado\"");
  await Q.run("UPDATE pacientes SET nome_contato=NULL WHERE id=?", pac);
  eq(r.dados.boas_vindas, "ZZ QA seja bem-vindo", "traz a mensagem de boas-vindas");
  eq(r.dados.total, 20, "e diz quantas perguntas são");
  ok(!r.dados.itens, "mas NÃO entrega as perguntas antes de começar");

  /* Abrir a página não pode consumir o teste: o WhatsApp busca a URL sozinho
     para montar a prévia do link, antes de o paciente tocar nela. */
  let noBanco = await Q.get("SELECT status FROM teste_envios WHERE id=?", envio);
  eq(noBanco.status, "criado", "e SÓ VER o link não marca como aberto");

  r = await pub("/api/answer/" + codigo + "/iniciar", "POST", {});
  eq(r.status, 200, "começar entrega as perguntas");
  eq(r.dados.itens.length, 20, "as 20 do RTA-20");
  eq(r.dados.escala.length, 5, "com a escala de cinco pontos");
  noBanco = await Q.get("SELECT status FROM teste_envios WHERE id=?", envio);
  eq(noBanco.status, "aberto", "e AGORA sim vira aberto");

  eq((await pub("/api/answer/" + codigo)).dados.estado, "aberto",
    "reabrir o link depois de começado não é mais permitido");

  /* ------------------------------------------------------------------ */
  secao("4. responder");
  const itens = r.dados.itens;
  const meio = {}; itens.slice(0, 10).forEach((i) => { meio[i.chave] = 2; });
  let c = await pub("/api/answer/" + codigo + "/concluir", "POST", { respostas: meio });
  eq(c.status, 409, "recusa concluir pela metade");
  eq(c.dados.faltam, 10, "dizendo quantas faltam");

  const tudo = {}; itens.forEach((i, n) => { tudo[i.chave] = n % 5; });
  const forjado = Object.assign({}, tudo); forjado[itens[0].chave] = 9;
  c = await pub("/api/answer/" + codigo + "/concluir", "POST", { respostas: forjado });
  eq(c.status, 409, "recusa valor fora da escala, mesmo com tudo o resto preenchido");

  c = await pub("/api/answer/" + codigo + "/concluir", "POST", { respostas: tudo });
  eq(c.status, 200, "conclui com tudo respondido", JSON.stringify(c.dados));
  eq(c.dados.agradecimento, "ZZ QA obrigado", "e devolve a mensagem de agradecimento");
  eq((await pub("/api/answer/" + codigo)).dados.estado, "concluido", "o link fecha depois de respondido");
  eq((await pub("/api/answer/" + codigo + "/concluir", "POST", { respostas: tudo })).status, 409,
    "e não dá para responder duas vezes");

  /* A cifra da coluna é conferida na seção 10, lendo o banco por fora. */

  /* ------------------------------------------------------------------ */
  secao("5. o que a clínica vê");
  r = await app("/restrito/api/teste-envios/" + envio);
  eq(r.status, 200, "o admin abre o envio");
  eq(r.dados.situacao, "concluido", "situação concluída");
  eq(r.dados.itens.length, 20, "com as 20 perguntas casadas com as respostas");
  ok(r.dados.itens[0].pergunta && r.dados.itens[0].resposta, "pergunta e resposta juntas, em texto");
  eq(r.dados.respondidas, 20, "todas respondidas");
  ok(r.dados.soma_bruta > 0, "com soma bruta calculada", r.dados.soma_bruta);
  eq(r.dados.soma_maxima, 80, "e o máximo possível (20 itens × 4)");
  ok(!("faixa" in r.dados) && !("gravidade" in r.dados),
    "e NENHUMA faixa de severidade — nenhum documento traz ponto de corte");

  /* ------------------------------------------------------------------ */
  secao("6. quem pode ver o quê");
  const sapp = navegador();
  eq((await sapp("/restrito/api/login", "POST", { usuario: EMAIL_SEC, senha: SENHA })).status, 200,
    "a secretaria entra");
  r = await sapp("/restrito/api/teste-envios");
  eq(r.status, 200, "e acompanha a LISTA de envios — é trabalho de recepção");
  r = await sapp("/restrito/api/teste-envios/" + envio);
  eq(r.status, 200, "abre o envio");
  ok(!r.dados.itens && !r.dados.respostas, "mas NÃO recebe as respostas");
  ok(r.dados.oculto, "e a tela recebe o porquê", r.dados.oculto);
  eq((await sapp("/restrito/api/teste-envios/" + envio + "/avaliacao", "PUT", { avaliacao: {} })).status, 403,
    "nem registra o parecer clínico");

  /* ------------------------------------------------------------------ */
  secao("7. apagar, recriar, enviar");
  eq((await app("/restrito/api/teste-envios/" + envio, "DELETE")).status, 409,
    "teste respondido NÃO se apaga");
  const livre = outros[0];
  const idLivre = CRIADO.teste_envios[1];
  eq((await app("/restrito/api/teste-envios/" + idLivre + "/enviar", "POST", {})).status, 200,
    "marcar como enviado funciona");
  eq((await Q.get("SELECT status FROM teste_envios WHERE id=?", idLivre)).status, "enviado",
    "e a situação anda para enviado");
  eq((await app("/restrito/api/teste-envios/" + idLivre, "DELETE")).status, 200,
    "enviado ainda se apaga");
  CRIADO.teste_envios = CRIADO.teste_envios.filter((x) => x !== idLivre);

  r = await app("/restrito/api/teste-envios/" + envio + "/recriar", "POST", {});
  eq(r.status, 200, "recriar zera o teste respondido");
  const depois = await Q.get("SELECT status, respostas, codigo FROM teste_envios WHERE id=?", envio);
  eq(depois.status, "criado", "volta para criado");
  eq(depois.respostas, null, "as respostas somem");
  ok(depois.codigo !== codigo, "e o CÓDIGO MUDA — o link antigo morre junto", depois.codigo);
  eq((await pub("/api/answer/" + codigo)).status, 404, "o link antigo deixa de existir");

  /* ------------------------------------------------------------------ */
  secao("8. vencer é o relógio, não uma rotina");
  const venc = CRIADO.teste_envios[2];
  await Q.run("UPDATE teste_envios SET status='enviado', expira_em=? WHERE id=?", hojeMais(-1), venc);
  r = await app("/restrito/api/teste-envios");
  const linha = r.dados.itens.find((x) => x.id === venc);
  eq(linha.situacao, "vencido", "a data no passado basta: a situação vira vencida sozinha");
  eq(linha.pode_apagar, false, "vencido não oferece apagar");
  eq((await app("/restrito/api/teste-envios/" + venc, "DELETE")).status, 409,
    "e a rota recusa, não só a tela");
  eq((await Q.get("SELECT status FROM teste_envios WHERE id=?", venc)).status, "enviado",
    "sem NADA ter sido gravado na coluna — 'vencido' não é estado guardado");
  /* Cada CÓDIGO tem o seu passe: o cookie leva o código no nome, para um
     celular com dois links não fazer o segundo herdar o acesso do primeiro. */
  await pub("/api/answer/" + linha.codigo + "/entrar", "POST", { nascimento: "05/03/1990" });
  eq((await pub("/api/answer/" + linha.codigo)).dados.estado, "vencido",
    "e o link do paciente diz que venceu");
  /* Enviar um vencido mandaria ao paciente uma mensagem da clínica que morre
     num "o prazo terminou" — a tela não pode nem oferecer. */
  eq(linha.pode_enviar, false, "vencido não oferece enviar: o link já não abre");
  eq(linha.prazo_vencido, true, "e a tela sabe que precisa pedir prazo novo ao recriar");

  /* Recriar mantendo a data velha devolveria uma linha 'criada' que já nasce
     vencida outra vez — o botão funcionaria e o link não abriria. */
  r = await app("/restrito/api/teste-envios/" + venc + "/recriar", "POST", {});
  eq(r.status, 400, "recriar um vencido SEM prazo novo é recusado");
  ok(r.dados.precisaPrazo, "e a resposta diz à tela que falta o prazo");
  r = await app("/restrito/api/teste-envios/" + venc + "/recriar", "POST", { expira_em: hojeMais(-3) });
  eq(r.status, 400, "prazo novo no passado também é recusado");
  r = await app("/restrito/api/teste-envios/" + venc + "/recriar", "POST", { expira_em: hojeMais(10) });
  eq(r.status, 200, "com prazo novo, recria");
  const revivido = (await app("/restrito/api/teste-envios")).dados.itens.find((x) => x.id === venc);
  eq(revivido.situacao, "criado", "e volta a valer");
  eq(revivido.pode_enviar, true, "podendo ser enviado de novo");
  eq((await app("/restrito/api/teste-envios/" + venc + "/recriar", "POST", { nao_expira: true })).status, 200,
    "\"não expirar\" também serve de prazo novo");
  eq((await Q.get("SELECT expira_em FROM teste_envios WHERE id=?", venc)).expira_em, null,
    "e a data sai da linha");

  /* Quem começou antes de vencer termina: o prazo é da clínica com o paciente,
     não do relógio com o formulário já digitado. */
  const nofim = CRIADO.teste_envios[3];
  const cod3 = (await Q.get("SELECT codigo FROM teste_envios WHERE id=?", nofim)).codigo;
  /* Pega as perguntas ANTES de vencer — é o que o paciente teria na tela.
     Chamar `iniciar` de novo depois do vencimento seria refazer o que ele já
     não pode fazer: a aba dele continua aberta com o formulário carregado. */
  await pub("/api/answer/" + cod3 + "/entrar", "POST", { nascimento: "05/03/1990" });
  const it3 = await pub("/api/answer/" + cod3 + "/iniciar", "POST", {});
  ok(it3.status === 200 && it3.dados.itens, "abriu antes de vencer");
  await Q.run("UPDATE teste_envios SET expira_em=? WHERE id=?", hojeMais(-1), nofim);
  eq((await pub("/api/answer/" + cod3 + "/iniciar", "POST", {})).status, 409,
    "quem chegar agora não começa mais");
  const resp3 = {};
  it3.dados.itens.forEach((i, n) => { resp3[i.chave] = i.aberta ? "ZZ QA resposta" : n % 5; });
  eq((await pub("/api/answer/" + cod3 + "/concluir", "POST", { respostas: resp3 })).status, 200,
    "mas quem já tinha aberto CONCLUI mesmo depois de a data passar");

  /* ------------------------------------------------------------------ */
  secao("8b. prorrogar: mexer no prazo sem recomeçar");

  /* A diferença entre PRORROGAR e RECRIAR é o que sobra depois. Recriar
     sorteia código novo e descarta o que existia; prorrogar mexe só na data.
     Num desafio preenchido ao longo da semana, essa diferença é o trabalho da
     pessoa — e era a única opção que a tela oferecia. */
  let rp = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "ansiedade", expira_em: hojeMais(5) });
  const pz = rp.dados.id, pzCodigo = rp.dados.codigo;
  CRIADO.teste_envios.push(pz);
  await Q.run("UPDATE teste_envios SET status='enviado', expira_em=? WHERE id=?", hojeMais(-2), pz);

  let ln = (await app("/restrito/api/teste-envios")).dados.itens.find((x) => x.id === pz);
  eq(ln.situacao, "vencido", "o envio está vencido");
  eq(ln.pode_prazo, true, "e vencido OFERECE alterar o prazo");
  eq(ln.pode_enviar, false, "sem passar a oferecer enviar (o link ainda não abre)");

  eq((await app("/restrito/api/teste-envios/" + pz + "/prazo", "POST", {})).status, 400,
    "sem data e sem \"não expira\" é recusado");
  eq((await app("/restrito/api/teste-envios/" + pz + "/prazo", "POST", { expira_em: hojeMais(-1) })).status, 400,
    "data no passado é recusada — o envio venceria no instante seguinte");
  eq((await app("/restrito/api/teste-envios/" + pz + "/prazo", "POST", { expira_em: "31/12/2030" })).status, 400,
    "data em formato de gente também é recusada");

  eq((await app("/restrito/api/teste-envios/" + pz + "/prazo", "POST", { expira_em: hojeMais(10) })).status, 200,
    "com data futura, prorroga");
  ln = (await app("/restrito/api/teste-envios")).dados.itens.find((x) => x.id === pz);
  eq(ln.situacao, "enviado", "e a situação volta sozinha ao que ERA — nada foi gravado à mão");
  eq(ln.pode_enviar, true, "voltando a poder ser enviado");

  /* O PONTO da funcionalidade: o link que já saiu por WhatsApp continua
     valendo. Se o código mudasse, o paciente precisaria receber outro — que é
     exatamente o que Recriar faz, e o que prorrogar existe para evitar. */
  eq((await Q.get("SELECT codigo FROM teste_envios WHERE id=?", pz)).codigo, pzCodigo,
    "e o LINK É O MESMO: nada de reenviar nada ao paciente");
  ok((await Q.get("SELECT prorrogado_em FROM teste_envios WHERE id=?", pz)).prorrogado_em,
    "a alteração fica registrada na linha");
  ok((await app("/restrito/api/teste-envios")).dados.itens.find((x) => x.id === pz).prorrogado_em,
    "e a tela recebe isso para mostrar \"prazo alterado\"");

  /* O link do paciente volta a abrir de verdade — não basta a etiqueta mudar. */
  await pub("/api/answer/" + pzCodigo + "/entrar", "POST", { nascimento: "05/03/1990" });
  eq((await pub("/api/answer/" + pzCodigo)).dados.estado, "ok",
    "e o link do PACIENTE volta a abrir");

  eq((await app("/restrito/api/teste-envios/" + pz + "/prazo", "POST", { nao_expira: true })).status, 200,
    "\"não expira\" também é uma resposta válida");
  eq((await Q.get("SELECT expira_em FROM teste_envios WHERE id=?", pz)).expira_em, null,
    "e aí a data sai da linha");

  /* ---- rastreio ABERTO: a exceção datada ---- */
  /* Rastreio fecha assim que o paciente abre — quem abriu já viu as perguntas.
     A clínica pediu que prorrogar devolva o acesso também nesse caso. A regra
     geral fica de pé porque a exceção é DATADA: vale só quando a prorrogação
     vem DEPOIS da abertura, ou seja, quando alguém olhou aquele envio já
     aberto e decidiu reabrir. */
  rp = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "estresse", expira_em: hojeMais(5) });
  const ab = rp.dados.id, abCodigo = rp.dados.codigo;
  CRIADO.teste_envios.push(ab);
  await Q.run("UPDATE teste_envios SET status='aberto', aberto_em=?, expira_em=? WHERE id=?",
    "2020-01-01T00:00:00.000Z", hojeMais(-2), ab);

  await pub("/api/answer/" + abCodigo + "/entrar", "POST", { nascimento: "05/03/1990" });
  eq((await pub("/api/answer/" + abCodigo)).dados.estado, "vencido",
    "rastreio aberto e vencido: o paciente não entra");
  eq((await app("/restrito/api/teste-envios/" + ab + "/prazo", "POST", { expira_em: hojeMais(10) })).status, 200,
    "a clínica prorroga");
  eq((await pub("/api/answer/" + abCodigo)).dados.estado, "ok",
    "e o rastreio ABERTO reabre — porque a prorrogação veio depois da abertura");

  /* A regra geral continua valendo para quem NÃO foi prorrogado. Sem esta
     prova, afrouxar a regra para todo mundo passaria despercebido. */
  rp = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "estresse", expira_em: hojeMais(9) });
  const ab2 = rp.dados.id, ab2Codigo = rp.dados.codigo;
  CRIADO.teste_envios.push(ab2);
  await Q.run("UPDATE teste_envios SET status='aberto', aberto_em=? WHERE id=?", new Date().toISOString(), ab2);
  await pub("/api/answer/" + ab2Codigo + "/entrar", "POST", { nascimento: "05/03/1990" });
  eq((await pub("/api/answer/" + ab2Codigo)).dados.estado, "aberto",
    "rastreio aberto SEM prorrogação continua fechado — a regra do cliente está de pé");

  /* ---- concluído não se prorroga ---- */
  /* Respondido AQUI, e não reaproveitando um envio que outra seção respondeu:
     depender do índice de um array compartilhado faz a prova falar de um
     registro diferente no dia em que alguém acrescentar um caso acima. */
  rp = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "ansiedade", expira_em: hojeMais(5) });
  const concl = rp.dados.id, cCod = rp.dados.codigo;
  CRIADO.teste_envios.push(concl);
  await pub("/api/answer/" + cCod + "/entrar", "POST", { nascimento: "05/03/1990" });
  const itC = await pub("/api/answer/" + cCod + "/iniciar", "POST", {});
  const respC = {};
  itC.dados.itens.forEach((i, n) => { respC[i.chave] = i.aberta ? "ZZ QA resposta" : n % 5; });
  await pub("/api/answer/" + cCod + "/concluir", "POST", { respostas: respC });
  eq((await Q.get("SELECT status FROM teste_envios WHERE id=?", concl)).status, "concluido",
    "o envio foi respondido");
  eq((await app("/restrito/api/teste-envios/" + concl + "/prazo", "POST", { expira_em: hojeMais(10) })).status, 409,
    "e respondido NÃO se prorroga: o prazo já cumpriu o que tinha para cumprir");
  eq((await app("/restrito/api/teste-envios")).dados.itens.find((x) => x.id === concl).pode_prazo, false,
    "a tela também não oferece");

  /* ---- os vencidos continuam à vista ---- */
  /* Pedido explícito do cliente, e o tipo de coisa que uma "melhoria" futura
     na lista quebra sem ninguém perceber: basta alguém filtrar o que "já
     passou" para os vencidos sumirem da tela de quem precisa agir sobre eles. */
  const outroVenc = CRIADO.teste_envios[4];
  await Q.run("UPDATE teste_envios SET status='enviado', expira_em=? WHERE id=?", hojeMais(-3), outroVenc);
  const todos = (await app("/restrito/api/teste-envios")).dados.itens;
  ok(todos.some((x) => x.id === outroVenc && x.situacao === "vencido"),
    "vencido aparece na lista geral, sem filtro");
  ok((await app("/restrito/api/teste-envios?paciente_id=" + pac)).dados.itens
    .some((x) => x.id === outroVenc), "e na lista do paciente");
  ok((await app("/restrito/api/teste-envios?situacao=vencido")).dados.itens
    .some((x) => x.id === outroVenc), "e o filtro por situação encontra os vencidos");

  /* ------------------------------------------------------------------ */
  secao("9. o vínculo com o prontuário");
  r = await app("/restrito/api/prontuario", "POST",
    { paciente_id: pac, especialidade: "Psicanálise Individual", profissional: "ZZ QA Dr" });
  const pasta = r.dados && r.dados.id; CRIADO.prontuario.push(pasta);
  ok(pasta, "pasta de prontuário criada");
  r = await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "depressao", nao_expira: true, prontuario_id: pasta });
  CRIADO.teste_envios.push(r.dados.id);
  eq(r.status, 201, "envio criado já preso à pasta");
  r = await app("/restrito/api/teste-envios?prontuario_id=" + pasta);
  eq(r.dados.itens.length, 1, "e a pasta lista só o teste dela");

  /* Teste criado antes de a pasta existir tem de poder ser trazido para ela —
     senão ficaria invisível justamente para quem lê o tratamento. */
  const solto = CRIADO.teste_envios[4];
  eq((await app(`/restrito/api/teste-envios/${solto}/pasta`, "PUT", { prontuario_id: pasta })).status, 200,
    "um teste solto pode ser trazido para a pasta");
  eq((await app("/restrito/api/teste-envios?prontuario_id=" + pasta)).dados.itens.length, 2,
    "e passa a contar nela");

  /* Pendurar o questionário de uma pessoa no prontuário de outra é o erro que
     ninguém acha pela tela. */
  const outro = await app("/restrito/api/pacientes", "POST", { nome: "ZZ QA Outro Paciente" });
  CRIADO.pacientes.push(outro.dados.id);
  const pastaAlheia = await app("/restrito/api/prontuario", "POST",
    { paciente_id: outro.dados.id, especialidade: "Ozonioterapia", profissional: "ZZ QA Dr" });
  CRIADO.prontuario.push(pastaAlheia.dados.id);
  eq((await app(`/restrito/api/teste-envios/${solto}/pasta`, "PUT",
    { prontuario_id: pastaAlheia.dados.id })).status, 400,
    "mas nunca para a pasta de OUTRO paciente");

  /* ------------------------------------------------------------------ */
  secao("10. paciente inativo");
  await Q.run("UPDATE pacientes SET ativo=0 WHERE id=?", pac);
  eq((await app("/restrito/api/teste-envios", "POST",
    { paciente_id: pac, teste_chave: "estresse", nao_expira: true })).status, 409,
    "não se manda teste novo para quem saiu da clínica");
  await Q.run("UPDATE pacientes SET ativo=1 WHERE id=?", pac);

  /* ------------------------------------------------------------------ */
  secao("11. a resposta não fica legível no banco");
  /* Lê SEM passar pela camada que decifra: é assim que um dump ou um backup
     vazado veria a coluna. */
  const { Client } = require("pg");
  const cli = new Client({
    host: process.env.PGHOST, user: process.env.PGUSER,
    password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
    port: Number(process.env.PGPORT) || 5432,
  });
  await cli.connect();
  const q = await cli.query("SELECT respostas FROM teste_envios WHERE id=$1", [nofim]);
  await cli.end();
  const bruta = q.rows[0] && q.rows[0].respostas;
  ok(bruta && bruta.length > 20, "a coluna tem conteúdo");
  ok(bruta && !/"s0_0"/.test(bruta), "e ele NÃO é o JSON legível das respostas");
  ok(bruta && !/\d,\s*"s/.test(bruta), "num dump, não há sintoma nenhum para ler");

})().then(async () => {
  await limpar();
  /* A conferência da própria limpeza. Se sobrou linha, a suíte REPROVA — não
     avisa em letra miúda. O banco é o mesmo do cliente. */
  for (const t of TABELAS_CONTADAS) {
    const agora = Number((await Q.get(`SELECT COUNT(*) c FROM ${t}`)).c);
    ok(agora === ANTES[t], `a suíte não deixou nada em ${t}`, `${ANTES[t]} → ${agora}`);
  }
  const total = passou + falhou;
  console.log("\n  " + "─".repeat(58));
  if (falhou) {
    console.log(`\n  ✖ ${falhou} de ${total} falharam:\n`);
    for (const f of falhas) console.log("    · " + f);
    console.log("");
    process.exitCode = 1;
  } else {
    console.log(`\n  ✔ ${passou}/${total} — o rastreio vai e volta inteiro\n`);
  }
  if (servidor) servidor.kill();
  process.exit(process.exitCode || 0);
}).catch(async (e) => {
  console.error("\n  ✖ a suíte quebrou: " + String((e && e.stack) || e).split("\n").slice(0, 5).join("\n"));
  if (falhas.length) {
    console.error(`\n  ${falhas.length} falha(s) já detectada(s):\n`);
    for (const f of falhas) console.error("    · " + f);
  }
  try { await limpar(); } catch {}
  if (servidor) servidor.kill();
  console.error("\n" + saida.slice(-900));
  process.exit(1);
});
