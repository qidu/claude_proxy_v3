/**
 * Node.js HTTP server adapter for running in containers
 * Wraps the Workers fetch handler with a native HTTP server
 */

import { createServer } from 'http';
import type { Env } from './types/shared.js';

const port = parseInt(process.env.PORT || '8788', 10);

// Import the Workers fetch handler
import handler from './index.js';

// Extend Env interface for Node.js environment
interface NodeEnv extends Env {
  NODE_ENV: string;
}

const env: NodeEnv = {
  NODE_ENV: process.env.NODE_ENV || 'production',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  LOCAL_TOKEN_COUNTING: process.env.LOCAL_TOKEN_COUNTING || 'false',
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,api.qnaigc.com',
  IMAGE_BLOCK_DATA_MAX_SIZE: process.env.IMAGE_BLOCK_DATA_MAX_SIZE || '10485760',
  FIXED_ROUTE_TARGET_URL: process.env.FIXED_ROUTE_TARGET_URL || 'https://api.qnaigc.com',
  FIXED_ROUTE_PATH_PREFIX: process.env.FIXED_ROUTE_PATH_PREFIX || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    const bodyStream = ['GET', 'HEAD'].includes(req.method || '')
      ? undefined
      : new ReadableStream({
          start(controller) {
            req.on('data', (chunk) => controller.enqueue(chunk));
            req.on('end', () => controller.close());
            req.on('error', (err) => controller.error(err));
          },
        });

    const requestInit: any = {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: bodyStream,
    };
    if (bodyStream) {
      requestInit.duplex = 'half';
    }
    const request = new Request(url.toString(), requestInit);

    const response = await handler.fetch(request, env);

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(await response.text());
  } catch (error) {
    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
