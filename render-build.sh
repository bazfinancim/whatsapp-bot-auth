#!/usr/bin/env bash
# Render build script to install Chromium for video codec support

set -e

echo "Installing Chromium for H.264/AAC video codec support..."

# Install chromium browser (has H.264/AAC codecs)
apt-get update
apt-get install -y chromium chromium-driver

# Verify installation
if [ -f "/usr/bin/chromium" ]; then
    echo "✓ Chromium installed successfully at /usr/bin/chromium"
    chromium --version
else
    echo "⚠️  Chromium installation failed, will fall back to bundled Chromium"
fi

# Install npm dependencies
echo "Installing npm dependencies..."
npm install

echo "Build complete!"
