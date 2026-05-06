#!/usr/bin/env node

/**
 * iCloud MCP Server
 *
 * Provides Claude with access to Apple services:
 * - Email (via IMAP/SMTP or Mail.app)
 * - Calendar (via CalDAV or Calendar.app)
 * - Contacts (via CardDAV or Contacts.app)
 * - Reminders (via Reminders.app - local only)
 * - Notes (via Notes.app - local only)
 * - Messages (via Messages.app - local only)
 * - Safari (via Safari.app - local only)
 *
 * Modes:
 * - LOCAL (default): Uses AppleScript to access native macOS apps (fast, requires Mac)
 * - CLOUD: Uses iCloud protocols (IMAP, CalDAV, CardDAV) - works from anywhere
 */

const readline = require('readline');
const config = require('./config');

// Import auth module
const { authTools } = require('./auth');

// Determine which tools to load based on mode
let TOOLS = [...authTools];
let MODE = 'cloud';

if (config.USE_LOCAL_MODE && config.IS_MACOS) {
  MODE = 'local';

  // Local mode - use AppleScript clients
  // Note: For simplicity, we'll create combined tools that work in both modes
  // The local-only modules are always available in local mode

  // Import local-only modules
  const { remindersTools } = require('./reminders');
  const { notesTools } = require('./notes');
  const { messagesTools } = require('./messages');
  const { safariTools } = require('./safari');

  // Import existing modules (they still work, cloud tools available)
  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');

  // Add local-only tools
  TOOLS = [
    ...authTools,
    ...emailTools,
    ...calendarTools,
    ...contactsTools,
    ...remindersTools,
    ...notesTools,
    ...messagesTools,
    ...safariTools
  ];

} else if (config.USE_LOCAL_MODE && !config.IS_MACOS) {
  // Local mode requested but not on macOS - fall back to cloud
  MODE = 'cloud (fallback - not macOS)';

  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');

  TOOLS = [
    ...authTools,
    ...emailTools,
    ...calendarTools,
    ...contactsTools
  ];

} else {
  // Cloud mode
  MODE = 'cloud';

  const { emailTools } = require('./email');
  const { calendarTools } = require('./calendar');
  const { contactsTools } = require('./contacts');

  TOOLS = [
    ...authTools,
    ...emailTools,
    ...calendarTools,
    ...contactsTools
  ];
}

// Server info
const SERVER_INFO = {
  name: 'icloud-mcp',
  version: '2.0.0',
  description: `MCP server for Apple services (Mode: ${MODE})`
};

/**
 * Handle MCP JSON-RPC request
 */
async function handleRequest(request) {
  const { method, params, id } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: {}
            }
          }
        };

      case 'notifications/initialized':
        // No response needed for notifications
        return null;

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        };

      case 'tools/call':
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        const tool = TOOLS.find(t => t.name === toolName);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`
            }
          };
        }

        console.error(`[icloud-mcp] Calling tool: ${toolName}`);

        const result = await tool.handler(toolArgs);

        return {
          jsonrpc: '2.0',
          id,
          result
        };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`
          }
        };
    }
  } catch (error) {
    console.error(`[icloud-mcp] Error handling ${method}:`, error.message);
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error.message
      }
    };
  }
}

/**
 * Start the MCP server
 */
function startServer() {
  console.error('[icloud-mcp] Starting iCloud MCP server...');
  console.error(`[icloud-mcp] Mode: ${MODE}`);
  console.error(`[icloud-mcp] Tools available: ${TOOLS.length}`);

  if (MODE === 'local') {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts, Reminders, Notes, Messages, Safari');
  } else {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts');
    console.error(`[icloud-mcp] Credentials configured: ${!!(config.ICLOUD_EMAIL && config.ICLOUD_APP_PASSWORD)}`);
  }

  // === HTTP SERVER ===
  const http = require('http');
  const PORT = process.env.PORT || 8080;

  const httpServer = http.createServer(async (req, res) => {
    // === OAuth Discovery Endpoints (required by Grok) ===
    if (req.method === 'GET') {
      if (req.url === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          resource: `https://${req.headers.host}`,
          authorization_servers: [`https://${req.headers.host}`],
          scopes_supported: ["tools:read", "tools:write"],
          bearer_methods_supported: ["header"]
        }));
        return;
      }

      if (req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer: `https://${req.headers.host}`,
          authorization_endpoint: `https://${req.headers.host}/authorize`,
          token_endpoint: `https://${req.headers.host}/token`,
          registration_endpoint: `https://${req.headers.host}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"]
        }));
        return;
      }

      // Health check
      if (req.url === '/') {
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
    }

    // === Main MCP endpoint ===
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const response = await handleRequest(request);

          if (response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } else {
            res.writeHead(204).end();
          }
        } catch (e) {
          console.error('[icloud-mcp] HTTP error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            jsonrpc: '2.0', 
            error: { code: -32700, message: 'Parse error' } 
          }));
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.error(`🚀 iCloud MCP HTTP server listening on http://0.0.0.0:${PORT}`);
    console.error(`   → Health: https://your-url.up.railway.app/`);
    console.error(`   → Grok MCP: https://your-url.up.railway.app/mcp`);
  });

  process.stdin.resume();

  process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
  process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));

  console.error('[icloud-mcp] Server ready with OAuth discovery ✅');
}

// Start only once
startServer();
