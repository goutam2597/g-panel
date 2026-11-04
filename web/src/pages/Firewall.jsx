import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, RefreshButton } from '../components/ui.jsx';
import { ShieldCheck, ShieldOff } from 'lucide-react';

export default function Firewall() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmToggle, setConfirmToggle] = useState(null);

  const load = useCallback(async () => {
    setData(await api.get('/firewall'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Firewall</h1>
          <div className="sub">
            ufw rules · fail2ban {data.fail2ban.active ? 'active' : 'inactive'}
          </div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn danger" onClick={() => setConfirmToggle(true)}>
            {data.enabled ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
            {data.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn primary" onClick={() => setShowAdd(true)}>Add rule</button>
        </div>
      </div>

      {!data.enabled && (
        <div className="callout warn" style={{ marginBottom: 14 }}>
          <b>Firewall is disabled</b> — every port on this server is open. Re-enable it as soon as possible.
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>Rules</h3><Badge kind={data.enabled ? 'ok' : 'danger'} dot>{data.enabled ? 'active' : 'inactive'}</Badge></div>
          <DataTable
            rows={data.rules}
            keyOf={(r) => r.index}
            empty={<EmptyState icon={ShieldCheck} title="No rules">Allow the ports you actually serve — 22, 80, 443, 53, 21 and the panel port.</EmptyState>}
            columns={[
              { key: 'port', label: 'Port', render: (r) => <span className="mono" style={{ fontSize: 12.5 }}>{r.port}</span> },
              {
                key: 'action', label: 'Action',
                render: (r) => r.action === 'ALLOW' ? <Badge kind="ok">ALLOW</Badge> : <Badge kind="danger">{r.action}</Badge>
              },
              { key: 'from', label: 'From', render: (r) => <span style={{ fontSize: 12.5 }}>{r.from}</span> },
              {
                key: 'actions', label: '', className: 'actions',
                render: (r) => <button className="rowlink danger" onClick={() => setConfirmDelete(r)}>Delete</button>
              }
            ]}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <h3>fail2ban jails</h3>
            <Badge kind={data.fail2ban.active ? 'ok' : 'warn'} dot>{data.fail2ban.active ? 'active' : 'not running'}</Badge>
          </div>
          {data.fail2ban.jails.length === 0
            ? <EmptyState icon={ShieldOff} title="No jail data">fail2ban may not be running.</EmptyState>
            : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Jail</th><th className="num">Banned now</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {data.fail2ban.jails.map((j) => (
                      <tr key={j.jail}>
                        <td style={{ fontWeight: 550 }}>{j.jail}</td>
                        <td className="num">{j.currentlyBanned > 0 ? <Badge kind="warn">{j.currentlyBanned}</Badge> : <span className="num muted">0</span>}</td>
                        <td className="num muted">{j.totalBanned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          <div className="card-body" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div className="label" style={{ marginBottom: 8 }}>Recommended open ports</div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.9 }}>
              <span className="mono">22</span> SSH · <span className="mono">80/443</span> web · <span className="mono">53</span> DNS ·
              <span className="mono"> 25/465/587</span> mail · <span className="mono">993</span> IMAPS ·
              <span className="mono"> 21+passive</span> FTP · <span className="mono">2083</span> panel
            </div>
          </div>
        </div>
      </div>

      {showAdd && (
        <AddRuleModal
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); toast.ok('Rule applied'); load(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete rule: ${confirmDelete?.action} ${confirmDelete?.port}?`}
        body="The rule takes effect immediately. Make sure you're not locking yourself out of SSH."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/firewall/rules/${confirmDelete.index}`);
            toast.ok('Rule deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmToggle)}
        danger={data.enabled}
        confirmLabel={data.enabled ? 'Disable firewall' : 'Enable firewall'}
        title={data.enabled ? 'Disable the firewall?' : 'Enable the firewall?'}
        body={data.enabled
          ? 'All ports become reachable. Only do this briefly for debugging.'
          : 'Default-deny is applied except for explicitly allowed rules. SSH port 22 stays reachable if allowed above.'}
        onCancel={() => setConfirmToggle(null)}
        onConfirm={async () => {
          try {
            await api.post('/firewall/toggle', { enabled: !data.enabled });
            toast.ok(data.enabled ? 'Firewall disabled' : 'Firewall enabled');
            setConfirmToggle(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function AddRuleModal({ onClose, onDone }) {
  const [form, setForm] = useState({ port: '', proto: 'tcp', action: 'allow' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/firewall/rules', form);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Add firewall rule" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.port}>{busy ? 'Applying…' : 'Apply rule'}</button></>}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Port" hint="e.g. 8080, or a range like 49152:49520">
            <input className="input mono" autoFocus placeholder="8080" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
          </Field>
          <Field label="Protocol">
            <select className="input" value={form.proto} onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value }))}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="">Both</option>
            </select>
          </Field>
          <Field label="Action">
            <select className="input" value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </Field>
        </div>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
