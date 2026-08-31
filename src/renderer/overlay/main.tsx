import React from 'react';
import { createRoot } from 'react-dom/client';
import { Overlay } from './Overlay';
import '../tailwind.css';
import './overlay.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);
