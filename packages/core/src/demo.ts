import type { AppData, Expense } from './types';
import { emptyData } from './store';
import { categorize } from './expenses';

/** A sample user so every platform can show the full app in one tap. */
export function demoData(today = new Date()): AppData {
  const d = emptyData();
  d.profile = {
    name: 'Demo User',
    age: 32,
    city: 'Hyderabad',
    monthlyIncome: 220000,
    dependents: 2,
    targetRetireAge: 45,
    lifeExpectancy: 85,
    currentMonthlySip: 50000,
  };
  d.riskAnswers = { horizon: 4, drop: 2, income_stability: 3, emergency: 2, experience: 3, goal: 3 };
  d.assets = [
    { id: 'a1', name: 'Equity mutual funds', type: 'equity_mf', value: 1850000, source: 'demo' },
    { id: 'a2', name: 'Direct stocks', type: 'stocks', value: 420000, source: 'demo' },
    { id: 'a3', name: 'EPF', type: 'epf', value: 980000, source: 'demo' },
    { id: 'a4', name: 'PPF', type: 'ppf', value: 310000, source: 'demo' },
    { id: 'a5', name: 'Bank FD', type: 'fd', value: 250000, source: 'demo' },
    { id: 'a6', name: 'Savings account', type: 'cash', value: 380000, source: 'demo' },
    { id: 'a7', name: 'Sovereign gold bonds', type: 'gold', value: 160000, source: 'demo' },
    { id: 'a8', name: 'Flat (self-occupied)', type: 'real_estate', value: 7500000, source: 'demo' },
  ];
  d.liabilities = [
    { id: 'l1', name: 'Home loan', type: 'home_loan', outstanding: 4200000, monthlyEmi: 38000, interestRate: 8.5 },
    { id: 'l2', name: 'Car loan', type: 'car_loan', outstanding: 350000, monthlyEmi: 12500, interestRate: 9.2 },
  ];
  const lines: [number, string, number][] = [
    [3, 'SWIGGY HYDERABAD', 640], [4, 'BIGBASKET', 3850], [5, 'UBER INDIA', 420], [6, 'AMAZON PAY INDIA', 2499],
    [8, 'NETFLIX.COM', 649], [9, 'HPCL PETROL PUMP', 3000], [11, 'ZOMATO', 890], [12, 'AIRTEL POSTPAID', 1199],
    [14, 'APOLLO PHARMACY', 760], [15, 'TSSPDCL ELECTRICITY', 2400], [17, 'MYNTRA', 3200], [18, 'BLINKIT', 1450],
    [20, 'BOOKMYSHOW', 1100], [22, 'DMART', 4200], [24, 'RAPIDO', 180], [25, 'HOUSE RENT VIA NOBROKER', 0],
    [26, 'SCHOOL FEES', 12000], [27, 'STARBUCKS', 520],
  ];
  const expenses: Expense[] = [];
  for (let back = 3; back >= 1; back--) {
    const m = new Date(today.getFullYear(), today.getMonth() - back, 1);
    for (const [day, desc, amt] of lines) {
      if (amt === 0) continue;
      const date = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const amount = Math.round(amt * (0.9 + ((day * back) % 7) / 30));
      expenses.push({ id: `e${back}_${day}`, date, description: desc, amount, category: categorize(desc), source: 'demo' });
    }
    // Household cash spends not on the card
    const date = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-28`;
    expenses.push({ id: `e${back}_hh`, date, description: 'Household help, milk, misc', amount: 22000, category: 'Other', source: 'demo' });
  }
  d.expenses = expenses;
  // Two check-ins so the progress screen has something to show.
  const s1 = new Date(today.getFullYear(), today.getMonth() - 6, 1);
  const s2 = new Date(today.getFullYear(), today.getMonth() - 3, 1);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`;
  d.snapshots = [
    { date: iso(s1), investable: 3650000, netWorth: 6550000, fireNumber: 26500000, monthlySip: 45000 },
    { date: iso(s2), investable: 4000000, netWorth: 6950000, fireNumber: 26800000, monthlySip: 50000 },
  ];
  return d;
}
