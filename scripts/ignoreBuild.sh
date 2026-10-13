#!/bin/sh
# Vercel Ignored Build Step (vercel.json `ignoreCommand`): exit 0 skips the
# build, exit 1 builds. Skips only when something changed since the last
# successful deployment of this branch and all of it is under docs/ or *.md,
# so a docs-only merge doesn't replace the production deployment (every new
# deployment strands open tabs on the old one, where each return is a cold
# start; server-latency roadmap row 7). Anything unexpected builds: only the
# docs-only path exits 0. Plain sh: it runs before dependencies are installed.

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [ -z "$prev" ]; then
  echo "ignoreBuild: no previous deployment on this branch, build."
  exit 1
fi

if ! git cat-file -e "$prev^{commit}"; then
  echo "ignoreBuild: can't read previous deployment $prev in the clone, build."
  exit 1
fi

# Compare trees, not commits: covers every commit skipped since $prev.
# --no-renames lists both sides of a move, so src/x → docs/x still builds.
if ! all=$(git diff --name-only --no-renames "$prev" HEAD); then
  echo "ignoreBuild: git diff failed, build."
  exit 1
fi

# Nothing changed: a redeploy (the dashboard's Redeploy runs this step too) or
# an empty commit. Both are deliberate, e.g. to pick up an env var change.
if [ -z "$all" ]; then
  echo "ignoreBuild: nothing changed since $prev (a redeploy or an empty commit), build."
  exit 1
fi

if ! changed=$(git diff --name-only --no-renames "$prev" HEAD -- . ':(exclude)docs/' ':(exclude)*.md'); then
  echo "ignoreBuild: git diff failed, build."
  exit 1
fi

if [ -z "$changed" ]; then
  echo "ignoreBuild: only docs/ and *.md changed since $prev, skip."
  exit 0
fi

echo "ignoreBuild: changed since $prev, build:"
printf '%s\n' "$changed"
exit 1
