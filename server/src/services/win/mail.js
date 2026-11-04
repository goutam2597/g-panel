// Full mail (SMTP/IMAP) needs Postfix/Dovecot — a Linux-server stack. On
// Windows, incoming mail is best handled with Cloudflare Email Routing
// (free, forwards to your inbox) while the site sends via an SMTP relay.

export default {
  async provisionDomain() {
    throw new Error('Mailboxes require a Linux server — on Windows use Cloudflare Email Routing for incoming mail and an SMTP relay for sending.');
  },
  async deprovisionDomain() { return true; },
  async provisionUser() { throw new Error('Mailboxes require a Linux server.'); },
  async deprovisionUser() { return true; },
  async mailboxUsage() { return 0; }
};
