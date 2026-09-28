// The Android app's page: the renderer (apps/desktop/renderer/src/main.tsx) with
// window.squigglyAndroid installed first. vite.config.ts points index.html here when building
// with --mode android.
import './install';
import '../../desktop/renderer/src/main';
import './posture.css';
import { followPosture, followRoomColour } from './system';

followRoomColour();
followPosture();
