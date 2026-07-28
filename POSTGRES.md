# PostgreSQL no servidor Hetzner — instalação e virada

Guia da migração do sistema de gestão (`/restrito`) do SQLite para o PostgreSQL.

**O site e o `/admin` NÃO mudam.** Eles continuam no SQLite, em `data/site.db`.
Só o `/restrito` — pacientes, agenda, prontuário, anamneses — passou para o
Postgres. Os dois convivem no mesmo processo Node.

| | |
|---|---|
| Servidor | Hetzner · `204.168.208.52` · host `budget-ia-prod` · usuário `deploy` |
| Caminho | `/var/www/projetos/BemEstarClinic` |
| Serviço | `bemestar.service` · porta 5185 |
| Banco novo | `bemestar_gestao` · usuário `bemestar` · só em `127.0.0.1` |

---

## Antes de começar

Reserve uma janela em que a clínica **não** esteja atendendo. A virada em si
leva minutos, mas ninguém pode estar cadastrando paciente enquanto os dados são
copiados — o que for gravado depois da cópia ficaria só no banco antigo.

---

## 1. Instalar o PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-client
```

O Debian/Ubuntu já sobe o serviço e o habilita no boot. Confira:

```bash
systemctl status postgresql --no-pager
psql --version
```

O `postgresql-client` **não é opcional**: é dele que vêm o `pg_dump` (usado pelo
backup automático e pelo botão do painel) e o `psql` (usado na restauração).

---

## 2. Criar o banco e o usuário da aplicação

Gere uma senha forte e **guarde-a** — ela vai para o arquivo de ambiente no
passo 3 e não aparece em lugar nenhum depois:

```bash
openssl rand -base64 24
```

Crie o usuário e o banco (troque `COLE_A_SENHA_AQUI`):

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bemestar LOGIN PASSWORD 'COLE_A_SENHA_AQUI';
CREATE DATABASE bemestar_gestao OWNER bemestar ENCODING 'UTF8' TEMPLATE template0;
SQL
```

O `TEMPLATE template0` garante que o banco nasça com a codificação pedida,
independente de como o servidor foi instalado — sem isso, um servidor criado com
locale `C` recusaria o UTF-8.

Confirme que o usuário entra:

```bash
psql "postgresql://bemestar@127.0.0.1/bemestar_gestao" -c "SELECT current_database(), current_user;"
```

### Fechar o banco para o mundo

O Postgres já nasce escutando só em `localhost` no Debian/Ubuntu. Confirme —
este banco guarda prontuário, não pode aceitar conexão externa:

```bash
sudo -u postgres psql -c "SHOW listen_addresses;"     # deve dizer: localhost
sudo ss -lntp | grep 5432                              # deve mostrar 127.0.0.1:5432
```

Se aparecer `0.0.0.0:5432`, corrija em `/etc/postgresql/*/main/postgresql.conf`
(`listen_addresses = 'localhost'`) e reinicie. E confirme que o firewall não
abriu a porta:

```bash
sudo ufw status | grep 5432    # não deve haver regra nenhuma para 5432
```

---

## 3. Entregar as credenciais ao serviço

Além da senha do banco, é preciso a **chave que cifra os dados sensíveis**.
Gere-a agora:

```bash
openssl rand -base64 32
```

> **Guarde essa chave fora do servidor.** Sem ela, CPF, RG, endereço, telefone,
> e-mail, anamneses e prontuários ficam ilegíveis — inclusive nos backups.
> Perder a chave é perder os dados, mesmo tendo o banco inteiro na mão.

Nada disso entra no repositório. As duas vivem num arquivo lido pelo systemd:

```bash
sudo tee /etc/bemestar.env >/dev/null <<'ENV'
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=bemestar
PGPASSWORD=COLE_A_SENHA_DO_BANCO
PGDATABASE=bemestar_gestao
DADOS_CHAVE=COLE_A_CHAVE_DE_32_BYTES
ENV

sudo chown root:deploy /etc/bemestar.env
sudo chmod 640 /etc/bemestar.env
```

`640 root:deploy` e não `600 root:root`: o serviço roda como `deploy`, e com
`600` você não conseguiria rodar `verificar.sh`, `migrar-dados.js` nem
`cifrar-dados.js` sem `sudo`. Continua fechado para os demais usuários da
máquina.

Ligue o arquivo ao serviço:

```bash
sudo systemctl edit bemestar.service
```

No editor que abrir, escreva:

```ini
[Service]
EnvironmentFile=/etc/bemestar.env
```

E recarregue:

```bash
sudo systemctl daemon-reload
```

---

## 4. Atualizar o código

```bash
cd /var/www/projetos/BemEstarClinic
./verificar.sh                 # fotografia do estado atual, antes de mexer
sudo ./deploy.sh               # backup → pull → npm ci → restart
```

O `deploy.sh` faz `npm ci`, que instala a dependência nova (`pg`). **`git pull`
sozinho não instala dependência** — se você atualizar à mão, rode
`npm ci --omit=dev` depois.

Nesta etapa o serviço vai **falhar ao subir**, e isso é esperado: o banco novo
ainda está vazio. O próximo passo resolve.

---

## 5. Migrar os dados

Primeiro **só o diagnóstico** — não escreve nada:

```bash
cd /var/www/projetos/BemEstarClinic
node migrar-dados.js --conferir
```

Ele lista quantas linhas há em cada tabela e avisa se existe algo que o Postgres
vai recusar: prontuário repetido para o mesmo paciente+procedimento, código de
paciente duplicado, número de prontuário duplicado. Se aparecer alguma coisa,
**resolva no sistema antes de continuar** — o SQLite antigo aceitava essas
duplicatas porque os índices únicos eram criados dentro de um try/catch e podiam
simplesmente não nascer.

Com o diagnóstico limpo, migre:

```bash
sudo systemctl stop bemestar          # ninguém escrevendo durante a cópia
node migrar-dados.js
```

O script aplica as migrations, copia tabela por tabela **numa transação só**
(se qualquer linha falhar, nada é gravado), preserva os ids, acerta os
contadores de sequência e no fim **confere**: conta as linhas dos dois lados e
compara o conteúdo de uma amostra. Divergência é erro, não aviso.

## 5b. Proteger os dados sensíveis

Com os dados já no Postgres, cifre o que é sensível. Primeiro veja o que falta
(não escreve nada):

```bash
node cifrar-dados.js --conferir
```

Depois proteja:

```bash
node cifrar-dados.js
```

Ele cifra CPF, RG, endereço, telefone, e-mail, contatos, anamneses, lançamentos
do prontuário e o histórico. É **seguro rodar de novo**: o que já está cifrado
é pulado, e uma execução interrompida continua de onde parou. No fim ele
confere, lendo pelos dois caminhos, que o banco guarda cifrado e que o sistema
lê corretamente.

Depois disso o sistema já grava cifrado sozinho — não é preciso repetir.

## 6. Subir e conferir

```bash
sudo systemctl start bemestar
systemctl status bemestar --no-pager
journalctl -u bemestar -n 40 --no-pager
```

No log deve aparecer `Banco da gestão: PostgreSQL — bemestar_gestao`.

Se aparecer `chave dos dados sensíveis ausente ou inválida`, falta o
`DADOS_CHAVE` no `/etc/bemestar.env`. O serviço **se recusa a subir** sem ela de
propósito: subir sem a chave significaria voltar a gravar prontuário em texto
puro com a clínica trabalhando normalmente e ninguém percebendo.

---

## 6. Conferir com os próprios olhos

Antes de liberar a equipe, entre no `/restrito` e confira:

- a lista de **pacientes** tem o mesmo total de antes;
- a **busca por nome** funciona digitando em minúsculas (`maria` acha `Maria`);
- um **prontuário** antigo abre com os lançamentos;
- a **agenda** mostra os agendamentos nas datas certas;
- uma **anamnese** finalizada continua ligada à sua pasta;
- **Backup do banco** (menu do topo, à direita) baixa um `.sql`.

A busca em minúsculas está nessa lista de propósito: o `LIKE` do SQLite ignora
maiúsculas e o do Postgres não. O sistema traduz para `ILIKE`, mas é o teste que
prova.

### Guarde o banco antigo

```bash
sudo mv data/gestao.db data/gestao.db.antes-do-postgres
```

Não apague. É o seu ponto de volta se algo aparecer semanas depois. O
`backup.js` já não o copia mais — ele passou a dumpar o Postgres.

---

## Operação no dia a dia

### Backup

Automático, diário, dentro do próprio processo (sem cron), guardando 30 cópias
em `backups/`:

- gestão → `bemestar_gestao.AAAAMMDD-HHMMSS.sql` (pg_dump)
- site → `site.AAAAMMDD-HHMMSS.db` (VACUUM INTO)

Sob demanda: **Backup do banco**, no menu do topo do `/restrito` (só admin).
Baixa o `.sql` completo pelo navegador.

```bash
node server.js --backup           # força uma cópia agora
node server.js --backup-status    # quando foi a última, quantas existem
```

Os dumps saem **cifrados**: os dados sensíveis dentro deles só são legíveis num
servidor que tenha a mesma `DADOS_CHAVE`. Um backup que vaze não entrega
prontuário nenhum — mas, pelo mesmo motivo, **um backup sem a chave não serve
para restaurar**. Guarde as duas coisas, em lugares separados.

### Restaurar

```bash
sudo ./restaurar.sh gestao
```

Ele confere o dump, guarda o estado atual antes de sobrescrever e pede
confirmação. À mão, se preferir:

```bash
psql "postgresql://bemestar@127.0.0.1/bemestar_gestao" -f backups/bemestar_gestao.AAAAMMDD-HHMMSS.sql
```

O dump é gerado com `--clean --if-exists`, então ele apaga o que existe antes de
recriar: restaurar substitui o banco inteiro, não mistura com o que está lá.
Os dados voltam cifrados e o sistema volta a lê-los normalmente — desde que o
`DADOS_CHAVE` seja o mesmo de quando foram gravados.

### Trocar a chave

Ponha a chave atual em `DADOS_CHAVE_ANTERIOR`, a nova em `DADOS_CHAVE`,
reinicie e rode `node cifrar-dados.js`. O sistema continua **lendo** o que foi
escrito com a antiga enquanto **grava** com a nova. Quando o script terminar,
remova a linha `DADOS_CHAVE_ANTERIOR`.

### Mudar o esquema

Nunca mais `ALTER TABLE` solto no código. Crie um arquivo em `migrations/` com o
número seguinte:

```
migrations/002_o_que_mudou.sql
```

Ele é aplicado uma vez, registrado em `schema_migrations`, e roda dentro de uma
transação — ou entra inteiro, ou não entra.

```bash
node migrar.js --status    # o que já foi aplicado e o que falta
node migrar.js             # aplica o que falta
```

O boot do serviço também aplica o que estiver pendente.

---

## Quando der errado

**O serviço não sobe.** O log diz o motivo. As causas prováveis:

```bash
journalctl -u bemestar -n 50 --no-pager
systemctl status postgresql --no-pager
sudo systemctl show bemestar -p EnvironmentFiles     # o /etc/bemestar.env está ligado?
psql "postgresql://bemestar@127.0.0.1/bemestar_gestao" -c '\dt'
```

**"password authentication failed"** — a senha em `/etc/bemestar.env` não bate
com a do banco. Redefina:

```bash
sudo -u postgres psql -c "ALTER ROLE bemestar PASSWORD 'nova-senha';"
```

E atualize o arquivo + `sudo systemctl restart bemestar`.

**"pg_dump não está instalado"** no botão de backup — falta o pacote:

```bash
sudo apt install -y postgresql-client
```

**A busca de paciente parou de achar nomes.** Sintoma de `LIKE` sem tradução
para `ILIKE`. Abra um chamado — é bug do código, não de configuração.

---

## O que ficou pendente

- **O backup continua só dentro do servidor.** Cobre erro humano e corrupção,
  não perda da máquina. Falta um destino externo **com criptografia**: as cópias
  são a clínica inteira em texto puro.
- **A restauração nunca foi ensaiada em produção.** O mecanismo está testado; o
  procedimento no servidor real, não. Vale fazer um ensaio com o banco de teste
  antes de precisar dele de verdade.
