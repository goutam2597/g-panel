import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtDateShort, download } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Mail as MailIcon, AtSign } from 'lucide-react';

export default function Mail() {
  const toast = useToast();
  const [mailDomains, setMailDomains] = useState(null);
  const [selected, setSelected] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [showEnable, setShowEnable] = useState(false);
  const [showAddMbox, setShowAddMbox] = useState(false);
  const [created, setCreated] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [webmailUrl, setWebmailUrl] = useState('');

  const loadDomains = useCallback(async () => {
    const data = await api.get('/mail');
    setMailDomains(data.mailDomains);
    if (data.mailDomains.length && !selected) selectDomain(data.mailDomains[0].id);
    else if (selected && !data.mailDomains.some((m) => m.id === selected.id)) {
      data.mailDomains.length ? selectDomain(data.mailDomains[0].id) : setSelected(null);
    }
  }, [selected]);

  const loadSettings = useCallback(async () => {
    const s = await api.get('/settings');
    setWebmailUrl(s.settings.webmail_url || '');
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  useEffect(() => { loadDomains(); }, []); // eslint-disable-line

  const selectDomain = async (id) => {
    const data = await api.get(`/mail/domains/${id}/accounts`);
    setSelected(data.domain);
    setAccounts(data.accounts);
  };

  if (!mailDomains) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Email</h1>
          <div className="sub">Mailboxes served by Postfix + Dovecot, signed with DKIM</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={loadDomains} />
          <button className="btn" onClick={() => setShowEnable(true)}>Enable mail on domain</button>
          {selected && <button className="btn primary" onClick={() => setShowAddMbox(true)}>Create mailbox</button>}
        </div>
      </div>

      {mailDomains.length === 0 ? (
        <div className="card">
          <EmptyState icon={MailIcon} title="No mail domains yet"
            action={<button className="btn primary" onClick={() => setShowEnable(true)}>Enable mail on a domain</button>}>
            Enabling email on one of your websites generates DKIM keys and inserts MX, SPF and DMARC records into its DNS zone.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="tabs">
            {mailDomains.map((m) => (
              <button key={m.id} className={selected?.domain === m.domain ? 'active' : ''} onClick={() => selectDomain(m.id)}>
                @{m.domain} <span style={{ color: 'var(--ink-4)', marginLeft: 4 }}>({m.account_count})</span>
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div className="callout" style={{ marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Mail client settings for @{selected.domain}</div>
                  <div className="conn-grid">
                    <div className="conn-box" style={{ border: 'none', padding: 0 }}>
                      <div className="conn-title">Sending (SMTP)</div>
                      <div className="conn-row"><span className="k">Server</span><span className="v"><Copyable text={`mail.${selected.domain}`} /></span></div>
                      <div className="conn-row"><span className="k">Port</span><span className="v">465 (SSL) or 587 (STARTTLS)</span></div>
                      <div className="conn-row"><span className="k">Auth</span><span className="v">full email address</span></div>
                    </div>
                    <div className="conn-box" style={{ border: 'none', padding: 0 }}>
                      <div className="conn-title">Receiving (IMAP)</div>
                      <div className="conn-row"><span className="k">Server</span><span className="v"><Copyable text={`mail.${selected.domain}`} /></span></div>
                      <div className="conn-row"><span className="k">Port</span><span className="v">993 (SSL)</span></div>
                      <div className="conn-row"><span className="k">Auth</span><span className="v">full email address</span></div>
                    </div>
                  </div>
                  {webmailUrl && (
                    <div style={{ marginTop: 8, fontSize: 12.5 }}>
                      Webmail: <a href={webmailUrl.startsWith('http') ? webmailUrl : `https://${webmailUrl}`} target="_blank" rel="noreferrer">{webmailUrl}</a>
                    </div>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Mailboxes @{selected.domain}</h3>
                  {selected.dkim_public && <Badge kind="ok" dot>DKIM signed</Badge>}
                </div>
                <DataTable
                  rows={accounts}
                  keyOf={(a) => a.id}
                  empty={<EmptyState icon={AtSign} title="No mailboxes on this domain yet">Create the first mailbox — credentials are shown once at creation.</EmptyState>}
                  columns={[
                    { key: 'address', label: 'Address', render: (a) => <span className="domain-cell">{a.address}</span> },
                    { key: 'quota', label: 'Quota', num: true, render: (a) => <span className="num">{a.quota_mb} MB</span> },
                    { key: 'used', label: 'Used', num: true, render: (a) => <span className="num muted">{fmtBytes(a.used_bytes)}</span> },
                    { key: 'created', label: 'Created', num: true, render: (a) => <span className="muted" style={{ fontSize: 12 }}>{fmtDateShort(a.created_at)}</span> },
                    {
                      key: 'actions', label: '', className: 'actions',
                      render: (a) => (
                        <>
                          <button className="rowlink" onClick={() => resetPassword(a)}>Reset password</button>
                          <button className="rowlink danger" onClick={() => setConfirmDelete(a)}>Delete</button>
                        </>
                      )
                    }
                  ]}
                />
              </div>
            </>
          )}
        </>
      )}

      {showEnable && (
        <EnableMailModal
          onClose={() => setShowEnable(false)}
          onDone={async (domain) => {
            setShowEnable(false);
            toast.ok(`Mail enabled for ${domain} — DKIM keys generated, DNS records inserted`);
            await loadDomains();
          }}
        />
      )}

      {showAddMbox && selected && (
        <CreateMailboxModal
          domainId={selected.domain ? undefined : undefined}
          mailDomainId={selected.id || selected.domain_id}
          domainName={selected.domain}
          onClose={() => setShowAddMbox(false)}
          onCreated={(res) => {
            setShowAddMbox(false);
            setCreated(res);
            loadDomains();
            selectDomain(selected.id || selected.domain_id);
          }}
        />
      )}

      {created && (
        <Modal open title="Mailbox created" onClose={() => setCreated(null)}
          footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}>
          <p style={{ fontSize: 13.5, marginBottom: 12 }}>Save these credentials now — the password is not stored in a recoverable form.</p>
          <div className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>Address</dt><dd><Copyable text={created.address} /></dd>
            <dt>Password</dt><dd><Copyable text={created.password} /></dd>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete mailbox ${confirmDelete?.address}?`}
        body="The mailbox and all its mail on the server will be removed. This cannot be undone."
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/mail/domains/${selected.id || selected.domain_id}/accounts/${confirmDelete.id}`);
            toast.ok('Mailbox deleted');
            setConfirmDelete(null);
            selectDomain(selected.id || selected.domain_id);
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );

  async function resetPassword(a) {
    try {
      const res = await api.post(`/mail/domains/${selected.id || selected.domain_id}/accounts/${a.id}/reset-password`, {});
      if (res.new_password) setCreated({ address: a.address, password: res.new_password });
      else toast.ok('Password updated');
    } catch (e) { toast.error(e.message); }
  }
}

function EnableMailModal({ onClose, onDone }) {
  const toast = useToast();
  const [domains, setDomains] = useState(null);
  const [domainId, setDomainId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/domains').then((d) => {
      setDomains(d.domains);
      if (d.domains.length) setDomainId(String(d.domains[0].id));
    });
  }, []);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/mail/domains', { domain_id: Number(domainId) });
      const dom = domains.find((d) => String(d.id) === domainId);
      onDone(dom?.domain);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title="Enable email on a domain" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !domainId}>{busy ? 'Generating keys…' : 'Enable mail'}</button>
      </>}>
      {domains?.length ? (
        <>
          <Field label="Domain" hint="Generates a 2048-bit DKIM keypair and inserts MX, SPF, DMARC and DKIM records into the zone.">
            <select className="input" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}{d.mail_enabled ? ' (mail already enabled)' : ''}</option>)}
            </select>
          </Field>
          {error && <div className="callout warn">{error}</div>}
        </>
      ) : (
        <p style={{ color: 'var(--ink-2)' }}>Add a website first — email is enabled per domain.</p>
      )}
    </Modal>
  );
}

function CreateMailboxModal({ mailDomainId, domainName, onClose, onCreated }) {
  const [form, setForm] = useState({ local: '', password: '', quota_mb: 1024 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { local: form.local, quota_mb: Number(form.quota_mb) };
      if (form.password) body.password = form.password;
      const res = await api.post(`/mail/domains/${mailDomainId}/accounts`, body);
      onCreated({ address: res.address, password: res.initial_password || form.password });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={`Create mailbox @${domainName}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !form.local}>{busy ? 'Creating…' : 'Create mailbox'}</button>
      </>}>
      <form onSubmit={submit}>
        <Field label="Mailbox name">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input className="input mono" autoFocus placeholder="hello" value={form.local} onChange={(e) => set('local', e.target.value)} style={{ flex: 1 }} />
            <span className="mono" style={{ color: 'var(--ink-3)' }}>@{domainName}</span>
          </div>
        </Field>
        <div className="form-row">
          <Field label="Password" hint="Leave empty to auto-generate">
            <input className="input" type="text" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="auto-generate" />
          </Field>
          <Field label="Quota (MB)">
            <input className="input num" type="number" min="10" step="10" value={form.quota_mb} onChange={(e) => set('quota_mb', e.target.value)} />
          </Field>
        </div>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}
