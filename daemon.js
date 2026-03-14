#!/usr/bin/env node
/**
 * agentchattr-remote — Remote agent daemon
 *
 * Connects to hub via WebSocket for real-time messaging.
 * Uses `claude -p` (print mode) with --resume for conversation continuity.
 * When @mentioned, executes the task and posts results back.
 *
 * Usage:
 *   node daemon.js --agent awppc --hub https://agents.awpdemon.com --token <session-token>
 */

import { execSync, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// --- Parse CLI args ---
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--') && i + 1 < process.argv.length) {
    args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
  }
}

const AGENT_NAME = args.agent || 'remote-agent';
const HUB_URL = args.hub || 'https://agents.awpdemon.com';
const TOKEN = args.token || '';
const CLAUDE_CMD = args.claude || findClaude();

if (!TOKEN) {
  console.error('Usage: node daemon.js --agent <name> --hub <url> --token <session-token>');
  process.exit(1);
}

// --- Find claude on PATH ---
function findClaude() {
  try {
    const result = execSync('where claude 2>nul || which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    return result.split('\n')[0].trim();
  } catch {
    return 'claude'; // Hope it's on PATH
  }
}

// Verify claude works
try {
  execSync(`${CLAUDE_CMD} --version`, { encoding: 'utf8', timeout: 10000 });
} catch {
  console.error(`[${AGENT_NAME}] ERROR: Cannot find 'claude' command. Install Claude Code or pass --claude /path/to/claude`);
  process.exit(1);
}

// --- State ---
const WS_URL = HUB_URL.replace('https://', 'wss://').replace('http://', 'ws://') + `/ws?token=${TOKEN}`;
const DATA_DIR = join(homedir(), '.agentchattr-remote');
const CONV_FILE = join(DATA_DIR, `${AGENT_NAME}-conversation.txt`);

let ws = null;
let reconnectAttempts = 0;
let initialized = false;
let processingTask = false;
let taskQueue = [];
let processedIds = new Set(); // Deduplication
let lastConversationId = loadConversationId();

// Ensure data dir
mkdirSync(DATA_DIR, { recursive: true });

function loadConversationId() {
  try {
    if (existsSync(CONV_FILE)) return readFileSync(CONV_FILE, 'utf8').trim() || null;
  } catch {}
  return null;
}

function saveConversationId(id) {
  if (id) {
    lastConversationId = id;
    try { writeFileSync(CONV_FILE, id, 'utf8'); } catch {}
  }
}

// --- WebSocket Connection ---
async function connectWs() {
  const { default: WebSocket } = await import('ws');

  if (ws) {
    try { ws.close(); } catch {}
  }

  console.log(`[${AGENT_NAME}] Connecting to ${HUB_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`[${AGENT_NAME}] Connected!`);
    reconnectAttempts = 0;

    // Skip all messages received in the first 3 seconds (historical backfill from agentchattr)
    initialized = false;
    setTimeout(() => {
      initialized = true;
      console.log(`[${AGENT_NAME}] Listening for @mentions...`);
      sendChat(`${AGENT_NAME} is online and ready.`);
    }, 3000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'message' && msg.data) {
        onMessage(msg.data);
      }
    } catch {}
  });

  ws.on('close', (code) => {
    if (code === 4003) {
      console.error(`[${AGENT_NAME}] Invalid token! Get the current token from the hub.`);
      process.exit(1);
    }
    reconnectAttempts++;
    const delay = Math.min(reconnectAttempts * 3000, 30000);
    console.log(`[${AGENT_NAME}] Disconnected (code ${code}). Reconnecting in ${delay / 1000}s...`);
    setTimeout(connectWs, delay);
  });

  ws.on('error', () => {}); // Suppress — close handler deals with reconnect
}

function sendChat(text, channel = 'general') {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'message', sender: AGENT_NAME, text, channel }));
}

// --- Message Processing ---
function onMessage(msg) {
  if (!initialized) return;
  if (!msg || !msg.text || !msg.id) return;

  // Deduplication — never process the same message ID twice
  if (processedIds.has(msg.id)) return;
  processedIds.add(msg.id);
  // Keep set from growing forever
  if (processedIds.size > 500) {
    const arr = [...processedIds];
    processedIds = new Set(arr.slice(-250));
  }

  // Skip own messages, system messages
  if (msg.sender === AGENT_NAME) return;
  if (['system', 'join', 'leave'].includes(msg.type)) return;

  // Check for @mention
  const text = msg.text.toLowerCase();
  const mentionsMe = text.includes(`@${AGENT_NAME.toLowerCase()}`);
  const mentionsAll = text.includes('@all');

  if (!mentionsMe && !mentionsAll) return;

  console.log(`[${AGENT_NAME}] @${msg.sender}: ${msg.text.substring(0, 120)}`);

  if (processingTask) {
    taskQueue.push(msg);
    sendChat(`📋 Queued (#${taskQueue.length}). Working on current task.`);
  } else {
    runTask(msg);
  }
}

async function runTask(msg) {
  processingTask = true;

  // Strip @mentions from the prompt
  const prompt = msg.text
    .replace(new RegExp(`@${AGENT_NAME}`, 'gi'), '')
    .replace(/@all/gi, '')
    .trim();

  if (!prompt) {
    sendChat(`⚠️ Empty task after removing @mentions.`);
    processingTask = false;
    drainQueue();
    return;
  }

  sendChat(`🔄 Working on it...`);

  try {
    const response = await runClaude(prompt);
    const maxLen = 3000;
    const output = response.length > maxLen
      ? response.substring(0, maxLen) + '\n... (truncated)'
      : response;
    sendChat(`✅ ${output}`);
  } catch (err) {
    sendChat(`❌ Failed: ${err.message.substring(0, 200)}`);
  }

  processingTask = false;
  drainQueue();
}

function drainQueue() {
  if (taskQueue.length > 0) {
    const next = taskQueue.shift();
    console.log(`[${AGENT_NAME}] Next task from queue (${taskQueue.length} left)`);
    runTask(next);
  }
}

// --- Claude Code Execution ---
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    // Build command — use --resume if we have a previous conversation
    const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`');
    let cmd = `${CLAUDE_CMD} --dangerously-skip-permissions -p "${escaped}"`;

    if (lastConversationId) {
      cmd += ` --resume "${lastConversationId}"`;
    }

    console.log(`[${AGENT_NAME}] Exec: claude -p "${prompt.substring(0, 80)}..."${lastConversationId ? ' (resuming)' : ''}`);

    exec(cmd, {
      encoding: 'utf8',
      timeout: 300000, // 5 min
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env }
    }, (err, stdout, stderr) => {
      // Try to capture conversation ID from output for continuity
      const idMatch = (stderr || '').match(/session[_\s]*id[:\s]+([a-f0-9-]+)/i)
        || (stdout || '').match(/session[_\s]*id[:\s]+([a-f0-9-]+)/i);
      if (idMatch) saveConversationId(idMatch[1]);

      if (err) {
        // Claude -p exits non-zero sometimes but still has output
        const output = (stdout || '').trim() || (stderr || '').trim();
        if (output) {
          resolve(output);
        } else {
          reject(new Error(err.message.substring(0, 200)));
        }
        return;
      }

      resolve((stdout || '').trim() || '(completed)');
    });
  });
}

// --- Main ---
console.log(`
╔═══════════════════════════════════════════╗
║       agentchattr remote daemon           ║
╠═══════════════════════════════════════════╣
║  Agent:   ${AGENT_NAME.padEnd(30)}║
║  Hub:     ${HUB_URL.substring(0, 30).padEnd(30)}║
║  Claude:  ${CLAUDE_CMD.substring(0, 30).padEnd(30)}║
╚═══════════════════════════════════════════╝
`);

connectWs().catch(err => {
  console.error(`[${AGENT_NAME}] Fatal:`, err.message);
  process.exit(1);
});
