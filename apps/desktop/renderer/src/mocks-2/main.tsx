import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Studies from './Studies';
import './studies.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Studies /></StrictMode>);
