import { createContext, useContext } from 'react';

export const TABS = [
  { key: 'home', label: 'Home', icon: '🏠' },
  { key: 'profile', label: 'Profile', icon: '👤' },
  { key: 'risk', label: 'Risk', icon: '🎯' },
  { key: 'networth', label: 'Net worth', icon: '💼' },
  { key: 'expenses', label: 'Expenses', icon: '🧾' },
  { key: 'gmail', label: 'Gmail', icon: '📧' },
  { key: 'fire', label: 'FIRE', icon: '🔥' },
  { key: 'portfolio', label: 'Portfolio', icon: '📊' },
  { key: 'buckets', label: 'Buckets', icon: '🪣' },
  { key: 'progress', label: 'Progress', icon: '📈' },
  { key: 'connect', label: 'Connect', icon: '🔗' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
] as const;

export type TabKey = (typeof TABS)[number]['key'];

export const NavCtx = createContext<(t: TabKey) => void>(() => {});
export const useNav = () => useContext(NavCtx);
