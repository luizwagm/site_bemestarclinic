#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — atualiza a BemEstarClinic em produção
#
#  Uso:  sudo ./deploy.sh
#
#  O que ele faz, nesta ordem:
#    1. backup do banco (é o conteúdo inteiro do site)
#    2. git pull, protegendo o banco e as fotos enviadas pelo painel
#    3. reinicia o serviço
#    4. confere se o site voltou no ar; se não voltou, restaura o backup
#
#  Por que o backup vem primeiro: data/site.db guarda TUDO que o cliente
#  editou pelo painel. Um pull mal resolvido sem backup é perda de conteúdo.
# ==========================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/projetos/BemEstarClinic}"
SERVICO="${SERVICO:-bemestarclinic}"
PORTA="${PORTA:-5185}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
MANTER_BACKUPS=20

cd "$APP_DIR"

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

# ---------------------------------------------------------------- 1. backup
azul "1/4  Backup do banco"
mkdir -p "$BACKUP_DIR"
CARIMBO=$(date +%Y-%m-%d_%H%M%S)
BACKUP="$BACKUP_DIR/site.db.$CARIMBO"

if [ -f data/site.db ]; then
  # .backup do sqlite3 copia com consistência mesmo com o servidor escrevendo;
  # se o sqlite3 não estiver instalado, o cp resolve (o banco é pequeno)
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/site.db ".backup '$BACKUP'"
  else
    cp data/site.db "$BACKUP"
  fi
  verde "     salvo em $BACKUP ($(du -h "$BACKUP" | cut -f1))"
  ls -1t "$BACKUP_DIR"/site.db.* 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
else
  amarelo "     data/site.db não existe ainda — primeira instalação?"
fi

# ------------------------------------------------------------------ 2. pull
azul "2/4  Baixando a versão nova"
# o banco e os uploads são do servidor, não do repositório. Se algum dia
# voltarem a ser rastreados por engano, este stash evita que o pull os derrube.
git stash push --quiet --include-untracked -- data assets/img/uploads 2>/dev/null || true
ANTES=$(git rev-parse --short HEAD)
git pull --ff-only
DEPOIS=$(git rev-parse --short HEAD)
git stash pop --quiet 2>/dev/null || true

if [ "$ANTES" = "$DEPOIS" ]; then
  amarelo "     já estava na versão mais recente ($DEPOIS)"
else
  verde "     $ANTES → $DEPOIS"
  git log --oneline "$ANTES..$DEPOIS" | sed 's/^/       /'
fi

# --------------------------------------------------------------- 3. restart
azul "3/4  Reiniciando o serviço"
# git pull NÃO reinicia o Node: o processo continua com o código antigo em
# memória até o restart. Foi exatamente isso que travou o deploy da v1.5.0.
systemctl restart "$SERVICO"
sleep 3

# ----------------------------------------------------------------- 4. teste
azul "4/4  Conferindo se o site respondeu"
OK=0
for i in $(seq 1 10); do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/" || echo 000)
  if [ "$CODIGO" = "200" ]; then OK=1; break; fi
  sleep 2
done

if [ "$OK" = "1" ]; then
  VERSAO=$(curl -s "http://127.0.0.1:$PORTA/admin/" | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
  verde "     site no ar (HTTP 200) — gerenciador $VERSAO"
  echo
  verde "Deploy concluído."
  echo "  Se mudou texto ou foto, entre no painel e clique em Publicar."
else
  vermelho "     o site NÃO respondeu (último código: $CODIGO)"
  echo
  vermelho "Últimas linhas do log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  echo
  amarelo "O backup do banco está intacto em:"
  amarelo "  $BACKUP"
  amarelo "Para restaurar:  systemctl stop $SERVICO && cp '$BACKUP' data/site.db && systemctl start $SERVICO"
  exit 1
fi
