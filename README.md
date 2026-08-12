# BemEstarClinic

Site institucional, painel de conteúdo e **sistema de gestão clínica** da
BemEstarClinic — psicanálise, psicologia, ozonioterapia e terapias integrativas,
em Caruaru-PE.

- **Domínio:** bemestarclinic.com · **Porta interna:** 5185 · **Serviço:** `bemestar.service`
- **Versões:** site `1.20.0` (`APP_VERSION`) · gestão `1.28.0` (`SISTEMA_VERSION`)

As duas séries são independentes e sobem em separado: o site é registrado em
[`CHANGELOG.md`](CHANGELOG.md); a gestão, em `HISTORICO_VERSOES` dentro do
`restrito.js`, e aparece na tela *Sobre o sistema*.

## Sobre

Um único processo Node atende três áreas independentes, que compartilham apenas
a porta:

| Área | O que é | Banco | Sessão |
|---|---|---|---|
| `/` | site público, estático, gerado pelo botão **Publicar** | — | — |
| `/admin/` | painel de conteúdo do site | SQLite · `data/site.db` | cookie `sid` |
| `/restrito/` | **sistema de gestão da clínica** | **PostgreSQL** · `bemestar_gestao` | cookie `rid` |

O `server.js` delega para o `restrito.js` tudo que começa com `/restrito` — e
isso acontece **antes** do modo manutenção, para a equipe seguir atendendo mesmo
com o site fechado ao público. Uma falha do PostgreSQL **não derruba o site**: as
duas outras áreas vivem no SQLite e continuam no ar.

## Objetivo

- Dar à clínica o controle do próprio site, sem depender de programador para
  trocar um texto ou uma foto.
- Substituir a ficha de papel por **prontuário eletrônico**, com anamnese
  padronizada, agenda sem choque de horário e impressão em papel timbrado.
- Proteger dado sensível de paciente: criptografia no banco, recorte de acesso
  por perfil aplicado no servidor e trilha de auditoria.

## Principais funcionalidades

**Site e painel**
- 84 campos editáveis em 19 grupos; 16 páginas de especialidade e blog.
- Publicação por um clique, modo manutenção em duas camadas e contador de
  acessos com IP pseudonimizado.
- SEO calculado na publicação: título ajustado à faixa de exibição do buscador,
  dimensões reais das imagens e cartão de compartilhamento por matéria.

**Sistema de gestão**
- Cadastros: pacientes, profissionais, convênios, procedimentos e salas.
- Agenda com validação de expediente, choque de profissional e choque de sala.
- Anamneses em três modelos (27 seções, 89 campos), que geram tela e impressão.
- Prontuário como **pasta por paciente + procedimento**, com lançamentos datados.
- Relatórios, arquivamento, auditoria e backup do banco pelo painel.
- Perfis **admin**, **secretaria** e **profissional**, com bloqueio no servidor.

## O caminho do paciente (regra de negócio)

```
cadastro → PAC-AAAA-00000 (gerado, nunca digitado)
   ↓
agendamento (exige paciente cadastrado; NÃO cria prontuário)
   ↓
anamnese (rascunho) → FINALIZAR
   ↓
prontuário PR-AAAA-00000 — um por paciente + PROCEDIMENTO
   ↑ recolhe os agendamentos daquele procedimento que estavam soltos
   ↓
próximos agendamentos já nascem vinculados
```

- **O agendamento nunca abre prontuário.** Quem abre a pasta é a anamnese
  **finalizada**.
- **A chave da pasta é o NOME do procedimento**, não o id da linha:
  "Ozonioterapia (Consulta)" e "(Sessão)" caem no mesmo prontuário.
- **Reabrir a anamnese não desfaz o prontuário**, que já pode ter lançamentos.
- **Arquivar ≠ inativar ≠ dar alta** — são três conceitos distintos, de
  propósito.

## Tecnologias

- **Node.js ≥ 20** (CI em 22), com `node:http` — sem framework.
- **PostgreSQL** (`pg`) no sistema de gestão; **SQLite** (`better-sqlite3`) no
  site e no painel.
- **AES-256-GCM** para os dados sensíveis, **scrypt** para as senhas.
- HTML, CSS e JavaScript sem framework nas três interfaces.
- nginx como proxy reverso, systemd como serviço, GitHub Actions na entrega.

Apenas duas dependências de produção: `better-sqlite3` e `pg`.

## Estrutura

```
server.js         site público, painel /admin, publicação, CEP, acessos
restrito.js       sistema de gestão inteiro
pg.js             adaptador do PostgreSQL (traduz o dialeto, decifra na leitura)
db.js             único ponto que abre SQLite
cripto.js         cifragem dos dados sensíveis
backup.js         backup diário dentro do processo
migrations/       esquema do PostgreSQL, versionado
src/              modelos das páginas internas — a ENTRADA da publicação
admin/            painel de conteúdo
restrito/         interface da gestão (app.html) e anexos de paciente
assets/           css, js, imagens e índice de busca
nginx/  ci/  .github/    vhost, entrega no servidor e pipeline
```

> **src/ é a fonte; as pastas de página são a saída.** Editar direto
> `especialidades/index.html` ou `agendar/index.html` funciona até o próximo
> clique em **Publicar**, que sobrescreve tudo a partir de `src/`.

## Como executar

```bash
npm ci --omit=dev      # instala os drivers
node migrar.js         # aplica as migrations pendentes
npm start              # sobe na porta 5185 (ou defina PORT)
```

O `.env` (modelo em `.env.exemplo`) precisa de `DADOS_CHAVE` — 32 bytes em
base64, geradas com `openssl rand -base64 32` — e das credenciais do PostgreSQL.
**O serviço se recusa a subir sem a chave**, de propósito: subir sem ela
significaria voltar a gravar prontuário em texto puro sem ninguém perceber.

Em produção as variáveis vêm do systemd, por `EnvironmentFile=/etc/bemestar.env`.

### Operação no servidor — a ordem importa

```bash
./verificar.sh          # só LÊ: commit, driver, permissões, contagens, backups
sudo ./deploy.sh        # backup → para → protege bancos → pull → npm ci → sobe → confere
```

- **Nunca `git pull` puro.** Os bancos não são versionados; o `deploy.sh` os tira
  do caminho antes do pull.
- **`git pull` não reinicia o Node.** Alterou `server.js` ou `restrito.js`?
  Reinicie — o sintoma típico de esquecer é uma função nova responder
  "Rota não encontrada".
- **`git pull` não instala dependência.** O `deploy.sh` roda `npm ci` no passo 6.
- **Editou texto ou foto no painel?** Clique em **Publicar**.

### Testes

```bash
node testar-limitador.js       # freio de tentativas de senha
node testar-campo-vazio.cjs    # sobe o servidor e testa por HTTP (exige PostgreSQL)
```

Os dois rodam no pipeline antes de qualquer entrega — suíte vermelha não vira
site no ar.

## Documentação

A documentação completa está em [`docs/`](docs/):

| Documento | Conteúdo |
|---|---|
| [Documentação Técnica](docs/documentacao-tecnica.pdf) | Arquitetura, APIs, segurança, configuração, deploy, testes e pontos de atenção |
| [Documentação de Produto](docs/documentacao-produto.pdf) | Funcionalidades, personas, jornadas, regras de negócio e requisitos |
| [Documentação de Banco de Dados](docs/documentacao-banco-de-dados.pdf) | 22 tabelas, diagrama ER, integridade, migrations e proteção dos dados |
| [Documentação de Protótipo](docs/documentacao-prototipo.pdf) | Identidade visual, telas, componentes, estados e navegação |

Complementares: [`CHANGELOG.md`](CHANGELOG.md) (histórico do site),
[`POSTGRES.md`](POSTGRES.md) (instalação e virada do banco) e
[`.env.exemplo`](.env.exemplo) (variáveis de ambiente).

> Os PDFs refletem o site **1.20.0** e a gestão **1.28.0**. Ao subir versão que
> mude arquitetura, banco ou telas, vale regerá-los — a defasagem do README é
> justamente o que esta análise encontrou como principal problema de
> documentação.

## LGPD

O banco da gestão guarda CPF, endereço, anamnese e prontuário — **dado pessoal
sensível** (art. 5º, II). Por isso: 48 colunas são cifradas com chave que vive
fora do banco, a aplicação escuta só em `127.0.0.1`, `/admin` e `/restrito`
enviam `noindex`, `/data`, `/backups` e arquivos `.db`/`.sql` respondem 404, e o
registro de visitas guarda apenas o hash do IP, com retenção de 12 meses.

**Um backup sem a chave não serve para restaurar.** Guarde as duas coisas — em
lugares separados, mas ambas.

## Pendências conhecidas

- **Backup externo.** As cópias ficam na mesma máquina; perda do servidor =
  perda de tudo. Falta destino externo com criptografia.
- **Restauração nunca ensaiada em produção.** O mecanismo está testado; o
  procedimento no servidor real, não.
- **Custódia da `DADOS_CHAVE` não documentada** — onde fica a cópia, quem tem
  acesso, como se recupera.
- **Sem chaves estrangeiras no banco.** Os relacionamentos são mantidos apenas
  pela aplicação; já produziu dois defeitos de vínculo órfão, ambos corrigidos.
  Ver o documento de Banco de Dados, capítulo 6.
- **`visit_salt` não rotacionado** — esteve exposto em repositório público.
- Fotos do topo, do atendimento online e as capas do blog ainda são de banco de
  imagens.
- IDs de GA4/GTM/Pixel/Clarity/Hotjar vazios em `assets/js/config.js`.
