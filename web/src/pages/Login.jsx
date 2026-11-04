import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useToast } from '../store.jsx';
import { Logo } from '../components/Layout.jsx';
import { useStatus } from '../meta.js';

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const status = useStatus();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      toast.ok(`Welcome back, ${username}`);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <Logo size={34} />
          <div className="brand-name">G-Panel</div>
        </div>
        {error && <div className="login-error">{error}</div>}
        <div className="field">
          <label htmlFor="lg-user">Username</label>
          <input id="lg-user" className="input" autoFocus autoComplete="username"
            value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lg-pass">Password</label>
          <input id="lg-pass" className="input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="login-foot">
          {status.dev ? 'Development build — services simulated' : 'Web hosting control panel'}
          <br />Port {status.port} · HTTPS enforced on production servers
        </div>
      </form>
    </div>
  );
}
