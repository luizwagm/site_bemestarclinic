/* ==========================================================================
   imagens-webp.js — converte para WEBP as imagens que JÁ estão no site.

   Desde a v1.21.0 toda foto NOVA já chega em WEBP pelo painel. Este script é o
   acerto do passado: as que entraram antes seguem em JPG/PNG, e imagem é quase
   sempre o que mais pesa numa página.

   POR QUE UM COMANDO À PARTE, e não uma migração no boot:

   · Ele MEXE NO BANCO. O caminho da foto está gravado em `settings`,
     `portfolio.image`, `team.photo`, `posts.image` e dentro do HTML de
     `posts.content` / `services.content`. Converter o arquivo sem trocar a
     referência deixaria o site com imagem quebrada — pior do que o problema.
   · Processar dezenas de imagens leva segundos e atrasaria a subida do serviço,
     que é justamente quando a clínica está esperando o site voltar.
   · `assets/img/uploads/` está no .gitignore: os arquivos do servidor NÃO são
     os desta máquina. Rodar aqui não conserta a produção — tem de rodar lá.

   USO (rode o ensaio primeiro, sempre):

     node imagens-webp.js --conferir     # não escreve nada, só mostra o que faria
     node imagens-webp.js                # converte e atualiza as referências
     ./deploy.sh   ou   Publicar no painel   # regenera o HTML com os caminhos novos

   O ORIGINAL NÃO É APAGADO. Fica no disco ao lado do .webp — link antigo, print
   de tela e página que alguém tenha salvo continuam funcionando. Se algo sair
   errado, é só devolver a referência no painel.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const { abrirBanco } = require("./db");

const ROOT = __dirname;
const ENSAIO = process.argv.includes("--conferir");
const QUALIDADE = 82;
const MAX_LADO = 2000;

let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("\n  O sharp não está instalado — sem ele não há como converter.");
  console.error("  Rode:  npm ci\n");
  process.exit(1);
}

const db = abrirBanco(path.join(ROOT, "data", "site.db"));

/* Só imagem NOSSA e em formato antigo. Endereço de fora (Unsplash) não é nosso
   para converter, e `..` é recusado por segurança. */
const ALVO = /^\/assets\/img\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:jpe?g|png))$/i;
const ehAlvo = (v) => {
  const m = ALVO.exec(String(v || "").trim());
  return m && !m[1].split("/").includes("..") ? m[0] : null;
};

/* ---------------------------------------------------------------------------
   1. ONDE os caminhos moram. Cada origem sabe ler e escrever o seu lugar.
   --------------------------------------------------------------------------- */
const origens = [];

/* `img_og` FICA DE FORA de propósito. É a imagem do cartão de compartilhamento:
   nenhum visitante a baixa (ela só existe nas meta tags), então converter não
   melhora Core Web Vitals em nada. Em troca, entregaria WEBP para o rastreador
   de cada rede social — e suporte a WEBP em prévia de link ainda é irregular.
   Ganho zero contra risco de o cartão sair sem imagem, que é o oposto do que
   se quer. Ela segue em PNG. */
const FORA = new Set(["img_og"]);
for (const r of db.prepare("SELECT key,value FROM settings").all()) {
  if (FORA.has(r.key)) { if (ehAlvo(r.value)) console.log(`  preservado  settings.${r.key} — imagem do cartão de compartilhamento, fica em PNG`); continue; }
  if (ehAlvo(r.value)) origens.push({ onde: `settings.${r.key}`, valor: r.value, tipo: "campo",
    gravar: (novo) => db.prepare("UPDATE settings SET value=? WHERE key=?").run(novo, r.key) });
}
for (const [tabela, coluna] of [["portfolio", "image"], ["team", "photo"], ["posts", "image"]]) {
  for (const r of db.prepare(`SELECT id,${coluna} AS v FROM ${tabela}`).all()) {
    if (ehAlvo(r.v)) origens.push({ onde: `${tabela}#${r.id}.${coluna}`, valor: r.v, tipo: "campo",
      gravar: (novo) => db.prepare(`UPDATE ${tabela} SET ${coluna}=? WHERE id=?`).run(novo, r.id) });
  }
}
/* Imagem colada DENTRO do texto pelo editor do painel. Sem isto, o corpo da
   matéria continuaria apontando para o JPG e a conversão pareceria incompleta. */
for (const [tabela, coluna] of [["posts", "content"], ["services", "content"]]) {
  for (const r of db.prepare(`SELECT id,${coluna} AS v FROM ${tabela}`).all()) {
    const html = String(r.v || "");
    const achados = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]).filter(ehAlvo);
    if (!achados.length) continue;
    origens.push({ onde: `${tabela}#${r.id}.${coluna}`, valor: [...new Set(achados)].join(" "), tipo: "html",
      html, achados: [...new Set(achados)],
      gravarHtml: (mapa) => {
        let novo = html;
        for (const [de, para] of mapa) novo = novo.split(`src="${de}"`).join(`src="${para}"`);
        db.prepare(`UPDATE ${tabela} SET ${coluna}=? WHERE id=?`).run(novo, r.id);
      } });
  }
}

/* ---------------------------------------------------------------------------
   2. Lista de ARQUIVOS distintos a converter (o mesmo arquivo pode ser citado
      em vários lugares — converter uma vez, trocar em todos).
   --------------------------------------------------------------------------- */
const arquivos = new Set();
for (const o of origens) (o.tipo === "html" ? o.achados : [o.valor]).forEach((v) => arquivos.add(v));

console.log(`\n  ${ENSAIO ? "ENSAIO — nada será gravado" : "CONVERSÃO"}`);
console.log(`  ${origens.length} referência(s) no banco · ${arquivos.size} arquivo(s) distinto(s)\n`);

if (!arquivos.size) {
  console.log("  Nenhuma imagem em JPG/PNG referenciada. Nada a fazer.\n");
  process.exit(0);
}

(async () => {
  const mapa = new Map();          // caminho antigo -> caminho novo
  let antes = 0, depois = 0, pulados = 0;

  for (const url of [...arquivos].sort()) {
    const disco = path.join(ROOT, url.replace(/^\//, ""));
    if (!fs.existsSync(disco)) { console.log(`  ausente  ${url}  (referência aponta para arquivo que não existe)`); continue; }

    const orig = fs.readFileSync(disco);
    let saida;
    try {
      saida = await sharp(orig).rotate()
        .resize({ width: MAX_LADO, height: MAX_LADO, fit: "inside", withoutEnlargement: true })
        .webp({ quality: QUALIDADE }).toBuffer();
    } catch (e) { console.log(`  ILEGÍVEL ${url}  (${e.message})`); continue; }

    /* Converter só compensa se ficar menor. PNG de poucas cores (ícone, captura
       de tela chapada) às vezes SAI MAIOR em WEBP — nesse caso o original fica,
       e a referência não muda. */
    if (saida.length >= orig.length) {
      pulados++;
      console.log(`  mantido  ${url}  (webp ficaria ${Math.round(saida.length / 1024)}kB vs ${Math.round(orig.length / 1024)}kB)`);
      continue;
    }

    const novoUrl = url.replace(/\.(jpe?g|png)$/i, ".webp");
    antes += orig.length; depois += saida.length;
    const pct = Math.round((1 - saida.length / orig.length) * 100);
    console.log(`  ${ENSAIO ? "converteria" : "convertido "}  ${url}`);
    console.log(`               → ${novoUrl}   ${Math.round(orig.length / 1024)}kB → ${Math.round(saida.length / 1024)}kB  (-${pct}%)`);

    if (!ENSAIO) fs.writeFileSync(path.join(ROOT, novoUrl.replace(/^\//, "")), saida);
    mapa.set(url, novoUrl);
  }

  /* ------------------------------------------------------------------------
     3. Trocar as referências — só depois de TODOS os arquivos existirem, para
        nunca haver um instante com a referência nova e o arquivo ainda ausente.
     ------------------------------------------------------------------------ */
  let trocadas = 0;
  for (const o of origens) {
    if (o.tipo === "html") {
      const meus = o.achados.filter((a) => mapa.has(a)).map((a) => [a, mapa.get(a)]);
      if (!meus.length) continue;
      if (!ENSAIO) o.gravarHtml(meus);
      trocadas += meus.length;
      console.log(`  ${ENSAIO ? "trocaria" : "trocado "}  ${o.onde}  (${meus.length} imagem(ns) no texto)`);
    } else if (mapa.has(o.valor)) {
      if (!ENSAIO) o.gravar(mapa.get(o.valor));
      trocadas++;
      console.log(`  ${ENSAIO ? "trocaria" : "trocado "}  ${o.onde}`);
    }
  }

  const kb = (n) => `${Math.round(n / 1024)}kB`;
  console.log(`\n  ${mapa.size} convertida(s) · ${pulados} mantida(s) · ${trocadas} referência(s) ${ENSAIO ? "a trocar" : "trocadas"}`);
  if (mapa.size) console.log(`  peso: ${kb(antes)} → ${kb(depois)}  (-${Math.round((1 - depois / antes) * 100)}%)`);
  console.log(ENSAIO
    ? `\n  Nada foi gravado. Para valer:  node imagens-webp.js\n`
    : `\n  Agora clique em Publicar no painel (ou rode ./deploy.sh) para o HTML sair com os caminhos novos.`
      + `\n  Os arquivos originais continuam no disco — nada foi apagado.\n`);
})();
