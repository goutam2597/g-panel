import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtBytes } from '../api.js';
import { AreaChart, PageLoading, RefreshButton, Badge } from '../components/ui.jsx';
import { useAuth } from '../store.jsx';
import { Cpu, MemoryStick, HardDrive, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

export default function Dashboard() {
  const { me } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get('/dashboard/summary')); setError(null); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="page"><div className="callout warn">{error}</div></div>;
  if (!data) return <PageLoading />;

  const { info, stats, services, counts, history } = data;
  const memPct = stats.memTotal ? (stats.memUsed / stats.memTotal) * 100 : 0;
  const diskPct = stats.diskTotal ? (stats.diskUsed / stats.diskTotal) * 100 : 0;
  const cpuHist = (history || []).map((s) => s.cpu);
  const memHist = (history || []).map((s) => s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0);
  const isAdmin = me.role === 'admin' && !data.impersonating;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">
            {info.hostname} · {info.distro} · {info.cpuCount}× {info.cpuModel} · up {fmtUptime(info.uptime)}
          </div>
        </div>
        <div className="actions"><RefreshButton onClick={load} /></div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatCard label="CPU" value={stats.cpu.toFixed(1)} unit="%" foot={`load ${stats.load1?.toFixed(2)} · ${stats.load5?.toFixed(2)} · ${stats.load15?.toFixed(2)}`} pct={stats.cpu} icon={Cpu} />
        <StatCard label="Memory" value={fmtBytes(stats.memUsed, 0)} unit={`/ ${fmtBytes(stats.memTotal, 0)}`} foot={`${memPct.toFixed(1)}% used`} pct={memPct} icon={MemoryStick} />
        <StatCard label="Disk /" value={fmtBytes(stats.diskUsed, 0)} unit={`/ ${fmtBytes(stats.diskTotal, 0)}`} foot={`${diskPct.toFixed(1)}% used`} pct={diskPct} icon={HardDrive} />
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="stat">
            <span className="stat-label">Network (live)</span>
            <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 15 }} className="num">
                <ArrowDownToLine size={14} color="var(--accent)" /> {fmtBytes(stats.netRx)}/s
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 15 }} className="num">
                <ArrowUpFromLine size={14} color="#B08D3E" /> {fmtBytes(stats.netTx)}/s
              </span>
            </div>
            <span className="stat-foot">rx / tx across all interfaces</span>
          </div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <h3>CPU & memory · last 24h</h3>
              <div className="chart-legend" style={{ padding: 0 }}>
                <span className="key"><i style={{ background: '#0E6B5A' }} /> CPU %</span>
                <span className="key"><i style={{ background: '#B08D3E' }} /> Memory %</span>
              </div>
            </div>
            <div className="chart-box">
              <AreaChart
                series={[
                  { label: 'CPU', values: cpuHist },
                  { label: 'Memory', values: memHist, area: false }
                ]}
                max={100}
                height={130}
                formatValue={(v) => `${Math.round(v)}%`}
              />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Services</h3>
              <Badge kind={services.every((s) => s.active) ? 'ok' : 'warn'} dot>
                {services.filter((s) => s.active).length}/{services.length} active
              </Badge>
            </div>
            <div className="svc-grid">
              {services.map((s) => (
                <div className="svc-item" key={s.name} title={`${s.name} — ${s.state}`}>
                  <span className="svc-name">{s.label}</span>
                  <span className={`dot ${s.active ? 'ok' : 'danger'}`} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head"><h3>{isAdmin ? 'Server' : 'Your account'}</h3></div>
            <div style={{ padding: '8px 0' }}>
              <LinkRow to="/websites" label="Websites" count={counts.domains} />
              <LinkRow to="/mail" label="Mailboxes" count={counts.mailboxes} />
              <LinkRow to="/databases" label="Databases" count={counts.databases} />
              <LinkRow to="/backups" label="Backups" count={counts.backups} />
              {isAdmin && counts.users != null && <LinkRow to="/admin/users" label="Hosting users" count={counts.users} />}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Recent activity</h3></div>
            <div style={{ padding: '6px 0' }}>
              {data.audit.length === 0 && <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--ink-3)' }}>No activity yet.</div>}
              {data.audit.map((a, i) => (
                <div key={i} style={{ padding: '7px 16px', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)', flexShrink: 0 }}>
                    {new Date(a.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 550 }}>{a.action}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.target || '—'} · {a.actor}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit, foot, pct, icon: Icon }) {
  const state = pct > 90 ? 'critical' : pct > 75 ? 'warn' : '';
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="stat">
        <span className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon size={13} style={{ color: 'var(--ink-3)' }} /> {label}
        </span>
        <span className="stat-value">{value}<span className="unit">{unit}</span></span>
        <div className="meter-row" style={{ padding: 0, gap: 8 }}>
          <div className={`meter-bar ${state}`} style={{ flex: 1 }}>
            <i style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        </div>
        <span className="stat-foot">{foot}</span>
      </div>
    </div>
  );
}

function LinkRow({ to, label, count }) {
  return (
    <Link to={to} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', color: 'var(--ink)', textDecoration: 'none' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span className="num" style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 600 }}>{count ?? '—'}</span>
    </Link>
  );
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}
