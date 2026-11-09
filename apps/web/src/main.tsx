import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { pathToHashRoute } from '@wealthfire/core';
import { App, ROUTE_NAMES } from './App';
import { DataProvider } from './store';
import './styles.css';

// A path link (/profile?preview=demo) opens that section: switch to the hash route, no reload.
const hashUrl = pathToHashRoute(window.location, import.meta.env.BASE_URL, ROUTE_NAMES);
if (hashUrl) window.history.replaceState(window.history.state, '', hashUrl);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter so deep links work on GitHub Pages without a server */}
    <HashRouter>
      <DataProvider>
        <App />
      </DataProvider>
    </HashRouter>
  </StrictMode>,
);
