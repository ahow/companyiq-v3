#!/bin/bash
# usage: wt-run.sh WORKTREE LABEL TASKSMAX(0=none)
W=$1; L=$2; T=$3; cd "$W" || exit 2
ENVS="REPRO_JOBS=${REPRO_JOBS:-12} REPRO_HOLD_MS=${REPRO_HOLD_MS:-20000} REPRO_DOCS_PER_CHILD=${REPRO_DOCS_PER_CHILD:-1} REPRO_LABEL=$L REPRO_OUT=/tmp/repro/$L.json"
echo "worktree=$W head=$(git rev-parse HEAD) tasksmax=$T" > /tmp/repro/$L.log
if [ "$T" = "0" ]; then
  env $ENVS timeout 900 npx tsx server/scripts/browser-lifetime-repro.ts >> /tmp/repro/$L.log 2>&1
else
  sudo systemd-run --quiet --scope --unit=ciq-repro-$L-$$ -p TasksMax=$T --uid=ubuntu --gid=ubuntu \
    /usr/bin/env HOME=/home/ubuntu PATH=$PATH $ENVS timeout 900 npx tsx server/scripts/browser-lifetime-repro.ts >> /tmp/repro/$L.log 2>&1
fi
echo "exit=$?" >> /tmp/repro/$L.log
