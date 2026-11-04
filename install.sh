#!/usr/bin/env bash
# ============================================================================
#  G-Panel installer — cPanel-style hosting control panel
#  Target: fresh Ubuntu 22.04/24.04 or Debian 12  (run as root)
#
#  curl -fsSL <your-release-url>/install.sh | bash
#  …or clone the repo and run:  sudo bash install.sh
#
#  Installs & configures: nginx, PHP 8.2/8.3-FPM, MariaDB, PostgreSQL,
#  Postfix + Dovecot + OpenDKIM (mail), BIND9 (DNS), vsftpd (FTP),
#  phpMyAdmin, Node.js 22, ufw + fail2ban, and the G-Panel service itself.
# ============================================================================
set -euo pipefail

GPANEL_DIR="/opt/gpanel"
GPANEL_DATA="/var/lib/gpanel"
GPANEL_PORT="${GPANEL_PORT:-2083}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"   # set to e.g. https://github.com/you/g-panel.git — or install from the current dir

log()  { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    \033[0;36m%s\033[0m\n' "$*"; }
err()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root: sudo bash install.sh"

# ----------------------------------------------------------------------------
log "Detecting system"
# ----------------------------------------------------------------------------
if [[ -f /etc/os-release ]]; then . /etc/os-release; fi
ID="${ID:-unknown}"; VERSION_ID="${VERSION_ID:-0}"
case "$ID" in
  ubuntu)  [[ "${VERSION_ID%%.*}" -ge 22 ]] || err "Ubuntu 22.04+ required (found $VERSION_ID)" ;;
  debian)  [[ "${VERSION_ID%%.*}" -ge 12 ]] || err "Debian 12+ required (found $VERSION_ID)" ;;
  *) err "Unsupported distribution: $ID (Ubuntu 22.04+/Debian 12+ required)" ;;
esac
ARCH=$(dpkg --print-architecture)
[[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]] || err "Unsupported architecture: $ARCH"
SERVER_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
[[ -n "$SERVER_IP" ]] || err "Could not determine the server's public IPv4 address"
info "$ID $VERSION_ID · $ARCH · $SERVER_IP"

export DEBIAN_FRONTEND=noninteractive

# ----------------------------------------------------------------------------
log "Installing base packages"
# ----------------------------------------------------------------------------
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null

# Node.js 22 (panel + hosted Node apps)
if ! command -v node >/dev/null || [[ "$(node -v | tr -d v | cut -d. -f1)" -lt 22 ]]; then
  log "Installing Node.js 22"
  curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_V=$(node -v); info "node $NODE_V"

log "Installing service stack (nginx, PHP, MariaDB, PostgreSQL, mail, DNS, FTP)"
APT_PKGS=(
  nginx mariadb-server postgresql
  postfix dovecot-core dovecot-imapd dovecot-pop3d dovecot-lmtpd
  opendkim opendkim-tools
  bind9 bind9utils vsftpd db-util
  certbot python3-certbot-nginx
  ufw fail2ban unzip zip
)
# PHP: prefer 8.3 + 8.2 from sury/ondrej when the distro doesn't ship them
if [[ "$ID" == "ubuntu" ]]; then
  add-apt-repository -y ppa:ondrej/php >/dev/null 2>&1 || true
  apt-get update -qq
fi
PHP_OK=()
for v in 8.3 8.2; do
  if apt-cache show "php${v}-fpm" >/dev/null 2>&1; then
    APT_PKGS+=("php${v}-fpm" "php${v}-mysql" "php${v}-pgsql" "php${v}-curl" "php${v}-gd" "php${v}-mbstring" "php${v}-xml" "php${v}-zip" "php${v}-intl" "php${v}-bcmath" "php${v}-soap" "php${v}-imagick" "php${v}-cli")
    PHP_OK+=("$v")
  fi
done
[[ ${#PHP_OK[@]} -gt 0 ]] || err "No suitable PHP-FPM version found"
info "PHP versions: ${PHP_OK[*]}"

apt-get install -y -qq "${APT_PKGS[@]}" >/dev/null

# phpMyAdmin — the panel owns its own instance of the ORIGINAL package:
# always the LATEST release, resolved from phpmyadmin.net's own version feed
# (the same feed phpMyAdmin checks), installed into /opt/gpanel/phpmyadmin
# (never the distro location, so nothing else's config or upgrades can clash).
# Distro package only as a last-resort fallback.
PMA_INSTALLED=0
PMA_VERSION="$(curl -fsSL --max-time 15 "https://www.phpmyadmin.net/home_page/version.json" 2>/dev/null | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')"
PMA_VERSION="${PMA_VERSION:-5.2.3}"
PMA_ROOT="/opt/gpanel/phpmyadmin"
log "Installing phpMyAdmin (panel-owned, latest official: $PMA_VERSION)"
PMA_TMP="$(mktemp -d)"
if curl -fsSL "https://files.phpmyadmin.net/phpMyAdmin/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-all-languages.tar.gz" -o "$PMA_TMP/pma.tar.gz"; then
  rm -rf "$PMA_ROOT"
  mkdir -p "$PMA_ROOT"
  tar -xzf "$PMA_TMP/pma.tar.gz" -C "$PMA_ROOT" --strip-components=1
  PMA_INSTALLED=1
  PMA_SOURCE="official ${PMA_VERSION}"
  info "phpMyAdmin ${PMA_VERSION} (official) → $PMA_ROOT"
else
  info "official download unavailable — trying the distro package as fallback"
  if apt-cache show phpmyadmin >/dev/null 2>&1; then
    echo "phpmyadmin phpmyadmin/dbconfig-install boolean false" | debconf-set-selections
    echo "phpmyadmin phpmyadmin/reconfigure-webserver multiselect none"  | debconf-set-selections
    apt-get install -y -qq phpmyadmin >/dev/null 2>&1 && { PMA_INSTALLED=1; PMA_SOURCE="distro package"; PMA_ROOT="/usr/share/phpmyadmin"; } || info "phpMyAdmin install skipped (optional)"
  fi
fi
rm -rf "$PMA_TMP"

# ----------------------------------------------------------------------------
log "Creating system users"
# ----------------------------------------------------------------------------
id vmail          >/dev/null 2>&1 || useradd -r -u 5000 -g mail -d /home/vmail -s /usr/sbin/nologin -c "G-Panel virtual mail" vmail
id gpanel         >/dev/null 2>&1 || useradd -r -d /opt/gpanel -s /usr/sbin/nologin -c "G-Panel service" gpanel
id gpanel-backups >/dev/null 2>&1 || useradd -r -d /home/gpanel-backups -s /usr/sbin/nologin -c "G-Panel backups" gpanel-backups
mkdir -p /home/vmail && chown vmail:mail /home/vmail && chmod 750 /home/vmail
mkdir -p /home/gpanel-backups && chown gpanel-backups:gpanel-backups /home/gpanel-backups && chmod 700 /home/gpanel-backups
info "vmail (5000), gpanel, gpanel-backups ready"

# ----------------------------------------------------------------------------
log "Installing panel source → $GPANEL_DIR"
# ----------------------------------------------------------------------------
mkdir -p "$GPANEL_DIR"
if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$GPANEL_DIR/.git" ]]; then
    git -C "$GPANEL_DIR" fetch --all -q && git -C "$GPANEL_DIR" reset --hard "origin/$BRANCH" -q
  else
    git clone -q --depth 1 -b "$BRANCH" "$REPO_URL" "$GPANEL_DIR"
  fi
else
  # install from the directory this script lives in
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_DIR/server/package.json" && "$SCRIPT_DIR" != "$GPANEL_DIR" ]]; then
    rsync -a --delete --exclude node_modules --exclude .devdata --exclude .git "$SCRIPT_DIR/" "$GPANEL_DIR/"
  fi
fi
[[ -f "$GPANEL_DIR/server/src/index.js" ]] || err "Panel source not found (set REPO_URL or run from the repo root)"

info "building backend + frontend dependencies…"
cd "$GPANEL_DIR/web" && npm install --no-audit --no-fund --loglevel=error >/dev/null
npm run build >/dev/null
cd "$GPANEL_DIR/server" && npm install --no-audit --no-fund --omit=dev --loglevel=error >/dev/null

mkdir -p "$GPANEL_DATA" && chmod 750 "$GPANEL_DATA" && chown root:root "$GPANEL_DATA"

# ----------------------------------------------------------------------------
log "Configuring MariaDB (MySQL hosting)"
# ----------------------------------------------------------------------------
systemctl enable --now mariadb -q
mysql -NBe "SELECT 1" >/dev/null 2>&1 || err "MariaDB not responding"
info "MariaDB ready (root via unix socket)"

# ----------------------------------------------------------------------------
log "Configuring PostgreSQL"
# ----------------------------------------------------------------------------
systemctl enable --now postgresql -q
sudo -u postgres psql -tAc "SELECT 1" >/dev/null || err "PostgreSQL not responding"
info "PostgreSQL ready (peer auth via postgres user)"

# ----------------------------------------------------------------------------
log "Configuring Postfix + Dovecot + OpenDKIM (mail)"
# ----------------------------------------------------------------------------
# virtual mailboxes live in the panel SQLite database; maps are live queries
cat > /etc/postfix/gpanel-vdomains.cf <<EOF
dbpath = $GPANEL_DATA/panel.db
query = SELECT 1 FROM mail_domains md JOIN domains d ON d.id = md.domain_id WHERE d.domain = '%s'
EOF
cat > /etc/postfix/gpanel-vmailboxes.cf <<EOF
dbpath = $GPANEL_DATA/panel.db
query = SELECT 1 FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.mail_domain_id JOIN domains d ON d.id = md.domain_id WHERE ma.address = '%s'
EOF
cat > /etc/postfix/gpanel-aliases.cf <<EOF
dbpath = $GPANEL_DATA/panel.db
query = SELECT address FROM mail_accounts WHERE address = '%s'
EOF
chmod 644 /etc/postfix/gpanel-*.cf

PMD=$(postconf -h mail_version >/dev/null 2>&1 && ls -d /usr/lib/postfix/*/ 2>/dev/null | head -1 || echo "")
[[ -n "$PMD" ]] || PMD="/usr/lib/postfix/sbin/"
postconf -e "virtual_mailbox_domains = sqlite:/etc/postfix/gpanel-vdomains.cf"
postconf -e "virtual_mailbox_maps  = sqlite:/etc/postfix/gpanel-vmailboxes.cf"
postconf -e "virtual_alias_maps    = sqlite:/etc/postfix/gpanel-aliases.cf"
postconf -e "virtual_uid_maps      = static:5000"
postconf -e "virtual_gid_maps      = static:8"
postconf -e "virtual_mailbox_base  = /home/vmail"
postconf -e "virtual_transport     = lmtp:unix:private/dovecot-lmtp"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = private/auth"
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem"
postconf -e "smtpd_tls_key_file  = /etc/ssl/private/ssl-cert-snakeoil.key"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtpd_recipient_restrictions = permit_sasl_authenticated, permit_mynetworks, reject_unauth_destination"
postconf -e "milter_default_action = accept"
postconf -e "milter_protocol = 6"
postconf -e "smtpd_milters = inet:127.0.0.1:8891"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
postconf -e "message_size_limit = 52428800"
postconf -e "compatibility_level = 3.6"

# Dovecot: LMTP + SASL auth for postfix + sqlite passdb against the panel db
cat > /etc/dovecot/conf.d/90-gpanel.conf <<'EOF'
passdb {
  driver = sql
  args = /etc/dovecot/gpanel-sql.conf.ext
}
userdb {
  driver = static
  args = uid=5000 gid=8 home=/home/vmail/%d/%n mail=maildir:/home/vmail/%d/%n/Maildir
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
protocol lda { mail_plugins = $mail_plugins }
protocol lmtp { mail_plugins = $mail_plugins }
EOF
cat > /etc/dovecot/gpanel-sql.conf.ext <<EOF
driver = sqlite
connect = $GPANEL_DATA/panel.db
default_pass_scheme = SSHA512
password_query = SELECT password AS password FROM mail_accounts WHERE address = '%u'
EOF
chown root:dovecot /etc/dovecot/gpanel-sql.conf.ext && chmod 640 /etc/dovecot/gpanel-sql.conf.ext
grep -q "^protocols" /etc/dovecot/dovecot.conf || echo "protocols = imap pop3 lmtp" >> /etc/dovecot/dovecot.conf
sed -i 's/^disable_plaintext_auth = .*/disable_plaintext_auth = yes/' /etc/dovecot/conf.d/10-auth.conf || true
info "postfix maps + dovecot sql passdb written"

# OpenDKIM
mkdir -p /etc/opendkim/keys
cat > /etc/opendkim.conf <<EOF
Syslog          yes
UMask           002
Canonicalization relaxed/simple
Mode            sv
SubDomains      no
AutoRestart     yes
AutoRestartRate 10/1M
Background      yes
DNSTimeout      5
SignatureAlgorithm rsa-sha256
KeyTable        refile:/etc/opendkim/KeyTable
SigningTable    refile:/etc/opendkim/SigningTable
ExternalIgnoreList refile:/etc/opendkim/TrustedHosts
InternalHosts   refile:/etc/opendkim/TrustedHosts
Socket          inet:8891@localhost
PidFile         /run/opendkim/opendkim.pid
UserID          opendkim:opendkim
EOF
cat > /etc/opendkim/TrustedHosts <<EOF
127.0.0.1
localhost
::1
EOF
touch /etc/opendkim/KeyTable /etc/opendkim/SigningTable
chown -R opendkim:opendkim /etc/opendkim/keys
info "opendkim configured on :8891"

# ----------------------------------------------------------------------------
log "Configuring BIND9 (authoritative DNS)"
# ----------------------------------------------------------------------------
mkdir -p /etc/bind/zones
chown root:bind /etc/bind/zones && chmod 775 /etc/bind/zones
touch /etc/bind/gpanel.zones
grep -q "gpanel.zones" /etc/bind/named.conf.local 2>/dev/null || \
  echo 'include "/etc/bind/gpanel.zones";' >> /etc/bind/named.conf.local
# allow recursion only locally; serve authoritative zones
sed -i 's/^options {/options {\n\tdirectory "\/etc\/bind\/zones";/' /etc/bind/named.conf.options 2>/dev/null || true
info "BIND zones dir + include ready"

# ----------------------------------------------------------------------------
log "Configuring vsftpd (FTP with virtual users)"
# ----------------------------------------------------------------------------
cat > /etc/pam.d/vsftpd <<'EOF'
#%PAM-1.0
auth    required pam_userdb.so db=/etc/vsftpd/gpanel.users crypt=none
account required pam_userdb.so db=/etc/vsftpd/gpanel.users crypt=none
session required pam_loginuid.so
EOF
GSC=$(ls /etc/ssl/certs/ssl-cert-snakeoil.pem >/dev/null 2>&1 && echo "rsa_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem
rsa_private_key_file=/etc/ssl/private/ssl-cert-snakeoil.key
ssl_enable=YES
allow_anon_ssl=NO
force_local_data_ssl=NO
force_local_logins_ssl=NO" || echo "")
cat > /etc/vsftpd.conf <<EOF
listen=YES
listen_ipv6=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
dirmessage_enable=YES
use_localtime=YES
xferlog_enable=YES
connect_from_port_20=YES
chroot_local_user=YES
secure_chroot_dir=/var/run/vsftpd/empty
pam_service_name=vsftpd
guest_enable=YES
guest_username=nobody
virtual_use_local_privs=YES
user_config_dir=/etc/vsftpd/gpanel.d
pasv_enable=YES
pasv_min_port=49152
pasv_max_port=49520
$GSC
EOF
mkdir -p /etc/vsftpd/gpanel.d /var/run/vsftpd/empty
touch /etc/vsftpd/gpanel.users && chmod 600 /etc/vsftpd/gpanel.users
info "vsftpd + PAM userdb ready (passive 49152-49520)"

# ----------------------------------------------------------------------------
log "Configuring nginx"
# ----------------------------------------------------------------------------
mkdir -p /etc/nginx/sites-available/gpanel /etc/nginx/snippets
cat > /etc/nginx/snippets/gpanel-extras.conf <<'EOF'
client_max_body_size 512m;
EOF
systemctl enable --now nginx -q
info "nginx ready"

# phpMyAdmin vhost — TLS (snakeoil until a real cert is issued), default_server
# on 443 so https://<server-ip> reaches it immediately; SSO-only auth via
# gpanel-signon.php (direct phpMyAdmin logins are disabled by design).
if [[ "$PMA_INSTALLED" = 1 ]]; then
  PHP_DEFAULT="${PHP_OK[0]}"
  # signon bridge: one-time token -> phpMyAdmin session (see server/php/)
  cp "$GPANEL_DIR/server/php/gpanel-signon.php" "$PMA_ROOT/gpanel-signon.php"
  chown root:root "$PMA_ROOT/gpanel-signon.php" && chmod 655 "$PMA_ROOT/gpanel-signon.php"

  # phpMyAdmin: signon-only auth against the GPanelSignon session.
  # The official package reads config.inc.php from its own root; the distro
  # package reads /etc/phpmyadmin/conf.d — write to whichever applies.
  if [[ "$PMA_SOURCE" == distro* ]]; then
    cat > /etc/phpmyadmin/conf.d/90-gpanel.php <<'EOF'
<?php
$cfg['Servers'] = array();
$i = 1;
$cfg['Servers'][$i]['auth_type']      = 'signon';
$cfg['Servers'][$i]['SignonSession']  = 'GPanelSignon';
$cfg['Servers'][$i]['SignonURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['LogoutURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['host']           = 'localhost';
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['ServerDefault'] = 1;
EOF
  else
    cat > "$PMA_ROOT/config.inc.php" <<'EOF'
<?php
$cfg['Servers'] = array();
$i = 1;
$cfg['Servers'][$i]['auth_type']      = 'signon';
$cfg['Servers'][$i]['SignonSession']  = 'GPanelSignon';
$cfg['Servers'][$i]['SignonURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['LogoutURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['host']           = 'localhost';
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['ServerDefault'] = 1;
$cfg['TempDir'] = '/var/lib/gpanel/pma-tmp';
EOF
    mkdir -p /var/lib/gpanel/pma-tmp
    chown www-data:www-data /var/lib/gpanel/pma-tmp
  fi

  cat > /etc/nginx/sites-available/gpanel/phpmyadmin.conf <<EOF
server {
    listen 80;
    listen 443 ssl default_server;
    server_name pma._;
    ssl_certificate     /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    index index.php;
    root ${PMA_ROOT};
    access_log /var/log/nginx/pma-access.log;
    error_log  /var/log/nginx/pma-error.log;
    location / {
        try_files \$uri \$uri/ /index.php?\$query_string;
    }
    location ~ \\.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${PHP_DEFAULT}-fpm.sock;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/gpanel/phpmyadmin.conf /etc/nginx/sites-enabled/phpmyadmin.conf
  info "phpMyAdmin installed: signon-only auth + TLS vhost (set pma.<hostname> DNS + cert for a named host)"
fi

# ----------------------------------------------------------------------------
log "Installing G-Panel service (systemd)"
# ----------------------------------------------------------------------------
ADMIN_PW=$(tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 20)

# self-signed panel certificate (replace with LE later: certbot certonly --standalone -d panel-host)
mkdir -p /etc/gpanel
if [[ ! -f /etc/gpanel/panel.key ]]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/gpanel/panel.key -out /etc/gpanel/panel.crt \
    -subj "/CN=${SERVER_IP}" >/dev/null 2>&1
fi

cat > /etc/systemd/system/gpanel.service <<EOF
[Unit]
Description=G-Panel hosting control panel
After=network.target mariadb.service postgresql.service postfix.service dovecot.service bind9.service nginx.service

[Service]
Type=simple
WorkingDirectory=$GPANEL_DIR/server
ExecStart=$(command -v node) src/index.js
Environment=NODE_ENV=production
Environment=GPANEL_PORT=$GPANEL_PORT
Environment=GPANEL_TLS_CERT=/etc/gpanel/panel.crt
Environment=GPANEL_TLS_KEY=/etc/gpanel/panel.key
Environment=GPANEL_VERSION=1.1.0
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gpanel -q
systemctl restart gpanel

# seed settings + admin once the db exists (panel creates it on boot)
for i in $(seq 1 30); do
  [[ -f "$GPANEL_DATA/panel.db" ]] && break
  sleep 1
done
node "$GPANEL_DIR/server/src/cli.js" set-setting server_ip "$SERVER_IP"
node "$GPANEL_DIR/server/src/cli.js" reset-admin-password "$ADMIN_PW" >/dev/null
if [[ "$PMA_INSTALLED" = 1 ]]; then
  node "$GPANEL_DIR/server/src/cli.js" set-setting pma_url "https://${SERVER_IP}/gpanel-signon.php" >/dev/null
fi
# panel db must be readable by www-data for the phpMyAdmin signon bridge
chgrp www-data "$GPANEL_DATA" 2>/dev/null && chmod 750 "$GPANEL_DATA" || true
for f in "$GPANEL_DATA"/panel.db "$GPANEL_DATA"/panel.db-wal "$GPANEL_DATA"/panel.db-shm; do
  [[ -f "$f" ]] && chgrp www-data "$f" && chmod 640 "$f" || true
done

# ----------------------------------------------------------------------------
log "Firewall (ufw) + fail2ban"
# ----------------------------------------------------------------------------
systemctl enable --now fail2ban -q
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for rule in "22/tcp" "80/tcp" "443/tcp" "25/tcp" "465/tcp" "587/tcp" "143/tcp" "993/tcp" "110/tcp" "995/tcp" "21/tcp" "49152:49520/tcp" "53/tcp" "53/udp" "${GPANEL_PORT}/tcp"; do
  ufw allow "$rule" >/dev/null
done
ufw --force enable >/dev/null
info "ufw enabled — ports 22 80 443 53 21+passive 25/465/587 143/993 110/995 ${GPANEL_PORT}"

# ----------------------------------------------------------------------------
log "Reloading services"
# ----------------------------------------------------------------------------
systemctl reload nginx >/dev/null 2>&1 || true
systemctl restart postfix dovecot opendkim vsftpd bind9 2>/dev/null || true
systemctl restart gpanel

sleep 2
systemctl is-active --quiet gpanel || { journalctl -u gpanel -n 30 --no-pager; err "G-Panel service failed to start"; }

cat > /root/gpanel-credentials.txt <<EOF
G-Panel installation complete — $(date)

  Panel:     https://${SERVER_IP}:${GPANEL_PORT}  (self-signed cert — accept the warning,
             or point panel.<your-domain> here and run: certbot certonly --nginx -d panel.<your-domain>)
  Login:     admin
  Password:  ${ADMIN_PW}

  (password also resettable with: node ${GPANEL_DIR}/server/src/cli.js reset-admin-password)

Next steps:
  1. Set the server hostname + server IP in Settings → Server settings
  2. Point your domains' nameservers (ns1/ns2) at this server, or edit ns1/ns2 first
  3. Create a package, then users; each user manages their own sites/mail/dbs
  4. For email deliverability set PTR/rDNS of ${SERVER_IP} to mail.<your-domain> at your provider

Files:
  Panel source:  ${GPANEL_DIR}
  Panel data:    ${GPANEL_DATA} (panel.db — SQLite; keep in your backups)
  Backups:       /home/gpanel-backups
  Logs:          journalctl -u gpanel -f
EOF
chmod 600 /root/gpanel-credentials.txt

echo
log "G-Panel is installed"
echo "    Panel:    https://${SERVER_IP}:${GPANEL_PORT}"
echo "    Login:    admin / ${ADMIN_PW}"
echo "    Saved to: /root/gpanel-credentials.txt"
echo
echo "    Service:  systemctl status gpanel"
echo "    Logs:     journalctl -u gpanel -f"
