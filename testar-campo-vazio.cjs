/* ==========================================================================
   CAMPO EM BRANCO — a suíte que prova o conserto pela ROTA, não pelo banco

       node testar-campo-vazio.cjs

   O defeito: campo de número deixado em branco chega como STRING VAZIA (o
   navegador não sabe mandar `null`). O SQLite engolia; o PostgreSQL recusa com
   `invalid input syntax for type integer: ""` e o salvar devolvia 500 — em 32
   colunas graváveis pelo formulário, espalhadas por 8 módulos.

   Testar pelo BANCO provaria só que o Postgres recusa string vazia, que já se
   sabe. O que precisa de prova é o CAMINHO: o formulário manda `""`, a rota
   trata, e o registro nasce certo. Por isso a suíte sobe o servidor de
   verdade, entra com sessão e conversa por HTTP.

   SOBRE OS DADOS: tudo que ela cria leva o prefixo `ZZ QA` e sai APAGADO POR
   ID no fim — nunca por `LIKE`, nunca por nome. O banco é o mesmo do cliente.
   ========================================================================== */
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Q, carregarAmbiente } = require("./pg.js");

carregarAmbiente(__dirname);

const PORTA = Number(process.env.PORTA_TESTE) || 5197;
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = "zz-qa-vazio-2026";
const EMAIL = "zz_qa_vazio@qa.local";

const CRIADO = { pacientes: [], convenios: [], g_usuarios: [] };
let passou = 0, falhou = 0; const falhas = [];
let servidor = null;

const ok = (c, t, d) => { if (c) { passou++; return true; }
  falhou++; falhas.push(t + (d ? "  → " + d : "")); return false; };
const eq = (a, b, t) => ok(a === b, t, `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

/* Mesmo formato do restrito.js: scrypt$N$r$p$sal$dk, em hex. Inventar o
   formato deixa a conta criada e o login recusando, sem dizer por quê. */
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
  /* A porta livre é conferida ANTES: um processo esquecido nela faria a suíte
     inteira rodar contra ele, e o erro apareceria longe da causa. */
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 800);
    await fetch(BASE + "/favicon.ico", { signal: c.signal });
    clearTimeout(t);
    throw new Error(`a porta ${PORTA} já está ocupada — feche o processo ou use PORTA_TESTE=<outra>.`);
  } catch (e) { if (/já está ocupada/.test(e.message)) throw e; }

  servidor = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(PORTA), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  servidor.stdout.on("data", (d) => { saida += d; });
  servidor.stderr.on("data", (d) => { saida += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/favicon.ico"); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("o servidor de teste não subiu:\n" + saida);
}

async function limpar() {
  for (const t of ["pacientes", "convenios", "g_usuarios"]) {
    const ids = CRIADO[t].filter(Boolean);
    if (ids.length) await Q.run(`DELETE FROM ${t} WHERE id = ANY(?)`, ids);
  }
}

(async () => {
  console.log("\n  campo em branco — do formulário até a coluna\n");
  await subir();

  CRIADO.g_usuarios.push(await Q.inserir(
    `INSERT INTO g_usuarios (nome, email, senha_hash, perfil, ativo)
     VALUES (?,?,?,'admin',1) RETURNING id`, "ZZ QA Vazio", EMAIL, hashSenha(SENHA)));

  const app = navegador();
  eq((await app("/restrito/api/login", "POST", { usuario: EMAIL, senha: SENHA })).status, 200, "entra no sistema");

  /* ---------------------------------------------------------------------
     1. O QUE ACONTECIA: número opcional em branco derrubava o salvar.
     --------------------------------------------------------------------- */
  let r = await app("/restrito/api/pacientes", "POST", { nome: "ZZ QA Sem Convenio", convenio_id: "" });
  eq(r.status, 200, "cadastrar com o convênio em branco NÃO devolve mais 500");
  const p1 = r.dados && r.dados.id; CRIADO.pacientes.push(p1);
  ok(p1, "e o paciente nasce mesmo assim", JSON.stringify(r.dados));

  r = await app("/restrito/api/pacientes/" + p1);
  eq(r.dados.convenio_id, null, "o campo em branco virou NULO — não zero, não string");

  /* ---------------------------------------------------------------------
     2. COLUNA COM PADRÃO: o valor de fábrica vale.

     `pacientes.ativo` é `DEFAULT 1` e ACEITA NULO. Se o nulo viesse antes do
     padrão, um `ativo` em branco viraria NULL — e como toda lista e todo
     seletor filtram `ativo=1`, o paciente sumiria do sistema. É o teste que
     mais importa desta suíte.
     --------------------------------------------------------------------- */
  r = await app("/restrito/api/pacientes", "POST", { nome: "ZZ QA Ativo Vazio", ativo: "" });
  const p2 = r.dados && r.dados.id; CRIADO.pacientes.push(p2);
  eq(r.status, 200, "cadastrar com `ativo` em branco responde");
  eq(Number((await app("/restrito/api/pacientes/" + p2)).dados.ativo), 1,
     "e `ativo` fica valendo 1 (o padrão), NÃO nulo");

  const lista = await app("/restrito/api/pacientes?ativo=1");
  ok((lista.dados || []).some((x) => x.id === p2),
     "por isso ele continua aparecendo na lista de ativos");

  /* ---------------------------------------------------------------------
     3. NA EDIÇÃO, limpar o campo devolve o valor de fábrica.

     Se a coluna apenas saísse da instrução, o valor ANTIGO permaneceria: a
     pessoa limpa, salva, e o número volta sozinho — parece que o sistema
     ignorou o que ela fez.
     --------------------------------------------------------------------- */
  r = await app("/restrito/api/convenios", "POST", { nome: "ZZ QA Convenio", sort: "7" });
  const c1 = r.dados && r.dados.id; CRIADO.convenios.push(c1);
  eq(Number((await app("/restrito/api/convenios/" + c1)).dados.sort), 7, "convênio nasce com a ordem 7");

  eq((await app("/restrito/api/convenios/" + c1, "PUT", { nome: "ZZ QA Convenio", sort: "" })).status, 200,
     "editar limpando a ordem responde");
  eq(Number((await app("/restrito/api/convenios/" + c1)).dados.sort), 0,
     "e a ordem volta ao valor de fábrica (0), em vez de manter o 7 antigo");

  /* ---------------------------------------------------------------------
     4. OBRIGATÓRIA SEM PADRÃO: 400 dizendo o que falta, nunca 500.

     Pela ROTA, hoje, quem responde é a conferência própria do módulo
     ("Selecione o paciente") — e ela dá uma frase melhor. O ramo `faltando`
     do `prepararCampos` é REDE, para a próxima coluna obrigatória que alguém
     acrescentar sem lembrar de escrever a conferência. Por isso ele é testado
     DIRETO, na função: rede que nunca foi testada não é rede.
     --------------------------------------------------------------------- */
  r = await app("/restrito/api/prontuario", "POST", { paciente_id: "", especialidade: "ZZ QA" });
  ok(r.status === 400, "campo obrigatório em branco devolve 400, não 500", "status " + r.status);
  ok(/selecione|preencha/i.test(String(r.dados && r.dados.error)),
     "com uma frase que diz o que fazer", JSON.stringify(r.dados));

  const { prepararCampos, destinoDoVazio, TIPOS } = require("./restrito.js")._paraTeste;

  /* O `TIPOS` é preenchido no boot, e o servidor roda em OUTRO processo — aqui
     ele nasce vazio, e `destinoDoVazio` responderia "texto" para tudo,
     aprovando qualquer coisa. Carregar do mesmo information_schema que o boot
     lê é o que faz este teste medir a LÓGICA, e não o esquecimento. */
  for (const t of ["pacientes", "prontuario", "convenios"]) {
    const cols = await Q.all(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name=?`, t);
    TIPOS[t] = Object.fromEntries(cols.map((c) => [c.column_name,
      { tipo: c.data_type, nulavel: c.is_nullable === "YES", padrao: c.column_default != null }]));
  }
  ok(Object.keys(TIPOS.pacientes || {}).length > 5, "os tipos das colunas foram carregados");

  eq(destinoDoVazio("prontuario", "paciente_id"), "obrigatorio",
     "o motor reconhece a coluna obrigatória sem padrão");
  eq(destinoDoVazio("pacientes", "ativo"), "omitir",
     "e a coluna com padrão sai da instrução, mesmo aceitando nulo");
  eq(destinoDoVazio("pacientes", "convenio_id"), "nulo", "a que só aceita nulo vira NULL");
  eq(destinoDoVazio("pacientes", "observacao"), "texto", "e a de texto continua texto");

  const rede = prepararCampos("prontuario", ["paciente_id", "especialidade"],
    { paciente_id: "", especialidade: "ZZ QA" });
  eq(rede.faltando.length, 1, "a rede acusa a coluna obrigatória em branco");
  eq(rede.faltando[0], "paciente", "com o rótulo legível, não o nome da coluna");
  ok(!rede.usar.includes("paciente_id"), "e ela não entra na instrução");

  /* ---------------------------------------------------------------------
     5. TEXTO em branco continua sendo texto em branco. O tratamento é só
        para coluna não-textual — transformar "" em NULL num campo de texto
        mudaria o significado de "apaguei a observação".
     --------------------------------------------------------------------- */
  r = await app("/restrito/api/pacientes", "POST", { nome: "ZZ QA Texto", observacao: "" });
  const p3 = r.dados && r.dados.id; CRIADO.pacientes.push(p3);
  eq((await app("/restrito/api/pacientes/" + p3)).dados.observacao, "",
     "campo de TEXTO em branco continua string vazia");

  /* ------------------------------------------------------ resultado ---- */
  await limpar();
  if (servidor) servidor.kill();
  const total = passou + falhou;
  if (falhou) {
    console.log(`\n  ✖ ${falhou} de ${total} falharam:\n`);
    for (const f of falhas) console.log("    · " + f);
    console.log("");
    process.exitCode = 1;
  } else {
    console.log(`\n  ✔ ${passou}/${total} — campo em branco tratado do formulário à coluna\n`);
  }
  process.exit(process.exitCode || 0);
})().catch(async (e) => {
  console.error("\n  ✖ a suíte quebrou: " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n"));
  if (falhas.length) { console.error("\n  falhas já detectadas:\n"); for (const f of falhas) console.error("    · " + f); }
  try { await limpar(); } catch {}
  if (servidor) servidor.kill();
  process.exit(1);
});
