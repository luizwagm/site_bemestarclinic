#!/usr/bin/env node
/* ==========================================================================
   sentinela-agente.js — AUDITORIA DE DENTRO DO SERVIDOR

   Roda NO servidor (cron ou systemd timer), de preferência como root, e
   manda o resultado assinado para o LA Sentinela. É o par do
   `lasentinela.js`: aquele fica dentro do site contando acessos; este olha
   a máquina — sistema, SSH, firewall, portas abertas, contas, PostgreSQL e
   SQLite.

   POR QUE PRECISA SER DE DENTRO: nada disso é visível pela URL. De fora dá
   para ver que a porta 5432 responde; só de dentro dá para ver que o
   `pg_hba.conf` tem uma linha `trust`, que o SSH aceita senha, que o
   firewall está desligado ou que o banco SQLite está com permissão 644 numa
   pasta servida pela web.

   O QUE ELE NÃO FAZ: não muda nada. Nenhum comando aqui escreve, instala,
   reinicia ou apaga — são leituras de arquivo e comandos de consulta
   (`ss`, `ufw status`, `pg_lsclusters`). O que ele encontra vira
   recomendação no painel, para VOCÊ aplicar.

   Uso:
     node sentinela-agente.js                    # audita e envia
     node sentinela-agente.js --mostrar          # audita e imprime, sem enviar
     node sentinela-agente.js --json             # imprime o JSON cru

   Configuração por ambiente (ou por argumento):
     SENT_URL, SENT_SITE, SENT_SEGREDO
     SENT_WEBROOT=/var/www/projetos    (onde procurar bancos SQLite)
   ========================================================================== */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const VERSAO_AGENTE = "1.1";

/* ---------------------------------------------------------------- utilidades */

/* Executa um comando de LEITURA. Nunca joga: comando ausente ou sem
   permissão devolve null, e a checagem correspondente vira "não sei" em vez
   de virar alarme falso. */
function cmd(bin, args = [], { timeout = 8000 } = {}) {
  try {
    return execFileSync(bin, args, { timeout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
const existe = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const ler = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const modo = (p) => { const s = stat(p); return s ? (s.mode & 0o777) : null; };
const octal = (m) => (m == null ? "?" : m.toString(8).padStart(3, "0"));
const ehRoot = () => { try { return typeof process.getuid === "function" && process.getuid() === 0; } catch { return false; } };
const linhas = (t) => String(t || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const ach = (chave, categoria, severidade, titulo, descricao, evidencia, recomendacao) =>
  ({ chave, categoria, severidade, titulo, descricao, evidencia, recomendacao });

/* ====================================================================== */
/*  1. SISTEMA — versão, atualizações pendentes, reboot                    */
/* ====================================================================== */
function auditarSistema() {
  const achados = [], fatos = {};

  const osRelease = ler("/etc/os-release") || "";
  fatos.distro = (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(osRelease) || [])[1] || os.type();
  fatos.kernel = os.release();
  fatos.hostname = os.hostname();
  fatos.uptime_s = Math.round(os.uptime());
  fatos.node = process.version;
  fatos.root = ehRoot();

  /* Reinício pendente: o Debian/Ubuntu deixa este arquivo depois de atualizar
     kernel/libc. Rodar com kernel velho é rodar com a falha já corrigida. */
  if (existe("/var/run/reboot-required")) {
    const pacotes = (ler("/var/run/reboot-required.pkgs") || "").split("\n").filter(Boolean).slice(0, 8).join(", ");
    fatos.reboot_pendente = true;
    achados.push(ach("sistema-reboot", "sistema", "media", "Servidor precisa reiniciar para aplicar atualização",
      "Um pacote de sistema (kernel ou biblioteca) foi atualizado, mas o processo antigo continua em memória — a correção só vale depois do reboot.",
      pacotes ? `Pacotes: ${pacotes}` : "/var/run/reboot-required presente",
      "Agende a janela e reinicie: `sudo shutdown -r +5 \"manutenção\"`. Confira depois se os serviços subiram (systemctl --failed) e se o site respondeu."));
  }

  /* Atualizações de segurança pendentes. O apt-check do update-notifier é a
     forma barata; o `apt-get -s` é o plano B. */
  let seg = null, total = null;
  const apt = cmd("/usr/lib/update-notifier/apt-check", [], { timeout: 20000 });
  if (apt && /^\d+;\d+$/.test(apt)) { const [t, s] = apt.split(";").map(Number); total = t; seg = s; }
  else {
    const sim = cmd("apt-get", ["-s", "upgrade"], { timeout: 25000 });
    if (sim) {
      const ups = linhas(sim).filter((l) => l.startsWith("Inst "));
      total = ups.length;
      seg = ups.filter((l) => /security/i.test(l)).length;
    }
  }
  if (seg != null) {
    fatos.updates_seguranca = seg; fatos.updates_total = total;
    if (seg > 0)
      achados.push(ach("sistema-updates-seguranca", "sistema", seg >= 10 ? "alta" : "media",
        `${seg} atualização(ões) de segurança pendente(s)`,
        "Pacotes com correção de segurança publicada e ainda não aplicada. É a via de invasão mais explorada porque a falha já é pública.",
        `${seg} de segurança · ${total} no total`,
        "Aplique: `sudo apt update && sudo apt upgrade`. Para não depender de lembrar, habilite o automático: `sudo dpkg-reconfigure -plow unattended-upgrades`."));
  }

  /* unattended-upgrades ligado? (o mesmo que reinicia o Postgres de
     madrugada — mas o remédio é tê-lo ligado e saber do horário.) */
  const uu = ler("/etc/apt/apt.conf.d/20auto-upgrades") || "";
  fatos.auto_upgrades = /Unattended-Upgrade\s+"1"/.test(uu);
  if (existe("/etc/apt") && !fatos.auto_upgrades)
    achados.push(ach("sistema-sem-auto-update", "sistema", "media", "Atualização automática de segurança desligada",
      "Sem o unattended-upgrades, toda correção depende de alguém lembrar de rodar o apt.",
      "/etc/apt/apt.conf.d/20auto-upgrades sem Unattended-Upgrade \"1\"",
      "Ligue: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`. Lembre que ele reinicia serviços de madrugada — o app precisa reconectar sozinho ao banco."));

  return { achados, fatos };
}

/* ====================================================================== */
/*  2. SSH — a porta da frente do servidor                                 */
/* ====================================================================== */
function auditarSsh() {
  const achados = [], fatos = {};
  let conf = ler("/etc/ssh/sshd_config");
  if (!conf) return { achados, fatos: { presente: false } };

  /* O Debian moderno espalha configuração em sshd_config.d/*.conf, e o que
     está lá costuma VENCER (Include no topo). Ler só o arquivo principal dá
     diagnóstico errado — é o erro clássico. */
  try {
    for (const f of fs.readdirSync("/etc/ssh/sshd_config.d").filter((x) => x.endsWith(".conf")).sort())
      conf += "\n" + (ler(path.join("/etc/ssh/sshd_config.d", f)) || "");
  } catch { }

  /* No SSH vale a PRIMEIRA ocorrência; com Include no topo, o do .d vem antes. */
  const opt = (nome, padrao) => {
    const re = new RegExp(`^\\s*${nome}\\s+(.+)$`, "im");
    const m = re.exec(conf);
    return m ? m[1].trim().split(/\s+/)[0] : padrao;
  };
  fatos.presente = true;
  fatos.porta = opt("Port", "22");
  fatos.permit_root = opt("PermitRootLogin", "prohibit-password");
  fatos.senha = opt("PasswordAuthentication", "yes");
  fatos.chave = opt("PubkeyAuthentication", "yes");
  fatos.vazia = opt("PermitEmptyPasswords", "no");
  fatos.max_tentativas = opt("MaxAuthTries", "6");

  if (/^yes$/i.test(fatos.permit_root))
    achados.push(ach("ssh-root", "ssh", "alta", "SSH aceita login direto como root",
      "Com PermitRootLogin yes, quem descobrir a senha do root entra com poder total — e 'root' é o único usuário cujo nome o atacante já sabe.",
      `PermitRootLogin ${fatos.permit_root}`,
      "Em /etc/ssh/sshd_config (ou no arquivo de sshd_config.d que estiver vencendo): `PermitRootLogin prohibit-password` (ou `no`). Entre com o usuário comum e use sudo. Recarregue: `sudo systemctl reload ssh`."));

  if (/^yes$/i.test(fatos.senha))
    achados.push(ach("ssh-senha", "ssh", "alta", "SSH aceita autenticação por senha",
      "Senha pode ser adivinhada; chave, não. É a diferença entre um alvo de força bruta 24h por dia e um alvo impossível de adivinhar.",
      `PasswordAuthentication ${fatos.senha}`,
      "Instale sua chave (`ssh-copy-id usuario@servidor`), CONFIRME que entra sem senha numa segunda janela e só então: `PasswordAuthentication no` + `sudo systemctl reload ssh`. Nunca troque sem testar antes — dá para se trancar do lado de fora."));

  if (/^yes$/i.test(fatos.vazia))
    achados.push(ach("ssh-senha-vazia", "ssh", "critica", "SSH aceita senha vazia",
      "PermitEmptyPasswords yes deixa entrar qualquer conta que esteja sem senha.",
      `PermitEmptyPasswords ${fatos.vazia}`,
      "Ponha `PermitEmptyPasswords no` e recarregue o SSH."));

  /* fail2ban: não é obrigatório, mas sem ele o SSH exposto apanha o dia todo. */
  const f2b = cmd("systemctl", ["is-active", "fail2ban"]);
  fatos.fail2ban = f2b === "active";
  if (!fatos.fail2ban && /^yes$/i.test(fatos.senha))
    achados.push(ach("ssh-sem-fail2ban", "ssh", "media", "SSH com senha e sem fail2ban",
      "A combinação senha + sem bloqueio de tentativas deixa o SSH sofrendo força bruta contínua da internet.",
      `fail2ban: ${f2b || "não instalado"}`,
      "Instale e ligue: `sudo apt install fail2ban && sudo systemctl enable --now fail2ban`. Melhor ainda: desligar a senha (ssh-senha) e manter só chave."));

  return { achados, fatos };
}

/* ====================================================================== */
/*  3. FIREWALL + PORTAS ABERTAS                                           */
/* ====================================================================== */
const PORTAS_ESPERADAS = new Set(["22", "80", "443"]);

function auditarFirewallEPortas() {
  const achados = [], fatos = {};

  /* --- estado do firewall --- */
  let ativo = null, politica = null, ferramenta = null, regras = [];
  const ufw = cmd("ufw", ["status", "verbose"]);
  if (ufw) {
    ferramenta = "ufw";
    ativo = /Status:\s*active/i.test(ufw);
    politica = (/Default:\s*([^\n(]+)/i.exec(ufw) || [])[1]?.trim() || null;
    regras = linhas(ufw).filter((l) => /ALLOW|DENY/i.test(l)).slice(0, 40);
  } else {
    const nft = cmd("nft", ["list", "ruleset"]);
    if (nft && nft.length > 20) {
      ferramenta = "nftables";
      ativo = /type filter hook input/i.test(nft);
      politica = (/hook input[^;]*policy (\w+)/i.exec(nft) || [])[1] || null;
    } else {
      const ipt = cmd("iptables", ["-S"]);
      if (ipt) {
        ferramenta = "iptables";
        politica = (/-P INPUT (\w+)/.exec(ipt) || [])[1] || null;
        ativo = !!politica && politica.toUpperCase() !== "ACCEPT";
        regras = linhas(ipt).filter((l) => l.startsWith("-A INPUT")).slice(0, 40);
      }
    }
  }
  fatos.ferramenta = ferramenta; fatos.ativo = ativo; fatos.politica = politica; fatos.regras = regras;

  if (ferramenta && ativo === false)
    achados.push(ach("fw-desligado", "firewall", "alta", `Firewall (${ferramenta}) está desligado`,
      "Sem firewall, qualquer serviço que suba escutando em 0.0.0.0 fica exposto à internet no mesmo instante — inclusive por engano.",
      `${ferramenta}: inativo${politica ? ` · política INPUT ${politica}` : ""}`,
      "Ligue negando tudo por padrão e abrindo só o necessário:\n  sudo ufw default deny incoming\n  sudo ufw default allow outgoing\n  sudo ufw allow 22/tcp   # ANTES de habilitar, senão você se tranca fora\n  sudo ufw allow 80,443/tcp\n  sudo ufw enable"));
  else if (!ferramenta)
    achados.push(ach("fw-ausente", "firewall", "alta", "Nenhum firewall detectado",
      "Não encontrei ufw, nftables nem iptables com regras. O servidor está aceitando o que os serviços resolverem escutar.",
      "ufw/nft/iptables não responderam",
      "Instale e configure o ufw: `sudo apt install ufw`, depois `deny incoming` como padrão e libere 22/80/443. Cuide para liberar o SSH ANTES do `ufw enable`."));

  if (ativo && politica && /allow/i.test(politica) && /incoming/i.test(politica))
    achados.push(ach("fw-politica-permissiva", "firewall", "alta", "Firewall com política de entrada ALLOW",
      "O firewall está ligado, mas a política padrão de entrada é aceitar — o que anula o propósito, porque tudo passa a menos que exista uma regra negando.",
      `Default: ${politica}`,
      "Inverta a lógica: `sudo ufw default deny incoming` e libere só as portas necessárias."));

  /* --- quem está escutando --- */
  const ss = cmd("ss", ["-lntup"]) || cmd("netstat", ["-lntup"]);
  const escutando = [];
  if (ss) {
    for (const l of linhas(ss)) {
      if (!/^(tcp|udp)/i.test(l)) continue;
      const cols = l.split(/\s+/);
      const local = cols.find((c) => /:\d+$/.test(c) && !/^users:/.test(c));
      if (!local) continue;
      const porta = local.split(":").pop();
      const endereco = local.slice(0, local.lastIndexOf(":"));
      const proc = (/users:\(\("([^"]+)"/.exec(l) || [])[1] || "";
      const publico = !/^(127\.|\[?::1\]?$|localhost)/i.test(endereco);
      escutando.push({ proto: cols[0].toLowerCase(), porta, endereco, proc, publico });
    }
  }
  fatos.escutando = escutando.slice(0, 60);

  /* O que interessa: porta pública, fora do trio esperado, de um serviço que
     não deveria estar exposto. Bancos e painéis internos são o caso grave. */
  const SENSIVEIS = { "5432": "PostgreSQL", "3306": "MySQL/MariaDB", "27017": "MongoDB", "6379": "Redis",
    "9200": "Elasticsearch", "11211": "Memcached", "5672": "RabbitMQ", "2375": "Docker (sem TLS)",
    "2376": "Docker", "25": "SMTP", "3389": "RDP", "5900": "VNC" };
  const vistos = new Set();
  for (const e of escutando) {
    if (!e.publico || vistos.has(e.porta)) continue;
    vistos.add(e.porta);
    const nome = SENSIVEIS[e.porta];
    if (nome) {
      achados.push(ach(`porta-exposta:${e.porta}`, "firewall", "critica", `${nome} escutando na rede pública (porta ${e.porta})`,
        `O serviço ${nome} aceita conexão de qualquer endereço, não só de 127.0.0.1. Banco e cache exposto é a via de invasão mais direta que existe: não passa por site nenhum.`,
        `${e.proto} ${e.endereco}:${e.porta}${e.proc ? ` (${e.proc})` : ""}`,
        `Faça o serviço escutar só no loopback (no PostgreSQL: \`listen_addresses = 'localhost'\` e reinicie) e, no firewall, bloqueie a porta: \`sudo ufw deny ${e.porta}\`. Se precisar acessar de fora, use túnel SSH: \`ssh -L ${e.porta}:127.0.0.1:${e.porta} usuario@servidor\`.`));
    } else if (!PORTAS_ESPERADAS.has(e.porta) && e.proto === "tcp") {
      achados.push(ach(`porta-aberta:${e.porta}`, "firewall", "media", `Porta ${e.porta} escutando na rede pública`,
        "Uma porta fora do trio 22/80/443 exposta à internet aumenta a superfície de ataque. Se for um app interno (painel, API, Node), ele deveria escutar em 127.0.0.1 e ficar atrás do nginx.",
        `${e.proto} ${e.endereco}:${e.porta}${e.proc ? ` (${e.proc})` : ""}`,
        `Se é app nosso: suba com HOST=127.0.0.1 e publique pelo nginx. Se não precisa mesmo: \`sudo ufw deny ${e.porta}\`.`));
    }
  }

  return { achados, fatos };
}

/* ====================================================================== */
/*  4. CONTAS E ARQUIVOS SENSÍVEIS                                         */
/* ====================================================================== */
function auditarContas(webroot) {
  const achados = [], fatos = {};

  const passwd = ler("/etc/passwd");
  if (passwd) {
    const uid0 = linhas(passwd).map((l) => l.split(":")).filter((c) => c[2] === "0").map((c) => c[0]);
    fatos.uid0 = uid0;
    if (uid0.length > 1)
      achados.push(ach("contas-uid0", "contas", "critica", "Mais de uma conta com poder de root (UID 0)",
        "Toda conta com UID 0 é root, com outro nome. Costuma ser porta dos fundos deixada por invasor — ou erro de criação de usuário.",
        `Contas UID 0: ${uid0.join(", ")}`,
        "Confirme se cada uma é legítima. Não sendo: `sudo usermod -u <novo-uid> <conta>` ou `sudo userdel <conta>`. Depois investigue como entrou (auth.log, chaves em ~/.ssh/authorized_keys)."));
  }

  /* Senha vazia só é legível como root — sem isso, silêncio em vez de palpite. */
  const shadow = ler("/etc/shadow");
  if (shadow) {
    const vazias = linhas(shadow).map((l) => l.split(":")).filter((c) => c[1] === "" ).map((c) => c[0]);
    if (vazias.length)
      achados.push(ach("contas-sem-senha", "contas", "critica", "Conta(s) sem senha",
        "Conta sem senha entra sem provar nada, se algum serviço aceitar autenticação por senha.",
        `Contas: ${vazias.join(", ")}`,
        "Defina senha (`sudo passwd <conta>`) ou trave a conta (`sudo passwd -l <conta>`)."));
  } else if (ehRoot() === false) {
    fatos.shadow_ilegivel = true;
  }

  /* sudo sem senha: conveniente e perigoso — quem tomar a sessão do usuário
     vira root sem precisar de mais nada. */
  const sudoTextos = [];
  for (const f of ["/etc/sudoers"]) { const t = ler(f); if (t) sudoTextos.push([f, t]); }
  try {
    for (const f of fs.readdirSync("/etc/sudoers.d")) {
      const t = ler(path.join("/etc/sudoers.d", f)); if (t) sudoTextos.push([`/etc/sudoers.d/${f}`, t]);
    }
  } catch { }
  const nopass = [];
  for (const [arq, t] of sudoTextos)
    for (const l of linhas(t))
      if (/NOPASSWD/.test(l) && !l.startsWith("#")) nopass.push(`${path.basename(arq)}: ${l.slice(0, 80)}`);
  if (nopass.length) {
    fatos.sudo_nopasswd = nopass.length;
    achados.push(ach("contas-sudo-nopasswd", "contas", "media", "sudo sem pedir senha (NOPASSWD)",
      "Se a sessão desse usuário for tomada (chave SSH vazada, processo comprometido), virar root não custa nada — some a última barreira.",
      nopass.slice(0, 4).join(" | "),
      "Deixe NOPASSWD só para o comando específico que a automação precisa (ex.: `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart bemestar.service`), nunca para ALL. Edite com `sudo visudo`."));
  }

  /* --- permissões de arquivos que guardam segredo --- */
  const alvos = [];
  const raizes = [webroot, "/var/www/projetos", "/var/www"].filter(Boolean);
  const vistos = new Set();
  for (const raiz of raizes) {
    if (!existe(raiz) || vistos.has(raiz)) continue;
    vistos.add(raiz);
    let dirs = [];
    try { dirs = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(raiz, d.name)); } catch { }
    for (const d of dirs.slice(0, 30)) {
      for (const nome of [".env", "data/.chave", "data/lapublisher.json", "data/sentinela.json"]) {
        const p = path.join(d, nome);
        if (existe(p)) alvos.push(p);
      }
    }
  }
  const frouxos = [];
  for (const p of alvos) {
    const m = modo(p);
    if (m != null && (m & 0o077)) frouxos.push(`${p} (${octal(m)})`);
  }
  fatos.segredos_conferidos = alvos.length;
  if (frouxos.length)
    achados.push(ach("arquivos-segredo-frouxo", "arquivos", "alta", "Arquivo de segredo legível por outros usuários",
      "Arquivos com senha de banco, chave de cifra ou segredo de integração precisam ser lidos só pelo dono. Com permissão frouxa, qualquer conta do servidor (inclusive um processo invadido de outro site) lê.",
      frouxos.slice(0, 5).join(" | "),
      "Feche: `sudo chmod 600 <arquivo>` e confirme o dono (`sudo chown <usuario-do-servico> <arquivo>`). Para a pasta data/: `chmod 750`."));

  /* chaves privadas de SSH com permissão aberta */
  const chaves = [];
  for (const home of ["/root", ...(() => { try { return fs.readdirSync("/home").map((u) => `/home/${u}`); } catch { return []; } })()]) {
    for (const k of ["id_rsa", "id_ed25519", "id_ecdsa"]) {
      const p = path.join(home, ".ssh", k);
      const m = existe(p) ? modo(p) : null;
      if (m != null && (m & 0o077)) chaves.push(`${p} (${octal(m)})`);
    }
  }
  if (chaves.length)
    achados.push(ach("ssh-chave-frouxa", "arquivos", "alta", "Chave privada de SSH com permissão aberta",
      "Chave privada legível por outros usuários do servidor pode ser copiada e usada para entrar em outras máquinas.",
      chaves.join(" | "),
      "`chmod 600` na chave e `chmod 700` na pasta ~/.ssh."));

  return { achados, fatos };
}

/* ====================================================================== */
/*  5. POSTGRESQL                                                          */
/* ====================================================================== */
/* Fim de vida oficial (a comunidade para de publicar correção de segurança). */
const PG_EOL = { "9.6": "2021-11", "10": "2022-11", "11": "2023-11", "12": "2024-11",
  "13": "2025-11", "14": "2026-11", "15": "2027-11", "16": "2028-11", "17": "2029-11", "18": "2030-11" };

function auditarPostgres() {
  const achados = [], fatos = {};

  /* `systemctl status postgresql` MENTE: no Debian é uma unit de fachada que
     fica "active (exited)" com o cluster no chão. Quem diz a verdade é o
     pg_lsclusters. (Armadilha já paga em 29/07/2026.) */
  const clusters = cmd("pg_lsclusters", ["--no-header"]) || cmd("pg_lsclusters", []);
  if (!clusters) {
    const temPg = existe("/etc/postgresql") || !!cmd("which", ["psql"]);
    return { achados, fatos: { presente: temPg, motivo: temPg ? "pg_lsclusters indisponível" : "PostgreSQL não instalado" } };
  }
  fatos.presente = true;
  fatos.clusters = linhas(clusters).filter((l) => !/^Ver\s+Cluster/i.test(l)).slice(0, 6);

  for (const l of fatos.clusters) {
    const c = l.split(/\s+/);
    const ver = c[0], nome = c[1], porta = c[2], estado = c[3];
    if (estado && !/online/i.test(estado))
      achados.push(ach(`pg-cluster-parado:${ver}-${nome}`, "postgres", "critica", `Cluster PostgreSQL ${ver}/${nome} não está online`,
        "O cluster está fora do ar. Atenção: `systemctl status postgresql` pode dizer 'active' mesmo assim — é uma unit de fachada.",
        `pg_lsclusters: ${l}`,
        `Suba: \`sudo pg_ctlcluster ${ver} ${nome} start\` e veja o log em /var/log/postgresql/. Confirme com \`pg_lsclusters\` (não com systemctl postgresql).`));

    const eol = PG_EOL[ver];
    if (eol && new Date(eol + "-01") < new Date())
      achados.push(ach(`pg-eol:${ver}`, "postgres", "alta", `PostgreSQL ${ver} fora de suporte (EOL em ${eol})`,
        "Versão sem suporte não recebe mais correção de segurança: falhas descobertas de agora em diante ficam abertas para sempre.",
        `Cluster ${ver}/${nome} na porta ${porta}`,
        `Planeje a migração para uma versão suportada (\`pg_upgradecluster ${ver} ${nome}\` ou dump/restore). Faça backup completo antes e teste a aplicação numa cópia.`));
  }

  /* --- postgresql.conf e pg_hba.conf de cada cluster --- */
  let raizes = [];
  try {
    for (const ver of fs.readdirSync("/etc/postgresql"))
      for (const nome of fs.readdirSync(path.join("/etc/postgresql", ver)))
        raizes.push({ ver, nome, dir: path.join("/etc/postgresql", ver, nome) });
  } catch { }

  for (const { ver, nome, dir } of raizes) {
    const conf = ler(path.join(dir, "postgresql.conf"));
    if (conf) {
      const val = (chave) => {
        const m = new RegExp(`^\\s*${chave}\\s*=\\s*'?([^'#\\n]+)'?`, "im").exec(conf);
        return m ? m[1].trim() : null;
      };
      const listen = val("listen_addresses");
      const ssl = val("ssl");
      const cifra = val("password_encryption");
      const logCon = val("log_connections");
      fatos[`conf_${ver}_${nome}`] = { listen, ssl, password_encryption: cifra, log_connections: logCon };

      if (listen && (listen === "*" || /0\.0\.0\.0/.test(listen)))
        achados.push(ach(`pg-listen:${ver}-${nome}`, "postgres", "critica", "PostgreSQL escutando em todos os endereços",
          "Com listen_addresses = '*', o banco aceita conexão vinda da internet. Nossa arquitetura é o app falando com o banco pelo loopback — não há motivo para expor.",
          `listen_addresses = ${listen} (cluster ${ver}/${nome})`,
          `Em ${dir}/postgresql.conf: \`listen_addresses = 'localhost'\`. Reinicie: \`sudo pg_ctlcluster ${ver} ${nome} restart\`. E confirme no firewall: \`sudo ufw deny 5432\`.`));

      if (cifra && /^md5$/i.test(cifra))
        achados.push(ach(`pg-md5:${ver}-${nome}`, "postgres", "media", "PostgreSQL guardando senha em MD5",
          "O md5 do Postgres é quebrável e o hash roubado do banco serve para autenticar direto. O SCRAM não tem esse problema.",
          `password_encryption = ${cifra}`,
          `Troque para \`password_encryption = scram-sha-256\`, recarregue (\`sudo pg_ctlcluster ${ver} ${nome} reload\`) e REDEFINA as senhas (\\password no psql) — só a troca do parâmetro não reescreve o que já está guardado.`));

      if (logCon && /^off$/i.test(logCon))
        achados.push(ach(`pg-log:${ver}-${nome}`, "postgres", "baixa", "PostgreSQL sem registro de conexões",
          "Sem log_connections, uma invasão pelo banco não deixa rastro de quem entrou e quando.",
          `log_connections = ${logCon}`,
          `Ligue \`log_connections = on\` (e \`log_disconnections = on\`) e recarregue o cluster.`));
    }

    /* pg_hba.conf: é ele quem decide QUEM entra e COMO prova quem é. */
    const hba = ler(path.join(dir, "pg_hba.conf"));
    if (hba) {
      const regras = linhas(hba).filter((l) => !l.startsWith("#"));
      fatos[`hba_${ver}_${nome}`] = regras.slice(0, 20);
      for (const r of regras) {
        const c = r.split(/\s+/);
        const tipo = c[0], metodo = c[c.length - 1], origem = c[3] || "";
        if (/^(local|host|hostssl|hostnossl)$/i.test(tipo) && /^trust$/i.test(metodo))
          achados.push(ach(`pg-hba-trust:${ver}-${nome}:${r.slice(0, 30)}`, "postgres", "critica", "pg_hba.conf com método 'trust'",
            "'trust' significa entrar SEM SENHA. Qualquer um que alcance o banco por esse caminho vira o usuário que quiser.",
            `${dir}/pg_hba.conf → ${r.slice(0, 90)}`,
            `Troque \`trust\` por \`scram-sha-256\` (ou \`peer\` nas linhas \`local\`) e recarregue: \`sudo pg_ctlcluster ${ver} ${nome} reload\`.`));
        else if (/^host/i.test(tipo) && /(0\.0\.0\.0\/0|::\/0)/.test(origem))
          achados.push(ach(`pg-hba-mundo:${ver}-${nome}:${r.slice(0, 30)}`, "postgres", "critica", "pg_hba.conf aceita conexão de qualquer endereço",
            "Uma regra com origem 0.0.0.0/0 autoriza o mundo inteiro a tentar autenticar no banco.",
            `${dir}/pg_hba.conf → ${r.slice(0, 90)}`,
            `Restrinja a origem para \`127.0.0.1/32\` (o app fala pelo loopback) e recarregue o cluster.`));
        else if (/^host/i.test(tipo) && /^(password|md5)$/i.test(metodo))
          achados.push(ach(`pg-hba-fraco:${ver}-${nome}:${metodo}`, "postgres", "media", `pg_hba.conf usando método de senha fraco (${metodo})`,
            metodo.toLowerCase() === "password" ? "'password' manda a senha EM CLARO pela conexão." : "'md5' é quebrável e o hash roubado serve para autenticar.",
            `${dir}/pg_hba.conf → ${r.slice(0, 90)}`,
            `Use \`scram-sha-256\` nessas linhas, redefina as senhas e recarregue o cluster.`));
      }
    }
  }

  /* Backups do banco largados com permissão aberta valem tanto quanto o banco. */
  const dumps = [];
  for (const d of ["/var/backups", "/var/www/projetos"]) {
    if (!existe(d)) continue;
    const achar = (dir, prof = 0) => {
      if (prof > 2) return;
      let it = []; try { it = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of it.slice(0, 200)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) achar(p, prof + 1);
        else if (/\.(sql|dump|sql\.gz|tar)$/i.test(e.name)) {
          const m = modo(p);
          if (m != null && (m & 0o044)) dumps.push(`${p} (${octal(m)})`);
        }
      }
    };
    achar(d);
  }
  if (dumps.length)
    achados.push(ach("pg-dump-frouxo", "postgres", "alta", "Backup do banco legível por outros usuários",
      "Um dump do PostgreSQL é o banco inteiro em texto. Com permissão de leitura para todos, qualquer conta do servidor leva os dados sem precisar invadir o banco.",
      dumps.slice(0, 4).join(" | "),
      "`sudo chmod 600` nos dumps e `chmod 700` na pasta de backup. Guarde cópia fora do servidor — e cifrada, se houver dado pessoal (LGPD)."));

  return { achados, fatos };
}

/* ====================================================================== */
/*  6. SQLITE                                                              */
/* ====================================================================== */
function auditarSqlite(webroot) {
  const achados = [], fatos = { bancos: [] };
  const raiz = webroot && existe(webroot) ? webroot : (existe("/var/www/projetos") ? "/var/www/projetos" : (existe("/var/www") ? "/var/www" : null));
  if (!raiz) return { achados, fatos: { motivo: "nenhuma raiz web encontrada" } };

  /* Procura .db até 3 níveis — o suficiente para <raiz>/<site>/data/site.db */
  const bancos = [];
  const varrer = (dir, prof = 0) => {
    if (prof > 3) return;
    let it = []; try { it = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of it.slice(0, 300)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) varrer(p, prof + 1); }
      else if (/\.(db|sqlite|sqlite3)$/i.test(e.name)) bancos.push(p);
    }
  };
  varrer(raiz);

  for (const p of bancos.slice(0, 40)) {
    const m = modo(p), dir = path.dirname(p), mdir = modo(dir);
    const s = stat(p);
    const info = { caminho: p, modo: octal(m), pasta: octal(mdir), bytes: s?.size ?? null };
    fatos.bancos.push(info);

    /* 1) legível por todo mundo: o banco É o dado. */
    if (m != null && (m & 0o044))
      achados.push(ach(`sqlite-legivel:${p}`, "sqlite", "alta", "Banco SQLite legível por outros usuários",
        "O arquivo .db é o banco inteiro. Com permissão de leitura para todos, qualquer conta do servidor — inclusive o processo de OUTRO site que for invadido — copia os dados sem tocar na aplicação.",
        `${p} (${octal(m)})`,
        `\`sudo chmod 640 ${p}\` e \`sudo chown <usuario-do-servico>:<grupo> ${p}\`. A PASTA precisa continuar gravável pelo serviço (o SQLite cria o -wal ao lado): \`chmod 750\` na pasta.`));

    /* 2) pasta gravável por todos: dá para trocar o banco por outro. */
    if (mdir != null && (mdir & 0o002))
      achados.push(ach(`sqlite-pasta-aberta:${dir}`, "sqlite", "critica", "Pasta do banco SQLite gravável por qualquer usuário",
        "Quem pode escrever na pasta pode SUBSTITUIR o banco (ou criar um -wal malicioso) — é escrita de dados arbitrários na aplicação, sem passar por login nenhum.",
        `${dir} (${octal(mdir)})`,
        `\`sudo chmod 750 ${dir}\` e confirme o dono como o usuário do serviço.`));

    /* 3) dentro da árvore servida pela web, fora de data/: risco de download. */
    const relativo = path.relative(raiz, p).replace(/\\/g, "/");
    const emPastaProtegida = /(^|\/)(data|backups)\//.test(relativo);
    if (!emPastaProtegida)
      achados.push(ach(`sqlite-na-web:${p}`, "sqlite", "alta", "Banco SQLite fora da pasta protegida",
        "Nossos servidores bloqueiam /data e /backups por caminho. Um .db em outro lugar da árvore do site pode acabar sendo servido por HTTP — e aí basta baixar.",
        relativo,
        "Mova o banco para `data/` do site (é a pasta que o server.js bloqueia) ou acrescente o caminho à lista `dirProibido`. Confirme com: `curl -s -o /dev/null -w \"%{http_code}\\n\" https://SEU-SITE/<caminho-do-db>` — tem que dar 404."));

    /* 4) integridade: corrupção silenciosa é mais comum do que parece. */
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(p, { readOnly: true });
      const r = db.prepare("PRAGMA quick_check").get();
      const v = Object.values(r || {})[0];
      info.integridade = v;
      if (v && String(v).toLowerCase() !== "ok")
        achados.push(ach(`sqlite-corrompido:${p}`, "sqlite", "critica", "Banco SQLite com falha de integridade",
          "O quick_check acusou problema na estrutura do arquivo. Um banco corrompido perde dados em silêncio.",
          `${p} → ${String(v).slice(0, 120)}`,
          "Restaure do backup mais recente e confira. Para tentar recuperar: `sqlite3 banco.db \".recover\" | sqlite3 novo.db`. Depois investigue a causa (disco cheio, queda de energia, dois processos escrevendo)."));
      db.close();
    } catch (e) { info.integridade = "não verificado"; }
  }

  /* WAL/SHM com permissão frouxa contam a mesma história do banco. */
  const wals = [];
  for (const p of bancos.slice(0, 40))
    for (const suf of ["-wal", "-shm"]) {
      const w = p + suf, m = existe(w) ? modo(w) : null;
      if (m != null && (m & 0o044)) wals.push(`${w} (${octal(m)})`);
    }
  if (wals.length)
    achados.push(ach("sqlite-wal-frouxo", "sqlite", "media", "Arquivos -wal/-shm do SQLite legíveis por outros",
      "O -wal guarda as escritas mais recentes: ler o -wal é ler o que acabou de ser gravado, mesmo com o .db protegido.",
      wals.slice(0, 4).join(" | "),
      "Ajuste as permissões junto com o banco (`chmod 640`) e verifique o umask do serviço no systemd (`UMask=0027`)."));

  fatos.total = bancos.length;
  return { achados, fatos };
}

/* ====================================================================== */
/*  Auditoria completa                                                     */
/* ====================================================================== */
function auditar(opts = {}) {
  const webroot = opts.webroot || process.env.SENT_WEBROOT || "/var/www/projetos";
  const partes = {
    sistema: auditarSistema(),
    ssh: auditarSsh(),
    firewall: auditarFirewallEPortas(),
    contas: auditarContas(webroot),
    postgres: auditarPostgres(),
    sqlite: auditarSqlite(webroot),
  };

  /* Cada bloco vai para a origem certa, para a conciliação do painel não
     misturar auditorias diferentes. */
  const porOrigem = {
    servidor: [...partes.sistema.achados, ...partes.ssh.achados, ...partes.contas.achados],
    firewall: partes.firewall.achados,
    postgres: partes.postgres.achados,
    sqlite: partes.sqlite.achados,
  };
  const retratos = {
    servidor: { ...partes.sistema.fatos, ssh: partes.ssh.fatos, contas: partes.contas.fatos },
    firewall: partes.firewall.fatos,
    postgres: partes.postgres.fatos,
    sqlite: partes.sqlite.fatos,
  };

  if (!ehRoot()) {
    porOrigem.servidor.push(ach("agente-sem-root", "sistema", "baixa", "Agente rodando sem privilégio de root",
      "Sem root, o agente não lê /etc/shadow nem algumas configurações — a auditoria fica incompleta e pode não enxergar problemas reais.",
      `Usuário atual: ${os.userInfo?.().username || "desconhecido"}`,
      "Rode o agente como root (cron do root ou systemd timer com User=root). Ele só LÊ: nenhum comando altera o servidor."));
  }

  return { agente: VERSAO_AGENTE, quando: new Date().toISOString(), porOrigem, retratos };
}

/* ====================================================================== */
/*  Envio                                                                  */
/* ====================================================================== */
async function enviar(resultado, cfg) {
  const corpo = JSON.stringify(resultado);
  const ts = Math.floor(Date.now() / 1000);
  const sig = "sha256=" + crypto.createHmac("sha256", cfg.segredo).update(`${ts}.${corpo}`).digest("hex");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(`${cfg.url.replace(/\/+$/, "")}/api/sentinela/auditoria`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", "X-SENT-SITE": String(cfg.siteId), "X-SENT-TS": String(ts), "X-SENT-SIG": sig },
      body: corpo,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j.error || ""}`);
    return j;
  } finally { clearTimeout(timer); }
}

/* --------------------------------- CLI ---------------------------------- */
if (require.main === module) {
  const arg = process.argv.slice(2);
  const r = auditar();
  const total = Object.values(r.porOrigem).flat().length;

  if (arg.includes("--json")) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

  if (arg.includes("--mostrar") || arg.includes("-m")) {
    console.log(`\n  LA Sentinela — agente v${VERSAO_AGENTE} · ${os.hostname()}\n`);
    for (const [origem, lista] of Object.entries(r.porOrigem)) {
      console.log(`  [${origem}] ${lista.length} achado(s)`);
      for (const a of lista) console.log(`    · ${a.severidade.toUpperCase().padEnd(8)} ${a.titulo}`);
    }
    console.log(`\n  Total: ${total}\n`);
    process.exit(0);
  }

  const cfg = { url: process.env.SENT_URL, siteId: process.env.SENT_SITE, segredo: process.env.SENT_SEGREDO };
  if (!cfg.url || !cfg.siteId || !cfg.segredo) {
    console.error("  ✖ Faltam SENT_URL, SENT_SITE e SENT_SEGREDO. Use --mostrar para ver o resultado sem enviar.");
    process.exit(1);
  }
  enviar(r, cfg)
    .then(() => { console.log(`  · auditoria enviada (${total} achado(s))`); process.exit(0); })
    .catch((e) => { console.error("  ✖ falha ao enviar:", e.message); process.exit(1); });
}

module.exports = { auditar, enviar, VERSAO_AGENTE };
