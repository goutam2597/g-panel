import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../store.jsx';
import { DataTable, Badge, Modal, Field, SearchInput, EmptyState, ConfirmDialog, Copyable, RefreshButton } from '../components/ui.jsx';
import { Network } from 'lucide-react';

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

export default function Dns() {
  const toast = useToast();
  const [zones, setZones] = useState(null);
  const [selected, setSelected] = useState(null);
  const [records, setRecords] = useState(null);
  const [zonefile, setZonefile] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editRec, setEditRec] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [search, setSearch] = useState('');

  const loadZones = useCallback(async () => {
    const data = await api.get('/dns/zones');
    setZones(data.zones);
    if (!selected && data.zones.length) selectZone(data.zones[0].domain_id);
    else if (selected && !data.zones.some((z) => z.domain_id === selected.domain_id)) {
      data.zones.length ? selectZone(data.zones[0].domain_id) : setSelected(null);
    }
  }, [selected]);

  useEffect(() => { loadZones(); }, []); // eslint-disable-line

  const selectZone = async (domainId) => {
    const [recs, zf] = await Promise.all([
      api.get(`/dns/zones/${domainId}/records`),
      api.get(`/dns/zones/${domainId}/zonefile`)
    ]);
    setSelected({ domain: recs.zone.domain, domain_id: domainId, serial: recs.zone.serial });
    setRecords(recs.records);
    setZonefile(zf.text);
  };

  const reloadZone = async () => {
    if (!selected) return;
    await selectZone(selected.domain_id);
    toast.ok('Zone file refreshed');
  };

  if (!zones) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;

  const filtered = (records || []).filter((r) => !search || r.name.includes(search.toLowerCase()) || r.type.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>DNS</h1>
          <div className="sub">Authoritative zones served by BIND · records apply within seconds</div>
        </div>
        <div className="actions">
          <RefreshButton onClick={reloadZone} />
          {selected && <button className="btn primary" onClick={() => setShowAdd(true)}>Add record</button>}
        </div>
      </div>

      {zones.length === 0 ? (
        <div className="card"><EmptyState icon={Network} title="No DNS zones hosted">
          Zones are created automatically when you add a domain with "Host DNS zone" enabled.
        </EmptyState></div>
      ) : (
        <>
          <div className="tabs">
            {zones.map((z) => (
              <button key={z.domain_id} className={selected?.domain_id === z.domain_id ? 'active' : ''}
                onClick={() => selectZone(z.domain_id)}>
                {z.domain} <span style={{ color: 'var(--ink-4)', marginLeft: 4 }}>({z.record_count})</span>
              </button>
            ))}
          </div>

          <div className="toolbar">
            <div className="left"><SearchInput value={search} onChange={setSearch} placeholder="Filter records…" /></div>
            <div className="right">
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>serial {selected?.serial}</span>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <DataTable
              rows={filtered}
              keyOf={(r) => r.id}
              columns={[
                { key: 'name', label: 'Name', render: (r) => <span className="mono" style={{ fontSize: 12.5 }}>{r.name === '@' ? selected.domain : `${r.name}.${selected.domain}`}</span> },
                { key: 'type', label: 'Type', render: (r) => <span className="rec-type">{r.type}</span> },
                { key: 'value', label: 'Value', render: (r) => <span className="rec-value">{r.value}</span> },
                { key: 'prio', label: 'Prio', num: true, render: (r) => r.prio != null ? <span className="num">{r.prio}</span> : <span className="muted">—</span> },
                { key: 'ttl', label: 'TTL', num: true, render: (r) => <span className="num muted" style={{ fontSize: 12 }}>{r.ttl}s</span> },
                { key: 'flags', label: '', render: (r) => r.system ? <Badge kind="info">system</Badge> : null },
                {
                  key: 'actions', label: '', className: 'actions',
                  render: (r) => r.system
                    ? <span className="muted" style={{ fontSize: 11 }}>managed by panel</span>
                    : <>
                        <button className="rowlink" onClick={() => setEditRec(r)}>Edit</button>
                        <button className="rowlink danger" onClick={() => setConfirmDelete(r)}>Delete</button>
                      </>
                }
              ]}
            />
          </div>

          <div className="card">
            <div className="card-head"><h3>Zone file ({selected?.domain})</h3></div>
            <pre style={{ margin: 0, padding: 14, fontSize: 11.5, lineHeight: 1.65, fontFamily: 'var(--mono)', color: 'var(--ink-2)', overflowX: 'auto' }}>
              {zonefile}
            </pre>
          </div>
        </>
      )}

      {showAdd && selected && (
        <RecordModal
          domain={selected.domain}
          domainId={selected.domain_id}
          onClose={() => setShowAdd(false)}
          onDone={async () => { setShowAdd(false); toast.ok('Record added — zone pushed to BIND'); await selectZone(selected.domain_id); }}
        />
      )}
      {editRec && (
        <RecordModal
          domain={selected.domain}
          domainId={selected.domain_id}
          record={editRec}
          onClose={() => setEditRec(null)}
          onDone={async () => { setEditRec(null); toast.ok('Record updated'); await selectZone(selected.domain_id); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.type} record?`}
        body={`${confirmDelete?.name}.${selected?.domain} → ${confirmDelete?.value}`}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.del(`/dns/zones/${selected.domain_id}/records/${confirmDelete.id}`);
            toast.ok('Record deleted');
            setConfirmDelete(null);
            await selectZone(selected.domain_id);
          } catch (e) { toast.error(e.message); }
        }}
      />
    </div>
  );
}

function RecordModal({ domain, domainId, record, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    type: record?.type || 'A', name: record?.name || '@', value: record?.value || '',
    ttl: record?.ttl || 3600, prio: record?.prio ?? 10
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const needsPrio = form.type === 'MX' || form.type === 'SRV';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (record) await api.put(`/dns/zones/${domainId}/records/${record.id}`, form);
      else await api.post(`/dns/zones/${domainId}/records`, form);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open title={record ? `Edit ${record.type} record` : `Add record to ${domain}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save record'}</button>
      </>}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Type" style={{ maxWidth: 120 }}>
            <select className="input" value={form.type} onChange={(e) => set('type', e.target.value)} disabled={Boolean(record)}>
              {TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Name" hint="@ for the apex, e.g. www, mail">
            <input className="input mono" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          {needsPrio && (
            <Field label="Priority" style={{ maxWidth: 110 }}>
              <input className="input num" type="number" min="0" max="65535" value={form.prio} onChange={(e) => set('prio', Number(e.target.value))} />
            </Field>
          )}
        </div>
        <Field label="Value" hint={valueHint(form.type)}>
          <input className="input mono" value={form.value} onChange={(e) => set('value', e.target.value)} autoFocus />
        </Field>
        <Field label="TTL (seconds)">
          <input className="input num" type="number" min="60" max="604800" step="60" value={form.ttl} onChange={(e) => set('ttl', Number(e.target.value))} />
        </Field>
        {error && <div className="callout warn">{error}</div>}
      </form>
    </Modal>
  );
}

function valueHint(type) {
  switch (type) {
    case 'A': return 'IPv4 address, e.g. 203.0.113.10';
    case 'AAAA': return 'IPv6 address';
    case 'CNAME': return 'Target hostname, e.g. example.net';
    case 'MX': return 'Mail server hostname, e.g. mail.example.com';
    case 'TXT': return 'Free text, e.g. SPF policy';
    case 'NS': return 'Nameserver hostname';
    case 'SRV': return 'weight port target, e.g. "5 5060 sip.example.com"';
    case 'CAA': return 'e.g. 0 issue "letsencrypt.org"';
    default: return '';
  }
}
