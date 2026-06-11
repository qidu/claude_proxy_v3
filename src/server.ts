/**
 * Node.js HTTP server adapter for running in containers
 * Wraps the Workers fetch handler with a native HTTP server
 */

import { createServer } from 'http';
import type { Env } from './types/shared.js';
import { loadProxyConfig, clearProxyConfigCache } from './utils/config-loader.js';
import { startTUI } from './tui.js';

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
  PORT: process.env.PORT || '8788',
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

    // Handle streaming vs non-streaming responses differently.
    // For streaming, tee the stream so we can pipe one branch to the client
    // while leaving the other available for reading (e.g. .text()).
    // For non-streaming, read the full body and write all at once.
    const contentType = response.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming && response.body) {
      // For streaming responses (text/event-stream), pipe directly to the Node.js
      // response without consuming the body via .text(), which avoids the
      // "headers already sent" error when the stream body was already locked.
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const { PassThrough } = await import('stream');
      const passthrough = new PassThrough();
      passthrough.pipe(res);
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          passthrough.write(chunk);
        },
        close() {
          passthrough.end();
        },
        abort(err) {
          passthrough.end();
        },
      })).catch(() => {
        passthrough.end();
      });
      return;
    }

    const responseBody = await response.clone().text();
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(responseBody);
  } catch (error) {
    console.error('Server error:', error);
    // Only write headers if they haven't been sent yet
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

let stopTui: (() => void) | undefined;

server.listen(port, '0.0.0.0', async () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
  console.log(` and dashboard at http://0.0.0.0:${port}/dashboard`);

  const tuiEnabled = process.env.TUI === 'true' || process.env.TUI === '1';
  if (tuiEnabled && process.stdin.isTTY && process.stdout.isTTY) {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.debug = () => {};

    stopTui = startTUI({
      env,
      loadConfig: async (forceReload?: boolean) => {
        if (forceReload) clearProxyConfigCache();
        return loadProxyConfig(env);
      },
      readOnly: !!env.PROXY_CONFIG_URL,
    });
  } else {
    // Non-TUI mode: eagerly load config to validate and show errors in console
    loadProxyConfig(env).catch((err) => {
      console.error('Failed to load config at startup:', (err as Error).message);
    });
  }
});

process.on('SIGINT', () => {
  stopTui?.();
  server.close(() => process.exit(0));
});
