FROM mcr.microsoft.com/devcontainers/base:ubuntu

# Install tmux for terminal session management and gh CLI for GitHub operations
RUN apt-get update \
    && apt-get install -y tmux \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code and make it available system-wide.
# Copy to /usr/local/bin/ so it's available regardless of home directory mount configuration.
USER vscode
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
RUN cp /home/vscode/.local/bin/claude /usr/local/bin/claude
USER vscode
