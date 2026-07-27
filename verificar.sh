#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — só olha, não altera nada.
#  Rode ANTES do deploy para saber em que estado a produção está.
# ==========================================================================
APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-bemestar.service}"
PORTA="${PORTA:-5185}"
cd "$APP_DIR" || exit 1

echo "===================== ESTADO DA PRODUÇÃO ====================="
echo
echo "Commit atual : $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
echo "Node         : $(node -v)"
echo "Driver SQLite: $(node -p 'require("./db").DRIVER_NOME + (require("./db").DRIVER_AVISO ? "  ⚠ " + require("./db").DRIVER_AVISO : "")' 2>/dev/null || echo '—')"
echo "Serviço      : $(systemctl is-active "$SERVICO" 2>/dev/null)"
printf "Site         : HTTP %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/")"
echo

# O /restrito é uma página só, com todo o JavaScript embutido. Um erro de
# sintaxe ali não aparece em lugar nenhum: o servidor entrega o arquivo, o
# navegador desiste de interpretar e a tela fica em branco, sem erro no log.
# Uma crase dentro do CSS (que mora num template literal) já causou isso.
echo "--- O JavaScript do /restrito compila? ---"
node -e '
  const fs=require("fs");
  const s=fs.readFileSync("restrito/app.html","utf8");
  const i=s.indexOf("<script>"), j=s.lastIndexOf("</script>");
  if(i<0||j<0){ console.log("  não achei o bloco <script> em restrito/app.html"); process.exit(0); }
  const tmp=require("os").tmpdir()+"/bem-app-check.js";
  fs.writeFileSync(tmp, s.slice(i+8,j));
  try { new (require("vm").Script)(fs.readFileSync(tmp,"utf8"), {filename:"app.html"}); console.log("  OK: sem erro de sintaxe"); }
  catch(e){ console.log("  ERRO DE SINTAXE — a tela do /restrito NÃO vai abrir:"); console.log("  " + e.message); }
  finally { try{ fs.unlinkSync(tmp); }catch{} }
' 2>/dev/null || echo "  não consegui verificar"
echo

echo "--- O banco corre risco no próximo pull? ---"
if git ls-files --error-unmatch data/site.db >/dev/null 2>&1; then
  echo "  ATENÇÃO: data/site.db ainda é RASTREADO neste commit."
  echo "  Um git pull simples pode apagá-lo. Use ./deploy.sh, que o protege."
else
  echo "  OK: data/site.db não é rastreado — o git não mexe nele."
fi
echo

echo "--- Permissão de escrita no banco ---"
DONO_SVC=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO_SVC" ] && DONO_SVC="root"
echo "  serviço roda como : $DONO_SVC"
echo "  dono de data/     : $(stat -c '%U:%G %a' data 2>/dev/null || echo '—')"
echo "  dono do site.db   : $(stat -c '%U:%G %a' data/site.db 2>/dev/null || echo '—')"
# o SQLite grava um -journal ao lado do banco: sem escrita NA PASTA, dá
# "attempt to write a readonly database" mesmo com o .db gravável
if sudo -u "$DONO_SVC" test -w data 2>/dev/null && sudo -u "$DONO_SVC" test -w data/site.db 2>/dev/null; then
  echo "  resultado         : OK, o serviço consegue gravar"
else
  echo "  resultado         : SEM PERMISSÃO — o painel não vai salvar nada"
  echo "                      corrija com: sudo chown -R $DONO_SVC: data assets/img/uploads"
fi
echo

echo "--- Conteúdo do banco ---"
if [ -f data/site.db ]; then
  echo "  arquivo: $(du -h data/site.db | cut -f1)"
  node -e '
    const { abrirBanco } = require("./db");
    try {
      const db = abrirBanco("data/site.db");
      for (const t of ["services","team","posts","portfolio","testimonials","settings","visits"])
        console.log("  " + t.padEnd(14) + db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
      console.log("  integridade   " + db.prepare("PRAGMA integrity_check").get().integrity_check);
      const at = db.prepare("SELECT value FROM settings WHERE key=?").get("atendimento");
      if (at) console.log("  bloco Atendemos " + (/<p/.test(at.value) ? "COM HTML (será corrigido no boot)" : "texto puro, ok"));
    } catch (e) { console.log("  ERRO ao ler: " + e.message); }
  ' 2>/dev/null
else
  echo "  data/site.db NÃO EXISTE"
fi
echo

echo "--- Banco da gestão (/restrito) ---"
if [ -f data/gestao.db ]; then
  echo "  arquivo: $(du -h data/gestao.db | cut -f1)"
  node -e '
    const { abrirBanco } = require("./db");
    try {
      const db = abrirBanco("data/gestao.db");
      for (const t of ["pacientes","profissionais","atendimentos","prontuario","prontuario_registros","anamneses"])
        console.log("  " + t.padEnd(22) + db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
      console.log("  integridade           " + db.prepare("PRAGMA integrity_check").get().integrity_check);
    } catch (e) { console.log("  ERRO ao ler: " + e.message); }
  ' 2>/dev/null
else
  echo "  data/gestao.db NÃO EXISTE"
fi
echo

echo "--- Backup automático ---"
node server.js --backup-status 2>/dev/null | sed 's/^/  /' || echo "  não consegui consultar"
echo
echo "--- Últimos backups no disco ---"
# o || não pega o caso vazio porque quem define o código de saída é o sed
LISTA=$(ls -1t backups/*.db 2>/dev/null | head -8)
if [ -n "$LISTA" ]; then echo "$LISTA" | sed 's/^/  /'; else echo "  nenhum ainda (o primeiro sai em até 24h ou no próximo deploy)"; fi
echo "  restaurar:  sudo ./restaurar.sh          (lista)"
echo "              sudo ./restaurar.sh gestao   (restaura o mais recente)"
echo
echo "=============================================================="
