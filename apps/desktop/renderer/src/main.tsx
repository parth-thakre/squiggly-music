import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/young-serif/400.css';
import '@fontsource-variable/familjen-grotesk/index.css';
import './app/app.css';
import './app/shell.css';
import { App } from './app/App';
import { Mini } from './app/Mini';
import { startExtensions } from './app/extensions';

// The desktop mini player is a second window running the same renderer.
const mini = window.squiggly?.window.isMini === true;
// Extensions run in the main window only.
if (!mini) startExtensions();
createRoot(document.getElementById('root')!).render(<StrictMode>{mini ? <Mini /> : <App />}</StrictMode>);
