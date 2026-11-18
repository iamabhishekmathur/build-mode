import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { StagecraftRoot } from '@stagecraft/react';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <StagecraftRoot>
        <App />
      </StagecraftRoot>
    </BrowserRouter>
  </StrictMode>,
);
