/* ==========================================================================
   testar-imagem.cjs — o que o painel faz com a foto que o cliente envia.

   O teste que mais importa aqui é o do METADADO: foto de celular traz EXIF, e o
   EXIF traz coordenada de GPS. Publicar isso no site é vazar dado que ninguém
   pediu para publicar. Os demais casos existem para garantir que a limpeza não
   quebrou nada pelo caminho — em especial a ORIENTAÇÃO, que depende do EXIF que
   estamos justamente apagando: apagar antes de girar deitaria toda foto de
   celular no site.

   Rodar: node testar-imagem.cjs
   ========================================================================== */
const assert = require("node:assert");
const { tratarUpload, disponivel } = require("./imagem");

let sharp;
try { sharp = require("sharp"); } catch { /* tratado abaixo */ }

let ok = 0, total = 0;
const teste = async (nome, fn) => {
  total++;
  try { await fn(); ok++; console.log(`  ok   ${nome}`); }
  catch (e) { console.error(`  FALHOU ${nome}\n         ${e.message}`); process.exitCode = 1; }
};

(async () => {
  console.log("\n  tratamento da foto enviada pelo painel\n");

  if (!disponivel()) {
    /* Sem o sharp o servidor continua de pé, e é isso que se prova aqui. O
       resto da suíte não teria o que medir. */
    await teste("sem o sharp, o upload passa direto em vez de estourar", async () => {
      const r = await tratarUpload(Buffer.from("qualquer coisa"), ".jpg");
      assert.equal(r.tratada, false);
      assert.ok(r.buffer, "o buffer original tem de sobreviver");
      assert.equal(r.ext, ".jpg");
    });
    console.log(`\n  ⚠ sharp ausente — só o caminho de degradação foi provado (${ok}/${total})\n`);
    return;
  }

  /* --------------------------------------------------------------------
     1. METADADO — o motivo de tudo isto existir
     -------------------------------------------------------------------- */
  await teste("EXIF com GPS é descartado", async () => {
    const comExif = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#5B4FD8" } })
      .jpeg()
      .withExif({
        IFD0: { Copyright: "BemEstarClinic", Artist: "Camera de teste" },
        GPS: { GPSLatitudeRef: "S", GPSLongitudeRef: "W" },
      })
      .toBuffer();

    // confere que a montagem do teste realmente produziu EXIF (senão o teste passa à toa)
    const antes = await sharp(comExif).metadata();
    assert.ok(antes.exif && antes.exif.length > 0, "o JPEG de teste precisava NASCER com EXIF");

    const r = await tratarUpload(comExif, ".jpg");
    const depois = await sharp(r.buffer).metadata();
    assert.ok(!depois.exif, "sobrou EXIF na imagem tratada");
    const cru = r.buffer.toString("latin1");
    assert.ok(!cru.includes("BemEstarClinic") && !cru.includes("Camera de teste"),
      "o texto do EXIF ainda aparece nos bytes do arquivo");
  });

  /* --------------------------------------------------------------------
     2. ORIENTAÇÃO — depende do EXIF que acabamos de apagar; a ORDEM importa
     -------------------------------------------------------------------- */
  await teste("foto deitada pelo EXIF sai em pé (rotação assada nos pixels)", async () => {
    /* orientation 6 = "para exibir, gire 90° à direita" — é o que o celular
       grava ao fotografar em pé.
       MONTAR A AMOSTRA COM `withMetadata({orientation})`, e NÃO com
       `withExif({IFD0:{Orientation:"6"}})`: o segundo grava EXIF, mas o sharp
       lê de volta como orientation 1, e o teste falha acusando um defeito que
       não existe no código. Já custou uma investigação. */
    const deitada = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#C9A86A" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    assert.equal((await sharp(deitada).metadata()).orientation, 6, "a amostra precisava NASCER deitada");

    const r = await tratarUpload(deitada, ".jpg");
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.width, 200, "a largura devia ter virado a altura original");
    assert.equal(m.height, 400, "a altura devia ter virado a largura original");
  });

  /* --------------------------------------------------------------------
     3. TAMANHO
     -------------------------------------------------------------------- */
  await teste("foto de celular é reduzida a 2000px no maior lado", async () => {
    const grande = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#F8F7FC" } }).jpeg().toBuffer();
    const r = await tratarUpload(grande, ".jpg");
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.width, 2000);
    assert.equal(m.height, 1500, "a proporção tem de ser mantida");
    assert.ok(r.buffer.length < grande.length, "devia ter ficado menor");
  });

  await teste("imagem pequena NÃO é ampliada", async () => {
    const pequena = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#5136d6" } }).png().toBuffer();
    const r = await tratarUpload(pequena, ".png");
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.width, 120);
    assert.equal(m.height, 90);
  });

  /* --------------------------------------------------------------------
     4. FORMATO
     -------------------------------------------------------------------- */
  await teste("sai em WEBP, com a extensão correspondente", async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toBuffer();
    const r = await tratarUpload(png, ".png");
    assert.equal(r.ext, ".webp");
    assert.equal((await sharp(r.buffer).metadata()).format, "webp");
  });

  await teste("transparência do PNG sobrevive à conversão", async () => {
    const comAlfa = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 91, g: 79, b: 216, alpha: 0.35 } } })
      .png().toBuffer();
    const r = await tratarUpload(comAlfa, ".png");
    assert.ok((await sharp(r.buffer).metadata()).hasAlpha, "perdeu o canal de transparência");
  });

  /* --------------------------------------------------------------------
     5. CASOS DE BORDA
     -------------------------------------------------------------------- */
  await teste("GIF passa inteiro (converter mataria a animação)", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const r = await tratarUpload(gif, ".gif");
    assert.equal(r.ext, ".gif");
    assert.equal(r.tratada, false);
    assert.ok(r.buffer.equals(gif), "o GIF tinha de sair idêntico");
  });

  await teste("arquivo que não é imagem é RECUSADO, não gravado", async () => {
    // o tipo declarado no data: URL é texto do cliente; aqui ele mente
    const mentira = Buffer.from("<?php system($_GET['c']); ?>", "utf8");
    const r = await tratarUpload(mentira, ".png");
    assert.equal(r.buffer, null, "não pode devolver buffer para gravar");
    assert.match(r.motivo, /ilegível/);
  });

  await teste("buffer vazio não derruba nada", async () => {
    const r = await tratarUpload(Buffer.alloc(0), ".jpg");
    assert.equal(r.buffer, null);
  });

  console.log(`\n  ${ok}/${total} — ${ok === total ? "tudo certo" : "REVISAR"}\n`);
})();
