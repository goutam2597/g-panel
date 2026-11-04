# G-Panel

A self-hosted, cPanel-style web hosting control panel. Install it on any Linux
VPS and manage the full hosting stack from one clean web UI — websites, DNS,
email, FTP, databases, Node.js apps, cron, SSL, files, backups, firewall.

Runs the **real** open-source hosting stack: nginx · PHP-FPM · MariaDB ·
PostgreSQL · Postfix · Dovecot · OpenDKIM · BIND9 · vsftpd · Let's Encrypt ·
ufw + fail2ban.

---

## Features

| Area | What you get |
|---|---|
| **Websites** | Unlimited domains per user, PHP version selector (8.2/8.3 FPM pools per user), static sites, reverse proxies, force-HTTPS, live access/error logs |
| **Node.js apps** | cPanel-style app manager — runs your app as a systemd service on its own port, nginx proxies its domain, npm install + start/stop/restart + journald logs |
| **DNS** | Full BIND9 zone management (A, AAAA, CNAME, MX, TXT, NS, SRV, CAA), auto serials, validated zone files, live zone-file viewer |
| **Domain connection** | Nameserver delegation wizard: shows exactly which NS/IP to set at your registrar and live-checks what the internet currently sees |
| **Email** | Virtual mailboxes (Postfix + Dovecot, Maildir), per-mailbox quotas, automatic DKIM 2048-bit keys, SPF/DMARC records, IMAP/SMTP connection cheat-sheet |
| **Databases** | MySQL/MariaDB **and** PostgreSQL, per-user scoped DB users and grants, size reporting, phpMyAdmin link |
| **FTP** | vsftpd virtual accounts, per-account directory scoping, mapped to the owner's Linux user |
| **SSH** | Public key manager (authorized_keys), per-user shell toggle, root/user web terminal (xterm.js) |
| **Cron** | Per-user real crontabs, human-readable schedule builder + validation, foreign-line preservation |
| **SSL/TLS** | Let's Encrypt issuance + auto-renewal (twice daily), self-signed fallback, expiry tracking, force-HTTPS toggle |
| **Files** | Web file manager: browse, upload, download, edit, rename, chmod, extract archives — scoped to docroots |
| **Backups** | Full account archives (websites + mail + DB dumps + crontab), scheduled retention, one-click download |
| **Multi-tenant** | Admin + hosting users, packages with resource limits (domains, disk, mailboxes, DBs, FTP, cron), impersonation, full audit log |
| **Server** | Live CPU/RAM/disk/network charts, service grid with restart controls, firewall rule manager, fail2ban jail status |

## Install (Ubuntu 22.04+/Debian 12, fresh VPS)

```bash
git clone <your-fork-url> g-panel && cd g-panel
sudo bash install.sh
```

The installer sets up every service, generates an admin password and prints the
panel URL (default `https://<server-ip>:2083` — self-signed cert, replaceable
with Let's Encrypt). Credentials are saved to `/root/gpanel-credentials.txt`.

See **[docs/INSTALL.md](docs/INSTALL.md)** for the full manual, firewall ports,
DNS/email setup checklist and troubleshooting.

## Windows support (regular Windows 10/11 + Windows Server)

G-Panel runs fully on Windows — real services, no simulation:

| Area | Windows implementation |
|---|---|
| Web server | Panel-owned **nginx for Windows** (official build, managed in `C:\gpanel\stack\nginx`) |
| PHP | **php-cgi FastCGI pools** per PHP version (uses Laragon/XAMPP PHP automatically, or the downloaded stack) |
| Databases | Your local **MySQL/MariaDB** (Laragon/XAMPP/MySQL installer) — detected automatically |
| Node.js apps | Panel-managed processes with crash-restart watchdog + nginx proxy |
| Cron | **Windows Task Scheduler** (presets: every N min / daily / weekly / monthly) |
| Backups | tar (ships with Windows) + mysqldump |
| Terminal | Real local PowerShell (line mode) |
| phpMyAdmin | Panel-owned, always the latest official package, one-click SSO |
| SSL | Terminated by **Cloudflare's edge** via the tunnel (no local certs needed) |
| Email / FTP | Linux-server features — on Windows use Cloudflare Email Routing + the built-in File Manager |

```powershell
powershell -ExecutionPolicy Bypass -File install-windows.ps1
```

Installs into `C:\gpanel` (panel + nginx + PHP stack), opens the firewall for the
panel port, registers an auto-start task, and prints the URL. Set
`GPANEL_WEB_PORT` if port 80 is taken (e.g. by Laragon).

## Cloudflare Tunnel — one click to go live

Panel → **Cloudflare**:

1. **Install cloudflared** (one click — official binary into the panel stack).
2. **Quick tunnel** → instant `https://<random>.trycloudflare.com` URL serving your
   local sites, HTTPS at Cloudflare's edge, no account needed.
3. **Named tunnel** → paste your tunnel token from Cloudflare Zero Trust and map
   your own domains to `http://localhost:<web port>` — permanent hostnames.
4. Optional: connect a **Cloudflare API token** to manage DNS records of your
   zones directly from the panel's DNS page (how domains resolve to a local
   machine — works on Windows and Linux).

## Development

```bash
npm install              # install workspace deps
npm run dev              # panel in DEV MODE on :2083 — all services simulated
                         # login: admin / gpanel-admin
npm run dev:web          # Vite dev server on :5173 (API proxied to :2083)
npm test                 # unit tests (validators, quotas, zone files, cron…)
npm run build            # production frontend build into web/dist
```

DEV MODE swaps every system driver (nginx/BIND/Postfix/…) for an in-memory
simulator with the same interface, so the entire panel runs on a workstation
with no root and no real services — great for UI work and demos. On the VPS
without `GPANEL_DEV`, the real drivers execute.

## Architecture

```
├── install.sh / uninstall.sh      one-command installer for Ubuntu/Debian
├── server/                        Fastify API (Node 22+, zero native deps)
│   └── src/
│       ├── services/real/         system drivers: nginx, php, dns, mail, ftp,
│       │                          db (MariaDB), pg (PostgreSQL), nodeapps, ssl,
│       │                          cron, files, ssh, firewall, backup
│       ├── services/sim/          dev-mode simulator (same interface)
│       ├── services/sites.js      provisioning orchestration (users→vhosts→DNS)
│       ├── routes/                REST API, one module per feature
│       ├── auth/                  sessions (scrypt+SQLite), CSRF, RBAC, audit
│       └── jobs/scheduler.js      stats sampler, cert renewal
└── web/                           React 18 SPA — hand-crafted design system
```

**Isolation model (like cPanel):** every hosting user maps to a real Linux
user. Sites live in `/home/<user>/domains/<domain>/public_html`, each user gets
their own PHP-FPM pool and crontab; FTP accounts chroot into their docroot;
database grants are scoped per user. The panel runs as root (required to
manage services) and logs every mutation to an audit trail.

## Security notes

- Session cookies are HttpOnly + SameSite=Lax; mutations require CSRF tokens;
  login is rate-limited; passwords are scrypt-hashed; mail passwords use
  Dovecot-compatible SSHA512.
- The panel listens on 2083 with TLS (self-signed at install; swap in a
  Let's Encrypt cert for `panel.<your-domain>` when ready).
- File-manager paths are validated against per-user roots; SQL identifiers and
  shell commands are constructed from validated panel-generated names only.

## License

MIT
