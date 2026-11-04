import { useCallback, useEffect, useRef, useState } from 'react';
import { api, download as downloadFile, fmtBytes, fmtDate } from '../api.js';
import { useToast } from '../store.jsx';
import { Modal, Field, EmptyState, Breadcrumbs, ConfirmDialog, fileIcon } from '../components/ui.jsx';
import { FolderOpen, Upload, FolderPlus, Save, Download, Pencil, Trash2, Archive, KeyRound, ChevronRight } from 'lucide-react';

export default function Files() {
  const toast = useToast();
  const [roots, setRoots] = useState(null);
  const [root, setRoot] = useState(null);
  const [cwd, setCwd] = useState(null);
  const [entries, setEntries] = useState(null);
  const [editing, setEditing] = useState(null);   // {path, content}
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showMkdir, setShowMkdir] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef(null);

  useEffect(() => {
    api.get('/files/roots').then((d) => {
      setRoots(d.roots);
      if (d.roots.length) {
        setRoot(d.roots[0].path);
        setCwd(d.roots[0].path);
      }
    });
  }, []);

  const load = useCallback(async (path) => {
    try {
      const d = await api.get(`/files/list?path=${encodeURIComponent(path)}`);
      setEntries(d.entries);
      setCwd(d.path);
    } catch (e) { toast.error(e.message); }
  }, [toast]);

  useEffect(() => { if (cwd) load(cwd); }, [cwd, load]);

  if (!roots) return <div className="page"><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div></div>;
  if (!roots.length) return <div className="page"><div className="card"><EmptyState icon={FolderOpen} title="No directories to browse">Add a website first — its public_html appears here.</EmptyState></div></div>;

  const crumbs = buildCrumbs(cwd || '/', (p) => setCwd(p));

  const openFile = async (entry) => {
    try {
      const d = await api.get(`/files/read?path=${encodeURIComponent(entry.path)}`);
      setEditing({ path: entry.path, content: d.content, original: d.content });
    } catch (e) { toast.error(e.message); }
  };

  const saveFile = async () => {
    setBusy(true);
    try {
      await api.put('/files/write', { path: editing.path, content: editing.content });
      toast.ok('File saved');
      setEditing(null);
      load(cwd);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.post('/files/delete', { path: confirmDelete.path });
      toast.ok(`Deleted ${confirmDelete.name}`);
      setConfirmDelete(null);
      load(cwd);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const doMkdir = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/files/mkdir', { path: joinPath(cwd, mkdirName) });
      toast.ok('Directory created');
      setShowMkdir(false);
      setMkdirName('');
      load(cwd);
    } catch (e2) { toast.error(e2.message); } finally { setBusy(false); }
  };

  const doRename = async (entry) => {
    const newName = window.prompt('New name:', entry.name);
    if (!newName || newName === entry.name) return;
    try {
      await api.post('/files/rename', { from: entry.path, to: joinPath(cwd, newName) });
      toast.ok('Renamed');
      load(cwd);
    } catch (e) { toast.error(e.message); }
  };

  const doChmod = async (entry) => {
    const mode = window.prompt('Permissions (octal):', entry.mode);
    if (!mode) return;
    try {
      await api.post('/files/chmod', { path: entry.path, mode });
      toast.ok('Permissions updated');
      load(cwd);
    } catch (e) { toast.error(e.message); }
  };

  const doExtract = async (entry) => {
    try {
      await api.post('/files/extract', { archive: entry.path, dest: cwd });
      toast.ok('Archive extracted');
      load(cwd);
    } catch (e) { toast.error(e.message); }
  };

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try {
      await api.upload(`/files/upload?path=${encodeURIComponent(cwd)}`, fd);
      toast.ok(`Uploaded ${file.name}`);
      load(cwd);
    } catch (e2) { toast.error(e2.message); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Files</h1>
          <div className="sub">Web-based file manager · edits save directly to disk</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => uploadRef.current?.click()} disabled={busy}>
            <Upload size={14} /> Upload
          </button>
          <button className="btn" onClick={() => setShowMkdir(true)}>
            <FolderPlus size={14} /> New folder
          </button>
          <input ref={uploadRef} type="file" style={{ display: 'none' }} onChange={onUpload} />
        </div>
      </div>

      <div className="fm-layout">
        <div className="card" style={{ padding: 8 }}>
          <div className="label" style={{ padding: '6px 9px 8px' }}>Locations</div>
          <div className="fm-roots">
            {roots.map((r) => (
              <button key={r.path}
                className={`fm-root-btn ${root === r.path ? 'active' : ''}`}
                onClick={() => { setRoot(r.path); setCwd(r.path); }}
                title={r.path}>
                <FolderOpen size={13} style={{ flexShrink: 0 }} />
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Breadcrumbs items={crumbs} />
          </div>
          {entries === null ? <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><div className="spinner" /></div> : entries.length === 0 ? (
            <EmptyState icon={FolderOpen} title="Empty directory">Upload files or create a folder to get started.</EmptyState>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Size</th>
                    <th>Perms</th>
                    <th>Modified</th>
                    <th className="num" style={{ paddingRight: 14 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const { Icon, cls } = fileIcon(entry);
                    return (
                      <tr key={entry.name}>
                        <td>
                          <span className="fm-file-name">
                            <Icon size={14} className={cls} />
                            {entry.type === 'dir'
                              ? <button onClick={() => setCwd(entry.path)}>{entry.name}</button>
                              : <button onClick={() => openFile(entry)}>{entry.name}</button>}
                          </span>
                        </td>
                        <td className="num muted" style={{ fontSize: 12 }}>{entry.type === 'dir' ? '—' : fmtBytes(entry.size)}</td>
                        <td><span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{entry.mode}</span></td>
                        <td className="muted" style={{ fontSize: 12 }}>{fmtDate(entry.mtime)}</td>
                        <td className="actions">
                          {entry.type === 'file' && (
                            <>
                              <button className="rowlink" onClick={() => openFile(entry)}><Pencil size={11} style={{ verticalAlign: -1 }} /> Edit</button>
                              <button className="rowlink" onClick={() => downloadFile(`/files/download?path=${encodeURIComponent(entry.path)}`, entry.name)}>Save</button>
                              {/\.(zip|tar|tar\.gz|tgz)$/i.test(entry.name) && (
                                <button className="rowlink" onClick={() => doExtract(entry)}>Extract</button>
                              )}
                            </>
                          )}
                          <button className="rowlink" onClick={() => doRename(entry)}>Rename</button>
                          <button className="rowlink" onClick={() => doChmod(entry)}>Perms</button>
                          <button className="rowlink danger" onClick={() => setConfirmDelete(entry)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="card editor-pane" style={{ marginTop: 14 }}>
          <div className="editor-head">
            <span className="path">{editing.path}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm" onClick={() => setEditing(null)}>Close</button>
              <button className="btn sm primary" onClick={saveFile} disabled={busy || editing.content === editing.original}>
                <Save size={12} /> Save
              </button>
            </div>
          </div>
          <div className="editor-body">
            <textarea
              value={editing.content}
              onChange={(e) => setEditing((ed) => ({ ...ed, content: e.target.value }))}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const el = e.target;
                  const { selectionStart: s, selectionEnd: en, value } = el;
                  const next = value.slice(0, s) + '  ' + value.slice(en);
                  setEditing((ed) => ({ ...ed, content: next }));
                  requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
              }}
            />
          </div>
        </div>
      )}

      <Modal open={showMkdir} title="New folder" onClose={() => setShowMkdir(false)}
        footer={<>
          <button className="btn" onClick={() => setShowMkdir(false)}>Cancel</button>
          <button className="btn primary" onClick={doMkdir} disabled={!mkdirName}>Create</button>
        </>}>
        <form onSubmit={doMkdir}>
          <Field label="Folder name">
            <input className="input mono" autoFocus value={mkdirName} onChange={(e) => setMkdirName(e.target.value)} />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={`Delete ${confirmDelete?.type === 'dir' ? 'folder' : 'file'} ${confirmDelete?.name}?`}
        body={confirmDelete?.type === 'dir' ? 'The folder and everything inside it will be removed.' : 'This cannot be undone.'}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}

function buildCrumbs(path, navigate) {
  const parts = path.split('/').filter(Boolean);
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    out.push({ label: p, path: acc });
  }
  return out.map((it, i) => ({
    label: it.label,
    onClick: i < out.length - 1 ? () => navigate(it.path) : undefined
  }));
}

function joinPath(dir, name) {
  return dir === '/' ? '/' + name : `${dir}/${name}`;
}
