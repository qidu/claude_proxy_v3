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
  VERSION: process.env.VERSION || 'dev',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  LOCAL_TIKTOKEN: process.env.LOCAL_TIKTOKEN || 'false',
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,api.qnaigc.com',
  IMAGE_BLOCK_DATA_MAX_SIZE: process.env.IMAGE_BLOCK_DATA_MAX_SIZE || '10485760',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  GEMINI_API_VERSION: process.env.GEMINI_API_VERSION || 'v1beta',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  CLAUDE_BASE_URL: process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
  MESSAGES_UPSTREAM_MODE: (process.env.MESSAGES_UPSTREAM_MODE as 'native' | 'openai-completions') || 'openai-completions',
  INTERACTIONS_UPSTREAM_MODE: (process.env.INTERACTIONS_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
  GENERATE_CONTENT_UPSTREAM_MODE: (process.env.GENERATE_CONTENT_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
  PROXY_CONFIG_PATH: process.env.PROXY_CONFIG_PATH || './proxy_config.toml',
  PROXY_CONFIG_URL: process.env.PROXY_CONFIG_URL,
  DEV_PASS_THROUGH: process.env.DEV_PASS_THROUGH || 'false',
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

    // Get client connection info from Node.js socket
    const clientAddress = req.socket.remoteAddress || 'unknown';
    const clientPort = req.socket.remotePort?.toString() || 'unknown';
    
    // Create headers with client info
    const headers = { ...req.headers } as Record<string, string>;
    headers['x-client-address'] = clientAddress;
    headers['x-client-port'] = clientPort;

    const requestInit: any = {
      method: req.method,
      headers,
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
  console.log(` and dashboard at http://0.0.0.0:${port}/dashboard`);
});
