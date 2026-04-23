"""Flask app wiring.

Two blueprints mount here:

- ``editor_api`` — URLs the browser editor already consumes
  (``/api/diagrams[/<id>]``, ``/api/diagrams/import``,
  ``/api/diagrams/<id>/export``, ``/api/layout``, ``/api/health``,
  ``/ws``, ``/api/internal/broadcast``). Unchanged URLs.
- ``agent_api`` — the parallel REST surface under ``/api/agent/*`` for
  non-MCP external clients.

The MCP server (``mcp_server.py``) runs in a separate process and
imports ``agent_service`` directly; it does not go through this app
except for the loopback ``/api/internal/broadcast`` POST used to fan WS
envelopes out to connected browsers.
"""

from __future__ import annotations

from flask import Flask
from flask_cors import CORS
from flask_sock import Sock

import storage  # noqa: F401 — imported so DATA_DIR directory is created at startup
from agent_api import agent_api
from editor_api import editor_api, register_ws
import ws  # noqa: F401 — imported so the loopback HTTP client is initialised


app = Flask(__name__)
CORS(app, origins=["http://localhost:5173"])
sock = Sock(app)

app.register_blueprint(editor_api)
app.register_blueprint(agent_api)

# The /ws route uses flask-sock, which requires the Sock object; blueprints
# can't register @sock.route decorators, so the WS handler is wired here via
# a helper in editor_api that knows how to install it on the given Sock.
register_ws(sock)
