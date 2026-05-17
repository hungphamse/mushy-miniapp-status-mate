import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/theme.css';   // Mushy default design system — auto-load
import App from './App.jsx';
import { DialogProvider } from './components/Dialog.jsx';

createRoot(document.getElementById('root')).render(
  <DialogProvider>
    <App />
  </DialogProvider>
);
