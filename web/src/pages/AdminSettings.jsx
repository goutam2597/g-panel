import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { Field, RefreshButton, Badge } from '../components/ui.jsx';

function fmtGb(bytes) {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export default function AdminSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [server, setServer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState(5);

  const load = useCallback(async () => {
    const [s, srv] = await Promise.all([api.get('/settings'), api.get('/settings/server')]);
    setSettings(s.settings);
    setServer(srv);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!settings || !server) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/settings', settings);
      toast.ok('Settings saved');
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };

  const restart = async (name, action = 'restart') => {
    try {
      await api.post(`/firewall/services/${name}/${action}`);
      toast.ok(`${name} ${action}ed`);
      await load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Server settings</h1>
          <div className="sub">Global values used across DNS zones, mail records and provisioning</div>
        </div>
        <div className="actions"><RefreshButton onClick={load} /></div>
      </div>

      <form onSubmit={save}>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-head"><h3>Identity</h3></div>
          <div className="card-body">
            <div className="form-row">
              <Field label="Server hostname" hint="Used in MX defaults and NS records">
                <input className="input mono" value={settings.hostname} onChange={(e) => set('hostname', e.target.value)} />
              </Field>
              <Field label="Server IP (IPv4)" hint="Default A record for hosted zones">
                <input className="input mono" value={settings.server_ip} onChange={(e) => set('server_ip', e.target.value)} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Primary nameserver (ns1)">
                <input className="input mono" value={settings.ns1} onChange={(e) => set('ns1', e.target.value)} />
              </Field>
              <Field label="Secondary nameserver (ns2)">
                <input className="input mono" value={settings.ns2} onChange={(e) => set('ns2', e.target.value)} />
              </Field>
            </div>
            <Field label="Webmail URL" hint="Shown to users on the Email page (e.g. https://webmail.example.com)">
              <input className="input mono" value={settings.webmail_url || ''} onChange={(e) => set('webmail_url', e.target.value)} />
            </Field>
            <Field label="phpMyAdmin signon URL" hint="URL of gpanel-signon.php on your phpMyAdmin host, e.g. https://pma.example.com/gpanel-signon.php — the Databases page's phpMyAdmin button uses it for one-click login">
              <input className="input mono" value={settings.pma_url || ''} onChange={(e) => set('pma_url', e.target.value)} />
            </Field>
          </div>
        </div>

        <button className="btn primary" type="submit" disabled={busy} style={{ marginBottom: 24 }}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </form>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3>Storage</h3><span className="label">{server.storage ? `drive ${server.storage.drive}` : ''}</span></div>
        <div className="card-body">
          {server.storage ? (
            <>
              <div style={{ marginBottom: 10 }}>
                <div className="meter-row" style={{ padding: 0 }}>
                  <div className="meter-bar" style={{ flex: 1 }}>
                    <i style={{ width: `${Math.min(100, (server.storage.used / (server.storage.total || 1)) * 100)}%` }} />
                  </div>
                  <span className="meter-val">
                    {fmtGb(server.storage.used)} used of {fmtGb(server.storage.total)} · {fmtGb(server.storage.free)} free
                  </span>
                </div>
              </div>
              <div className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
                <dt>Install root</dt><dd>{server.storage.installRoot}</dd>
                <dt>Sites storage</dt><dd>{server.storage.sitesDir}</dd>
                <dt>Backups</dt><dd>{server.storage.backupsDir}</dd>
                {server.storage.stackDir ? <><dt>Service stack</dt><dd>{server.storage.stackDir}</dd></> : null}
                <dt>Panel database</dt><dd>{server.storage.dataDir}/panel.db</dd>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Everything the panel stores — site files, backups, the stack and the database —
                lives on the drive it was installed to ({server.storage.drive}).
              </p>
            </>
          ) : <span className="muted">Storage information unavailable.</span>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head"><h3>System</h3></div>
        <div className="card-body">
          <div className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
            <dt>Host</dt><dd>{server.info.hostname} ({server.info.distro})</dd>
            <dt>Kernel</dt><dd>{server.info.kernel} · {server.info.arch}</dd>
            <dt>CPU</dt><dd>{server.info.cpuCount}× {server.info.cpuModel}</dd>
            <dt>Panel version</dt><dd>{server.info.panelVersion}</dd>
            <dt>Pending updates</dt><dd>{server.updates == null ? '—' : server.updates}</dd>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Services</h3></div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Service</th><th>Status</th><th className="num" style={{ paddingRight: 14 }}>Actions</th></tr></thead>
            <tbody>
              {server.services.map((s) => (
                <tr key={s.name}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{s.label}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>{s.name}</div>
                  </td>
                  <td><Badge kind={s.active ? 'ok' : 'danger'} dot>{s.state}</Badge></td>
                  <td className="actions">
                    <button className="rowlink" onClick={() => restart(s.name, 'reload')} title="Reload config">Reload</button>
                    <button className="rowlink" onClick={() => restart(s.name, 'restart')}>Restart</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
