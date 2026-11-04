import { useEffect, useRef, useState } from 'react';
import { X, Search, Folder, FileText, Link2, ChevronRight, RefreshCw } from 'lucide-react';

// ---------- confirm dialog ----------
export function ConfirmDialog({ open, title, body, confirmLabel = 'Delete', danger = true, onConfirm, onCancel, busy = false }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-only" onClick={onCancel} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="modal-body" style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{body}</div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- modal ----------
export function Modal({ open, title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-only" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- form fields ----------
export function Field({ label, hint, error, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', width = 240 }) {
  return (
    <div className="search">
      <Search size={14} />
      <input className="input" style={{ width }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="checkbox-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------- data table ----------
export function DataTable({ columns, rows, empty, keyOf = (r) => r.id, loading = false, footer }) {
  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><div className="spinner" /></div>;
  }
  if (!rows?.length) return empty || null;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.key} className={c.num ? 'num' : ''} style={{ width: c.width }}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={keyOf(row)}>
              {columns.map((c) => (
                <td key={c.key} className={`${c.num ? 'num' : ''} ${c.className || ''}`}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer}
      </table>
    </div>
  );
}

// ---------- badges / status ----------
export function Badge({ kind = 'neutral', children, dot = false }) {
  return (
    <span className={`badge ${kind}`}>
      {dot && <span className={`dot ${kind === 'neutral' ? 'idle' : kind}`} style={{ width: 6, height: 6, boxShadow: 'none' }} />}
      {children}
    </span>
  );
}

const STATE_KIND = {
  ok: 'ok', warn: 'warn', critical: 'danger', danger: 'danger', info: 'info', accent: 'accent'
};

export function StateBadge({ state, label }) {
  return <Badge kind={STATE_KIND[state] || 'neutral'}>{label}</Badge>;
}

// ---------- empty state ----------
export function EmptyState({ icon: Icon = Folder, title, children, action }) {
  return (
    <div className="empty">
      <Icon size={26} strokeWidth={1.6} />
      <div className="empty-title">{title}</div>
      <p>{children}</p>
      {action}
    </div>
  );
}

// ---------- sparkline / area chart (dependency-free) ----------
export function AreaChart({ series, height = 120, max = null, colors = ['#0E6B5A', '#B08D3E'], formatValue = (v) => v }) {
  if (!series?.length) return <div style={{ height }} />;
  const w = 600;
  const h = height;
  const pad = 4;
  const allVals = series.flatMap((s) => s.values);
  const top = max ?? (Math.max(...allVals) * 1.1 || 1);
  const n = Math.max(...series.map((s) => s.values.length));

  const pathFor = (values) => {
    if (!values.length) return '';
    const step = (w - pad * 2) / Math.max(1, n - 1);
    return values.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - (v / top) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: 'block' }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={w} y1={h * f} y2={h * f} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
      ))}
      {series.map((s, si) => {
        const d = pathFor(s.values);
        const area = `${d} L${(pad + (s.values.length - 1) * ((w - pad * 2) / Math.max(1, n - 1))).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
        return (
          <g key={s.label || si}>
            {s.area !== false && <path d={area} fill={colors[si % colors.length]} opacity="0.09" />}
            <path d={d} fill="none" stroke={colors[si % colors.length]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      <text x={pad + 2} y={13} fontSize="10" fill="var(--ink-4)" fontFamily="var(--mono)">{formatValue(top)}</text>
    </svg>
  );
}

// ---------- quota bar ----------
export function QuotaBar({ item }) {
  const fmt = (v) => {
    if (item.unit === 'mb') return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`;
    if (item.unit === 'gb') return `${v} GB`;
    return v;
  };
  return (
    <div className={`quota ${item.state === 'warn' ? 'warn' : item.state === 'critical' ? 'critical' : ''}`}>
      <div className="quota-top">
        <span className="quota-label">{item.label}</span>
        <span className="quota-val">
          {fmt(item.used)} / {item.max === null ? '∞' : fmt(item.max)}
        </span>
      </div>
      <div className="bar"><i style={{ width: `${Math.max(item.pct, item.used > 0 ? 2 : 0)}%` }} /></div>
    </div>
  );
}

// ---------- copyable value ----------
export function Copyable({ text, mono = true, title }) {
  const [copied, setCopied] = useState(false);
  const t = useRef(null);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <span
      className={mono ? 'mono' : ''}
      title={title || text}
      onClick={copy}
      style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, wordBreak: 'break-all' }}
    >
      {text}
      <span style={{ fontSize: 10, color: copied ? 'var(--ok)' : 'var(--ink-4)', fontWeight: 600, flexShrink: 0 }}>
        {copied ? 'copied' : ''}
      </span>
    </span>
  );
}

// ---------- breadcrumbs ----------
export function Breadcrumbs({ items }) {
  return (
    <div className="crumbs-path">
      {items.map((it, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {i > 0 && <ChevronRight size={12} className="sep" />}
          {it.onClick
            ? <button onClick={it.onClick}>{it.label}</button>
            : <span style={{ color: i === items.length - 1 ? 'var(--ink)' : undefined }}>{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

// ---------- refresh button with spin ----------
export function RefreshButton({ onClick, spinning = false, title = 'Refresh' }) {
  return (
    <button className="btn ghost icon-only" onClick={onClick} title={title} aria-label={title}>
      <RefreshCw size={14} className={spinning ? 'spin' : ''} />
    </button>
  );
}

// ---------- loading page ----------
export function PageLoading() {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><div className="spinner" /></div>;
}

export function fileIcon(entry) {
  if (entry.type === 'dir') return { Icon: Folder, cls: 'dir-icon' };
  if (entry.type === 'link') return { Icon: Link2, cls: '' };
  return { Icon: FileText, cls: '' };
}
