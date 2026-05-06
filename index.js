#!/usr/bin/env node

/**
 * iCloud MCP Server with ScaleKit OAuth 2.1
 */

require('dotenv').config();           // ← ADD THIS
const readline = require('readline');
const config = require('./config');

// Import auth module
const { authTools } = require('./auth');

// === ScaleKit Setup (NEW) ===
const { Scalekit } = require('@scalekit-sdk/node');

const scalekit = new Scalekit(
  process.env.SCALEKIT_ENVIRONMENT_URL,
  process.env.SCALEKIT_CLIENT_ID,
  process.env.SCALEKIT_CLIENT_SECRET
);

const RESOURCE_ID = process.env.RESOURCE_ID || 'https://your-mcp.up.railway.app';
const METADATA_ENDPOINT = `${RESOURCE_ID}/.well-known/oauth-protected-resource`;

const WWW_AUTH = {
  key: 'WWW-Authenticate',
  value: `Bearer realm="OAuth", resource_metadata="${METADATA_ENDPOINT}"`
};
// === End ScaleKit Setup ===

// ... (your existing TOOLS + MODE logic stays exactly the same)
let TOOLS = [...authTools];
let MODE = 'cloud';

if (config.USE_LOCAL_MODE && config.IS_MACOS) {
  MODE = 'local';
  const { remindersTools } = require('./reminders');
  const { notesTools } = require('./notes');
  const { messagesTools } = require('./messages');
  const { safariTools } = require('./safari');
  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');

  TOOLS = [
    ...authTools, ...emailTools, ...calendarTools, ...contactsTools,
    ...remindersTools, ...notesTools, ...messagesTools, ...safariTools
  ];
} else if (config.USE_LOCAL_MODE && !config.IS_MACOS) {
  MODE = 'cloud (fallback - not macOS)';
  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');
  TOOLS = [...authTools, ...emailTools, ...calendarTools, ...contactsTools];
} else {
  MODE = 'cloud';
  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');
  TOOLS = [...authTools, ...emailTools, ...calendarTools, ...contactsTools];
}

const SERVER_INFO = {
  name: 'icloud-mcp',
  version: '2.0.0',
  description: `MCP server for Apple services (Mode: ${MODE})`
};

/** ScaleKit Auth Helper (NEW) */
async function authenticateRequest(req) {
  // Skip auth for discovery & health
  if (req.url.includes('.well-known') || req.url === '/') {
    return true;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.split('Bearer ')[1]?.trim()
    : null;

  if (!token) {
    throw new Error('Missing Bearer token');
  }

  // Validate with ScaleKit
  await scalekit.validateToken(token, {
    audience: [RESOURCE_ID]
    // issuer is auto-validated by the SDK
  });

  return true;
}

/**
 * Handle MCP JSON-RPC request
 */
async function handleRequest(request) {
  // ... your existing handleRequest stays 100% unchanged
  const { method, params, id } = request;
  try {
    switch (method) {
      case 'initialize':
        return { /* ... same as before */ };
      case 'notifications/initialized':
        return null;
      case 'tools/list':
        return { /* ... same */ };
      case 'tools/call':
        // ... same
        const result = await tool.handler(toolArgs);
        return { /* ... */ };
      default:
        return { /* ... */ };
    }
  } catch (error) {
    console.error(`[icloud-mcp] Error:`, error.message);
    return { /* error */ };
  }
}

/**
 * Start the MCP server with OAuth
 */
function startServer() {
  console.error('[icloud-mcp] Starting iCloud MCP server with ScaleKit OAuth...');
  console.error(`[icloud-mcp] Mode: ${MODE}`);
  console.error(`[icloud-mcp] Resource ID: ${RESOURCE_ID}`);

  const http = require('http');
  const PORT = process.env.PORT || 8080;

  const httpServer = http.createServer(async (req, res) => {
    // Health check (public)
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        name: SERVER_INFO.name,
        version: SERVER_INFO.version,
        mode: MODE,
        tools: TOOLS.length
      }));
      return;
    }

    // OAuth Protected Resource Metadata (required by MCP)
    if (req.method === 'GET' && req.url === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        resource: RESOURCE_ID,
        authorization_servers: [
          `${process.env.SCALEKIT_ENVIRONMENT_URL}/resources/${/* your MCP Server ID from dashboard */}`
        ],
        bearer_methods_supported: ["header"],
        scopes_supported: ["read", "write", "tools:execute"]   // adjust to what you set in ScaleKit
      }));
      return;
    }

    // === MCP endpoint with auth ===
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          // === AUTH CHECK (NEW) ===
          await authenticateRequest(req);

          const requestJson = JSON.parse(body);
          const response = await handleRequest(requestJson);

          if (response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } else {
            res.writeHead(204).end();
          }
        } catch (e) {
          console.error('[icloud-mcp] Auth or request error:', e.message);
          res.writeHead(401, {
            'Content-Type': 'application/json',
            [WWW_AUTH.key]: WWW_AUTH.value
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unauthorized: ' + e.message }
          }));
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.error(`🚀 iCloud MCP + ScaleKit OAuth listening on http://0.0.0.0:${PORT}`);
    console.error(`   → Metadata: ${RESOURCE_ID}/.well-known/oauth-protected-resource`);
  });

  // ... your existing graceful shutdown code stays the same
  process.stdin.resume();
  process.on('SIGINT', () => { /* ... */ });
  process.on('SIGTERM', () => { /* ... */ });
}

startServer();