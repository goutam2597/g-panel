import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, setCsrf, onUnauthorized } from './api.js';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

// ---------------- auth ----------------
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [impersonating, setImpersonating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setMe(data.user);
      setImpersonating(data.impersonating);
      setCsrf(data.csrf);
      return data;
    } catch {
      setMe(null);
      setImpersonating(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { onUnauthorized(() => { setMe(null); setImpersonating(false); }); }, []);

  const login = useCallback(async (username, password) => {
    const data = await api.post('/auth/login', { username, password });
    setMe(data.user);
    setImpersonating(false);
    setCsrf(data.csrf);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* session may be gone */ }
    setMe(null);
    setImpersonating(false);
  }, []);

  return (
    <AuthCtx.Provider value={{ me, loading, impersonating, login, logout, refresh, setMe }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() { return useContext(AuthCtx); }

// ---------------- toasts ----------------
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((message, kind = 'ok') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);

  const ok = useCallback((m) => push(m, 'ok'), [push]);
  const error = useCallback((m) => push(m, 'error'), [push]);

  return (
    <ToastCtx.Provider value={{ ok, error }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok'
              ? <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1, color: '#5CB98A' }} />
              : <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1, color: '#D4685F' }} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() { return useContext(ToastCtx); }
