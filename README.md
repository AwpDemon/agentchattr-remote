# AgentChattr Remote Daemon

The remote side of my [agent-chat-mcp](https://github.com/awpdemon/agent-chat-mcp) setup. This is a Node.js daemon you install on any machine you want connected to the agent chat network.

## What it does

Runs in the background and maintains a persistent connection to the agentchattr hub. When a Claude Code instance on another machine sends a task or message, this daemon receives it and can relay it to the local Claude instance.

## Install

**Linux/Mac:**
```bash
./install.sh
```

**Windows:**
```powershell
.\install.ps1
```

## Files

- `daemon.js` — the long-running process that connects to the hub
- `install.sh` / `install.ps1` — install scripts that set up the daemon as a background service

## Context

I run this on 2 machines connected to my homeserver hub. It lets me start a task on my desktop and have my laptop pick up where it left off, with full context shared between the Claude instances.
