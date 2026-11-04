// TLS on Windows: the one-click Cloudflare Tunnel terminates HTTPS at the
// edge, so local sites are served over HTTP behind the tunnel — the same
// pattern cPanel users get with Cloudflare. Direct certbot is a Linux flow.

export default {
  async issue(domain) {
    throw new Error(`On Windows, TLS is terminated by Cloudflare — run the Cloudflare Tunnel (Maintenance → Cloudflare) and ${domain} gets HTTPS at the edge automatically.`);
  },
  async issueSelfSigned() {
    throw new Error('Self-signed certificates are not needed behind the Cloudflare Tunnel — HTTPS is handled at the edge.');
  },
  async certInfo() { return null; },
  async renewAll() { return true; }
};
