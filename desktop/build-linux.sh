#!/bin/bash
echo "Building Linux x64..."
cd "$(dirname "$0")"
npm install
npx electron-builder --linux --x64
echo ""
echo "Build complete: desktop/dist/"
