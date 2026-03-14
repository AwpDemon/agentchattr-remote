#!/bin/bash
# agentchattr Remote Agent Installer (Mac/Linux)
# Usage: ./install.sh awpmac "your-session-token"

AGENT_NAME="${1:-}"
TOKEN="${2:-}"
HUB_URL="${3:-https://agents.awpdemon.com}"

if [ -z "$AGENT_NAME" ] || [ -z "$TOKEN" ]; then
    echo "Usage: ./install.sh <agent-name> <session-token> [hub-url]"
    echo "Example: ./install.sh awpmac abc123def456"
    exit 1
fi

echo ""
echo "=== agentchattr Remote Agent Installer ==="
echo "Agent: $AGENT_NAME"
echo "Hub: $HUB_URL"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "Node.js not found. Install it first:"
    echo "  macOS: brew install node"
    echo "  Linux: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs"
    exit 1
fi

# Install
INSTALL_DIR="$HOME/.agentchattr-remote"
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/daemon.js" "$INSTALL_DIR/"
cp "$(dirname "$0")/package.json" "$INSTALL_DIR/"

# Create start script
cat > "$INSTALL_DIR/start-agent.sh" << SCRIPT
#!/bin/bash
cd "$INSTALL_DIR"
node daemon.js --agent $AGENT_NAME --hub $HUB_URL --token $TOKEN
SCRIPT
chmod +x "$INSTALL_DIR/start-agent.sh"

# Create launchd plist for macOS auto-start
if [ "$(uname)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.agentchattr.remote.$AGENT_NAME.plist"
    cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentchattr.remote.$AGENT_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$INSTALL_DIR/daemon.js</string>
        <string>--agent</string>
        <string>$AGENT_NAME</string>
        <string>--hub</string>
        <string>$HUB_URL</string>
        <string>--token</string>
        <string>$TOKEN</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/agent.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/agent.log</string>
</dict>
</plist>
PLIST
    echo "macOS LaunchAgent created. Loading..."
    launchctl load "$PLIST" 2>/dev/null
    echo "Agent will auto-start on login."
fi

# Linux systemd user service
if [ "$(uname)" = "Linux" ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/agentchattr-$AGENT_NAME.service" << SVC
[Unit]
Description=agentchattr remote agent ($AGENT_NAME)
After=network-online.target

[Service]
ExecStart=$(which node) $INSTALL_DIR/daemon.js --agent $AGENT_NAME --hub $HUB_URL --token $TOKEN
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SVC
    systemctl --user daemon-reload
    systemctl --user enable "agentchattr-$AGENT_NAME"
    systemctl --user start "agentchattr-$AGENT_NAME"
    echo "systemd user service created and started."
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Agent '$AGENT_NAME' installed at: $INSTALL_DIR"
echo "To start manually: $INSTALL_DIR/start-agent.sh"
echo ""
