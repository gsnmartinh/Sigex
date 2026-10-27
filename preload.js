'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (name, ...args) => ipcRenderer.invoke('rpc', name, args).catch(err => {
    // Electron antepone "Error invoking remote method..." al mensaje; se deja solo el texto útil.
    const msg = String(err && err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    throw new Error(msg);
  }),
  pathForFile: file => webUtils.getPathForFile(file),
  onStartup: cb => ipcRenderer.on('startup', (_e, data) => cb(data)),
  onGoto: cb => ipcRenderer.on('goto', (_e, view) => cb(view))
});
