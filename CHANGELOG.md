# Changelog — BemEstarClinic

Série do **site** (`APP_VERSION` no `server.js`, exibida no painel e em `/api/me`).
Regra combinada com o cliente: **2ª casa = funcionalidade, 3ª casa = correção.**
A primeira casa não muda. O `/restrito` tem série própria.

---

## 1.20.0 — 2026-08-12 · SEO e compartilhamento

Rodada a partir do levantamento do LA Sentinela de 12/08/2026 (19 pendências).

### Acrescentado

- **Google Analytics 4** (`G-5J42VGQ08W`) em `assets/js/config.js`. A estrutura
  já existia: quem injeta é o `main.js`, **somente após o "Aceitar cookies"**,
  com `anonymize_ip`. Conferido no navegador — antes do aceite não há nenhum
  script do Google nem `dataLayer`; depois, a coleta sai com o `tid` correto.
  Consequência a ter em mente: **o GA4 só enxerga quem aceita cookies**, então
  o número será menor que o total real de visitantes. É o preço do consentimento
  prévio que a LGPD exige — não "conserte" isso soltando a tag no `<head>`.

- **`geo` e `sameAs` no schema `MedicalClinic`.** Coordenadas conferidas pelo
  cliente no Google Maps (-8.260997, -35.966046; guardadas com 6 casas, que já
  dão precisão de centímetros). É o que o Google usa para decidir se a clínica
  entra na busca do mapa e no bloco local.

### Corrigido

- **`/privacidade/` era página órfã.** Nenhum link do HTML apontava para ela. O
  único link existente ficava no aviso de cookies, que é **injetado por
  JavaScript** — o rastreador nunca o via. Agora há link no rodapé do
  `index.html` e no rodapé enxuto dos 8 templates de `src/`, ou seja, nas 26
  páginas.

- **Os posts do blog compartilhavam todos a MESMA imagem.** `aplicarTextos()`
  roda sobre o template antes de `{{IMAGE}}` ser substituído, e a troca geral de
  `og:image` sobrescrevia o placeholder pela imagem padrão do site. Resultado:
  9 matérias, 9 cartões idênticos. A troca agora ignora valores em
  `{{PLACEHOLDER}}`, e cada post leva a própria capa.

- **JSON-LD do post podia ser descartado pelo validador.** `image` ia com o
  valor cru: foto enviada pelo painel gera caminho relativo, que é inválido em
  JSON-LD. Agora é sempre absoluto. O tipo passou de `Article` para
  `BlogPosting` e ganhou `isPartOf`.

- **`/agendar/` não tinha nenhuma tag `og:`.** É a página de conversão, a que
  mais vai colada no WhatsApp, e o link virava uma linha de texto sem imagem.
  Ganhou `og:type/site_name/locale/title/description/url/image` (+ dimensões e
  alt) e `twitter:card`.

- **Fotos do Nosso Espaço sem `width`/`height`** — a galeria empurrava o resto
  da página ao carregar (CLS). `medirImagem()` só olhava
  `/assets/img/uploads/`; agora lê qualquer imagem local sob `/assets/img/`,
  com recusa explícita de `..` e conferência de que o caminho resolvido cai
  dentro da pasta. As 7 fotos passaram a declarar a medida real lida do arquivo
  (6 em paisagem, 1 em retrato).

- **`.work img` ganhou `height: auto`** — obrigatório junto com os atributos.
  Sem isso o `height="900"` viraria dica de apresentação e esticaria a foto numa
  coluna de ~350px.

- **Capa de post vinda de fora** (Unsplash) não pode ser medida na publicação:
  a classe `.post__cover--reserva` reserva a proporção pelo CSS. A capa **nossa**
  segue fluida de propósito — a clínica sobe foto de WhatsApp em pé, e forçar
  16/10 nela recortaria a imagem.

- **Títulos fora da faixa de 30–62 caracteres.** Novo `tituloTag()`: corta
  primeiro na pontuação que fecha a ideia (`? : — –`), depois em palavra
  inteira, e acrescenta marca + cidade quando o título é curto demais. Os posts
  passaram a usá-lo (o template mandava `{{TITLE}}` cru para o `<title>`), e a
  página de especialidade ganhou um 3º degrau — com nome longo, até o formato
  curto passava de 62 e o Google cortava justamente a cidade.
  **`<h1>` e `og:title` continuam com o título inteiro.**

- **Hierarquia de títulos pulava h1 → h3** em `/blog/` e `/especialidades/`.
  O nível do título do card virou parâmetro: `h2` nas listagens (logo abaixo do
  `<h1>`) e `h3` na home e em "Outras especialidades" (onde há `<h2>` de seção
  antes). O CSS mira as classes, então **nada mudou visualmente**.

### Notas

- `/busca/` ficou de fora das tags `og:` de propósito: é `noindex` e é página de
  resultado de busca, que ninguém compartilha.
- `noindex` em `/agendar/` é **proposital** (formulário) — confirmado pelo
  comentário do gerador do sitemap.
- Sem `loading="lazy"` continuam apenas as imagens de primeira tela (hero e capa
  do post). É o correto: elas são o LCP e devem carregar antes.

- **"25 páginas com pouco texto" é, em boa parte, ATRASO DE DEPLOY.** As três
  páginas citadas no relatório já têm conteúdo farto no banco local e estão
  apenas esperando a publicação:

  | Página | Produção | Local |
  |---|---|---|
  | `/especialidades/psicanalise-individual-e-casal/` | 237 | **711** |
  | `/especialidades/protocolo-integrativo-…/` | 215 | **555** |
  | `/especialidades/acupuntura/` | 212 | **479** |

  Magras DE VERDADE no local: `psicologia` (260) e `diversas-especialidades`
  (191), mais as matérias do blog (~150–170 palavras cada). Medir de novo com o
  Sentinela DEPOIS do deploy, antes de escrever qualquer coisa.
