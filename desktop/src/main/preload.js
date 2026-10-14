'use strict';
// 렌더러에 노출하는 안전한 API (contextIsolation + contextBridge)

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('codeai', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial)
  },
  preview: {
    base: () => ipcRenderer.invoke('preview:base')
  },
  project: {
    current: () => ipcRenderer.invoke('project:current'),
    open: () => ipcRenderer.invoke('project:open'),
    close: () => ipcRenderer.invoke('project:close'),
    chooseDir: () => ipcRenderer.invoke('project:chooseDir'),
    defaultDir: () => ipcRenderer.invoke('project:defaultDir'),
    create: (opts) => ipcRenderer.invoke('project:create', opts)
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list')
  },
  fs: {
    tree: () => ipcRenderer.invoke('fs:tree'),
    read: (rel) => ipcRenderer.invoke('fs:read', rel),
    write: (rel, content) => ipcRenderer.invoke('fs:write', rel, content),
    createFile: (rel) => ipcRenderer.invoke('fs:createFile', rel),
    createFolder: (rel) => ipcRenderer.invoke('fs:createFolder', rel),
    remove: (rel) => ipcRenderer.invoke('fs:delete', rel),
    exists: (rel) => ipcRenderer.invoke('fs:exists', rel),
    onChanged: (cb) => on('fs:changed', cb)
  },
  chat: {
    send: (id, payload) => ipcRenderer.invoke('chat:send', id, payload),
    abort: (id) => ipcRenderer.invoke('chat:abort', id),
    onEvent: (cb) => on('chat:event', cb)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    restore: (id) => ipcRenderer.invoke('history:restore', id)
  },
  deploy: () => ipcRenderer.invoke('deploy'),
  server: {
    health: () => ipcRenderer.invoke('server:health')
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check')
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItem: (rel) => ipcRenderer.invoke('shell:showItem', rel)
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text)
  },
  onMenu: (cb) => on('menu', cb),
  onThemeUpdated: (cb) => on('theme:updated', cb)
});
