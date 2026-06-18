/**
 * Electron preload script.
 *
 * Runs in a sandboxed context (contextIsolation: true, nodeIntegration: false).
 * Use contextBridge.exposeInMainWorld() here to expose safe IPC APIs to the
 * renderer when needed.
 *
 * Currently a placeholder — the SPA communicates with the local Express server
 * directly over HTTP/WebSocket, so no IPC bridging is needed yet.
 */

// No-op preload. Add contextBridge.exposeInMainWorld() calls here as needed.
