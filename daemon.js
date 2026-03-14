#!/usr/bin/env node
/**
 * agentchattr-remote — Remote agent daemon
 *
 * Connects to hub via WebSocket for real-time messaging.
 * Maintains one persistent Claude Code session.
 * When @mentioned, injects the task into the session.
 *
 * Usage:
 *   node daemon.js --agent awppc --hub https://agents.awpdemon.com --token <session-token>
 */

import { spawn, execSync } from 'child_process';
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
const CLAUDE_CMD = args.claude || 'claude';

if (!TOKEN) {
  console.error('Usage: node daemon.js --agent <name> --hub <url> --token <session-token>');
  process.exit(1);
}

// Convert https to wss for WebSocket
const WS_URL = HUB_URL.replace('https://', 'wss://').replace('http://', 'ws://') + `/ws?token=${TOKEN}`;

// State
let ws = null;
let claudeProcess = null;
let claudeReady = false;
let claudeOutput = '';
let processingTask = false;
let reconnectAttempts = 0;
let initialized = false; // Skip messages until we're caught up
let taskQueue = [];

// --- WebSocket Connection ---
async function connectWs() {
  const { default: WebSocket } = await import('ws');

  console.log(`[${AGENT_NAME}] Connecting to hub WebSocket...`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`[${AGENT_NAME}] WebSocket connected!`);
    reconnectAttempts = 0;

    // Ignore all messages for the first 2 seconds (historical backfill)
    initialized = false;
    setTimeout(() => {
      initialized = true;
      console.log(`[${AGENT_NAME}] Ready — now listening for @mentions`);
      // Announce presence
      sendChat(`${AGENT_NAME} is online and ready.`);
    }, 2000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    console.log(`[${AGENT_NAME}] WebSocket disconnected. Reconnecting...`);
    reconnectAttempts++;
    const delay = Math.min(reconnectAttempts * 2000, 30000);
    setTimeout(connectWs, delay);
  });

  ws.on('error', (err) => {
    console.error(`[${AGENT_NAME}] WebSocket error:`, err.message);
  });
}

function sendChat(text, channel = 'general') {
  if (!ws || ws.readyState !== 1) {
    console.log(`[${AGENT_NAME}] WebSocket not ready, can't send`);
    return;
  }
  ws.send(JSON.stringify({
    type: 'message',
    sender: AGENT_NAME,
    text,
    channel
  }));
}

// --- Message Handling ---
function handleMessage(msg) {
  // agentchattr broadcasts: {"type": "message", "data": {id, sender, text, type, channel}}
  if (msg.type === 'message' && msg.data) {
    // Skip our own messages to prevent loops
    if (msg.data.sender === AGENT_NAME) return;
    checkMention(msg.data);
    return;
  }
}

function checkMention(msg) {
  if (!msg || !msg.text) return;
  if (!initialized) return; // Skip historical messages

  const text = msg.text.toLowerCase();
  const sender = msg.sender || '';

  // Don't process own messages or system messages
  if (sender === AGENT_NAME) return;
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave') return;

  // Check if @mentioned
  const mentionsMe = text.includes(`@${AGENT_NAME.toLowerCase()}`);
  const mentionsAll = text.includes('@all');

  if (mentionsMe || mentionsAll) {
    console.log(`[${AGENT_NAME}] Mentioned by ${sender}: ${msg.text.substring(0, 100)}`);
    if (processingTask) {
      taskQueue.push(msg);
      sendChat(`📋 Queued (${taskQueue.length} in queue). Still working on current task.`);
    } else {
      processTask(msg);
    }
  }
}

async function processTask(msg) {
  processingTask = true;
  const task = msg.text
    .replace(new RegExp(`@${AGENT_NAME}\\s*`, 'gi'), '')
    .replace(/@all\s*/gi, '')
    .trim();

  sendChat(`🔄 Working on: "${task.substring(0, 150)}"`);

  try {
    const response = await runClaude(task);

    // Send result back (truncate if needed)
    const maxLen = 3000;
    const result = response.length > maxLen
      ? response.substring(0, maxLen) + '\n\n... (truncated)'
      : response;

    sendChat(`✅ Done.\n\n${result}`);
  } catch (err) {
    sendChat(`❌ Error: ${err.message}`);
  }

  processingTask = false;

  // Process next queued task
  if (taskQueue.length > 0) {
    const next = taskQueue.shift();
    console.log(`[${AGENT_NAME}] Processing next queued task (${taskQueue.length} remaining)`);
    processTask(next);
  }
}

// --- Claude Code Execution ---
// Uses `claude -p` (print mode) for each task — returns clean output
let conversationId = null; // Reuse conversation for context continuity

async function runClaude(prompt) {
  // Escape the prompt for shell use
  const escaped = prompt.replace(/"/g, '\\"');
  const cmd = `${CLAUDE_CMD} --dangerously-skip-permissions -p "${escaped}"`;

  console.log(`[${AGENT_NAME}] Running: ${cmd.substring(0, 100)}...`);

  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: 300000, // 5 min
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env }
    });
    return output.trim() || '(completed with no text output)';
  } catch (err) {
    if (err.stdout) return err.stdout.trim();
    if (err.stderr) return err.stderr.trim();
    throw err;
  }
}

function startClaude() {
  // No persistent session needed — we use claude -p per task
  claudeReady = true;
  console.log(`[${AGENT_NAME}] Claude Code ready (print mode)`);
}

// --- Main ---
async function main() {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     agentchattr remote daemon         ║
  ╠═══════════════════════════════════════╣
  ║  Agent:  ${AGENT_NAME.padEnd(28)}║
  ║  Hub:    ${HUB_URL.substring(0, 28).padEnd(28)}║
  ╚═══════════════════════════════════════╝
  `);

  // Start Claude Code
  startClaude();

  // Connect WebSocket (real-time, no polling)
  await connectWs();
}

main().catch(console.error);
