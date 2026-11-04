import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, ToastProvider, useAuth } from './store.jsx';
import Layout from './components/Layout.jsx';
import { PageLoading } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Websites from './pages/Websites.jsx';
import Dns from './pages/Dns.jsx';
import Mail from './pages/Mail.jsx';
import Ftp from './pages/Ftp.jsx';
import Databases from './pages/Databases.jsx';
import Apps from './pages/Apps.jsx';
import Cron from './pages/Cron.jsx';
import Ssl from './pages/Ssl.jsx';
import Files from './pages/Files.jsx';
import SshKeys from './pages/SshKeys.jsx';
import Terminal from './pages/Terminal.jsx';
import Backups from './pages/Backups.jsx';
import Firewall from './pages/Firewall.jsx';
import Cloudflare from './pages/Cloudflare.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import AdminPackages from './pages/AdminPackages.jsx';
import AdminSettings from './pages/AdminSettings.jsx';
import AuditLog from './pages/AuditLog.jsx';

function Protected({ children, admin = false }) {
  const { me, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (!me) return <Navigate to="/login" replace />;
  if (admin && me.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function GuestOnly({ children }) {
  const { me, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (me) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
            <Route element={<Protected><Layout /></Protected>}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/websites" element={<Websites />} />
              <Route path="/dns" element={<Dns />} />
              <Route path="/mail" element={<Mail />} />
              <Route path="/databases" element={<Databases />} />
              <Route path="/apps" element={<Apps />} />
              <Route path="/ftp" element={<Ftp />} />
              <Route path="/ssl" element={<Ssl />} />
              <Route path="/files" element={<Files />} />
              <Route path="/ssh" element={<SshKeys />} />
              <Route path="/terminal" element={<Terminal />} />
              <Route path="/cron" element={<Cron />} />
              <Route path="/backups" element={<Backups />} />
              <Route path="/cloudflare" element={<Protected><Cloudflare /></Protected>} />
              <Route path="/firewall" element={<Protected admin><Firewall /></Protected>} />
              <Route path="/admin/users" element={<Protected admin><AdminUsers /></Protected>} />
              <Route path="/admin/packages" element={<Protected admin><AdminPackages /></Protected>} />
              <Route path="/admin/settings" element={<Protected admin><AdminSettings /></Protected>} />
              <Route path="/admin/audit" element={<Protected admin><AuditLog /></Protected>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
