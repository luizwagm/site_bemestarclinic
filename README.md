# BemEstarClinic — site + gerenciador + sistema de gestão

Site da **BemEstarClinic** (psicanálise, ozonioterapia e terapias integrativas,
Caruaru-PE), com painel de conteúdo (`/admin`) e o **sistema de gestão da clínica**
(`/restrito`) — pacientes, agenda, prontuário e anamneses.

- **Domínio:** bemestarclinic.com · **Porta interna:** 5185 · **Serviço:** `bemestar.service`
- **Stack:** Node puro (`node:http` + `node:sqlite`) — zero dependências. Exige **Node ≥ 22.5**.

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
- **profissional** — sua agenda, seus prontuários e as anamneses.

## Operação — a ordem importa

```bash
./verificar.sh          # só lê: commit, permissões, contagens, integridade
sudo ./deploy.sh        # backup → para → protege bancos → pull → devolve → sobe → confere
```

- **Nunca `git pull` puro.** Os bancos não são versionados; o `deploy.sh` tira
  `site.db` **e** `gestao.db` (mais `restrito/arquivos`) do caminho antes do pull.
- **`git pull` não reinicia o Node.** Alterou `server.js` ou `restrito.js`? Reinicie.
- **Editou texto/foto no painel?** Clique em **Publicar**.

## LGPD

O `gestao.db` guarda CPF, endereço, anamnese e prontuário — **dado pessoal
sensível** (art. 5º, II). Por isso: app escuta só em `127.0.0.1`, `/restrito`
exige login e envia `noindex`, `/data` e `.db` respondem 404, `/restrito` está no
`Disallow` do robots, e o `deploy.sh` faz backup próprio do `gestao.db`.
