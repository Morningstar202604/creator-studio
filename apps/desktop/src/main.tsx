import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootTheme } from './lib/theme';
import './styles/tokens.css';
import './styles/base.css';

bootTheme();

const container = document.getElementById('root');
if (container === null) throw new Error('#root missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
