import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { SearchInput, RefreshButton } from '../components/ui.jsx';
import { ScrollText } from 'lucide-react';

const ACTION_KIND = {
  login: 'neutral', 'login.failed': 'danger',
  'user.create': 'accent', 'user.delete': 'danger', 'user.impersonate': 'warn',
  'domain.create': 'accent', 'domain.delete': 'danger',
  'ssl.issue': 'ok', 'db.create': 'accent', 'db.delete': 'danger',
  'backup.create': 'ok', 'backup.delete': 'danger',
  'firewall.allow': 'warn', 'firewall.deny': 'warn', 'firewall.delete': 'danger'
};

export default function AuditLog() {
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async (query = '') => {
    setEntries(await api.get(`/audit?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line

  if (!entries) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">Every state-changing action, with actor and source IP · last 200 entries</div>
        </div>
        <div className="actions"><RefreshButton onClick={() => load(q)} /></div>
      </div>

      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Filter by actor, action, target…" width={320} />
      </div>

      <div className="card">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr>
            </thead>
            <tbody>
              {entries.entries.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30, color: 'var(--ink-3)' }}>
                  <ScrollText size={20} style={{ display: 'block', margin: '0 auto 8px', opacity: .5 }} />
                  No matching entries
                </td></tr>
              )}
              {entries.entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(e.ts)}</td>
                  <td style={{ fontWeight: 550 }}>{e.actor}</td>
                  <td><span className="mono" style={{ fontSize: 12 }}>{e.action}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.target || '—'}</td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.detail || ''}</td>
                  <td className="mono muted" style={{ fontSize: 11.5 }}>{e.ip || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
