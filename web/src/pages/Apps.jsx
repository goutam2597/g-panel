import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateShort } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Boxes } from 'lucide-react';

export default function Apps() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [domains, setDomains] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [logs, setLogs] = useState(null);
  const [npmOut, setNpmOut] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const [apps, dom] = await Promise.all([api.get('/apps'), api.get('/domains')]);
    setData(apps);
    setDomains(dom.domains);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const doAction = async (a, action) => {
    setBusyId(a.id);
    try {
      const res = await api.post(`/apps/${a.id}/${action}`);
      if (action === 'npm-install' && res.output) setNpmOut({ app: a.name, output: res.output });
      else toast.ok(`${action} — ${a.name} is now ${res.status || 'ok'}`);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  const showLogs = async (a) => {
    try {
      const res = await api.get(`/apps/${a.id}/logs`);
      setLogs({ name: a.name, text: res.text });
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Node.js apps</h1>
          <div className="sub">
            Managed application services · nginx proxies each app's domain to its loopback port · Node {data.nodeVersions[0] || ''}
          </div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>Create app</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data.apps}
          keyOf={(a) => a.id}
          empty={<EmptyState icon={Boxes} title="No Node.js apps yet"
            action={<button className="btn primary" onClick={() => setShowAdd(true)}>Create app</button>}>
            Deploy Express, Next.js, Strapi or any Node app — the panel runs it as a service, wires the domain and keeps it alive.
          </EmptyState>}
          columns={[
            {
              key: 'name', label: 'App',
              render: (a) => (
                <div>
                  <div className="domain-cell">{a.name}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>{a.app_dir}</div>
                </div>
              )
            },
            { key: 'domain', label: 'Domain', render: (a) => <span style={{ fontSize: 12.5 }}>{a.domain}</span> },
            { key: 'port', label: 'Port', num: true, render: (a) => <span className="num mono" style={{ fontSize: 12 }}>{a.port}</span> },
            { key: 'startup', label: 'Startup', render: (a) => <span className="mono" style={{ fontSize: 12 }}>{a.startup_file}</span> },
            {
              key: 'status', label: 'Status',
              render: (a) => a.status === 'running'
                ? <Badge kind="ok" dot>running</Badge>
                : a.status === 'failed' ? <Badge kind="danger" dot>failed</Badge> : <Badge kind="neutral" dot>stopped</Badge>
            },
            { key: 'created', label: 'Created', num: true, render: (a) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(a.created_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (a) => (
                <>
                  {a.status === 'running'
                    ? <button className="rowlink" onClick={() => doAction(a, 'stop')} disabled={busyId === a.id}>Stop</button>
                    : <button className="rowlink" onClick={() => doAction(a, 'start')} disabled={busyId === a.id}>Start</button>}
                  <button className="rowlink" onClick={() => doAction(a, 'restart')} disabled={busyId === a.id}>Restart</button>
                  <button className="rowlink" onClick={() => doAction(a, 'npm-install')} disabled={busyId === a.id}>npm install</button>
                  <button className="rowlink" onClick={() => showLogs(a)}>Logs</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(a)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      <div className="callout" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5 }}>
          Upload your code to the app directory (via <b>Files</b> or git over SSH), hit <b>npm install</b>, then start.
          The <span className="mono">PORT</span> environment variable carries the assigned port — listen on it.
        </div>
      </div>

      {showAdd && (
        <CreateAppModal
          domains={domains}
          nodeVersions={data.nodeVersions}
          onClose={() => setShowAdd(false)}
          onCreated={(res) => { setShowAdd(false); toast.ok(`App created on port ${res.port}`); load(); }}
        />
      )}

      {logs && (
        <Modal open wide title={`${logs.name} — service logs`} onClose={() => setLogs(null)}>
          <pre style={{ background: '#14161A', color: '#C9CDC2', padding: 14, borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, maxHeight: '52vh', overflow: 'auto', margin: 0 }}>
            {logs.text || '(no output yet)'}
          </pre>
        </Modal>
      )}

      {npmOut && (
        <Modal open wide title={`${npmOut.app} — npm install output`} onClose={() => setNpmOut(null)}
          footer={<button className="btn primary" onClick={() => setNpmOut(null)}>Close</button>}>
          <pre style={{ background: '#14161A', color: '#C9CDC2', padding: 14, borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, maxHeight: '52vh', overflow: 'auto', margin: 0 }}>
            {npmOut.output}
          </pre>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete app ${confirmDelete?.name}?`}
        body="Stops the service and removes its directory and systemd unit. The domain stays but stops proxying (becomes a static site)."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/apps/${confirmDelete.id}`);
            toast.ok('App deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function CreateAppModal({ domains, nodeVersions, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', domain: '', startup_file: 'app.js', node_version: nodeVersions[0] || '22', new_domain: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const useNewDomain = form.domain === '__new__';
  const effectiveDomain = useNewDomain ? form.new_domain : form.domain;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post('/apps', {
        name: form.name,
        domain: effectiveDomain,
        startup_file: form.startup_file,
        node_version: form.node_version
      });
      onCreated(res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Create Node.js app" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.name || !effectiveDomain}>{busy ? 'Provisioning…' : 'Create app'}</button></>}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="App name" hint="lowercase, dashes ok — used for the service and directory">
            <input className="input mono" autoFocus placeholder="api" value={form.name} onChange={(e) => set('name', e.target.value.toLowerCase())} />
          </Field>
          <Field label="Node version">
            <select className="input" value={form.node_version} onChange={(e) => set('node_version', e.target.value)}>
              {nodeVersions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Domain" hint="Existing domains route to the app immediately; a new subdomain is created and proxied">
          <select className="input" value={form.domain} onChange={(e) => set('domain', e.target.value)}>
            <option value="">Choose…</option>
            {domains.map((d) => <option key={d.id} value={d.domain}>{d.domain}{d.type === 'proxy' ? ' (currently proxied)' : ''}</option>)}
            <option value="__new__">New subdomain…</option>
          </select>
        </Field>
        {useNewDomain && (
          <Field label="Subdomain">
            <input className="input mono" placeholder={`app.${domains[0]?.domain || 'yourdomain.com'}`} value={form.new_domain} onChange={(e) => set('new_domain', e.target.value.toLowerCase())} />
          </Field>
        )}
        <Field label="Startup file" hint="Relative to the app directory — e.g. app.js, server.js, dist/index.js">
          <input className="input mono" value={form.startup_file} onChange={(e) => set('startup_file', e.target.value)} />
        </Field>
        {error && <div className="callout warn">{error}</div>}
        <div className="callout" style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12 }}>
            After creating, upload your code to the app directory and run <b>npm install</b>.
            Bind your server to <span className="mono">process.env.PORT</span> — the panel assigns it.
          </div>
        </div>
      </form>
    </Modal>
  );
}
