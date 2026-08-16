# Changelog — BemEstarClinic

Série do **site** (`APP_VERSION` no `server.js`, exibida no painel e em `/api/me`).
Regra combinada com o cliente: **2ª casa = funcionalidade, 3ª casa = correção.**
A primeira casa não muda. O `/restrito` tem série própria.

---

## 1.28.0 / restrito 1.34.0 — 2026-08-16 · o desafio é de um paciente só

Correção de entendimento, e ela muda onde as coisas ficam.

A 1.26.0 tratou o desafio como mais um item de catálogo: aparecia em
Cadastros → Testes/desafios, era escolhido no "Enviar" como qualquer rastreio,
e nada impedia mandá-lo a outra pessoa. Estava errado.

Um **rastreio** é o mesmo instrumento para todo mundo — é justamente isso que
permite comparar a mesma escala ao longo do tratamento. Um **desafio** é escrito
para uma pessoa, na realidade dela, naquela semana. Reaproveitar não é economia:
é mandar a alguém a tarefa pensada para outro.

### Onde cada coisa fica agora

- **Cadastros → Testes** voltou a ser só dos treze rastreios (e o rótulo, só
  "Testes"). O botão "Novo desafio" saiu dali.
- **Enviar teste** oferece só rastreio.
- **O desafio nasce dentro do prontuário do paciente**, no botão "Novo desafio"
  ao lado de "Enviar teste", na área Testes e desafios — que é onde ele vai
  viver depois. A mecânica é a mesma: colar → conferir na visualização →
  aprovar.
- **Criar já envia.** Separar as duas coisas criaria o estado "desafio escrito e
  nunca mandado", que só serviria para alguém encontrá-lo meses depois sem saber
  para quem era. Prazo e mensagem de boas-vindas estão na própria visualização.
- Na pasta, o desafio vem com etiqueta **Desafio** ao lado do nome: os dois
  aparecem juntos, e a diferença muda o que se espera — um foi respondido de uma
  vez, o outro está sendo preenchido ao longo da semana.

### O link quebrado, e o que ele ensinou

Um desafio já enviado parou de abrir: pedia a data de nascimento, aceitava a
data e então dizia "não encontrado, fale com a clínica". A causa foi eu ter
apagado a linha do catálogo numa limpeza, sem ver que havia um envio apontando
para ela — as perguntas de um desafio vivem nessa linha.

O defeito aparece do lado de quem está com o celular na mão, uma semana depois
de alguém mexer no cadastro. Agora **apagar um teste ou desafio com envio
pendurado é recusado**, com a contagem de envios, como já acontece com
profissional e convênio.

- Migração `008_desafio_do_paciente.sql` (`testes.paciente_id`).
- `testar-desafios.cjs`: 82 → **85**, agora provando que criar sem paciente é
  recusado, que o desafio **não** entra no catálogo nem na lista de envio, e que
  ele já sai com o link.

---

## 1.27.0 / restrito 1.33.0 — 2026-08-16 · o desafio da semana, e o link com dono

Duas mudanças que vieram juntas porque uma depende da outra.

### O desafio reabre, e o que foi escrito fica guardado

Um desafio é feito ao longo da semana: escolhe a tarefa na segunda, anota a
distração na terça, responde as três perguntas todo fim de dia. Fechar no
primeiro acesso transformava um exercício de sete dias num formulário para
preencher de memória no domingo à noite — que é o oposto do que ele treina.

Agora o link do desafio **reabre enquanto não estiver concluído**, e o que o
paciente escreve é guardado sozinho (1,5 s depois da última tecla, e também ao
sair da página, com `sendBeacon` — um `fetch` disparado nesse instante morre com
a aba). Ao voltar, o botão diz "Continuar de onde parei" e os campos já vêm
preenchidos.

O rascunho fica em **coluna própria**, cifrada, e não em `respostas`: o que está
pela metade não pode aparecer no prontuário como se fosse o que o paciente
entregou. Ao concluir, ele é promovido a resposta e **apagado** — duas cópias
criariam a pergunta "qual delas vale?", que é a pergunta errada para se fazer
diante do prontuário de alguém.

O rastreio não mudou: continua abrindo uma vez só.

### O link agora tem dono: a data de nascimento

O código do link tem 8 a 11 caracteres sorteados de 62 símbolos — ninguém o
adivinha. O risco nunca foi adivinhação, é o link **encaminhado**: a mensagem
vai por WhatsApp, e WhatsApp se encaminha.

Antes de qualquer conteúdo, a página pede a data de nascimento de quem recebeu o
link, e ela é conferida com o cadastro. Acertando, o **aparelho** guarda um passe
assinado e não pergunta mais — a proteção é digitada uma vez, não sete.

**A barreira vem antes do estado, e isso é o principal.** Até aqui, quem tivesse
o link lia o **nome do paciente e o nome do teste** sem passar por nada — e
"Rastreio Terapêutico de TDAH Adulto" é diagnóstico. Por isso a verificação vale
para teste e desafio, e a resposta é a mesma para vencido, concluído e em aberto:
"prove que é você". Dizer que existe um teste vencido para fulano já conta que
fulano está em tratamento.

O que ela **não** protege, dito na hora da escolha: quem convive com o paciente
costuma saber a data. Contra o link encaminhado dentro de casa, um PIN dito na
sessão seria mais forte — e mais caro para o paciente. A escolha foi do cliente,
com a fraqueza na mesa.

**Sem a trava de tentativas isso não valeria nada**: são poucas dezenas de
milhares de datas plausíveis. O balde por código é a defesa inteira aqui — e é
justamente o balde que o comentário do login diz ser inútil contra adivinhação de
código. Os dois estão certos: lá o atacante troca de código a cada tentativa e o
balde nunca enche; aqui ele tem um código e troca a data.

### Consequências que valem saber

- **Enviar para paciente sem data de nascimento é barrado**, com a frase que diz
  o que fazer. Deixar passar geraria um link que ninguém abre — ou, pior, um
  link sem fechadura, em silêncio.
- A comparação normaliza os dois lados: o banco guarda `1990-03-05` e o paciente
  digita `05/03/1990`. Comparar dígitos crus recusava todo mundo, e o erro na
  tela mandava a pessoa conferir a própria certidão. (Achado pelo teste.)
- O cookie tem `Path=/api/answer` e o **código no nome**: um celular com dois
  links de dois familiares não faz o segundo herdar o acesso do primeiro.
- O arquivo da trava passou a ser configurável por `LIMITES_ARQUIVO`, **para as
  suítes**: elas erram a data de propósito e, gravando no arquivo do sistema,
  empilhavam bloqueio de uma execução para a outra até não conseguirem mais
  entrar.

- Migração `007_desafio_rascunho_e_acesso.sql` (`rascunho`, `rascunho_em`,
  `acesso_em`).
- `testar-desafios.cjs`: 55 → **82** verificações. `testar-testes.cjs`: 94 →
  **97**, agora provando que a porta vale para o rastreio também.

---

## 1.26.0 / restrito 1.32.0 — 2026-08-16 · desafios: o formulário nasce do texto

Cada paciente recebe um desafio diferente, escrito para a realidade dele. Um
catálogo fixo não serve — e pedir para alguém montar o formulário campo a campo
significaria, na prática, que ninguém manda desafio.

Agora o terapeuta **cola o texto que escreveu** e o sistema monta o formulário.

### Colar → conferir → aprovar

Em **Cadastros → Testes/desafios**, o botão "Novo desafio" abre uma caixa de
texto. Ao ler o texto, o sistema mostra a **visualização** do formulário como o
paciente vai vê-lo: as orientações onde estão, os exemplos onde estão, e os
campos destacados um a um. O desafio só existe depois que o terapeuta aprova —
e, se algo saiu errado, "Voltar e ajustar o texto" preserva o que foi colado.

Interpretação de texto humano erra; a visualização é o que torna isso
administrável em vez de perigoso.

### O que vira campo, e o que deliberadamente não vira

Três regras: a linha é uma **pergunta** (termina em "?"), traz uma **lacuna**
(`__`), ou a seção manda **registrar** alguma coisa ("anote", "traga",
"escolha"). E o que não vira campo, por decisão:

- **citação** (`>`) — no texto do terapeuta é sempre exemplo de resposta
  ("Estou sem vontade."), e viraria oito caixas para o paciente preencher oito
  ilustrações;
- **lista** (`*`) — é repertório, não questionário;
- **seção que só orienta** ("REGRA IMPORTANTE: não transforme isso em mais uma
  cobrança") — forçar um campo ali faria o paciente achar que devia escrever.

Interpretar é achar o que o texto **pede**, não inventar pergunta que ele não
fez. No desafio de TDAH que o cliente mandou, o resultado são exatamente 7
campos — e o texto dele virou a suíte de teste, palavra por palavra.

### O mesmo link, o mesmo caminho

`/answer/<código>` serve os dois: o paciente não sabe (nem precisa saber) se
recebeu um rastreio ou um desafio. Envio, prontuário, impressão e situações em
tempo real vieram de graça, porque o desafio entra como uma linha de `testes` e
um resolvedor único (`modeloDe`) decide se as perguntas vêm do código ou do
banco.

### Decisões que valem registrar

- **A estrutura do desafio é DADO, e por isso vai ao banco** — ao contrário das
  perguntas dos 13 rastreios, que continuam em `testes-modelos.js`. A migração
  005 argumentava que pergunta é estrutura; isso vale para o que é igual para
  todo mundo. Um desafio escrito para uma pessoa numa semana não tem versão no
  código, e ninguém faz deploy para mandar um desafio.
- **A coluna `estrutura` é cifrada.** "TDAH — observar o que acontece antes de
  deixar para depois", em texto puro numa coluna, é diagnóstico legível por
  quem abrir um dump.
- **Nada de renderizar markdown.** O texto chega colado de fora e é exibido numa
  página pública; ele é reduzido a estrutura (seção, parágrafo, lista, citação,
  campo) e nenhum HTML atravessa.
- **Quem cria desafio é o profissional, não só o admin.** Editar o catálogo de
  rastreios é administração; escrever um desafio é trabalho clínico. Exigir o
  admin faria o terapeuta depender de terceiro para mandar a tarefa da semana.
- Rótulos renomeados: **Testes/desafios** e **Enviar teste/desafio**; a lista
  ganhou a coluna **Tipo** (Rastreio × Desafio).

- Migração `006_desafios.sql` (`tipo`, `estrutura`, `criado_por` em `testes`).
- Suíte nova `testar-desafios.cjs` — **55 verificações**, metade no
  interpretador e metade no caminho do texto colado até a resposta lida.
- A suíte de rastreio passou a contar só `tipo='teste'`: contar a tabela inteira
  a faria quebrar no dia em que a clínica criasse o primeiro desafio de verdade.

---

## 1.25.0 / restrito 1.31.0 — 2026-08-16 · o chat avisa quem não está olhando

O chat entrou ontem e ficava quieto: só existia enquanto a gaveta estava aberta.
Quem estava na agenda não tinha como saber que alguém falou com ele.

Do lado do módulo (LA Chat 0.4.0) o chat passou a ficar **conectado mesmo
fechado** — e daí vieram o selo vermelho no botão, a contagem no título da aba
(`(2) Gestão — BemEstarClinic`) e o aviso sonoro. Daqui, o que mudou foi o
**elenco**.

### A lista de Pessoas é o cadastro do sistema, sempre

Antes o elenco ia para o chat uma única vez, no boot. Funcionário cadastrado às
10h só apareceria no chat depois de reiniciar o serviço; desligado continuaria
lá para sempre. Agora são dois gatilhos, e os dois são necessários:

- **o aviso** — a gestão anuncia "a equipe mudou" (`aoMudarEquipe`) e o elenco
  vai em 2 s. É o caminho normal, e é o que faz a lista mudar na tela de quem
  está com o chat aberto no instante em que o admin salva o cadastro;
- **o relógio** — reenvio de 5 em 5 minutos. É a rede de segurança: o chat pode
  estar fora do ar na hora do cadastro, ou ter sido reiniciado depois. O estado
  converge sozinho, sem ninguém precisar reiniciar o site.

O aviso sai de dentro do `restrito.js`, nos **quatro** pontos que mexem em
`g_usuarios` — inclusive o acesso do profissional, que não tem "usuarios" no
caminho da rota. É por isso que o gatilho é um evento do módulo de gestão e não
uma inspeção da URL no `server.js`: adivinhar por URL erraria em silêncio
justamente nesse quarto ponto.

Quem sai do cadastro é **desativado** no chat (não apagado — o histórico das
conversas continua com autor), e quem volta a ser cadastrado volta a aparecer.

Registrado no log só o que muda: sem isso, o reenvio periódico deixaria 288
linhas idênticas por dia no `journalctl`.

- Nenhuma migração de banco. `CHAT_URL` e `CHAT_SEGREDO_PASSE` continuam sendo
  a configuração inteira.
- Conector `1.3` → `1.4`.

---

## 1.24.1 / restrito 1.30.0 — 2026-08-16 · o chat da equipe, dentro do `/restrito`

A equipe passou a ter **conversa interna** sem sair do sistema: um botão
redondo fixo no canto inferior direito de toda tela do `/restrito`, que abre
uma gaveta lateral. Quem está logado na gestão **já está logado no chat** — não
existe segunda senha, segundo cadastro nem segunda lista de gente.

### Não é biblioteca; é um sistema à parte, instalado aqui

O chat é o **LA Chat**, que roda sozinho, com banco próprio, e pode atender
vários sites. O que mora dentro do BemEstar é um **conector** — um arquivo,
`lachat.js`, sem dependência de `npm` — mais duas linhas no `server.js`. O
conector faz três coisas: repassa `/restrito/chat/*` para o serviço, emite o
**passe** que diz ao chat quem está logado aqui, e leva a **lista da equipe**.

Consequência prática, que é o ponto: **atualizar o chat não é mexer no site**.
O comando é do lado do chat —

    node instalar-em.js --todos --conferir    # quem está atrasado
    node instalar-em.js --todos               # atualiza

e o que o site precisa saber é só o endereço e o segredo, no `.env`
(`CHAT_URL`, `CHAT_SEGREDO_PASSE`). Se o chat cair, o site continua de pé: o
repasse tem teto de tempo e responde 503 só no `/restrito/chat/*`.

### O papel de cada um vira o cargo no chat

Administrador vira **Administração**, secretária vira **Recepção**,
profissional vira **Profissional de saúde** — é o que aparece embaixo do nome
na aba "Pessoas". A equipe inteira é registrada no chat no boot da gestão
(`sincronizarElencoDoChat`), então a primeira pessoa a abrir já encontra os
colegas, em vez de uma lista vazia esperando que todos entrem uma vez.

### Por que em `/restrito/chat` e não em `/chat`

O cookie da gestão tem `Path=/restrito`. Com o chat na raiz, o navegador não
mandava o cookie e o passe respondia 401 — de dentro do sistema, logado. Montar
o chat **dentro** do caminho protegido resolve, e de quebra deixa claro a quem
ele pertence: é ferramenta de equipe, não do site público. Isso exigiu duas
correções no próprio LA Chat (0.3.1), porque nada nele traduzia caminho de
verdade nos dois sentidos.

- Nenhuma migração de banco. A mudança no `server.js` é aditiva.
- Sem chave configurada, o conector avisa no boot e as rotas do chat somem —
  o resto do sistema não muda de comportamento.

---

## 1.24.0 — 2026-08-14 · a página do paciente: `/answer/<código>`

O site ganhou **uma página nova, e uma só**: onde o paciente responde o
questionário que a clínica lhe mandou. Tudo o mais — catálogo, envio,
acompanhamento e leitura — está no `/restrito` 1.29.0.

### Acrescentado

- **`GET /answer/<código>`** — servida por ROTA, a partir de
  `restrito/answer.html`, e nunca como arquivo estático: o HTML fica fora da
  árvore pública do site. Três telas (boas-vindas, questionário com barra de
  progresso, agradecimento) e uma quarta para o link que já não abre, com texto
  próprio para cada motivo — quem já respondeu não pode ler "link inválido" e
  achar que perdeu o que preencheu.
- **`/api/answer/<código>`**, `…/iniciar` e `…/concluir`, públicas como a busca
  de CEP. Passam pelo **mesmo freio de força bruta do login**, mas apenas no
  balde por IP: um balde por "conta" com valor fixo seria um balde único para o
  mundo inteiro, e bastaria um atacante enchê-lo para nenhum paciente conseguir
  mais responder teste nenhum.

### Decisões que valem registro

- **A página não carrega nada de fora.** Sem fonte de CDN, sem biblioteca, sem
  rastreador — uma fonte remota entregaria a um terceiro o IP de quem abriu um
  questionário de saúde, e a página precisa subir em qualquer rede de celular.
- **`/answer` passa pelo modo manutenção**, junto com o painel e a API. O link
  está no celular de alguém com prazo para responder; fechar o site para trocar
  uma foto não pode fazer esse prazo correr contra uma tela de "estamos
  atualizando".
- **`Disallow: /answer/` no robots.txt** — aqui o bloqueio de rastreamento é o
  certo, ao contrário de `/busca/` e `/agendar/`: não há nada a indexar, e um
  rastreador que entrasse **consumiria o link**, porque o teste abre uma vez só.
- **CSP fechada** (`default-src 'none'`), `X-Robots-Tag`, `no-store` e
  `Referrer-Policy: no-referrer` no cabeçalho da resposta.

---

## 1.23.0 — 2026-08-13 · llms.txt, dados estruturados do Feed e WEBP do acervo

Segunda rodada do LA Sentinela (13/08): **19 → 7 pendências**.

### Acrescentado

- **`llms.txt`** (llmstxt.org) — o equivalente do robots.txt para assistentes de
  IA: resumo em Markdown do que a clínica é e do que há no site. Quem responde
  "qual clínica de ozonioterapia tem em Caruaru?" hoje é cada vez mais um
  assistente, e ele acerta muito mais lendo isto do que rastreando HTML.
  **Gerado no publish**, como o sitemap — arquivo escrito à mão envelheceria a
  cada especialidade ou matéria nova. Tudo sai do BANCO; campo não preenchido
  simplesmente não aparece.

- **`imagens-webp.js`** — converte para WEBP as imagens que já estavam no site
  (as novas já chegam convertidas desde a 1.21.0). Local: **1322 kB → 818 kB
  (−38%)**; o `og-image.png` sozinho cairia 85%.

  **Comando à parte, e não migração no boot**, por três motivos: mexe no BANCO
  (o caminho da foto está em `settings`, `portfolio.image`, `team.photo`,
  `posts.image` e dentro do HTML de `posts.content`/`services.content` — converter
  o arquivo sem trocar a referência quebraria a imagem); processar dezenas de
  imagens atrasaria a subida do serviço; e `assets/img/uploads/` está no
  .gitignore, então **os arquivos do servidor não são os desta máquina — rodar
  aqui não conserta a produção.**

  Tem ensaio (`--conferir`) e **não apaga o original**. Converte só se ficar
  menor: PNG chapado às vezes SAI MAIOR em WEBP.

  **`img_og` fica de fora de propósito.** É a imagem do cartão de
  compartilhamento: nenhum visitante a baixa, então converter não melhora Core
  Web Vitals em nada — e entregaria WEBP ao rastreador de cada rede, cujo
  suporte em prévia de link ainda é irregular. Ganho zero contra risco de
  cartão sem imagem.

### Corrigido

- **`/blog/` tinha um `Blog` FIXO no template** que não citava matéria nenhuma
  e não tinha trilha — envelhecia a cada post. Agora sai do banco, como já era
  em `/especialidades/`: `Blog` com `blogPost[]` (cada um `BlogPosting` com
  headline, url, data e imagem absoluta) mais `BreadcrumbList`.

- **Capa do post ganhou `fetchpriority="high"`.** Ela é o LCP da página; a
  intenção agora está declarada, em vez de apenas "não ter lazy".

### Dois achados do relatório que são FALSO POSITIVO (conferidos na produção)

- **"1 de 9 posts sem Article"** — existem **8** posts, todos com `BlogPosting`
  completo (headline, image, datePublished, author, publisher). O nono item é o
  `/blog/`, a página de LISTAGEM, cobrada como se fosse matéria. Listagem não é
  Article; o que faltava ali eram dados estruturados próprios, agora feitos.

- **"1 de 39 imagens sem alt"** — é o `mark-violet.svg` da home, `class="split__mark"`,
  com `alt=""`. Marca decorativa: `alt=""` é o CORRETO pela WCAG, e o próprio
  relatório diz isso. O verificador conta alt vazio como ausente.

- **"9 imagens sem lazy"** — são o hero da home e as 8 capas de post, ou seja o
  **LCP** de cada página. Lazy nelas atrasaria justamente o que o Core Web
  Vitals cronometra.

### Nota de deploy (não óbvia)

Rodar `imagens-webp.js` no local muda o HTML versionado para `.webp`, mas a
produção tem outro banco. Não quebra: o `deploy.sh` refaz as páginas no passo
**7b** (`node server.js --publicar`) a partir do banco de lá, e o serviço está
parado nesse intervalo. Para a produção encolher de fato, o script precisa
rodar **no servidor**.

---

## 1.22.0 — 2026-08-12 · conector do LA Sentinela

Primeira instalação do monitoramento num site real. Três pontos no `server.js`:
o `require`, a construção do conector (ambos logo **antes** do `listen`) e o
`sentinela.contar(req, res)` no **topo** do handler.

- **Por que antes do `listen`, e não junto dos outros `require`:** construir o
  conector já LIGA o laço de envio. Ali ele nasce depois do banco e antes da
  primeira requisição — o handler chama `contar`, então precisa existir; e não
  faz sentido começar a bater antes de o servidor estar de pé.

- **Por que no TOPO do handler:** assim 404, 503 e erro entram na conta. Não
  interfere na resposta — só pendura um ouvinte no `finish`.

- **O SEGREDO NÃO ESTÁ NO CÓDIGO.** Este repositório é **público**; segredo
  commitado aqui fica permanente no histórico do GitHub, e o projeto já pagou
  esse preço duas vezes (`visit_salt` e `data/site.db` com hash de senha seguem
  lá). Vem de `SENT_SEGREDO` no ambiente — `.env` no local, `EnvironmentFile` do
  systemd em produção, igual às credenciais do PostgreSQL. Documentado no
  `.env.exemplo`. **Sem o segredo o conector fica inativo e avisa no boot**; o
  site segue normal.

Provado ponta a ponta: servidor de teste na 5199, tráfego variado, e o beat
CHEGOU — o banco do Sentinela registrou `site_id 1, hits 5, s2xx 4, s4xx 1,
tempo_med 15ms`, batendo com o que foi gerado. Assinatura HMAC aceita.

**Para valer em produção falta `SENT_SEGREDO` em `/etc/bemestar.env`** — deploy
sozinho não liga o conector.

---

## 1.21.0 — 2026-08-12 · a foto que chega pelo painel

Até aqui o `/api/upload` gravava o base64 **cru** no disco, sem olhar. Agora
passa pelo `imagem.js` (novo), sobre o **sharp**.

### O que mudou na prática

| | Antes | Depois |
|---|---|---|
| Metadado da foto | ia inteiro para o site | **descartado** |
| Foto de celular em pé | saía deitada | girada nos pixels |
| 3000×2000, 35 kB | igual | 1333×2000 WEBP, 5 kB |
| Arquivo disfarçado de imagem | **gravado** | recusado com 400 |

- **O motivo principal é privacidade, não peso.** O EXIF de foto de celular
  costuma trazer **coordenadas de GPS**, e numa clínica a foto pode ter sido
  tirada dentro do consultório. O sharp descarta todo metadado por padrão — não
  acrescentar `.withMetadata()` aqui.

- **A ordem importa:** `.rotate()` **antes** de gravar. O celular não gira os
  pixels, grava "está de lado" no EXIF. Apagar o metadado sem aplicar a rotação
  deitaria toda foto de celular no site.

- **O tipo declarado no `data:` URL é texto que o cliente escreve.** Com o sharp
  quem decide a extensão é o que ele conseguiu DECODIFICAR; o que não abre como
  imagem é recusado em vez de ir para o disco.

- **`imagem.js` degrada de propósito.** O sharp é módulo nativo: se o `npm ci`
  do servidor não instalar, um `require` solto derrubaria o processo — e com ele
  o site, o /admin e o /restrito, por causa de um redimensionamento de foto. Sem
  o sharp, o upload volta ao comportamento antigo e o boot **grita no log**.
  Mesma escolha do `db.js`. O CI tem passo próprio que falha se o sharp não
  carregar, porque essa degradação seria silenciosa.

- GIF passa inteiro (converter mataria a animação).

### Ainda NÃO feito

As **17 imagens que já estão no site** continuam em JPG/PNG. Convertê-las não é
só rodar o sharp: os caminhos estão gravados no banco (`portfolio.image`,
`team.photo`, `posts.image`, `settings`), e o banco de produção **não é** o
local. Exige migração no servidor que troque arquivo e referência juntos, com
trava. Fica para uma rodada própria.

Testado: `testar-imagem.cjs` 9/9 + integração pelo `/api/upload` real (login,
envio de foto com GPS, conferência do arquivo gravado, recusa do disfarçado).

**Armadilha do teste:** montar a amostra deitada com
`withExif({IFD0:{Orientation:"6"}})` **não funciona** — o sharp lê de volta como
orientation 1 e o teste acusa defeito inexistente. Use
`withMetadata({orientation: 6})`.

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
