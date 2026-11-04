import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Globe2, Network, Mail, Server, Database, Clock, Lock,
  FolderOpen, TerminalSquare, KeyRound, Archive, ShieldCheck, Users, Package,
  Settings2, ScrollText, LogOut, ChevronDown, ArrowLeftRight, Activity, Boxes, Cloud
} from 'lucide-react';
import { useAuth } from '../store.jsx';
import { api } from '../api.js';

// runtime platform: 'windows' | 'linux' — controls which modules make sense
let PLATFORM = null;
export function setPlatform(p) { PLATFORM = p; }
export function getPlatform() { return PLATFORM || (/Win(dows|NT)/.test(navigator.userAgent) ? 'windows' : 'linux'); }

const Logo = ({ size = 26 }) => (
  <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="7" fill="#0E6B5A" />
    <path d="M22.5 10.9c-1.3-1.9-3.6-3.1-6.2-3.1C12.1 7.8 8.7 11.4 8.7 16s3.4 8.2 7.6 8.2c4 0 7.1-3 7.1-7.4v-.4h-7v2.8h3.9c-.6 1.7-2.1 2.7-4 2.7-2.6 0-4.6-2.3-4.6-5.9s2-5.9 4.6-5.9c1.8 0 3.3.9 4.2 2.4l2-1.6z" fill="#FAFAF7" />
  </svg>
);

export { Logo };

const NAV = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, text: 'Dashboard' }
    ]
  },
  {
    label: 'Hosting',
    items: [
      { to: '/websites', icon: Globe2, text: 'Websites' },
      { to: '/dns', icon: Network, text: 'DNS' },
      { to: '/mail', icon: Mail, text: 'Email', platform: 'linux' },
      { to: '/databases', icon: Database, text: 'Databases' },
      { to: '/apps', icon: Boxes, text: 'Node.js apps' },
      { to: '/ftp', icon: Server, text: 'FTP', platform: 'linux' },
      { to: '/ssl', icon: Lock, text: 'SSL / TLS', platform: 'linux' }
    ]
  },
  {
    label: 'Server access',
    items: [
      { to: '/files', icon: FolderOpen, text: 'Files' },
      { to: '/ssh', icon: KeyRound, text: 'SSH keys', platform: 'linux' },
      { to: '/terminal', icon: TerminalSquare, text: 'Terminal' },
      { to: '/cron', icon: Clock, text: 'Cron jobs' }
    ]
  },
  {
    label: 'Maintenance',
    items: [
      { to: '/backups', icon: Archive, text: 'Backups' },
      { to: '/cloudflare', icon: Cloud, text: 'Cloudflare' },
      { to: '/firewall', icon: ShieldCheck, text: 'Firewall', admin: true, platform: 'linux' }
    ]
  },
  {
    label: 'Administration',
    admin: true,
    items: [
      { to: '/admin/users', icon: Users, text: 'Users' },
      { to: '/admin/packages', icon: Package, text: 'Packages' },
      { to: '/admin/settings', icon: Settings2, text: 'Settings' },
      { to: '/admin/audit', icon: ScrollText, text: 'Audit log' }
    ]
  }
];

export default function Layout() {
  const { me, impersonating, logout, refresh } = useAuth();
  const [servicesUp, setServicesUp] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const check = async () => {
      try {
        const data = await api.get('/dashboard/summary');
        if (alive) setServicesUp(data.services.every((s) => s.active));
      } catch { /* dashboard requires auth; ignore */ }
    };
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [me, location.pathname]);

  useEffect(() => {
    // learn the runtime platform once for module gating
    api.get('/auth/status').then((s) => setPlatform(s.platform || getPlatform())).catch(() => {});
  }, []);

  const isAdmin = me?.role === 'admin';
  const platform = getPlatform();
  const nav = NAV
    .filter((g) => !g.admin || isAdmin)
    .map((g) => ({ ...g, items: g.items.filter((it) => (!it.admin || isAdmin) && (!it.platform || it.platform === platform)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div className="brand-name">G-Panel</div>
          {window.location.hostname === 'localhost' && <div className="brand-env">DEV</div>}
        </div>
        <nav className="nav">
          {nav.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <item.icon />
                  <span>{item.text}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`svc-ok ${servicesUp === false ? 'down' : ''}`}>
            <i />
            {servicesUp === null ? 'checking…' : servicesUp ? 'all services up' : 'service down'}
          </span>
          <span className="mono">v1.0</span>
        </div>
      </aside>

      <div className="main">
        {impersonating && (
          <div className="impersonation-bar">
            <ArrowLeftRight size={14} />
            <span>You are acting as <b>{me?.username}</b> — actions are attributed to this account</span>
            <button onClick={async () => { await api.post('/users/stop-impersonating'); await refresh(); navigate('/'); }}>
              Return to admin
            </button>
          </div>
        )}
        <header className="topbar">
          <TopbarUser me={me} onLogout={logout} />
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function TopbarUser({ me, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (!me) return <div className="spacer" />;
  const initials = me.username.slice(0, 2).toUpperCase();

  return (
    <>
      <div className="crumbs" style={{ flex: 1 }}>
        <Activity size={13} style={{ color: 'var(--accent)' }} />
        <span>G-Panel</span>
      </div>
      <div className="topbar-user" ref={ref}>
        <button className="user-menu-btn" onClick={() => setOpen((o) => !o)}>
          <span className="avatar">{initials}</span>
          <span>{me.username}</span>
          <span className="label" style={{ fontSize: 10 }}>{me.role}</span>
          <ChevronDown size={13} />
        </button>
        {open && (
          <div className="user-pop">
            <div className="pop-head">
              <div className="name">{me.username}</div>
              <div className="role">{me.email}</div>
            </div>
            <button className="pop-item" onClick={() => { setOpen(false); onLogout(); }}>
              <LogOut size={14} /> Sign out
            </button>
          </div>
        )}
      </div>
    </>
  );
}
