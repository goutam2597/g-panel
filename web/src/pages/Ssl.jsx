import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, EmptyState, ConfirmDialog, RefreshButton } from '../components/ui.jsx';
import { Lock } from 'lucide-react';

export default function Ssl() {
  const toast = useToast();
  const [certs, setCerts] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmIssue, setConfirmIssue] = useState(null);

  const load = useCallback(async () => {
    setCerts((await api.get('/ssl')).certificates);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!certs) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const issue = async (c) => {
    setBusyId(c.id);
    setConfirmIssue(null);
    try {
      await api.post(`/ssl/${c.id}/issue`, {});
      toast.ok(`Let's Encrypt certificate issued for ${c.domain}`);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  const selfSign = async (c) => {
    setBusyId(c.id);
    try {
      await api.post(`/ssl/${c.id}/selfsigned`, {});
      toast.ok(`Self-signed certificate created for ${c.domain}`);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  const toggleHttps = async (c) => {
    setBusyId(c.id);
    try {
      await api.post(`/ssl/${c.id}/force-https`, { enabled: !c.force_https });
      toast.ok(!c.force_https ? 'HTTP now redirects to HTTPS' : 'HTTPS redirect disabled');
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>SSL / TLS certificates</h1>
          <div className="sub">Free Let's Encrypt certificates, renewed automatically twice daily</div>
        </div>
        <div className="actions"><RefreshButton onClick={load} /></div>
      </div>

      <div className="card">
        <DataTable
          rows={certs}
          keyOf={(c) => c.id}
          empty={<EmptyState icon={Lock} title="No domains yet">Add a website first, then issue certificates from here.</EmptyState>}
          columns={[
            { key: 'domain', label: 'Domain', render: (c) => <span className="domain-cell">{c.domain}</span> },
            {
              key: 'state', label: 'Certificate',
              render: (c) => c.ssl_state === 'letsencrypt'
                ? <Badge kind="ok" dot>Let's Encrypt</Badge>
                : c.ssl_state === 'selfsigned'
                  ? <Badge kind="warn" dot>Self-signed</Badge>
                  : <Badge kind="neutral" dot>None</Badge>
            },
            {
              key: 'expiry', label: 'Expires',
              render: (c) => {
                if (!c.days_left && c.days_left !== 0) return <span className="muted">—</span>;
                const kind = c.days_left < 14 ? 'danger' : c.days_left < 30 ? 'warn' : 'ok';
                return <Badge kind={kind}>{c.days_left} days left</Badge>;
              }
            },
            { key: 'issuer', label: 'Issuer', render: (c) => <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{c.issuer || '—'}</span> },
            {
              key: 'https', label: 'Force HTTPS',
              render: (c) => c.force_https ? <Badge kind="accent">on</Badge> : <span className="muted" style={{ fontSize: 12 }}>off</span>
            },
            {
              key: 'actions', label: '', className: 'actions',
              render: (c) => (
                <>
                  <button className="rowlink" onClick={() => setConfirmIssue(c)} disabled={busyId === c.id}>
                    {c.ssl_state === 'letsencrypt' ? 'Renew' : 'Issue LE cert'}
                  </button>
                  {c.ssl_state === 'none' && (
                    <button className="rowlink" onClick={() => selfSign(c)} disabled={busyId === c.id}>Self-signed</button>
                  )}
                  {c.ssl_state !== 'none' && (
                    <button className="rowlink" onClick={() => toggleHttps(c)} disabled={busyId === c.id}>
                      {c.force_https ? 'Disable redirect' : 'Force HTTPS'}
                    </button>
                  )}
                </>
              )
            }
          ]}
        />
      </div>

      <div className="callout" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5 }}>
          <b>Before issuing:</b> the domain's DNS must point at this server (A record), and port 80 must be reachable
          from the internet. If the zone is hosted here, that's already handled. Certificates cover
          <span className="mono"> domain </span> and <span className="mono">www.domain</span>.
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmIssue)}
        danger={false}
        confirmLabel="Issue certificate"
        title={`Issue Let's Encrypt certificate for ${confirmIssue?.domain}?`}
        body="certbot will validate domain ownership over HTTP. Validation failures are usually DNS pointing elsewhere or port 80 blocked."
        onCancel={() => setConfirmIssue(null)}
        onConfirm={() => issue(confirmIssue)}
      />
    </div>
  );
}
