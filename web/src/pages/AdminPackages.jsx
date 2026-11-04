import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { Modal, Field, EmptyState, ConfirmDialog, RefreshButton } from '../components/ui.jsx';
import { Package as PackageIcon, Pencil, Trash2, Plus } from 'lucide-react';

const LIMITS = [
  ['max_domains', 'Domains', 'count'],
  ['max_disk_mb', 'Disk', 'MB'],
  ['max_mailboxes', 'Mailboxes', 'count'],
  ['max_databases', 'Databases', 'count'],
  ['max_ftp', 'FTP accounts', 'count'],
  ['max_cron', 'Cron jobs', 'count'],
  ['max_bandwidth_gb', 'Bandwidth / mo', 'GB']
];

export default function AdminPackages() {
  const toast = useToast();
  const [packages, setPackages] = useState(null);
  const [edit, setEdit] = useState(null);       // null | {} (new) | package
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setPackages((await api.get('/packages')).packages);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!packages) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Packages</h1>
          <div className="sub">Resource plans assigned to users — limits are enforced at creation time</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setEdit({})}><Plus size={14} /> New package</button>
        </div>
      </div>

      {packages.length === 0 ? (
        <div className="card"><EmptyState icon={PackageIcon} title="No packages">Create a plan to assign limits to users.</EmptyState></div>
      ) : (
        <div className="pkg-grid">
          {packages.map((p) => (
            <div className="card pkg-card" key={p.id} style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div className="pkg-name">{p.name}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {p.user_count} user{p.user_count === 1 ? '' : 's'}
                  </div>
                </div>
                <div>
                  <button className="rowlink" onClick={() => setEdit(p)}><Pencil size={12} style={{ verticalAlign: -1 }} /> Edit</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(p)}><Trash2 size={12} style={{ verticalAlign: -1 }} /> Delete</button>
                </div>
              </div>
              <div className="pkg-limits">
                {LIMITS.map(([key, label]) => (
                  <div key={key}>{label} <b>{p[key] < 0 ? '∞' : p[key]}</b></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {edit !== null && (
        <PackageModal
          pkg={edit.id ? edit : null}
          onClose={() => setEdit(null)}
          onDone={() => { setEdit(null); toast.ok(edit.id ? 'Package updated' : 'Package created'); load(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete package ${confirmDelete?.name}?`}
        body={confirmDelete?.user_count ? `${confirmDelete.user_count} user(s) still use this package.` : 'This cannot be undone.'}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/packages/${confirmDelete.id}`);
            toast.ok('Package deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function PackageModal({ pkg, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState(() => {
    const base = { name: pkg?.name || '' };
    for (const [key] of LIMITS) base[key] = pkg ? pkg[key] : { max_domains: 1, max_disk_mb: 1024, max_mailboxes: 5, max_databases: 1, max_ftp: 1, max_cron: 2, max_bandwidth_gb: 10 }[key];
    return base;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (pkg) await api.put(`/packages/${pkg.id}`, form);
      else await api.post('/packages', form);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={pkg ? `Edit package ${pkg.name}` : 'New package'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.name}>{busy ? 'Saving…' : 'Save package'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Package name">
          <input className="input" autoFocus placeholder="Standard" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <div className="form-row" style={{ flexWrap: 'wrap' }}>
          {LIMITS.map(([key, label, unit]) => (
            <div className="field" key={key} style={{ flex: '1 1 140px' }}>
              <label>{label}{unit === 'MB' || unit === 'GB' ? ` (${unit})` : ''}</label>
              <input className="input num" type="number" step="1"
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
                title="-1 = unlimited" />
            </div>
          ))}
        </div>
        <p className="hint" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Use <b>-1</b> for unlimited on any limit. 0 blocks the resource entirely.
        </p>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
