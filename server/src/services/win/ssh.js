// SSH key management is a Linux-server feature. On Windows, remote access is
// via RDP (or the panel terminal). The web terminal runs PowerShell.

export default {
  async syncAuthorizedKeys() {
    throw new Error('SSH authorized_keys are a Linux-server feature — on Windows use RDP for remote access.');
  },
  async ensurePanelKey() {
    throw new Error('SSH is not used on Windows — the panel terminal runs PowerShell locally.');
  }
};
