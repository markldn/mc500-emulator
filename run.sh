#!/bin/bash
# Roland MC-500 Emulator - Start Script
# This script starts a local HTTP server for the web-based emulator

cd "$(dirname "$0")/emulator"

echo "========================================"
echo "  Roland MC-500 Emulator"
echo "========================================"
echo ""

# Preferred: serve.py sends Cache-Control: no-store so browsers always
# pick up updated emulator files (plain http.server lets them go stale).
if command -v python3 &> /dev/null; then
    echo "Starting HTTP server (no-cache) with Python 3..."
    echo "Open your browser to: http://localhost:8500"
    echo ""
    echo "Press Ctrl+C to stop the server"
    echo ""
    python3 serve.py

# Fallback to Python 2
elif command -v python &> /dev/null; then
    echo "Starting HTTP server with Python 2..."
    echo "Open your browser to: http://localhost:8000"
    echo ""
    echo "Press Ctrl+C to stop the server"
    echo ""
    python -m SimpleHTTPServer 8000

# Fallback to npx serve
elif command -v npx &> /dev/null; then
    echo "Starting HTTP server with npx serve..."
    echo "Open your browser to: http://localhost:3000"
    echo ""
    echo "Press Ctrl+C to stop the server"
    echo ""
    npx serve -p 3000

else
    echo "Error: No HTTP server found!"
    echo "Please install Python 3 or Node.js with npx"
    exit 1
fi
