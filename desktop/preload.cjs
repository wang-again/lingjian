const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lingjianDesktop', {
  savePdf: (name, language) => ipcRenderer.invoke('desktop:save-pdf', name, language),
  showEditorMenu: (hasSelection, canRewrite, language) => ipcRenderer.invoke('desktop:editor-menu', hasSelection, canRewrite, language),
});
