import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PlatformShell from './components/PlatformShell.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PlatformShell>
      <App />
    </PlatformShell>
  </React.StrictMode>
);
