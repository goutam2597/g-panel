// Authoritative DNS on a local Windows machine is not practical — the
// natural pairing for locally hosted sites is Cloudflare: their free DNS
// makes domains resolve to the tunnel, worldwide. The DNS page switches to
// the Cloudflare record manager when a token is configured (works via the
// cloudflare.js driver in services/real — shared with Linux).

export default {
  async addZone() { return true; },
  async removeZone() { return true; },
  async writeZone() { return true; },
  async readZone() { return ''; }
};
