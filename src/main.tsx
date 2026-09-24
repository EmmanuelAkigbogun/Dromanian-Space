import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initTypography } from '@/components/workspace/TypographySettings';
import { initColorPrefs } from '@/components/workspace/ColorSettings';
import { applyStartupTheme } from '@/lib/workspace/themeCache';
import './styles/global.css';
import App from './App';

initTypography();
initColorPrefs();
applyStartupTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
