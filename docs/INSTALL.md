# G-Panel — installation & operations guide

Target: a **fresh** Ubuntu 22.04 / 24.04 or Debian 12 VPS with root SSH access.
Nothing else needs to be pre-installed.

## 1. Install

```bash
git clone <your-fork-url> g-panel && cd g-panel
sudo bash install.sh
```

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `GPANEL_PORT` | `2083` | HTTPS panel port |
| `REPO_URL` | — | install from a git URL instead of the local checkout |
| `BRANCH` | `main` | branch to install when using `REPO_URL` |

The installer prints the panel URL and admin password and saves them to
`/root/gpanel-credentials.txt`.

## 2. First login

1. Open `https://<server-ip>:2083` — accept the self-signed certificate
   warning (or replace it, see §7).
2. Sign in as `admin`.
3. Go to **Settings** and set the server hostname and IP, plus your
   nameserver names (`ns1`/`ns2`, e.g. `ns1.yourdomain.com`).

## 3. Connecting domains (nameservers)

For each domain you host:

1. At the registrar, set the nameservers to the `ns1`/`ns2` values from
   Settings (the **Connect** button on the Websites page shows them and
   live-checks delegation).
2. Alternatively keep external DNS and create `A` records for `@` and `www`
   pointing at the server IP.
3. Once delegated, zones are served by BIND from the panel — manage records
   in the **DNS** section. The zone file viewer shows exactly what BIND loads.

## 4. Email checklist

Email deliverability needs three things beyond the panel:

1. **PTR / reverse DNS** — set `<server-ip>`'s rDNS to `mail.<your-domain>`
   at your VPS provider (most important single item).
2. **Ports open** — the installer opens 25/465/587/143/993 in ufw; some
   providers block port 25 until you ask.
3. **DKIM/SPF/DMARC** — automatic: enabling mail on a domain generates a
   2048-bit DKIM key and inserts `mail`, MX, SPF and DMARC records into the
   hosted zone.

Mailboxes connect with the full email address as username:
IMAP `mail.<domain>:993 (SSL)`, SMTP `mail.<domain>:465 (SSL)`.

## 5. Firewall ports opened by the installer

| Port | Service |
|---|---|
| 22 | SSH |
| 80 / 443 | Websites (nginx) |
| 53 tcp+udp | DNS (BIND) |
| 21 + 49152-49520 | FTP (vsftpd, passive range) |
| 25 / 465 / 587 | SMTP |
| 143 / 993 | IMAP |
| 110 / 995 | POP3 |
| 2083 | G-Panel (TLS) |

## 6. Node.js apps

1. **Node.js apps → Create app** — pick a domain (or new subdomain), name and
   startup file. The panel assigns a loopback port, creates a systemd service
   and routes nginx to it.
2. Upload code into `/home/<user>/apps/<name>` via **Files** or git over SSH.
3. Click **npm install**, then **Start**. Listen on `process.env.PORT`.
4. Logs come from journald (`journalctl -u gp-node-<user>-<name>`), also
   visible in the panel.

## 7. Replacing the self-signed panel certificate

```bash
certbot certonly --nginx -d panel.<your-domain>       # after DNS points here
cp /etc/letsencrypt/live/panel.<your-domain>/fullchain.pem /etc/gpanel/panel.crt
cp /etc/letsencrypt/live/panel.<your-domain>/privkey.pem  /etc/gpanel/panel.key
systemctl restart gpanel
```

## 8. Operations cheat-sheet

```bash
systemctl status gpanel            # panel service
journalctl -u gpanel -f            # panel logs
node /opt/gpanel/server/src/cli.js reset-admin-password    # recovery
node /opt/gpanel/server/src/cli.js set-setting ns1 ns1.example.com
sqlite3 /var/lib/gpanel/panel.db   # direct inspection (careful)
```

Backups live in `/home/gpanel-backups/<user>/`. The panel database
(`/var/lib/gpanel/panel.db`) holds all account metadata — include it in
off-server backups.

## 9. Uninstall

```bash
sudo bash uninstall.sh            # removes the panel, keeps hosted data
sudo bash uninstall.sh --purge    # also removes hosting users' files + configs
```

`--purge` never drops MariaDB/PostgreSQL databases — do that manually if you
really mean it.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Panel unreachable | `systemctl status gpanel`, ufw rules, cloud firewall (security group) |
| Let's Encrypt fails | DNS A record → server IP? port 80 open? zone propagated? (Connect modal live-checks) |
| Mail bounced | PTR record, port 25 outbound, DKIM record present in zone |
| Site 502 | PHP-FPM pool running? `systemctl status php8.3-fpm`, app started? |
| DNS not resolving elsewhere | delegation (NS) at registrar — Connect modal; serial bumped? |
| FTP login fails | account password reset via panel; vsftpd running; passive ports open |

## 11. phpMyAdmin single sign-on

The installer (when phpMyAdmin is available) configures it for **signon-only
authentication** — phpMyAdmin cannot be logged into directly; the only way in
is the **phpMyAdmin button on the Databases page**:

1. Click **phpMyAdmin** → choose which of your MySQL database users to sign in as.
2. The panel issues a one-time token (valid 90 seconds) and opens
   `https://<server>/gpanel-signon.php?t=<token>`, which seeds the phpMyAdmin
   session and redirects — already logged in, no password typed or visible.

Files involved:

- `/usr/share/phpmyadmin/gpanel-signon.php` — the bridge (reads one-time
  tokens from the panel database; tokens are burned on first use)
- `/etc/phpmyadmin/conf.d/90-gpanel.php` — forces `auth_type = signon`
- nginx vhost `sites-available/gpanel/phpmyadmin.conf` — TLS via the default
  snakeoil cert at `https://<server-ip>`; point `pma.<your-domain>` at the
  server and issue a real cert to brand it, then update the **phpMyAdmin
  signon URL** in Admin → Settings accordingly.

The panel database (`/var/lib/gpanel/panel.db`) is group-readable by
`www-data` only (root:www-data 0640) — that is what lets the PHP bridge read
tokens without exposing anything else.
