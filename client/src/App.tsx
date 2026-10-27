import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Manager } from '../../shared/types';
import { useAuth } from './auth';
import { ErrorBanner, Loading } from './components/ui';
import AccountDetailPage from './pages/AccountDetailPage';
import AccountsPage from './pages/AccountsPage';
import AuditPage from './pages/AuditPage';
import LoginPage from './pages/LoginPage';
import ManagersPage from './pages/ManagersPage';
import PasswordPage from './pages/PasswordPage';
import PoliciesPage from './pages/PoliciesPage';
import RoleEditorPage from './pages/RoleEditorPage';
import RolesPage from './pages/RolesPage';

const NAV = [
  { to: '/accounts', label: 'Accounts', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6' },
  { to: '/roles', label: 'Roles', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { to: '/policies', label: 'Policy catalog', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4' },
  { to: '/audit', label: 'Audit log', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2' },
  { to: '/managers', label: 'Account managers', icon: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4' },
];

export default function App() {
  const { session, error } = useAuth();
  if (error) {
    return (
      <div className="auth-screen">
        <ErrorBanner message={`Could not reach the server: ${error}`} />
      </div>
    );
  }
  if (!session) return <Loading />;
  if (!session.manager) return <LoginPage needsSetup={session.needsSetup} />;
  // Re-mount everything when a different manager signs in so no data carries over.
  return <Shell key={session.manager.id} manager={session.manager} />;
}

function Shell({ manager }: { manager: Manager }) {
  const { signOut } = useAuth();
  const initials = manager.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <div>
            <div className="brand-name">Data Governance</div>
            <div className="brand-sub">Account manager console</div>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="nav-link">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.icon} />
              </svg>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="whoami">
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <div className="whoami-text">
              <div className="whoami-name">{manager.name}</div>
              <div className="whoami-email">{manager.email}</div>
            </div>
          </div>
          <div className="sidebar-footer-actions">
            <NavLink to="/password" className="link-button">
              Change password
            </NavLink>
            <button type="button" className="link-button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/accounts" replace />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/roles/new" element={<RoleEditorPage />} />
          <Route path="/roles/:id" element={<RoleEditorPage />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/managers" element={<ManagersPage />} />
          <Route path="/password" element={<PasswordPage />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Routes>
      </main>
    </div>
  );
}
