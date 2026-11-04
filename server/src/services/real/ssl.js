import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';

export default {
  /**
   * Issue a Let's Encrypt certificate via certbot with the nginx plugin.
   * Requires the domain's DNS to point at this server and port 80 reachable.
   */
  async issue(domain, email) {
    const args = [
      'certbot', 'certonly', '--nginx',
      '-d', domain, '-d', `www.${domain}`,
      '--non-interactive', '--agree-tos',
      '-m', email || 'admin@' + domain,
      '--keep-until-expiring'
    ];
    const r = await run(args[0], args.slice(1), { timeout: 180000 });
    if (!r.stdout.includes('Successfully received certificate') && !r.stdout.includes('Certificate not yet due for renewal')) {
      if (r.stdout.includes('Challenge failed') || r.stderr.includes('Challenge failed')) {
        throw new Error('Let\'s Encrypt challenge failed — check that the domain DNS points to this server and port 80 is open');
      }
    }
    return this.certInfo(domain);
  },

  async issueSelfSigned(domain) {
    const dir = `/etc/nginx/ssl/${domain}`;
    await run('mkdir', ['-p', dir]);
    await run('openssl', [
      'req', '-x509', '-nodes', '-days', '3650',
      '-newkey', 'rsa:2048',
      '-keyout', `${dir}/privkey.pem`,
      '-out', `${dir}/fullchain.pem`,
      '-subj', `/CN=${domain}`
    ], { timeout: 60000 });
    await runSafe('systemctl', ['reload', 'nginx']);
    return this.certInfo(domain, dir);
  },

  async certInfo(domain, dirOverride = null) {
    // Let's Encrypt
    const leCert = config.paths.letsencryptLive(domain);
    let certPath = null, kind = null;
    if (fs.existsSync(leCert)) {
      certPath = leCert; kind = 'letsencrypt';
    } else if (dirOverride && fs.existsSync(`${dirOverride}/fullchain.pem`)) {
      certPath = `${dirOverride}/fullchain.pem`; kind = 'selfsigned';
    } else {
      const ssDir = `/etc/nginx/ssl/${domain}`;
      if (fs.existsSync(`${ssDir}/fullchain.pem`)) { certPath = `${ssDir}/fullchain.pem`; kind = 'selfsigned'; }
    }
    if (!certPath) return null;
    try {
      const cert = new X509Certificate(fs.readFileSync(certPath));
      return {
        kind,
        issuer: cert.issuer.replace(/[^=]+=([^=]+)$/, '$1').trim() || cert.issuer,
        subject: cert.subject,
        validFrom: cert.validFromDate,
        expiry: new Date(cert.validToDate).getTime()
      };
    } catch {
      return null;
    }
  },

  async renewAll() {
    const r = await runSafe('certbot', ['renew', '--quiet', '--deploy-hook', 'systemctl reload nginx'], { timeout: 600000 });
    return !r.failed;
  }
};
