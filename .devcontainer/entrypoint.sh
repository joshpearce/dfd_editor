#!/bin/sh
# Install mitmproxy CA certificate into the system trust store.
# This runs as the container entrypoint, BEFORE VS Code connects,
# ensuring TLS interception works for VS Code Server downloads.
#
# The proxy healthcheck (service_healthy) guarantees the cert file
# exists before the app container starts, but we still wait as a
# safety net and fail fast (exit 1) if the cert never appears so
# broken TLS interception surfaces immediately instead of silently
# corrupting later package installs.

# Fix ownership of named volumes mounted inside the workspace bind mount.
# Docker creates these directories as root because their parent is a bind
# mount (not an image layer), so vscode can't write to them otherwise.
sudo chown vscode:vscode /workspaces/dfd_editor/node_modules 2>/dev/null || true

CERT_SRC="/tmp/mitmproxy-certs/mitmproxy-ca-cert.pem"
CERT_DST="/usr/local/share/ca-certificates/mitmproxy-ca-cert.crt"

echo "Waiting for mitmproxy CA certificate..."
timeout=30
while [ ! -f "$CERT_SRC" ] && [ "$timeout" -gt 0 ]; do
    sleep 1
    timeout=$((timeout - 1))
done

if [ ! -f "$CERT_SRC" ]; then
    echo "ERROR: mitmproxy CA cert not found after 30s. HTTPS through proxy will fail."
    exit 1
fi

sudo cp "$CERT_SRC" "$CERT_DST"
sudo update-ca-certificates --fresh > /dev/null 2>&1

# Configure git system-wide to use the updated CA bundle.
# This ensures git trusts the proxy CA even when spawned by tools
# that may not pass through GIT_SSL_CAINFO (e.g. npm/yarn postinstall
# scripts that invoke git under a stripped environment).
sudo git config --system http.sslCAInfo /etc/ssl/certs/ca-certificates.crt

echo "Proxy CA certificate installed"

exec "$@"
