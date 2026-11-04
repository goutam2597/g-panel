import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateShort } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Server } from 'lucide-react';

export default function Ftp() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [domains, setDomains] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [created, setCreated] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    const [acc, dom] = await Promise.all([api.get('/ftp'), api.get('/domains')]);
    setData(acc.accounts);
    setDomains(dom.domains);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const serverIp = domains.length ? domains[0].server_ip : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>FTP accounts</h1>
          <div className="sub">vsftpd virtual accounts · connect on port 21 (explicit TLS where available)</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)} disabled={!domains.length}>Add FTP account</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data}
          keyOf={(a) => a.id}
          empty={<EmptyState icon={Server} title="No FTP accounts"
            action={domains.length ? <button className="btn primary" onClick={() => setShowAdd(true)}>Add FTP account</button> : null}>
            {domains.length
              ? 'FTP accounts are virtual users scoped to one domain directory — no shell access.'
              : 'Add a website first — FTP accounts are scoped to a domain directory.'}
          </EmptyState>}
          columns={[
            { key: 'username', label: 'Login', render: (a) => <span className="domain-cell">{a.username}</span> },
            { key: 'domain', label: 'Domain', render: (a) => <span style={{ fontSize: 12.5 }}>{a.domain}</span> },
            { key: 'dir', label: 'Directory', render: (a) => <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{a.directory === '/' ? '/ (site root)' : a.directory}</span> },
            { key: 'created', label: 'Created', num: true, render: (a) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(a.created_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (a) => (
                <>
                  <button className="rowlink" onClick={() => resetPassword(a)}>Reset password</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(a)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      <div className="callout" style={{ marginTop: 14 }}>
        <div style={{ flex: 1, fontSize: 12.5 }}>
          <b>Connection details:</b> host = this server's IP or your domain · port 21 · protocol FTP with
          explicit TLS if your client supports it · login = the account name above.
          {' '}{serverIp && <>Server IP: <Copyable text={serverIp} /></>}
        </div>
      </div>

      {showAdd && (
        <AddFtpModal
          domains={domains}
          onClose={() => setShowAdd(false)}
          onCreated={(res) => { setShowAdd(false); setCreated(res); load(); }}
        />
      )}

      {created && (
        <Modal open title="FTP account created" onClose={() => setCreated(null)}
          footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
          <p style={{ fontSize: 13.5, marginBottom: 12 }}>Save these credentials — the password cannot be retrieved later.</p>
          <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>Login</dt><dd><Copyable text={created.username} /></dd>
            <dt>Password</dt><dd><Copyable text={created.password} /></dd>
            <dt>Host</dt><dd><Copyable text={created.host || 'this server'} /></dd>
            <dt>Port</dt><dd>21</dd>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete FTP account ${confirmDelete?.username}?`}
        body="The login is removed immediately. Files are not touched."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/ftp/${confirmDelete.id}`);
            toast.ok('FTP account deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );

  async function resetPassword(a) {
    try {
      const res = await api.post(`/ftp/${a.id}/reset-password`, {});
      if (res.new_password) setCreated({ username: a.username, password: res.new_password, host: null });
      else toast.ok('Password updated');
    } catch (e) { toast.error(e.message); }
  }
}

function AddFtpModal({ domains, onClose, onCreated }) {
  const [form, setForm] = useState({ username_suffix: '', domain: domains[0]?.domain || '', directory: '/', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const owner = domains.find((d) => d.domain === form.domain);
      const prefix = owner?.owner ? `${owner.owner}_` : '';
      const fullLogin = `${prefix}${form.username_suffix}`;
      const res = await api.post('/ftp', {
        username: fullLogin,
        domain: form.domain,
        directory: form.directory || '/',
        password: form.password || undefined
      });
      onCreated({ username: fullLogin, password: res.initial_password || form.password, host: null });
    } catch (e2) { setError(e2.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Add FTP account" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.username_suffix}>{busy ? 'Creating…' : 'Create account'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Domain">
          <select className="input" value={form.domain} onChange={(e) => set('domain', e.target.value)}>
            {domains.map((d) => <option key={d.id} value={d.domain}>{d.domain}</option>)}
          </select>
        </Field>
        <Field label="Login name" hint="Must start with your username, e.g. johndoe_deploy">
          <input className="input mono" autoFocus placeholder="deploy" value={form.username_suffix}
            onChange={(e) => set('username_suffix', e.target.value.toLowerCase())} />
        </Field>
        <Field label="Directory" hint="Relative to the domain root — / limits to the whole site, /subdir to a subfolder">
          <input className="input mono" value={form.directory} onChange={(e) => set('directory', e.target.value)} placeholder="/" />
        </Field>
        <Field label="Password" hint="Leave empty to auto-generate">
          <input className="input" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="auto-generate" />
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
