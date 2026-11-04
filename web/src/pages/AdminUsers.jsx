import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateShort } from '../api.js';
import { useToast, useAuth } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Users as UsersIcon } from 'lucide-react';

export default function AdminUsers() {
  const toast = useToast();
  const { refresh } = useAuth();
  const [data, setData] = useState(null);
  const [packages, setPackages] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [edit, setEdit] = useState(null);
  const [created, setCreated] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmSuspend, setConfirmSuspend] = useState(null);
  const [resetPw, setResetPw] = useState(null);

  const load = useCallback(async () => {
    const [users, pkgs] = await Promise.all([api.get('/users'), api.get('/packages')]);
    setData(users.users);
    setPackages(pkgs.packages);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="sub">Hosting accounts — each maps to a Linux user with isolated services</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={load} />
          <button className="btn primary" onClick={() => setShowAdd(true)}>Create user</button>
        </div>
      </div>

      <div className="card">
        <DataTable
          rows={data}
          keyOf={(u) => u.id}
          empty={<EmptyState icon={UsersIcon} title="No users yet"
            action={<button className="btn primary" onClick={() => setShowAdd(true)}>Create user</button>}>
            Users get a package with resource limits and can manage only their own sites.
          </EmptyState>}
          columns={[
            {
              key: 'username', label: 'User',
              render: (u) => (
                <div className="user-cell">
                  <span className="avatar">{u.username.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <div className="u-name">{u.username}</div>
                    <div className="u-mail">{u.email}</div>
                  </div>
                </div>
              )
            },
            {
              key: 'role', label: 'Role',
              render: (u) => u.role === 'admin' ? <Badge kind="accent">admin</Badge> : <span className="muted" style={{ fontSize: 12.5 }}>user</span>
            },
            { key: 'pkg', label: 'Package', render: (u) => u.package_name ? <Badge kind="info">{u.package_name}</Badge> : <span className="muted" style={{ fontSize: 12 }}>none</span> },
            { key: 'domains', label: 'Sites', num: true, render: (u) => <span className="num">{u.domain_count ?? '—'}</span> },
            {
              key: 'status', label: 'Status',
              render: (u) => u.suspended
                ? <Badge kind="danger" dot>suspended</Badge>
                : <Badge kind="ok" dot>active</Badge>
            },
            { key: 'created', label: 'Created', num: true, render: (u) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(u.created_at)}</span> },
            {
              key: 'actions', label: '', className: 'actions',
              render: (u) => u.role === 'admin' ? (
                <button className="rowlink" onClick={() => setEdit(u)}>Edit</button>
              ) : (
                <>
                  <button className="rowlink" onClick={async () => {
                    await api.post(`/users/${u.id}/impersonate`);
                    await refresh();
                    window.location.href = '/';
                  }}>Act as user</button>
                  <button className="rowlink" onClick={() => setEdit(u)}>Edit</button>
                  <button className="rowlink danger" onClick={() => setConfirmDelete(u)}>Delete</button>
                </>
              )
            }
          ]}
        />
      </div>

      {showAdd && (
        <AddUserModal
          packages={packages}
          onClose={() => setShowAdd(false)}
          onCreated={(res) => { setShowAdd(false); if (res.initial_password) setCreated({ username: res.username || 'user', password: res.initial_password }); else { toast.ok('User created'); } load(); }}
        />
      )}

      {edit && (
        <EditUserModal
          user={edit}
          packages={packages}
          onClose={() => setEdit(null)}
          onDone={async () => {
            setEdit(null);
            toast.ok('User updated');
            await load();
          }}
          onResetPw={(pw) => setResetPw(pw)}
        />
      )}

      {(created || resetPw) && (
        <Modal open title="One-time password" onClose={() => { setCreated(null); setResetPw(null); }}
          footer={<button className="btn primary" onClick={() => { setCreated(null); setResetPw(null); }}>Done</button>}>
          <p style={{ fontSize: 13.5, marginBottom: 12 }}>Share this with the user — it is not recoverable later.</p>
          <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>User</dt><dd><Copyable text={(created || resetPw).username} /></dd>
            <dt>Password</dt><dd><Copyable text={(created || resetPw).password} /></dd>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete user ${confirmDelete?.username}?`}
        body="Removes their sites, DNS zones, mailboxes, databases, FTP accounts, cron jobs and Linux account. Website files under their home directory are deleted."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/users/${confirmDelete.id}`);
            toast.ok('User deleted');
            setConfirmDelete(null);
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function AddUserModal({ packages, onClose, onCreated }) {
  const [form, setForm] = useState({ username: '', email: '', package_id: packages[0]?.id || '', password: '', ssh_enabled: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { ...form, package_id: form.package_id ? Number(form.package_id) : null };
      if (!body.password) delete body.password;
      const res = await api.post('/users', body);
      onCreated({ username: form.username, initial_password: res.initial_password });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Create hosting user" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.username || !form.email}>{busy ? 'Provisioning…' : 'Create user'}</button></>}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Username" hint="lowercase, 3-32 chars — also their Linux user">
            <input className="input mono" autoFocus placeholder="johndoe" value={form.username}
              onChange={(e) => set('username', e.target.value.toLowerCase())} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" placeholder="john@example.com" value={form.email}
              onChange={(e) => set('email', e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Package">
            <select className="input" value={form.package_id} onChange={(e) => set('package_id', e.target.value)}>
              <option value="">No package (can't add sites)</option>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Password" hint="Leave empty to auto-generate">
            <input className="input" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="auto-generate" />
          </Field>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.ssh_enabled} onChange={(e) => set('ssh_enabled', e.target.checked)} />
          <span>Allow SSH access for this user</span>
        </label>
        {error && <div className="callout warn" style={{ marginTop: 12 }}>{error}</div>}
      </form>
    </Modal>
  );
}

function EditUserModal({ user, packages, onClose, onDone, onResetPw }) {
  const toast = useToast();
  const [form, setForm] = useState({
    email: user.email, package_id: user.package_id || '',
    ssh_enabled: Boolean(user.ssh_enabled), suspended: Boolean(user.suspended)
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/users/${user.id}`, {
        email: form.email,
        package_id: form.package_id ? Number(form.package_id) : null,
        ssh_enabled: form.ssh_enabled,
        suspended: form.suspended
      });
      onDone();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };

  const resetPassword = async () => {
    try {
      const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const pw = Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
      await api.put(`/users/${user.id}`, { password: pw });
      onResetPw({ username: user.username, password: pw });
    } catch (err) { toast.error(err.message); }
  };

  return (
    <Modal open title={`Edit ${user.username}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={resetPassword} type="button">Reset password</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={submit}>
        <Field label="Email">
          <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Package">
          <select className="input" value={form.package_id} onChange={(e) => set('package_id', e.target.value)}>
            <option value="">No package</option>
            {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.ssh_enabled} onChange={(e) => set('ssh_enabled', e.target.checked)} />
            <span>SSH access</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.suspended} onChange={(e) => set('suspended', e.target.checked)} />
            <span>Suspended (blocks login)</span>
          </label>
        </div>
      </form>
    </Modal>
  );
}
