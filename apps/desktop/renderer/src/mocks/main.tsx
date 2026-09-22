import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Mockups from './Mockups';
import './mocks.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Mockups /></StrictMode>);
