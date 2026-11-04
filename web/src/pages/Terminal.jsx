import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store.jsx';
import '@xterm/xterm/css/xterm.css';

export default function Terminal() {
  const { me } = useAuth();
  const holderRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ws;
    let term;
    let fitAddon;
    let killed = false;

    (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit')
      ]);
      if (killed || !holderRef.current) return;

      term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        theme: {
          background: '#14161A',
          foreground: '#C9CDC2',
          cursor: '#5FA996',
          selectionBackground: '#2C4A42',
          black: '#14161A', brightBlack: '#5C636A',
          green: '#5CB98A', brightGreen: '#7ED0A5',
          blue: '#6B9BD1', brightBlue: '#8FB8E0',
          yellow: '#CFA54B', brightYellow: '#E0BC6C',
          red: '#D4685F', brightRed: '#E08A83',
          white: '#C9CDC2', brightWhite: '#EDEFEA'
        }
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(holderRef.current);
      try { fitAddon.fit(); } catch { /* zero-size */ }

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/api/v1/terminal`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => term.write(ev.data);
      ws.onclose = () => { if (!killed) { term.write('\r\n\x1b[38;5;244m— session closed —\x1b[0m\r\n'); setConnected(false); } };
      ws.onerror = () => setError('Terminal connection failed');

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ data }));
      });
      const onResize = () => {
        try { fitAddon.fit(); } catch { /* ignore */ }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
        }
      };
      window.addEventListener('resize', onResize);
      ws.addEventListener('open', onResize);

      return () => window.removeEventListener('resize', onResize);
    })();

    return () => {
      killed = true;
      ws?.close();
      term?.dispose();
    };
  }, []);

  return (
    <div className="term-wrap">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h1>Terminal</h1>
          <div className="sub">
            {me?.role === 'admin'
              ? 'Root shell on this server (via panel-managed SSH key)'
              : 'Shell for your hosting account'}
            {' · '}
            {connected
              ? <span className="ok-text">connected</span>
              : error ? <span className="danger-text">{error}</span> : 'connecting…'}
          </div>
        </div>
      </div>
      <div className="term-card">
        <div ref={holderRef} style={{ width: '100%', height: '100%', padding: 8 }} />
      </div>
    </div>
  );
}
