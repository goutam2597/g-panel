import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateShort } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Modal, Field, EmptyState, ConfirmDialog, Badge, RefreshButton } from '../components/ui.jsx';
import { Clock } from 'lucide-react';

const PRESETS = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 03:00', expr: '0 3 * * *' },
  { label: 'Weekly (Sun 03:00)', expr: '0 3 * * 0' },
  { label: 'Monthly (1st 03:00)', expr: '0 3 1 * *' }
];

export default function Cron() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [edit, setEdit] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setData(await api.get('/cron'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cron jobs</h1>
          <div className="sub">Scheduled commands in the user's real crontab</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>Add cron job</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data.jobs}
          keyOf={(j) => j.id}
          empty={<EmptyState icon={Clock} title="No cron jobs"
            action={<button className="btn primary" onClick={() => setShowAdd(true)}>Add cron job</button>}>
            Schedule maintenance scripts, imports or cleanups — jobs run as your Linux user.
          </EmptyState>}
          columns={[
            {
              key: 'schedule', label: 'Schedule',
              render: (j) => (
                <div>
                  <span className="mono" style={{ fontSize: 12.5 }}>{j.schedule}</span>
                  {j.description && <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{j.description}</div>}
                </div>
              )
            },
            { key: 'command', label: 'Command', render: (j) => <span className="mono" style={{ fontSize: 12 }}>{j.command}</span> },
            { key: 'comment', label: 'Note', render: (j) => j.comment ? <span style={{ fontSize: 12.5 }}>{j.comment}</span> : <span className="muted">—</span> },
            { key: 'enabled', label: 'Status', render: (j) => j.enabled ? <Badge kind="ok" dot>active</Badge> : <Badge kind="neutral" dot>paused</Badge> },
            { key: 'created', label: 'Added', num: true, render: (j) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(j.created_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (j) => (
                <>
                  <button className="rowlink" onClick={() => toggle(j)}>{j.enabled ? 'Pause' : 'Resume'}</button>
                  <button className="rowlink" onClick={() => setEdit(j)}>Edit</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(j)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      {data.foreignLines.length > 0 && (
        <div className="callout warn" style={{ marginTop: 14 }}>
          <div style={{ flex: 1 }}>
            <b>{data.foreignLines.length} crontab line(s) not managed by the panel</b> (added directly via SSH). They are preserved.
            <pre style={{ marginTop: 6, fontSize: 11.5, color: 'inherit' }}>{data.foreignLines.join('\n')}</pre>
          </div>
        </div>
      )}

      {showAdd && (
        <JobModal
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); toast.ok('Cron job added'); load(); }}
        />
      )}
      {edit && (
        <JobModal
          job={edit}
          onClose={() => setEdit(null)}
          onDone={() => { setEdit(null); toast.ok('Cron job updated'); load(); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete cron job?"
        body={confirmDelete ? `${confirmDelete.schedule} ${confirmDelete.command}` : ''}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/cron/${confirmDelete.id}`);
            toast.ok('Cron job deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );

  async function toggle(j) {
    try {
      await api.put(`/cron/${j.id}`, { enabled: !j.enabled });
      load();
    } catch (e) { toast.error(e.message); }
  }
}

function JobModal({ job, onClose, onDone }) {
  const [form, setForm] = useState({
    schedule: job?.schedule || '0 3 * * *',
    command: job?.command || '',
    comment: job?.comment || ''
  });
  const [description, setDescription] = useState(job?.description || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const validate = useCallback(async (schedule) => {
    if (!schedule.trim()) { setDescription(null); return; }
    try {
      const res = await api.post('/cron/validate', { schedule });
      setDescription(res.valid ? res.description : null);
    } catch { setDescription(null); }
  }, []);

  useEffect(() => { const t = setTimeout(() => validate(form.schedule), 300); return () => clearTimeout(t); }, [form.schedule, validate]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (job) await api.put(`/cron/${job.id}`, form);
      else await api.post('/cron', form);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={job ? 'Edit cron job' : 'Add cron job'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.command}>{busy ? 'Saving…' : 'Save job'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Schedule">
          <input className="input mono" value={form.schedule} onChange={(e) => set('schedule', e.target.value)} placeholder="0 3 * * *" />
        </Field>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {PRESETS.map((p) => (
            <button type="button" key={p.expr} className="btn sm" onClick={() => set('schedule', p.expr)}>{p.label}</button>
          ))}
        </div>
        {description && <div className="cron-preview" style={{ marginBottom: 14 }}>{description}</div>}
        <Field label="Command">
          <textarea className="input" rows={3} value={form.command} onChange={(e) => set('command', e.target.value)}
            placeholder="/usr/local/bin/backup.sh --weekly" />
        </Field>
        <Field label="Note (optional)">
          <input className="input" value={form.comment} onChange={(e) => set('comment', e.target.value)} placeholder="Nightly site backup" />
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
