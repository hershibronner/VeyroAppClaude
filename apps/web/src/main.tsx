import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './styles.css';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './lib/toast';
import { ConfirmProvider } from './components/ui';

// After a deploy, an open tab still points at the old chunk names. Reload once to pick up the new build.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('veyro:chunk-reload') || 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('veyro:chunk-reload', String(Date.now()));
  } catch { /* storage blocked: still reload */ }
  e.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
