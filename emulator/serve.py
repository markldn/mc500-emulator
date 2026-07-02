#!/usr/bin/env python3
"""
Simple HTTP server for Roland MC-500 Emulator
Run this script and open http://localhost:8000 in your browser
"""

import http.server
import socketserver
import os

# 8500: port 8000 is used by another app on this machine (reachy-mi)
PORT = 8500

# Change to emulator directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

Handler = http.server.SimpleHTTPRequestHandler

# Add CORS headers and proper MIME types
class CORSHandler(Handler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.js'):
            return 'application/javascript'
        return super().guess_type(path)

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), CORSHandler) as httpd:
    import socket
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    print(f"Roland MC-500 Emulator")
    print(f"Serving at:")
    print(f"  Local:   http://localhost:{PORT}")
    print(f"  Network: http://{local_ip}:{PORT}")
    print(f"Press Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
