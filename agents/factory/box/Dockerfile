# The locked box a factory agent works in (task 010 Part B). Built and run by
# agents/factory/execute-card.mjs; nothing from the host is mounted except
# /in (read-only: the brief and a git bundle of the base branch), /opt/pstack
# (read-only: the pstack plugin) and /out (the only writable host folder).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.266
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

COPY run.sh /usr/local/bin/factory-box
USER node
WORKDIR /home/node
ENTRYPOINT ["bash", "/usr/local/bin/factory-box"]
