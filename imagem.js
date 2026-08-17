/* ==========================================================================
   imagem.js — tratamento da foto que chega pelo painel.

   Antes disto o /api/upload gravava o base64 CRU no disco. Três consequências,
   em ordem de gravidade:

   1. METADADOS. Foto de celular carrega EXIF, e o EXIF costuma trazer as
      COORDENADAS DE GPS de onde ela foi tirada. Publicar isso no site é vazar
      dado que ninguém pediu para publicar — e num site de clínica a foto pode
      ter sido tirada dentro do consultório. O sharp descarta todo metadado por
      padrão (só preserva com .withMetadata(), que NÃO usamos aqui).

   2. ORIENTAÇÃO. O celular não gira os pixels: grava "está de lado" no EXIF e
      deixa o programa girar na hora de exibir. Ao apagar o EXIF sem aplicar a
      rotação, a foto sairia deitada. `.rotate()` sem argumento assa a rotação
      nos pixels ANTES de o metadado ser descartado — a ordem importa.

   3. TAMANHO. Foto de celular chega com 8–12 MP. A maior imagem do site é
      exibida com ~900px de largura; o resto era peso puro no LCP.

   POR QUE UM MÓDULO À PARTE, e não um trecho no server.js: o `sharp` é módulo
   NATIVO. Se o `npm ci` do servidor não instalar (arquitetura sem binário
   pronto, rede fora), um `require` solto derrubaria o processo inteiro — e com
   ele o site, o /admin e o /restrito, por causa de um redimensionamento de
   foto. Aqui ele é opcional: sem o sharp, o upload volta ao comportamento
   antigo e o servidor sobe com aviso no log. Mesma escolha do `db.js`.
   ========================================================================== */

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  /* segue sem — quem avisa é o server.js no boot */
}

const disponivel = () => sharp !== null;

/* 2000px no maior lado: acima disso nenhuma tela do site aproveita, e o
   `srcset` não existe aqui. Não aumenta imagem pequena (withoutEnlargement). */
const MAX_LADO = 2000;
const QUALIDADE = 82;

/* ==========================================================================
   Trata a imagem enviada pelo painel.

   Devolve { buffer, ext, tratada, motivo }. NUNCA lança: uma foto que o sharp
   não consegue ler não pode impedir o cliente de trabalhar.

   GIF passa inteiro de propósito — convertê-lo mataria a animação, e o ganho
   não compensa (o site não usa GIF em lugar nenhum hoje).
   ========================================================================== */
async function tratarUpload(buffer, extOriginal) {
  if (!disponivel()) return { buffer, ext: extOriginal, tratada: false, motivo: "sharp ausente" };
  if (extOriginal === ".gif") return { buffer, ext: extOriginal, tratada: false, motivo: "gif preservado" };

  try {
    const saida = await sharp(buffer)
      .rotate()                                    // aplica o EXIF nos pixels…
      .resize({ width: MAX_LADO, height: MAX_LADO, fit: "inside", withoutEnlargement: true })
      .webp({ quality: QUALIDADE })                // …e aqui o metadado se perde
      .toBuffer();

    /* Imagem já otimizada (um WEBP pequeno, por exemplo) pode SAIR maior do que
       entrou. Nesse caso o trabalho foi inútil e a original fica — mas só se
       ela também não tiver metadado para limpar, o que só vale para o WEBP que
       já chegou sem EXIF. Na dúvida, prevalece o arquivo tratado: o motivo
       principal desta função é a privacidade, não o byte. */
    if (saida.length >= buffer.length && extOriginal === ".webp")
      return { buffer, ext: extOriginal, tratada: false, motivo: "original já menor" };

    return { buffer: saida, ext: ".webp", tratada: true, motivo: `${Math.round(buffer.length / 1024)}kB → ${Math.round(saida.length / 1024)}kB` };
  } catch (e) {
    /* Chegou aqui = o sharp não reconheceu como imagem. Com o sharp instalado
       isso é sinal de arquivo malformado ou disfarçado (o tipo declarado no
       data: URL é texto que o cliente escreve, não prova nada). Recusar é mais
       seguro do que gravar um arquivo que não sabemos o que é. */
    return { buffer: null, ext: null, tratada: false, motivo: `imagem ilegível: ${e.message}` };
  }
}

/* ==========================================================================
   A FOTO DE PERFIL — outra regra, e por isso outra função

   A foto do usuário não é a foto do site. Ela é exibida SEMPRE em círculo e
   SEMPRE pequena: 36px na lista de pessoas do chat, 40px no cabeçalho da
   conversa, 72px no cartão do perfil. Passar por `tratarUpload` deixaria um
   WEBP de 2000px para ser encolhido pelo navegador em cada uma dessas telas —
   centenas de kB baixados e redimensionados para caber num disquinho.

   Três decisões que vêm do formato circular:

   1. `fit: "cover"` com recorte QUADRADO. Uma foto 3:4 dentro de um círculo
      precisa ser cortada de qualquer jeito — a diferença é quem corta. Aqui,
      onde dá para escolher o que fica; no CSS, sempre pelo centro geométrico,
      que em retrato costuma cortar o queixo.

   2. `position: "attention"` (não "center"). O sharp procura a região de maior
      entropia — em retrato, quase sempre o rosto. Centralizar cegamente numa
      foto de corpo inteiro devolveria um círculo de camisa.

   3. 256px. É o dobro do maior uso (72px em tela de 2×), o que cobre telas de
      alta densidade sem guardar imagem que ninguém vê inteira.

   A rotação pelo EXIF e o descarte de metadado continuam valendo pelo mesmo
   motivo de sempre: foto de celular vem deitada e com GPS dentro.
   ========================================================================== */
const LADO_AVATAR = 256;

async function tratarAvatar(buffer, extOriginal) {
  if (!disponivel()) return { buffer, ext: extOriginal, tratada: false, motivo: "sharp ausente" };
  try {
    const saida = await sharp(buffer)
      .rotate()
      .resize(LADO_AVATAR, LADO_AVATAR, {
        fit: "cover", position: "attention", withoutEnlargement: false,
      })
      .webp({ quality: 84 })
      .toBuffer();
    return {
      buffer: saida, ext: ".webp", tratada: true,
      motivo: `${Math.round(buffer.length / 1024)}kB → ${Math.round(saida.length / 1024)}kB`,
    };
  } catch (e) {
    /* Sem foto tratada NÃO gravamos a original: um avatar é sempre uma imagem
       enviada por gente, e o que o sharp não lê aqui é arquivo disfarçado. */
    return { buffer: null, ext: null, tratada: false, motivo: `imagem ilegível: ${e.message}` };
  }
}

module.exports = { tratarUpload, tratarAvatar, disponivel, MAX_LADO, LADO_AVATAR };
