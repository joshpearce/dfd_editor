#!/bin/bash
# Dev container post-create setup.
#
# Runs after the container is created, once per container lifecycle.
# Project-specific initialization (dependency install, migrations,
# build steps) goes in the "Project-specific setup" section below.
#
# The mitmproxy CA cert is installed by entrypoint.sh (before VS Code
# Server download). This script verifies the install completed before
# running any network-dependent commands.

set -e

# ============================================================
# Wait for mitmproxy CA certificate to be trusted
# ============================================================
# entrypoint.sh installs the cert into the system trust store, but
# there's a brief window between update-ca-certificates finishing and
# postCreateCommand starting. Re-verify before touching the network so
# package installs fail loudly (not with confusing TLS errors) if the
# cert never made it in.
if [ -n "$https_proxy" ]; then
    echo "Verifying proxy CA certificate..."
    timeout=15
    while [ ! -f /usr/local/share/ca-certificates/mitmproxy-ca-cert.crt ]; do
        timeout=$((timeout - 1))
        if [ "$timeout" -le 0 ]; then
            echo "ERROR: Proxy CA certificate not installed after 15s"
            echo "Check that entrypoint.sh ran update-ca-certificates successfully."
            exit 1
        fi
        sleep 1
    done
    echo "Proxy CA certificate verified"
fi

# ============================================================
# Project-specific setup
# Add project initialization commands below (e.g., dependency
# install, database migrations, build steps).
# ============================================================

echo ""
echo "========================================="
echo "Development environment ready!"
echo "========================================="
echo "Claude Code CLI version: $(claude --version 2>/dev/null || echo 'not installed')"
echo ""
