import { useCallback, useEffect, useState } from 'react';
import { api, download, fmtDate, fmtBytes } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, EmptyState, ConfirmDialog, RefreshButton } from '../components/ui.jsx';
import { Archive } from 'lucide-react';

export default function Backups() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setData(await api.get('/backups'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post('/backups/create', {});
      toast.ok(`Backup created (${fmtBytes(res.size)})`);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Backups</h1>
          <div className="sub">Full account archives: websites, mail, databases and crontab · {data.retention} kept per user</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create backup now'}</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data.backups}
          keyOf={(b) => b.id}
          empty={<EmptyState icon={Archive} title="No backups yet"
            action={<button className="btn primary" onClick={create} disabled={busy}>Create backup now</button>}>
            A backup archives your document roots, mailboxes, database dumps and crontab into one downloadable file.
          </EmptyState>}
          columns={[
            { key: 'file', label: 'File', render: (b) => <span className="domain-cell">{b.filename}</span> },
            { key: 'owner', label: 'Owner', render: (b) => b.owner ? <span style={{ fontSize: 12.5 }}>{b.owner}</span> : null },
            { key: 'size', label: 'Size', num: true, render: (b) => <span className="num">{b.size_human}</span> },
            { key: 'status', label: 'Status', render: (b) => b.status === 'done' ? <Badge kind="ok" dot>done</Badge> : b.status === 'running' ? <Badge kind="info" dot>running</Badge> : <Badge kind="danger" dot>failed</Badge> },
            { key: 'created', label: 'Created', num: true, render: (b) => <span className="muted" style={{ fontSize: 12 }}>{fmtDate(b.created_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (b) => (
                <>
                  <button className="rowlink" onClick={() => download(`/backups/${b.id}/download`, b.filename)}>Download</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(b)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      <div className="callout" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5 }}>
          Backups are stored under <span className="mono">/home/gpanel-backups/</span>. Downloads are streamed with
          your session. Keep off-server copies of anything critical — this disk dying takes the backups with it.
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete backup ${confirmDelete?.filename}?`}
        body="The archive file on disk is removed. This cannot be undone."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/backups/${confirmDelete.id}`);
            toast.ok('Backup deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}
