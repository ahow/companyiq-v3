#!/bin/bash
# usage: run.sh LABEL TASKSMAX(0=none)
cd /home/ubuntu/github_repos/companyiq-v3
L=$1; T=$2
ENVS="REPRO_JOBS=${REPRO_JOBS:-12} REPRO_HOLD_MS=${REPRO_HOLD_MS:-20000} REPRO_DOCS_PER_CHILD=${REPRO_DOCS_PER_CHILD:-1} REPRO_LABEL=$L REPRO_OUT=/tmp/repro/$L.json"
if [ "$T" = "0" ]; then
  env $ENVS timeout 900 npx tsx server/scripts/browser-lifetime-repro.ts > /tmp/repro/$L.log 2>&1
else
  sudo systemd-run --quiet --scope --unit=ciq-repro-$L-$$ -p TasksMax=$T --uid=ubuntu --gid=ubuntu \
    /usr/bin/env HOME=/home/ubuntu PATH=$PATH $ENVS timeout 900 npx tsx server/scripts/browser-lifetime-repro.ts > /tmp/repro/$L.log 2>&1
fi
echo "exit=$?" >> /tmp/repro/$L.log
