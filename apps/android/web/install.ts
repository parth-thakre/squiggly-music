import { androidBridge } from './bridge';

// Its own module, imported first by main.ts: the renderer's modules read window.squigglyAndroid
// as they load, the way they read the desktop's window.squiggly.
window.squigglyAndroid = androidBridge;
