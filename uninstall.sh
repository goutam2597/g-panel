#!/usr/bin/env bash
# G-Panel uninstaller — removes the panel service and its system integration.
# Hosted data (websites, mail, databases) is left intact unless --purge is given.
set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

log() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }

log "Stopping G-Panel service"
systemctl disable --now gpanel 2>/dev/null || true
rm -f /etc/systemd/system/gpanel.service
systemctl daemon-reload

log "Removing panel files"
rm -rf /opt/gpanel /etc/gpanel
if [[ $PURGE = 1 ]]; then
  rm -rf /var/lib/gpanel
  echo "  removed /var/lib/gpanel (panel db, DKIM state)"
else
  echo "  kept /var/lib/gpanel (panel.db with all account metadata)"
fi

log "Removing panel-managed service configs"
rm -rf /etc/nginx/sites-available/gpanel /etc/vsftpd/gpanel.d
rm -f /etc/nginx/sites-enabled/gpanel-*.conf /etc/nginx/sites-enabled/phpmyadmin.conf
rm -f /etc/bind/gpanel.zones
rm -f /etc/bind/zones/*.zone 2>/dev/null || true
rm -f /etc/postfix/gpanel-*.cf
rm -f /etc/dovecot/gpanel-sql.conf.ext /etc/dovecot/conf.d/90-gpanel.conf
nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
systemctl restart postfix dovecot vsftpd bind9 2>/dev/null || true

if [[ $PURGE = 1 ]]; then
  log "Removing panel system users"
  userdel -r vmail 2>/dev/null || true
  userdel gpanel 2>/dev/null || true
  userdel -r gpanel-backups 2>/dev/null || true
  # remove hosting users created by the panel (home dirs /home/<username>)
  for d in /home/*/domains; do
    [[ -d "$d" ]] || continue
    u=$(basename "$(dirname "$d")")
    [[ "$u" = "gpanel-backups" ]] && continue
    echo "  deleting hosting user: $u"
    pkill -u "$u" 2>/dev/null || true
    crontab -r -u "$u" 2>/dev/null || true
    userdel -r "$u" 2>/dev/null || true
  done
  echo "  NOTE: MariaDB/PostgreSQL databases are NOT dropped automatically."
fi

log "G-Panel removed"
[[ $PURGE = 1 ]] || echo "Run with --purge to also remove panel data, users and configs."
