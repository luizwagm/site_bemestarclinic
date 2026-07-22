#!/usr/bin/env bash
# ==========================================================================
#  criar-site.sh — cria o vhost do nginx e emite o certificado
#
#  Uso:  sudo ./criar-site.sh <dominio> <porta> [email]
#  Ex.:  sudo ./criar-site.sh bemestarclinic.com 5185 faleconosco@bemestarclinic.com
#        sudo ./criar-site.sh institutokenosis.com 5189
#
#  Antes de rodar, o DNS precisa estar apontando para este servidor. O script
#  confere isso e para se não estiver — certificado não sai com DNS errado, e
#  o Let's Encrypt limita 5 falhas por hora para o mesmo domínio.
# ==========================================================================
set -uo pipefail

DOMINIO="${1:-}"
PORTA="${2:-}"
EMAIL="${3:-admin@$DOMINIO}"

[ -z "$DOMINIO" ] || [ -z "$PORTA" ] && {
  echo "Uso: sudo $0 <dominio> <porta> [email]"; exit 1; }

verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

# ------------------------------------------------------- 1. conferir o DNS
echo "1/5  Conferindo DNS de $DOMINIO"
IP_SERVIDOR=$(curl -s --max-time 10 https://ifconfig.me || curl -s --max-time 10 https://api.ipify.org)
IP_DOMINIO=$(dig +short A "$DOMINIO" | tail -1)
IP_WWW=$(dig +short A "www.$DOMINIO" | tail -1)
CNAME_APEX=$(dig +short CNAME "$DOMINIO")

echo "     servidor          : $IP_SERVIDOR"
echo "     $DOMINIO          : ${IP_DOMINIO:-(sem registro A)}"
echo "     www.$DOMINIO      : ${IP_WWW:-(sem registro A)}"

if [ -n "$CNAME_APEX" ]; then
  vermelho "     ERRO: o domínio raiz está como CNAME ($CNAME_APEX)."
  vermelho "     CNAME no domínio raiz é inválido pela RFC 1034 e quebra a validação."
  vermelho "     Troque por um registro A apontando para $IP_SERVIDOR."
  exit 1
fi
if [ "$IP_DOMINIO" != "$IP_SERVIDOR" ]; then
  vermelho "     ERRO: $DOMINIO não aponta para este servidor."
  vermelho "     Crie um registro A: $DOMINIO -> $IP_SERVIDOR"
  vermelho "     (a propagação leva de minutos a algumas horas)"
  exit 1
fi
verde "     DNS ok"

DOMINIOS="-d $DOMINIO"
if [ "$IP_WWW" = "$IP_SERVIDOR" ]; then
  DOMINIOS="$DOMINIOS -d www.$DOMINIO"
  verde "     www também aponta para cá — vai no mesmo certificado"
else
  amarelo "     www.$DOMINIO não aponta para cá — certificado só para o domínio raiz"
fi

# ------------------------------------------------- 2. a aplicação responde?
echo "2/5  Testando a aplicação em 127.0.0.1:$PORTA"
CODIGO=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$PORTA/" || echo 000)
if [ "$CODIGO" != "200" ]; then
  vermelho "     a aplicação não respondeu (HTTP $CODIGO)."
  vermelho "     Suba o serviço antes: systemctl status <servico>"
  exit 1
fi
verde "     aplicação no ar"

# -------------------------------------------------------------- 3. o vhost
echo "3/5  Criando o vhost"
ARQ="/etc/nginx/sites-available/$DOMINIO"
if [ -f "$ARQ" ]; then
  cp "$ARQ" "$ARQ.bak-$(date +%F-%H%M%S)"
  amarelo "     já existia — copiei para $ARQ.bak-*"
fi

cat > "$ARQ" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMINIO www.$DOMINIO;

    # o painel envia foto em base64 no JSON; o padrão de 1 MB devolveria 413
    client_max_body_size 25m;

    access_log /var/log/nginx/$DOMINIO.access.log;
    error_log  /var/log/nginx/$DOMINIO.error.log;

    location ~ /\\.(git|env|gitignore) {
        deny all;
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORTA;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        # sem estes dois a aplicação vê todo mundo como 127.0.0.1: o contador
        # de acessos conta 1 visitante e o cookie de sessão perde o Secure
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_connect_timeout 10s;
        proxy_read_timeout    60s;
    }
}
NGINX

ln -sf "$ARQ" "/etc/nginx/sites-enabled/$DOMINIO"
if ! nginx -t 2>&1 | sed 's/^/     /'; then
  vermelho "     configuração inválida — nada foi recarregado"
  exit 1
fi
systemctl reload nginx
verde "     vhost ativo em HTTP"

# ----------------------------------------------------------- 4. certificado
echo "4/5  Emitindo o certificado"
# shellcheck disable=SC2086
if certbot --nginx $DOMINIOS --redirect --agree-tos --no-eff-email -m "$EMAIL" --non-interactive; then
  verde "     certificado emitido e HTTPS ativado"
else
  vermelho "     o certbot falhou. O site segue funcionando em HTTP."
  vermelho "     Veja /var/log/letsencrypt/letsencrypt.log"
  exit 1
fi

# --------------------------------------------------------------- 5. testes
echo "5/5  Conferindo"
sleep 2
HTTPS=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMINIO/" || echo 000)
REDIR=$(curl -s -o /dev/null -w "%{http_code}" "http://$DOMINIO/" || echo 000)
echo "     https://$DOMINIO      -> $HTTPS"
echo "     http (deve ser 301)   -> $REDIR"
certbot renew --dry-run >/dev/null 2>&1 \
  && verde "     renovação automática testada com sucesso" \
  || amarelo "     atenção: o teste de renovação falhou — rode 'certbot renew --dry-run'"

echo
if [ "$HTTPS" = "200" ]; then
  verde "Pronto: https://$DOMINIO no ar."
else
  amarelo "HTTPS respondeu $HTTPS — confira os logs em /var/log/nginx/$DOMINIO.error.log"
fi
