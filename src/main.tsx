import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/push.ts';
import { applyTheme } from './lib/theme.ts';

applyTheme(); // before the first paint, so dark mode never flashes light
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
