import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { ProfilePage } from './pages/Profile';
import { RiskPage } from './pages/Risk';
import { NetWorthPage } from './pages/NetWorth';
import { ExpensesPage } from './pages/Expenses';
import { FirePage } from './pages/Fire';
import { PortfolioPage } from './pages/Portfolio';
import { BucketsPage } from './pages/Buckets';
import { ProgressPage } from './pages/Progress';
import { ConnectPage } from './pages/Connect';
import { SettingsPage } from './pages/Settings';
import { OnboardingPage } from './pages/Onboarding';
import { useStore } from './store';
import { Disclaimer } from './ui';

const NAV = [
  { to: '/', label: 'Home', icon: '🏠' },
  { to: '/profile', label: 'Profile', icon: '👤' },
  { to: '/risk', label: 'Risk', icon: '🎯' },
  { to: '/networth', label: 'Net worth', icon: '💼' },
  { to: '/expenses', label: 'Expenses', icon: '🧾' },
  { to: '/fire', label: 'FIRE plan', icon: '🔥' },
  { to: '/portfolio', label: 'Portfolio', icon: '📊' },
  { to: '/buckets', label: 'Buckets', icon: '🪣' },
  { to: '/progress', label: 'Progress', icon: '📈' },
  { to: '/connect', label: 'Connect', icon: '🔗' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

export function App() {
  const { data } = useStore();
  const navigate = useNavigate();
  // Keeps the onboarding page up for the "You're all set" screen after the Aadhaar OTP passes.
  const [finishing, setFinishing] = useState(false);
  if (data.onboarding.step !== 'done' || finishing) {
    return <OnboardingPage onCompleting={() => setFinishing(true)} onFinish={() => { setFinishing(false); navigate('/'); }} />;
  }
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span aria-hidden="true">🔥</span> Wealthfire
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'nav active' : 'nav')}>
              <span aria-hidden="true">{n.icon}</span> {n.label}
            </NavLink>
          ))}
        </nav>
        <p className="privacy">🔒 Your data stays in this browser.</p>
      </aside>
      <main id="main" className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/risk" element={<RiskPage />} />
          <Route path="/networth" element={<NetWorthPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/gmail" element={<Navigate to="/expenses" replace />} />
          <Route path="/fire" element={<FirePage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/buckets" element={<BucketsPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Disclaimer />
      </main>
    </div>
  );
}
