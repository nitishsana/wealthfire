import { Link } from 'react-router-dom';
import { Card, Page } from '../ui';

const SOURCES = [
  { icon: '🏦', name: 'Bank accounts (Account Aggregator)', what: 'Pull balances and FDs with your consent.', needs: 'An RBI Account Aggregator partner (e.g. Setu, Finvu, OneMoney).' },
  { icon: '📊', name: 'Mutual funds (CAS)', what: 'Import all your mutual funds from CAMS / KFintech.', needs: 'CAS PDF upload or an MF Central link.' },
  { icon: '📈', name: 'Stocks (Zerodha, Groww, etc.)', what: 'Import stock holdings.', needs: 'Broker API keys or holdings file upload.' },
  { icon: '🧓', name: 'EPF / NPS', what: 'Track retirement balances.', needs: 'EPFO passbook / NPS statement upload.' },
];

export function ConnectPage() {
  return (
    <Page feature="connect" title="Connect apps" intro="Link your accounts for one full view. Gmail works now; the rest come next.">
      <div className="grid two">
        <Card title="📧 Gmail">
          <p>Connect your credit cards through Gmail. Spends land in Expenses.</p>
          <Link className="btn primary" to="/expenses">Connect in Expenses</Link>
        </Card>
        {SOURCES.map((s) => (
          <Card key={s.name} title={`${s.icon} ${s.name}`}>
            <p>{s.what}</p>
            <p className="muted small">Needs: {s.needs}</p>
            <button className="btn" disabled aria-disabled="true">Coming soon</button>
          </Card>
        ))}
      </div>
      <p className="muted">For now, add assets by hand in Net worth, and upload statements in Expenses.</p>
    </Page>
  );
}
