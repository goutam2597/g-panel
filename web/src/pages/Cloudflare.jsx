import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { Badge, Modal, Field, RefreshButton, Copyable } from '../components/ui.jsx';
import { Cloud, Download, Play, Square, Globe2 } from 'lucide-react';

export default function Cloudflare() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // 'tunnel' | 'cf' | null
  const [tunnelToken, setTunnelToken] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [logs, setLogs] = useState('');
  const logRef = useRef(null);

  const load = useCallback(async () => {
    setStatus(await api.get('/cloudflare/status'));
    try { setLogs((await api.get('/cloudflare/logs')).text || ''); } catch {}
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.ok(okMsg);
      await load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  if (!status) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cloudflare Tunnel</h1>
          <div className="sub">Put locally hosted sites online — free, no port forwarding, TLS handled at Cloudflare's edge</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          {status.installed && status.running && (
            <button className="btn danger" onClick={() => act(() => api.post('/cloudflare/stop'), 'Tunnel stopped')} disabled={busy}>
              <Square size={14} /> Stop tunnel
            </button>
          )}
        </div>
      </div>

      {!status.installed ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <Cloud size={30} style={{ color: 'var(--accent)', marginBottom: 10 }} />
          <h2 style={{ fontSize: 17, marginBottom: 6 }}>One-click install: cloudflared</h2>
          <p className="muted" style={{ maxWidth: 460, margin: '0 auto 16px', fontSize: 13.5 }}>
            Downloads the official Cloudflare tunnel binary into the panel's own stack directory.
            No account needed for a quick tunnel; a free Cloudflare account unlocks permanent hostnames.
          </p>
          <button className="btn primary" style={{ padding: '9px 18px' }} disabled={busy}
            onClick={() => act(() => api.post('/cloudflare/install'), 'cloudflared installed')}>
            <Download size={15} /> {busy ? 'Downloading…' : 'Install cloudflared (one click)'}
          </button>
        </div>
      ) : (
        <>
          <div className="grid cols-2" style={{ marginBottom: 14 }}>
            <div className="card">
              <div className="card-head">
                <h3>Quick tunnel <Badge kind={status.running && status.mode === 'quick' ? 'ok' : 'neutral'} dot>{status.running && status.mode === 'quick' ? 'live' : 'idle'}</Badge></h3>
              </div>
              <div className="card-body">
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  Zero configuration: exposes the local web server (port 80) at a random
                  <span className="mono"> *.trycloudflare.com </span> address. Perfect to test a site right now.
                </p>
                {status.url ? (
                  <div className="callout ok" style={{ marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Your site is live at:</div>
                      <a href={status.url} target="_blank" rel="noreferrer" style={{ fontSize: 14 }}>
                        <Copyable text={status.url} /> ↗
                      </a>
                    </div>
                  </div>
                ) : null}
                {status.running && status.mode === 'quick'
                  ? <button className="btn danger" onClick={() => act(() => api.post('/cloudflare/stop'), 'Tunnel stopped')} disabled={busy}><Square size={13} /> Stop</button>
                  : <button className="btn primary" onClick={() => act(() => api.post('/cloudflare/quick/start', {}), 'Quick tunnel starting…')} disabled={busy}>
                      <Play size={13} /> Start quick tunnel
                    </button>}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Named tunnel <Badge kind={status.running && status.mode === 'named' ? 'ok' : 'neutral'} dot>{status.running && status.mode === 'named' ? 'live' : 'idle'}</Badge></h3>
              </div>
              <div className="card-body">
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  Permanent hostnames on your own domain. Create a tunnel in
                  Cloudflare Zero Trust → Networks → Tunnels, copy its token, paste it here,
                  and map hostnames to <span className="mono">http://localhost:80</span> in the dashboard.
                </p>
                {status.running && status.mode === 'named'
                  ? <button className="btn danger" onClick={() => act(() => api.post('/cloudflare/stop'), 'Tunnel stopped')} disabled={busy}><Square size={13} /> Stop named tunnel</button>
                  : <button className="btn" onClick={() => setModal('tunnel')} disabled={busy}>
                      <Globe2 size={13} /> Run with tunnel token
                    </button>}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3>Cloudflare DNS manager</h3>
              <Badge kind={status.cf_token_set ? 'ok' : 'warn'} dot>{status.cf_token_set ? 'token configured' : 'not connected'}</Badge>
            </div>
            <div className="card-body">
              <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                Manage DNS records for your Cloudflare zones directly from the panel — this is how
                domains resolve to locally hosted sites (point records at the tunnel). Create a free
                API token in Cloudflare (My Profile → API Tokens → "Edit zone DNS" template).
              </p>
              {status.cf_token_set
                ? <button className="btn" onClick={() => act(() => api.post('/cloudflare/token/clear'), 'Token cleared')}>Remove token</button>
                : <button className="btn primary" onClick={() => { setCfToken(''); setModal('cf'); }}><Globe2 size={13} /> Connect API token</button>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Tunnel logs</h3></div>
            <pre ref={logRef} style={{ background: '#14161A', color: '#C9CDC2', padding: 14, borderRadius: '0 0 6px 6px', fontSize: 11.5, lineHeight: 1.6, maxHeight: 260, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>
              {logs || '(no output yet — start a tunnel)'}
            </pre>
          </div>
        </>
      )}

      {modal === 'tunnel' && (
        <Modal open title="Run named tunnel" onClose={() => setModal(null)}
          footer={<>
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !tunnelToken.trim()}
              onClick={() => act(async () => { await api.post('/cloudflare/named/start', { token: tunnelToken.trim() }); setModal(null); }, 'Named tunnel starting…')}>
              <Play size={13} /> Start tunnel
            </button>
          </>}>
          <Field label="Tunnel token" hint="Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Install connector → copy the token after --token">
            <textarea className="input" rows={3} value={tunnelToken} onChange={(e) => setTunnelToken(e.target.value)} placeholder="eyJhIjoi…" />
          </Field>
          <div className="callout">
            <div style={{ fontSize: 12.5 }}>
              Then in the tunnel's Public Hostname tab map your domains to
              <span className="mono"> http://localhost:80</span> — DNS records are created for you by Cloudflare.
            </div>
          </div>
        </Modal>
      )}

      {modal === 'cf' && (
        <Modal open title="Connect Cloudflare API token" onClose={() => setTokenMode(null)}
          footer={<>
            <button className="btn" onClick={() => setTokenMode(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !cfToken.trim()}
              onClick={() => act(async () => {
                const r = await api.post('/cloudflare/token', { token: cfToken.trim() });
                toast.ok(`Token verified — ${r.zones} zone(s)`);
                setTokenMode(null);
              }, null)}>
              Verify & save
            </button>
          </>}>
          <Field label="API token" hint="My Profile → API Tokens → Create Token → 'Edit zone DNS' template → include your zones">
            <input className="input mono" type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} />
          </Field>
          <p className="muted" style={{ fontSize: 12.5 }}>The token is stored in the panel database and used only for DNS record management.</p>
        </Modal>
      )}
    </div>
  );
}

