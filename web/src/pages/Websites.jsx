import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtBytes, fmtDateShort } from '../api.js';
import { useToast } from '../store.jsx';
import {
  DataTable, Badge, Modal, Field, SearchInput, EmptyState, ConfirmDialog,
  StateBadge, RefreshButton
} from '../components/ui.jsx';
import { Globe2, FileText, ScrollText } from 'lucide-react';

export default function Websites() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [edit, setEdit] = useState(null);
  const [logs, setLogs] = useState(null);
  const [connection, setConnection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(async () => {
    setData(await api.get('/domains'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const rows = data.domains.filter((d) =>
    !search || d.domain.includes(search.toLowerCase()) || (d.owner || '').includes(search.toLowerCase())
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Websites</h1>
          <div className="sub">Domains served by nginx from this server · server IP {data.serverIp}</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>Add domain</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="left"><SearchInput value={search} onChange={setSearch} placeholder="Filter domains…" /></div>
        <div className="right" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {data.domains.length} domain{data.domains.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={rows}
          loading={false}
          keyOf={(d) => d.id}
          empty={<EmptyState icon={Globe2} title="No websites yet">Add your first domain — G-Panel will create the document root, nginx vhost, PHP pool and a DNS zone automatically.</EmptyState>}
          columns={[
            {
              key: 'domain', label: 'Domain',
              render: (d) => (
                <div className="domain-cell">{d.domain}</div>
              )
            },
            ...(data.domains.some((d) => d.owner) ? [{
              key: 'owner', label: 'Owner', render: (d) => <span style={{ fontSize: 12.5 }}>{d.owner}</span>
            }] : []),
            {
              key: 'type', label: 'Type',
              render: (d) => <Badge kind={d.type === 'php' ? 'accent' : 'neutral'}>{d.type}</Badge>
            },
            {
              key: 'php', label: 'PHP', render: (d) => d.type === 'php' ? <span className="mono" style={{ fontSize: 12.5 }}>{d.php_version}</span> : <span className="muted">—</span>
            },
            {
              key: 'ssl', label: 'SSL',
              render: (d) => d.ssl_state === 'letsencrypt'
                ? <Badge kind="ok" dot>Let's Encrypt</Badge>
                : d.ssl_state === 'selfsigned'
                  ? <Badge kind="warn" dot>Self-signed</Badge>
                  : <Badge kind="neutral" dot>None</Badge>
            },
            {
              key: 'dns', label: 'DNS',
              render: (d) => d.dns_zone ? <Badge kind="info">hosted</Badge> : <span className="muted">external</span>
            },
            {
              key: 'local', label: 'Local URL',
              render: (d) => d.local_port
                ? <a className="mono" style={{ fontSize: 12 }} href={`http://127.0.0.1:${d.local_port}`} target="_blank" rel="noreferrer">127.0.0.1:{d.local_port}</a>
                : <span className="muted">created before local ports</span>
            },
            {
              key: 'tunnel', label: 'Public (tunnel)',
              render: (d) => d.tunnel_url
                ? <a className="mono" style={{ fontSize: 12 }} href={d.tunnel_url} target="_blank" rel="noreferrer">{d.tunnel_url.replace('https://', '')}</a>
                : d.tunnel_status === 'error'
                  ? <Badge kind="warn" dot>tunnel error</Badge>
                  : <span className="muted">—</span>
            },
            {
              key: 'created', label: 'Added', num: true, render: (d) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(d.created_at)}</span>
            },
            {
              key: 'actions', label: '', className: 'actions',
              render: (d) => (
                <>
                  <button className="rowlink" onClick={() => openConnection(d)}>Connect</button>
                  <button className="rowlink" onClick={() => openLogs(d, 'access')}>Access log</button>
                  <button className="rowlink" onClick={() => openLogs(d, 'error')}>Errors</button>
                  <button className="rowlink" onClick={() => setEdit(d)}>Edit</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(d)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      {showAdd && (
        <AddDomainModal
          data={data}
          onClose={() => setShowAdd(false)}
          onDone={async (res) => {
            setShowAdd(false);
            if (res?.tunnel?.url) {
              toast.ok('Site is live — opening its public URL…');
            } else {
              toast.ok('Domain created — public_html ready (tunnel unavailable, local URL open)');
            }
            await load();
            // open the site automatically: public tunnel URL, local URL as fallback
            const url = res?.tunnel?.url || res?.local_url;
            if (url) window.open(url, '_blank', 'noopener');
          }}
        />
      )}

      {edit && (
        <EditDomainModal
          domain={edit}
          data={data}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); toast.ok('Site updated'); await load(); }}
        />
      )}

      {logs && (
        <Modal open wide title={`${logs.domain} — ${logs.kind} log`} onClose={() => setLogs(null)}>
          <pre style={{ background: '#14161A', color: '#C9CDC2', padding: 14, borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, maxHeight: '52vh', overflow: 'auto', margin: 0 }}>
            {logs.text || '(empty — no requests logged yet)'}
          </pre>
        </Modal>
      )}

      {connection && (
        <ConnectionModal
          info={connection}
          onClose={() => setConnection(null)}
          onRecheck={async () => {
            const fresh = await api.get(`/domains/${connection.id}/connection`);
            setConnection((c) => ({ ...c, ...fresh }));
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.domain}?`}
        body="Removes the nginx vhost, DNS zone and any mailboxes on this domain. Website files remain on disk under the user's home directory."
        confirmLabel="Delete domain"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/domains/${confirmDelete.id}`);
            toast.ok('Domain deleted');
            setConfirmDelete(null);
            await load();
          } catch (e) {
            if (e.status === 409 && confirmDelete) {
              // has mailboxes: confirm force
              const force = window.confirm(`${e.message}\n\nForce delete everything?`);
              if (force) {
                await api.del(`/domains/${confirmDelete.id}?force=1`);
                toast.ok('Domain deleted');
                setConfirmDelete(null);
                await load();
              }
            } else {
              toast.error(e.message);
            }
          }
        }}
      />
    </div>
  );

  async function openLogs(d, kind) {
    try {
      const res = await api.get(`/domains/${d.id}/logs/${kind}`);
      setLogs({ domain: d.domain, kind, text: res.text });
    } catch (e) { toast.error(e.message); }
  }

  async function openConnection(d) {
    try {
      const res = await api.get(`/domains/${d.id}/connection`);
      setConnection({ ...res, id: d.id });
    } catch (e) { toast.error(e.message); }
  }
}

function ConnectionModal({ info, onClose, onRecheck }) {
  const [checking, setChecking] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelErr, setTunnelErr] = useState(null);
  const recheck = async () => {
    setChecking(true);
    try { await onRecheck(); } finally { setChecking(false); }
  };
  const tunnelAction = async (kind) => {
    setTunnelBusy(true); setTunnelErr(null);
    try {
      const res = await api.post(`/domains/${info.id}/tunnel/${kind}`);
      onRecheck();
    } catch (e) { setTunnelErr(e.message); } finally { setTunnelBusy(false); }
  };
  const registrar = info.dns_hosted;
  return (
    <Modal open wide title={`Connect ${info.domain}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={recheck} disabled={checking}>{checking ? 'Checking…' : 'Re-check now'}</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Local PC (no DNS needed)</div>
          <div className="card" style={{ padding: 12, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12.5 }}>
              <b>Files:</b> <span className="mono">{info.local?.docroot || '—'}</span>
            </div>
            <div style={{ fontSize: 12.5 }}>
              <b>On this PC:</b>{' '}
              {info.local?.url
                ? <a className="mono" href={info.local.url} target="_blank" rel="noreferrer">{info.local.url}</a>
                : <span className="muted">not available (site created before local ports)</span>}
            </div>
            <div style={{ fontSize: 12.5 }}>
              <b>Public URL (Cloudflare tunnel):</b>{' '}
              {info.tunnel
                ? <a className="mono" href={info.tunnel} target="_blank" rel="noreferrer">{info.tunnel}</a>
                : <span className="muted">no tunnel yet</span>}
              {info.tunnel_status === 'running' && <Badge kind="ok" dot>running</Badge>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {!info.tunnel
                ? <button className="btn primary" disabled={tunnelBusy} onClick={() => tunnelAction('start')}>{tunnelBusy ? 'Starting tunnel…' : 'Start Cloudflare tunnel'}</button>
                : <button className="btn" disabled={tunnelBusy} onClick={() => tunnelAction('stop')}>{tunnelBusy ? 'Stopping…' : 'Stop tunnel'}</button>}
              {tunnelErr && <span className="danger-text" style={{ fontSize: 12 }}>{tunnelErr}</span>}
            </div>
          </div>
        </div>

        <div className={`callout ${info.delegated ? 'ok' : 'warn'}`}>
          <div style={{ fontSize: 13 }}>
            {info.delegated
              ? <><b>Connected.</b> This domain resolves to this server and is delegated to its nameservers.</>
              : <><b>Not connected yet.</b> Complete the steps below at your domain registrar, then re-check. Delegation changes can take up to 24–48h to propagate.</>}
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 8 }}>Step 1 — set these nameservers at your registrar</div>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="label" style={{ marginBottom: 4 }}>Nameserver 1</div>
                <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{info.expected?.ns1 || '—'}</div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="label" style={{ marginBottom: 4 }}>Nameserver 2</div>
                <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{info.expected?.ns2 || '—'}</div>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              With these nameservers, G-Panel's DNS zone serves the domain — records are managed in the DNS section.
            </p>
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 8 }}>Step 2 (alternative) — or keep external DNS</div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            If you prefer your registrar's DNS, create an <b>A record</b> for <span className="mono">@</span> and
            <span className="mono"> www</span> pointing to <span className="mono">{info.expected?.serverIp}</span>,
            and an <b>MX record</b> pointing to <span className="mono">mail.{info.domain}</span> if you use email here.
          </p>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 8 }}>Live check — what the internet sees right now</div>
          <div className="card">
            {(info.checks || []).map((c) => (
              <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                <span className={`dot ${c.ok ? 'ok' : 'warn'}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 550 }}>{c.label}</div>
                  <div className="mono muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.detail}</div>
                </div>
                {c.ok ? <span className="ok-text" style={{ fontSize: 12, fontWeight: 600 }}>OK</span> : <span className="danger-text" style={{ fontSize: 12, fontWeight: 600 }}>pending</span>}
              </div>
            ))}
          </div>
          {(info.found?.mx || []).length > 0 && (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>MX: <span className="mono">{info.found.mx.join(', ')}</span></p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AddDomainModal({ data, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    domain: '', type: 'php', php_version: data.phpVersions[0] || '8.3',
    dns_enabled: true, force_https: true, proxy_target: '', tunnel: true
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post('/domains', form);
      onDone(res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Add domain" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.domain}>{busy ? 'Provisioning…' : 'Create site'}</button>
      </>}>
      <form onSubmit={submit}>
        <Field label="Domain name" hint="On this PC a public_html folder, local URL and Cloudflare tunnel URL are created automatically — DNS delegation is optional.">
          <input className="input" autoFocus placeholder="example.com" value={form.domain}
            onChange={(e) => set('domain', e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Site type">
            <select className="input" value={form.type} onChange={(e) => set('type', e.target.value)}>
              <option value="php">PHP application</option>
              <option value="static">Static HTML</option>
              <option value="proxy">Reverse proxy</option>
              <option value="parked">Parked (redirect later)</option>
            </select>
          </Field>
          {form.type === 'php' && (
            <Field label="PHP version">
              <select className="input" value={form.php_version} onChange={(e) => set('php_version', e.target.value)}>
                {data.phpVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
          )}
          {form.type === 'proxy' && (
            <Field label="Proxy target">
              <input className="input" placeholder="http://127.0.0.1:3000" value={form.proxy_target}
                onChange={(e) => set('proxy_target', e.target.value)} />
            </Field>
          )}
        </div>
        <label className="checkbox-row" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={form.dns_enabled} onChange={(e) => set('dns_enabled', e.target.checked)} />
          <span>Host DNS zone on this server (creates A, www, MX, SPF records)</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.force_https} onChange={(e) => set('force_https', e.target.checked)} />
          <span>Force HTTPS once a certificate is issued</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.tunnel} onChange={(e) => set('tunnel', e.target.checked)} />
          <span>Start a Cloudflare tunnel for this site (gives a public https URL)</span>
        </label>
        {error && <div className="callout warn" style={{ marginTop: 12 }}>{error}</div>}
      </form>
    </Modal>
  );
}

function EditDomainModal({ domain, data, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    type: domain.type, php_version: domain.php_version,
    force_https: Boolean(domain.force_https), proxy_target: domain.proxy_target || '', active: Boolean(domain.active)
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/domains/${domain.id}`, form);
      onDone();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={`Edit ${domain.domain}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Applying…' : 'Save changes'}</button>
      </>}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Site type">
            <select className="input" value={form.type} onChange={(e) => set('type', e.target.value)}>
              <option value="php">PHP application</option>
              <option value="static">Static HTML</option>
              <option value="proxy">Reverse proxy</option>
              <option value="parked">Parked</option>
            </select>
          </Field>
          {form.type === 'php' && (
            <Field label="PHP version">
              <select className="input" value={form.php_version} onChange={(e) => set('php_version', e.target.value)}>
                {data.phpVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
          )}
          {form.type === 'proxy' && (
            <Field label="Proxy target">
              <input className="input" value={form.proxy_target} onChange={(e) => set('proxy_target', e.target.value)} placeholder="http://127.0.0.1:3000" />
            </Field>
          )}
        </div>
        <Field label="Document root">
          <input className="input mono" value={domain.docroot} disabled style={{ color: 'var(--ink-3)' }} />
        </Field>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.force_https} onChange={(e) => set('force_https', e.target.checked)} />
            <span>Force HTTPS</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            <span>Site active</span>
          </label>
        </div>
      </form>
    </Modal>
  );
}
