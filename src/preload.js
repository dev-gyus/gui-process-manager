/**
 * Preload Script - Secure Bridge between Main and Renderer Process
 *
 * Note: This repo uses `"type": "module"` so preload must be ESM (no `require`).
 */

import { contextBridge, ipcRenderer } from 'electron';

// Whitelist of allowed IPC channels
const VALID_CHANNELS = {
  invoke: [
    'get-servers',
    'start-all',
    'stop-all',
    'select-folder',
    'save-dynamic-config',
    'save-node-paths',
    'delete-server',
    'start-server',
    'stop-server',
    'restart-server',
    'open-browser',
    'open-terminal',
    'get-logs',
    'get-dynamic-config',
    'get-node-paths',
    'get-presets',
    'save-preset',
    'delete-preset',
    'add-manual-server',
    'clear-all-servers',
    'detect-node-paths',
    'update-server',
  ],
  send: [
    'hide-window',
    'window-content-changed'
  ],
  on: [
    'server-status-changed',
    'log-update',
    'navigate',
    'ready',
    'show',
  ]
};

// Expose safe API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Invoke IPC methods (async request-response)
   */
  invoke: (channel, ...args) => {
    if (!VALID_CHANNELS.invoke.includes(channel)) {
      throw new Error(`Invalid IPC channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /**
   * Send IPC messages (one-way)
   */
  send: (channel, ...args) => {
    if (!VALID_CHANNELS.send.includes(channel)) {
      throw new Error(`Invalid IPC channel: ${channel}`);
    }
    ipcRenderer.send(channel, ...args);
  },

  /**
   * Listen to IPC events
   */
  on: (channel, callback) => {
    if (!VALID_CHANNELS.on.includes(channel)) {
      throw new Error(`Invalid IPC channel: ${channel}`);
    }

    // Wrap callback to prevent context leaks
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  }
});
