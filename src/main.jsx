import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import SchematicConverter from './components/SchematicConverter.jsx';
import PlatformShell from './components/PlatformShell.jsx';
import PreviewAccess from './components/PreviewAccess.jsx';
import './styles.css';

const params = new URLSearchParams(location.search);
const mode = (params.get('mode') || 'library').toLowerCase();
const Workspace = mode === 'schematic' ? SchematicConverter : App;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PreviewAccess><PlatformShell>
      <Workspace />
    </PlatformShell></PreviewAccess>
  </React.StrictMode>
);
