import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, DesktopBridge } from '../../../packages/core/contracts';

const bridge: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke('squiggly:get-snapshot'),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on('squiggly:snapshot', handler);
    return () => ipcRenderer.removeListener('squiggly:snapshot', handler);
  },
  command: command => ipcRenderer.invoke('squiggly:command', command),
  openFiles: () => ipcRenderer.invoke('squiggly:open-files'),
  connect: connection => ipcRenderer.invoke('squiggly:connect', connection),
  albums: offset => ipcRenderer.invoke('squiggly:albums', offset),
  playAlbum: id => ipcRenderer.invoke('squiggly:play-album', id),
  disconnect: () => ipcRenderer.invoke('squiggly:disconnect'),
  exportDiagnostics: () => ipcRenderer.invoke('squiggly:export-diagnostics'),
};
contextBridge.exposeInMainWorld('squiggly', bridge);
