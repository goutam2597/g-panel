import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { KeyRound } from 'lucide-react';

export default function SshKeys() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setData(await api.get('/ssh/keys'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>SSH keys</h1>
          <div className="sub">
            Public keys in <span className="mono">~/.ssh/authorized_keys</span> ·
            shell access {data.ssh_enabled
              ? <Badge kind="ok" dot>enabled</Badge>
              : <Badge kind="danger" dot>disabled</Badge>}
          </div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>Add key</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data.keys}
          keyOf={(k) => k.id}
          empty={<EmptyState icon={KeyRound} title="No SSH keys yet"
            action={<button className="btn primary" onClick={() => setShowAdd(true)}>Add key</button>}>
            Add your public key (from <span className="mono">~/.ssh/id_ed25519.pub</span> on your machine) for passwordless SSH login.
          </EmptyState>}
          columns={[
            { key: 'name', label: 'Name', render: (k) => <span style={{ fontWeight: 550 }}>{k.name}</span> },
            { key: 'fp', label: 'Fingerprint', render: (k) => <span className="mono" style={{ fontSize: 12 }}><Copyable text={k.fingerprint} /></span> },
            { key: 'type', label: 'Type', render: (k) => <Badge kind="info">{k.public_key.split(' ')[0]}</Badge> },
            { key: 'added', label: 'Added', num: true, render: (k) => <span className="muted" style={{ fontSize: 12 }}>{fmtDate(k.added_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (k) => <button className="rowlink danger" onClick={() => setConfirmDelete(k)}>Remove</button>
            }
          ]}
        />
      </div>

      <div className="callout" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5 }}>
          Connect with: <span className="mono">ssh your-username@server-address</span>.
          Keys apply within seconds of saving. Shell access is controlled per user by the administrator.
        </div>
      </div>

      {showAdd && (
        <AddKeyModal
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); toast.ok('Key added — authorized_keys updated'); load(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Remove key "${confirmDelete?.name}"?`}
        body="Machines using this key will no longer be able to log in."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/ssh/keys/${confirmDelete.id}`);
            toast.ok('Key removed');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function AddKeyModal({ onClose, onDone }) {
  const [form, setForm] = useState({ name: '', public_key: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/ssh/keys', form);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Add SSH public key" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.name || !form.public_key}>{busy ? 'Adding…' : 'Add key'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Key name" hint="A label so you remember which machine this is">
          <input className="input" autoFocus placeholder="work laptop" value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Public key" hint="One line: ssh-ed25519 AAAA… comment">
          <textarea className="input" rows={4} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… user@host"
            value={form.public_key} onChange={(e) => setForm((f) => ({ ...f, public_key: e.target.value }))} />
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
