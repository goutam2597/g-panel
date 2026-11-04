import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Database as DbIcon, UserRound, LogIn } from 'lucide-react';

export default function Databases() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [engine, setEngine] = useState('mysql');
  const [view, setView] = useState('databases');
  const [showAddDb, setShowAddDb] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [grantUser, setGrantUser] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [created, setCreated] = useState(null);
  const [pma, setPma] = useState(null);       // {users, pma_url, dev}
  const [pmaBusy, setPmaBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await api.get('/databases'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openPhpMyAdmin = async () => {
    setPmaBusy(true);
    try {
      const info = await api.get('/databases/pma-users');
      if (!info.users.length) {
        toast.error('Create a MySQL database user first — phpMyAdmin signs in with one of them');
        return;
      }
      setPma(info);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPmaBusy(false);
    }
  };

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const dbs = data.databases.filter((d) => d.engine === engine);
  const users = data.dbUsers.filter((u) => u.engine === engine);
  const version = engine === 'mysql' ? data.serverVersion?.mysql : data.serverVersion?.postgres;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Databases</h1>
          <div className="sub">
            {version || 'Database server'}{' · '}
            {engine === 'mysql' ? 'MariaDB (MySQL compatible)' : 'PostgreSQL'}
          </div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          {engine === 'mysql' && (
            <button className="btn" onClick={openPhpMyAdmin} disabled={pmaBusy}>
              <LogIn size={14} /> {pmaBusy ? 'Preparing…' : 'phpMyAdmin'}
            </button>
          )}
          {view === 'databases'
            ? <button className="btn primary" onClick={() => setShowAddDb(true)}>Create database</button>
            : <button className="btn primary" onClick={() => setShowAddUser(true)}>Create database user</button>}
        </div>
      </div>

      <div className="tabs">
        <button className={engine === 'mysql' ? 'active' : ''} onClick={() => setEngine('mysql')}>
          MySQL / MariaDB <span style={{ color: 'var(--ink-4)', marginLeft: 4 }}>({data.databases.filter((d) => d.engine === 'mysql').length})</span>
        </button>
        <button className={engine === 'postgres' ? 'active' : ''} onClick={() => setEngine('postgres')}>
          PostgreSQL <span style={{ color: 'var(--ink-4)', marginLeft: 4 }}>({data.databases.filter((d) => d.engine === 'postgres').length})</span>
        </button>
      </div>

      <div className="toolbar">
        <div className="left" style={{ display: 'flex', gap: 2 }}>
          <button className={`btn sm ${view === 'databases' ? 'primary' : ''}`} onClick={() => setView('databases')}>Databases</button>
          <button className={`btn sm ${view === 'users' ? 'primary' : ''}`} onClick={() => setView('users')}>Database users</button>
        </div>
        <div className="right" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {dbs.length} database{dbs.length === 1 ? '' : 's'} · {users.length} user{users.length === 1 ? '' : 's'}
        </div>
      </div>

      {view === 'databases' ? (
        <div className="card">
          <DataTable
            rows={dbs}
            keyOf={(d) => d.id}
            empty={<EmptyState icon={DbIcon} title={`No ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} databases yet`}
              action={<button className="btn primary" onClick={() => setShowAddDb(true)}>Create database</button>}>
              Databases are named <span className="mono">username_name</span> on the local {engine === 'mysql' ? 'MariaDB' : 'PostgreSQL'} server.
            </EmptyState>}
            columns={[
              {
                key: 'name', label: 'Database', render: (d) => (
                  <div>
                    <span className="domain-cell">{d.name}</span>
                    {(d.granted_to || []).map((u) => (
                      <div key={u.id} style={{ marginTop: 3 }}>
                        <Badge kind="info" title={`Granted to ${u.name} — visible in phpMyAdmin when signed in as this user`}>→ {u.name}</Badge>
                      </div>
                    ))}
                  </div>
                )
              },
              { key: 'size', label: 'Size', num: true, render: (d) => <span className="num">{d.size_mb != null ? `${d.size_mb} MB` : '—'}</span> },
              { key: 'created', label: 'Created', num: true, render: (d) => <span className="muted" style={{ fontSize: 12 }}>{new Date(d.created_at).toLocaleDateString()}</span> },
              {
                key: 'actions', label: '', className: 'actions',
                render: (d) => <button className="rowlink danger" onClick={() => setConfirm({ kind: 'db', row: d })}>Delete</button>
              }
            ]}
          />
        </div>
      ) : (
        <div className="card">
          <DataTable
            rows={users}
            keyOf={(u) => u.id}
            empty={<EmptyState icon={UserRound} title="No database users yet"
              action={<button className="btn primary" onClick={() => setShowAddUser(true)}>Create database user</button>}>
              Users are named <span className="mono">username_name</span> and granted per database.
            </EmptyState>}
            columns={[
              { key: 'name', label: 'User', render: (u) => <span className="domain-cell">{u.name}</span> },
              {
                key: 'grants', label: 'Granted databases',
                render: (u) => u.databases.length
                  ? <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {u.databases.map((dbId) => {
                        const dbRow = data.databases.find((d) => d.id === dbId);
                        return <Badge key={dbId} kind="accent">{dbRow?.name || dbId}</Badge>;
                      })}
                    </div>
                  : <span className="muted" style={{ fontSize: 12 }}>none</span>
              },
              {
                key: 'actions', label: '', className: 'actions',
                render: (u) => (
                  <>
                    <button className="rowlink" onClick={() => setGrantUser(u)}>Grant database</button>
                    <button className="rowlink" onClick={() => resetUserPassword(u)}>Reset password</button>
                    <button className="rowlink danger" onClick={() => setConfirm({ kind: 'dbuser', row: u })}>Delete</button>
                  </>
                )
              }
            ]}
          />
        </div>
      )}

      {showAddDb && <CreateDbModal engine={engine} dbUsers={data.dbUsers.filter((u) => u.engine === engine)} onClose={() => setShowAddDb(false)} onCreated={(res) => { setShowAddDb(false); if (res.warning) toast.error(res.warning); else toast.ok('Database created — granted users see it in phpMyAdmin'); load(); }} />}
      {showAddUser && <CreateDbUserModal engine={engine} onClose={() => setShowAddUser(false)} onCreated={(res) => { setShowAddUser(false); setCreated(res.password ? res : null); if (!res.password) toast.ok('User created'); load(); }} />}
      {grantUser && (
        <GrantModal
          dbUser={grantUser}
          databases={data.databases}
          onClose={() => setGrantUser(null)}
          onDone={() => { setGrantUser(null); toast.ok('Grant applied'); load(); }}
        />
      )}

      {created && (
        <Modal open title="Credentials created" onClose={() => setCreated(null)}
          footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
          <p style={{ fontSize: 13.5, marginBottom: 12 }}>Save these now — the password cannot be retrieved later.</p>
          <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>{created.kind === 'user' ? 'User' : 'Database'}</dt><dd><Copyable text={created.name} /></dd>
            <dt>Password</dt><dd><Copyable text={created.password} /></dd>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === 'db' ? `Delete database ${confirm?.row.name}?` : `Delete database user ${confirm?.row.name}?`}
        body={confirm?.kind === 'db'
          ? 'All data in this database will be permanently removed.'
          : 'The database account is removed; grants disappear with it.'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            if (confirm.kind === 'db') await api.del(`/databases/databases/${confirm.row.id}`);
            else await api.del(`/databases/users/${confirm.row.id}`);
            toast.ok('Deleted');
            setConfirm(null);
            load();
          } catch (e) {
            toast.error(e.message);
            setConfirm(null); // don't trap the user in a failing dialog
            load();
          }
        }}
      />

      {pma && (
        <PmaLoginModal
          info={pma}
          onClose={() => setPma(null)}
        />
      )}
    </div>
  );

  async function resetUserPassword(u) {
    try {
      const res = await api.post(`/databases/users/${u.id}/reset-password`, {});
      if (res.new_password) setCreated({ kind: 'user', name: u.name, password: res.new_password });
      else toast.ok('Password updated');
    } catch (e) { toast.error(e.message); }
  }
}

/**
 * cPanel-style phpMyAdmin SSO: pick the MySQL user to sign in as, the panel
 * issues a one-time 90-second token and opens phpMyAdmin already logged in.
 */
function PmaLoginModal({ info, onClose }) {
  const toast = useToast();
  const [selected, setSelected] = useState(info.users[0]?.id);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const res = await api.post('/databases/pma-login', { db_user_id: selected });
      if (res.phpMissing) {
        toast.error(res.reason || 'phpMyAdmin needs PHP — not found on this machine');
        return;
      }
      window.open(res.url, '_blank');
      toast.ok('Opening phpMyAdmin — signed in automatically (one-time sign-on)');
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Log in to phpMyAdmin" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={go} disabled={busy || !selected}>
          {busy ? 'Signing in…' : <><LogIn size={13} /> Log in</>}
        </button>
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--ink-2)', marginBottom: 14 }}>
        phpMyAdmin opens in a new tab, signed in with the MySQL user you choose —
        no password to type. The sign-on link is single-use and expires in 90 seconds.
      </p>
      <Field label="Sign in as (MySQL user)">
        <div style={{ display: 'grid', gap: 6 }}>
          {info.users.map((u) => (
            <label key={u.id} className={`checkbox-row`} style={{
              border: `1px solid ${selected === u.id ? 'var(--accent-line)' : 'var(--line)'}`,
              background: selected === u.id ? 'var(--accent-soft)' : 'var(--surface)',
              borderRadius: 5, padding: '8px 11px'
            }}>
              <input type="radio" name="pma-user" checked={selected === u.id} onChange={() => setSelected(u.id)} />
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 550 }}>{u.name}</span>
            </label>
          ))}
        </div>
      </Field>
      {info.dev && (
        <div className="callout warn" style={{ marginTop: 6 }}>
          Dev mode — this opens the panel's own phpMyAdmin: the official
          package, downloaded once and served locally with the same one-click
          sign-on used on the server. Your Laragon/XAMPP installs stay untouched.
        </div>
      )}
      {!info.dev && !info.pma_url && (
        <div className="callout warn" style={{ marginTop: 6 }}>
          phpMyAdmin URL is not configured yet — set it under Admin → Settings
          (the installer normally fills this in).
        </div>
      )}
    </Modal>
  );
}

// (view state lives in the component)

function CreateDbModal({ engine, dbUsers, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [grantTo, setGrantTo] = useState(dbUsers[0]?.id ? String(dbUsers[0].id) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body = { name, engine };
      if (grantTo) body.grant_to = Number(grantTo);
      const res = await api.post('/databases/databases', body);
      onCreated(res);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Create ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} database`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !name}>{busy ? 'Creating…' : 'Create'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Name" hint="Prefix username_ is added automatically (64-char limit applies)">
          <input className="input mono" autoFocus placeholder="wordpress" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Grant to database user"
          hint={engine === 'mysql'
            ? 'Granted users see (and manage) this database immediately in phpMyAdmin — no extra step'
            : 'Granted users can manage this database immediately'}
        >
          <select className="input" value={grantTo} onChange={(e) => setGrantTo(e.target.value)}>
            <option value="">None — grant later from the users tab</option>
            {dbUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}

function CreateDbUserModal({ engine, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body = { name: form.name, engine };
      if (form.password) body.password = form.password;
      const res = await api.post('/databases/users', body);
      onCreated({ kind: 'user', name: res.name, password: res.initial_password || form.password });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Create ${engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} user`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.name}>{busy ? 'Creating…' : 'Create'}</button></>}>
      <form onSubmit={submit}>
        <Field label="Name" hint="Prefix username_ is added automatically">
          <input className="input mono" autoFocus placeholder="wp" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Password" hint="Leave empty to auto-generate">
          <input className="input" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="auto-generate" />
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}

function GrantModal({ dbUser, databases, onClose, onDone }) {
  const [dbId, setDbId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const granted = new Set(dbUser.databases);
  const available = databases.filter((d) => !granted.has(d.id) && d.engine === dbUser.engine);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`/databases/users/${dbUser.id}/grants`, { database_id: Number(dbId) });
      onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={`Grant database to ${dbUser.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !dbId}>{busy ? 'Applying…' : 'Grant access'}</button></>}>
      {available.length ? (
        <Field label="Database" hint="User receives ALL PRIVILEGES on this database only.">
          <select className="input" value={dbId} onChange={(e) => setDbId(e.target.value)} autoFocus>
            <option value="">Choose…</option>
            {available.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      ) : <p style={{ color: 'var(--ink-2)' }}>All {dbUser.engine} databases are already granted to this user.</p>}
      {error && <div className="callout warn">{error}</div>}
    </Modal>
  );
}
