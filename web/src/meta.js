import { useEffect, useState } from 'react';
import { api } from './api.js';

// Server boot info (dev flag, port) — safe to fetch unauthenticated.
let cached = null;

export function useStatus() {
  const [status, setStatus] = useState(cached || { dev: false, port: 2083, version: '', name: 'G-Panel' });
  useEffect(() => {
    let alive = true;
    api.get('/auth/status').then((s) => {
      cached = s;
      if (alive) setStatus(s);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return status;
}
