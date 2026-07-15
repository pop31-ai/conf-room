#!/bin/bash
cd "$(dirname "$0")"
export CONF_URL=https://87.242.117.240:8443
npm install
npx electron .
