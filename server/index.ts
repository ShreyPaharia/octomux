import { createServer } from 'http';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createApp();
const server = createServer(app);
const PORT = process.env.PORT || 7777;

// Serve SPA in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`octomux-agents running at http://localhost:${PORT}`);
});

export { server, app };
