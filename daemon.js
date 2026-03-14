#!/usr/bin/env node
/**
 * agentchattr-remote — Remote agent daemon
 *
 * Runs on any device. Connects to a hub agentchattr instance.
 * Maintains one persistent Claude Code session.
 * When @mentioned in the chat, injects the message into the session.
 * Reports results back to the chat.
 *
 * Usage:
 *   node daemon.js --agent awppc --hub https://agents.awpdemon.com --token <session-token>
 *   node daemon.js --agent awpmac --hub https://agents.awpdemon.com --token <session-token>
 */

import { spawn } from 'child_process';
import { platform } from 'os';

// Parse CLI args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  args[key] = process.argv[i + 1];
}

const AGENT_NAME = args.agent || 'remote-agent';
const HUB_URL = args.hub || 'https://agents.awpdemon.com';
const TOKEN = args.token || '';
const POLL_INTERVAL = parseInt(args.interval) || 3000;
const CLAUDE_CMD = args.claude || 'claude';

if (!TOKEN) {
  console.error('Usage: node daemon.js --agent <name> --hub <url> --token <session-token>');
  console.error('');
  console.error('Get the session token from the agentchattr startup output on the hub.');
  process.exit(1);
}

// State
let lastMessageId = 0;
let claudeProcess = null;
let claudeReady = false;
let claudeOutput = '';
let pendingPrompt = null;
let processingTask = false;

const headers = {
  'Content-Type': 'application/json',
  'Cookie': `session_token=${TOKEN}`
};

// --- Hub API ---
async function hubFetch(path, options = {}) {
  const url = `${HUB_URL}${path}`;
  try {
    const res = await fetch(url, { headers, ...options });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (e.message.includes('fetch failed')) return null;
    throw e;
  }
}

async function sendMessage(text, channel = 'general') {
  return hubFetch('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ sender: AGENT_NAME, text, channel })
  });
}

async function getMessages(since = 0) {
  return hubFetch(`/api/messages?channel=general&since_id=${since}`);
}

async function register() {
  return hubFetch('/api/register', {
    method: 'POST',
    body: JSON.stringify({ name: AGENT_NAME, label: AGENT_NAME })
  });
}

async function heartbeat() {
  return hubFetch(`/api/heartbeat/${AGENT_NAME}`, { method: 'POST' });
}

// --- Claude Code Session ---
function startClaude() {
  console.log(`[${AGENT_NAME}] Starting Claude Code session...`);

  const isWindows = platform() === 'win32';
  const cmd = isWindows ? `${CLAUDE_CMD}.cmd` : CLAUDE_CMD;

  // Try to find claude
  claudeProcess = spawn(cmd, ['--dangerously-skip-permissions', '--verbose'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env }
  });

  claudeProcess.stdout.on('data', (data) => {
    const text = data.toString();
    claudeOutput += text;

    // Detect when Claude is ready for input (shows the prompt)
    if (text.includes('❯') || text.includes('>') || text.includes('Human:')) {
      claudeReady = true;
    }
  });

  claudeProcess.stderr.on('data', (data) => {
    const text = data.toString();
    // Claude Code outputs status info on stderr
    if (text.includes('ready') || text.includes('Connected')) {
      claudeReady = true;
    }
  });

  claudeProcess.on('exit', (code) => {
    console.log(`[${AGENT_NAME}] Claude Code exited with code ${code}. Restarting in 5s...`);
    claudeReady = false;
    claudeProcess = null;
    setTimeout(startClaude, 5000);
  });

  claudeProcess.on('error', (err) => {
    console.error(`[${AGENT_NAME}] Failed to start Claude:`, err.message);
    console.log(`[${AGENT_NAME}] Retrying in 10s...`);
    setTimeout(startClaude, 10000);
  });
}

function injectPrompt(text) {
  if (!claudeProcess || !claudeProcess.stdin.writable) {
    console.log(`[${AGENT_NAME}] Claude not ready, queuing prompt`);
    pendingPrompt = text;
    return false;
  }

  console.log(`[${AGENT_NAME}] Injecting: ${text.substring(0, 100)}...`);
  claudeProcess.stdin.write(text + '\n');
  return true;
}

// --- Collect Claude's response ---
async function waitForResponse(timeoutMs = 120000) {
  claudeOutput = '';
  const start = Date.now();
  let settled = 0;
  let lastLen = 0;

  return new Promise((resolve) => {
    const check = setInterval(() => {
      const elapsed = Date.now() - start;

      // Check if output has stopped growing (settled for 3s)
      if (claudeOutput.length > 0 && claudeOutput.length === lastLen) {
        settled += 500;
      } else {
        settled = 0;
      }
      lastLen = claudeOutput.length;

      if (settled >= 3000 || elapsed >= timeoutMs) {
        clearInterval(check);
        // Clean up ANSI codes and extract meaningful output
        const clean = claudeOutput
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\r/g, '')
          .trim();
        resolve(clean || '(no output)');
      }
    }, 500);
  });
}

// --- Message Processing ---
function isForMe(msg) {
  const text = msg.text || '';
  const mentionsMe = text.toLowerCase().includes(`@${AGENT_NAME.toLowerCase()}`);
  const mentionsAll = text.toLowerCase().includes('@all');
  // Don't process my own messages or system messages
  const isFromMe = msg.sender === AGENT_NAME;
  const isSystem = msg.type === 'system' || msg.type === 'join';
  return (mentionsMe || mentionsAll) && !isFromMe && !isSystem;
}

async function processMessage(msg) {
  if (processingTask) {
    console.log(`[${AGENT_NAME}] Already processing, skipping message ${msg.id}`);
    return;
  }

  processingTask = true;
  const task = msg.text.replace(new RegExp(`@${AGENT_NAME}\\s*`, 'gi'), '').trim();

  console.log(`[${AGENT_NAME}] Processing: "${task}" from ${msg.sender}`);
  await sendMessage(`🔄 Working on it: "${task.substring(0, 100)}"`);

  // Inject into Claude
  const injected = injectPrompt(task);
  if (!injected) {
    await sendMessage(`⚠️ Claude session not ready. Task queued.`);
    pendingPrompt = task;
    processingTask = false;
    return;
  }

  // Wait for response
  const response = await waitForResponse();

  // Truncate if too long for chat
  const maxLen = 2000;
  const truncated = response.length > maxLen
    ? response.substring(0, maxLen) + '\n\n... (truncated)'
    : response;

  await sendMessage(`✅ Done.\n\n${truncated}`);
  processingTask = false;
}

// --- Main Loop ---
async function pollMessages() {
  try {
    const data = await getMessages(lastMessageId);
    if (!data || !data.messages) return;

    for (const msg of data.messages) {
      if (msg.id <= lastMessageId) continue;
      lastMessageId = msg.id;

      if (isForMe(msg)) {
        await processMessage(msg);
      }
    }
  } catch (e) {
    // Silently retry on network errors
  }
}

async function main() {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     agentchattr remote daemon         ║
  ╠═══════════════════════════════════════╣
  ║  Agent:  ${AGENT_NAME.padEnd(28)}║
  ║  Hub:    ${HUB_URL.padEnd(28).substring(0, 28)}║
  ║  Poll:   ${(POLL_INTERVAL + 'ms').padEnd(28)}║
  ╚═══════════════════════════════════════╝
  `);

  // Register with hub
  console.log(`[${AGENT_NAME}] Registering with hub...`);
  const reg = await register();
  if (reg) {
    console.log(`[${AGENT_NAME}] Registered successfully`);
  } else {
    console.error(`[${AGENT_NAME}] Registration failed — check token and hub URL`);
  }

  // Get current message ID to avoid processing old messages
  const initial = await getMessages(0);
  if (initial && initial.messages && initial.messages.length > 0) {
    lastMessageId = initial.messages[initial.messages.length - 1].id;
    console.log(`[${AGENT_NAME}] Caught up to message #${lastMessageId}`);
  }

  // Start Claude Code session
  startClaude();

  // Announce presence
  setTimeout(async () => {
    await sendMessage(`${AGENT_NAME} is online and ready for tasks.`);
  }, 3000);

  // Poll for messages
  setInterval(pollMessages, POLL_INTERVAL);

  // Heartbeat every 30s
  setInterval(heartbeat, 30000);

  // Process pending prompts when Claude becomes ready
  setInterval(() => {
    if (claudeReady && pendingPrompt) {
      const prompt = pendingPrompt;
      pendingPrompt = null;
      injectPrompt(prompt);
    }
  }, 1000);

  console.log(`[${AGENT_NAME}] Polling for @mentions every ${POLL_INTERVAL}ms...`);
}

main().catch(console.error);
