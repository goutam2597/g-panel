// vsftpd is Linux-only. On Windows, upload via the panel File Manager
// (identical features) or any SFTP client over RDP file sharing.

export default {
  async syncUsers() {
    throw new Error('FTP accounts require a Linux server — use the panel File Manager on Windows (same features, no extra client needed).');
  }
};
