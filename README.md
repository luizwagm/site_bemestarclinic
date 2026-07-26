# BemEstarClinic — site + gerenciador + sistema de gestão

Site da **BemEstarClinic** (psicanálise, ozonioterapia e terapias integrativas,
Caruaru-PE), com painel de conteúdo (`/admin`) e o **sistema de gestão da clínica**
(`/restrito`) — pacientes, agenda, prontuário e anamneses.

- **Domínio:** bemestarclinic.com · **Porta interna:** 5185 · **Serviço:** `bemestar.service`
- **Stack:** Node puro (`node:http`) + SQLite via **`better-sqlite3`**. Exige **Node ≥ 20**.

## As três áreas

| Área | O que é | Banco | Sessão |
|---|---|---|---|
| `/` | site público (estático, gerado pelo publish) | — | — |
| `/admin/` | painel de conteúdo do site | `data/site.db` | cookie `sid` |
| `/restrito/` | **sistema de gestão da clínica** | `data/gestao.db` | cookie `rid` |

O `/restrito` é um app **independente** (`restrito.js` + `restrito/app.html`):
banco, login e sessão próprios. O `server.js` só delega o que começa com
`/restrito` — e isso acontece **antes** do modo manutenção, para a equipe seguir
atendendo mesmo com o site fechado ao público.

## Site e painel

Nada é editado no HTML. O conteúdo vive em `data/site.db` e o botão **Publicar**
regenera os estáticos. `CAMPOS` no `server.js` é a fonte única do que é editável:
campo novo = 1 linha em `CAMPOS` + `<!--#CHAVE-->` no HTML.

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

- **Todo paciente tem um código próprio**, gerado no cadastro. Com ele — ou com
  nome e CPF (com ou sem máscara) — se acha a pessoa em Agendamento, Prontuário,
  Documentos e Anamneses.
- **O agendamento nunca abre prontuário.** Ele só se pendura numa pasta que já
  exista para aquele paciente naquele procedimento. Quem abre a pasta é a
  **anamnese finalizada**.
- **A chave da pasta é o NOME do procedimento, não o id da linha.** "Ozonioterapia
  (Consulta)" e "(Sessão)" são o mesmo tratamento e caem no mesmo prontuário.
- **Cada procedimento aponta o modelo de anamnese que pede** (campo no cadastro de
  Procedimentos). É o que faz o agendamento oferecer "Preencher anamnese" já no
  formulário certo.
- **O prontuário mostra seus vínculos**: as anamneses (pode ser mais de uma ao
  longo do tratamento) e os agendamentos. Ambos saem na impressão.
- Enquanto está em **rascunho**, a anamnese não cria nada. Depois de
  **finalizada** vira documento fechado (só leitura) até ser reaberta — reabrir
  **não** desfaz o prontuário, que já pode ter lançamentos e agenda pendurados.

## Sistema de gestão (/restrito)

**Login inicial:** `admin` · senha `bemestar-gestao` — **trocar no primeiro acesso**.

Menu: **Painel · Cadastros · Agendamento · Documentos · Relatórios**, com
*Cadastros* → Pacientes, Profissionais, Convênios, Procedimentos, Salas,
**Anamneses** (submenu: Todas / Psicanálise / Ozonioterapia / Terapias
Integrativas) e Prontuário.

### Anamneses
Três modelos, definidos em `MODELOS_ANAMNESE` no `restrito.js` — **fonte única**
que monta o formulário na tela *e* a versão impressa. As respostas ficam em
`anamneses.dados` como JSON, então **acrescentar pergunta não exige mexer no
banco**: basta editar o modelo.

Ao escolher o paciente, o bloco *Dados pessoais* é preenchido sozinho com o
cadastro (nome, nascimento, CPF, RG, estado civil, escolaridade, profissão,
religião, contato, convênio, endereço) — em tela e na impressão.

### Impressão
Todas as impressões saem no **papel timbrado da clínica** (`timbreHTML`): marca
oficial inline, faixa violeta→champagne, e rodapé com CNPJ, endereço e o aviso
de dado sensível. O cabeçalho fica num `<thead>` de tabela de página, técnica que
faz o navegador **repeti-lo a cada quebra de página**.

- **Ficha do paciente** — cadastro completo.
- **Anamnese** — dados pessoais + respostas (caixas ☒/☐, matrizes e listas) + assinaturas.
- **Prontuário completo** — tudo do paciente **em sequência cronológica**: resumo
  com período de tratamento, cada anamnese em página própria, a evolução clínica
  numerada e a tabela de atendimentos. Feito para o caso de 1+ ano de tratamento.
- **Agenda** — em paisagem, agrupada por dia.

### Regras de agenda
Início e fim próprios (o fim é sugerido pela duração do procedimento). Valida:
expediente 06h–22h, fim depois do início, sem choque **do profissional** e sem
choque **da sala**. Cancelados não bloqueiam horário.

### Perfis
- **admin** — tudo.
- **secretaria/recepção** — cadastros, agenda e relatórios. **Não vê prontuário
  nem anamnese** (dado clínico sensível) — bloqueado no servidor, não só na tela.
- **profissional** — sua agenda, **seus lançamentos** de prontuário e as anamneses
  (as anamneses são visíveis a todos os profissionais; os lançamentos, não).

## Banco de dados

SQLite, dois arquivos: `data/site.db` (conteúdo do site) e `data/gestao.db`
(clínica). Quem abre os dois é o **`db.js`**, e só ele — nenhum outro arquivo
importa driver direto.

O driver preferido é o **`better-sqlite3`**. Se `node_modules` não existir, o
`db.js` cai sozinho no `node:sqlite` de fábrica e o sistema continua no ar, só
com um aviso no boot e no `verificar.sh`. Motivo da preferência: o `node:sqlite`
é marcado como **experimental** pelo próprio Node — uma atualização do Node
poderia mudar a interface e derrubar a clínica. Mesma engine, mesmo arquivo
`.db`, mesmo SQL; trocar de driver **não migra nada**.

```bash
npm ci --omit=dev       # instala o driver (o deploy.sh já faz isso)
```

## Backup

O sistema tira backup **sozinho, todo dia**, sem depender de cron: `backup.js`
roda dentro do processo e, de hora em hora, pergunta se já passaram 24h desde a
última cópia. Se a máquina estava desligada na hora marcada, a cópia sai no
próximo boot em vez de ser pulada.

- **Como copia:** `VACUUM INTO` — o backup online do SQLite. Sai consistente com
  o sistema em uso e gravando (testado com escrita concorrente). Copiar o `.db`
  com `cp` **não** dá essa garantia: o WAL fica em outro arquivo.
- **Confere sozinho:** toda cópia é aberta e passa por `integrity_check` antes de
  contar como válida. Cópia quebrada é apagada e vira erro no log.
- **Onde:** `backups/` (fora do git). Guarda as **30** últimas de cada banco.
- **Ajuste:** `BACKUP_HORAS` e `BACKUP_MANTER` no ambiente do serviço.

```bash
node server.js --backup          # copia agora
node server.js --backup-status   # quando foi a última, quantas existem
sudo ./restaurar.sh              # lista os backups disponíveis
sudo ./restaurar.sh gestao       # restaura o gestao.db mais recente
```

O `restaurar.sh` confere a integridade do backup **antes** de sobrescrever,
guarda o banco atual como `.antes-da-restauracao`, e pede confirmação digitada —
restaurar o `gestao.db` descarta tudo que foi lançado depois daquela cópia.

> As cópias ficam no **mesmo servidor**. Isso cobre erro humano e corrupção, mas
> não perda da máquina. Cópia externa (outro servidor ou storage) ainda é uma
> pendência — ver o final deste arquivo.

## Operação — a ordem importa

```bash
./verificar.sh          # só lê: commit, driver, permissões, contagens, backups
sudo ./deploy.sh        # backup → para → protege bancos → pull → npm ci → devolve → sobe → confere
```

- **Nunca `git pull` puro.** Os bancos não são versionados; o `deploy.sh` tira
  `site.db` **e** `gestao.db` (mais `restrito/arquivos`) do caminho antes do pull.
- **`git pull` não reinicia o Node.** Alterou `server.js` ou `restrito.js`? Reinicie.
- **`git pull` não instala dependência.** O `deploy.sh` roda `npm ci` no passo 6.
- **Editou texto/foto no painel?** Clique em **Publicar**.

## LGPD

O `gestao.db` guarda CPF, endereço, anamnese e prontuário — **dado pessoal
sensível** (art. 5º, II). Por isso: app escuta só em `127.0.0.1`, `/restrito`
exige login e envia `noindex`, `/data`, `/backups` e `.db` respondem 404,
`/restrito` está no `Disallow` do robots, e o backup diário cobre o `gestao.db`
junto com o do site.

**Atenção:** os arquivos em `backups/` são cópias completas do banco sensível.
Eles herdam a mesma exigência de proteção do original — não copie para fora do
servidor sem criptografia, e mantenha a pasta fora do alcance do nginx (já está:
`backups` é diretório bloqueado no `server.js` e não é servido).

## Pendências conhecidas

- **Backup externo (offsite).** Hoje as cópias ficam na mesma máquina. Perda do
  servidor = perda de tudo. Falta definir destino e criptografia.
- **Restauração nunca foi ensaiada em produção.** O mecanismo está testado, o
  procedimento no servidor real não.
