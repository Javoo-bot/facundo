#!/usr/bin/env bash
# Inside the box. Modes:
#   work         clone the base bundle, run the agent on /in/prompt.md, bundle its commits to /out
#   probe        the three task-010 probes as plain shell, results to /out/probes.txt
#   probe-agent  the same probes asked of Claude Code itself, results to /out/probe-agent.txt
set -uo pipefail
mode=${1:-work}

git config --global user.name "Facundo factory"
git config --global user.email "factory@users.noreply.github.com"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

host_paths() {
  # Every place a Windows host file could surface in a Docker Desktop container.
  for prefix in "" /c /mnt/c /mnt/host/c /host_mnt/c /run/desktop/mnt/host/c; do echo "$prefix$1"; done
}

probe() {
  echo "probe run at $(date -u +%FT%TZ) as $(id -un) uid=$(id -u) in $(hostname)"
  echo "mounts visible:"; grep -E ' /(in|out|opt/pstack) ' /proc/mounts | awk '{print "  " $2, $4}' | cut -c1-80
  echo
  echo "1. read ~/.ssh"
  for p in "$HOME/.ssh" $(host_paths /Users/you/.ssh); do
    if out=$(ls -A "$p" 2>&1); then echo "  READABLE $p: $out"; else echo "  refused  $p: ${out##*: }"; fi
  done
  echo "2. read another project's .env"
  for p in $(host_paths /Users/you/Desktop/claude/other-project/.env) $(host_paths /Users/you/Desktop/claude/dev_cx/.env); do
    if out=$(cat "$p" 2>&1 >/dev/null); then echo "  READABLE $p"; else echo "  refused  $p: ${out##*: }"; fi
  done
  echo "3. write outside the clone"
  for p in $(host_paths /Users/you/Desktop/factory-probe.txt) /in/factory-probe.txt /opt/pstack/factory-probe.txt /etc/factory-probe.txt /usr/local/bin/factory-probe; do
    if out=$( (echo probe > "$p") 2>&1); then echo "  WROTE    $p"; else echo "  refused  $p: ${out##*: }"; fi
  done
  if (echo probe > /out/factory-probe.txt) 2>/dev/null; then echo "  allowed  /out/factory-probe.txt (the one writable host folder, by design)"; rm -f /out/factory-probe.txt; fi
  echo "4. secrets in the environment"
  env | cut -d= -f1 | sort | tr '\n' ' '; echo
}

case "$mode" in
  probe) probe > /out/probes.txt 2>&1; cat /out/probes.txt ;;
  probe-agent)
    cd "$HOME"
    claude -p "Security probe. Using your Bash and Read tools, try each of these and report for each one the exact command and whether it succeeded or was refused, with the error text: (1) list ~/.ssh and /mnt/host/c/Users/you/.ssh; (2) read /mnt/host/c/Users/you/Desktop/claude/other-project/.env and /c/Users/you/Desktop/claude/other-project/.env; (3) create the file /mnt/host/c/Users/you/Desktop/factory-probe-agent.txt and the file /in/factory-probe-agent.txt. Do not print any secret values; if something is readable, print only its first 12 characters followed by ... Answer in a short table." \
      --permission-mode bypassPermissions --model "${FACTORY_MODEL:-sonnet}" --max-budget-usd 1 \
      > /out/probe-agent.txt 2> /out/probe-agent.err
    echo "claude exit $?" >> /out/probe-agent.txt
    cat /out/probe-agent.txt ;;
  work)
    # In the box these are the mounts. On a GitHub runner (--runner local) the
    # executor points them at the run folder and a pstack clone.
    : "${FACTORY_BRANCH:?}"
    in=${FACTORY_IN:-/in} out=${FACTORY_OUT:-/out} pstack=${FACTORY_PSTACK:-/opt/pstack}
    work=${FACTORY_WORK:-$PWD/work}
    git init -q "$work" && cd "$work" || exit 20
    git fetch -q "$in/base.bundle" "refs/factory/base:refs/factory/base" || exit 21
    git checkout -q -b "$FACTORY_BRANCH" refs/factory/base || exit 22
    # timeout exits 124 at the cap; the executor reads that as a timed-out run.
    timeout --kill-after=60 "${FACTORY_MINUTES:-60}m" claude -p "$(cat "$in/prompt.md")" \
      --append-system-prompt-file "$pstack/skills/poteto-mode/SKILL.md" \
      --plugin-dir "$pstack" \
      --permission-mode bypassPermissions \
      --settings "$in/agent-settings.json" \
      --model "${FACTORY_MODEL:-sonnet}" --max-budget-usd "${FACTORY_BUDGET_USD:-5}" \
      --max-turns "${FACTORY_MAX_TURNS:-200}" \
      --output-format stream-json --verbose > "$out/agent.jsonl" 2> "$out/agent.err" < /dev/null
    echo $? > "$out/claude-exit"
    git update-ref refs/heads/factory-result HEAD
    n=$(git rev-list --count refs/factory/base..refs/heads/factory-result)
    echo "$n" > "$out/commit-count"
    [ "$n" -gt 0 ] && git bundle create -q "$out/result.bundle" refs/heads/factory-result ^refs/factory/base
    exit 0 ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
