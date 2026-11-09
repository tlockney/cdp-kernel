#!/bin/sh
# Whether a pull request needs the test jobs in ci.yml (#431). Prints
# `code=true|false`, for $GITHUB_OUTPUT.
#
# On a pull request, actions/checkout checks out the merge commit, so
# HEAD^1 is the base and `git diff HEAD^1 HEAD` is what the PR changes.
# Docs and Markdown can't change what the jobs test (pages.yml builds the
# docs); CHANGELOG.md can (test/package.test.ts reads it), and anything
# not listed counts as code. A push to main diffs against the commit
# main was at before it (BASE_SHA, github.event.before; HEAD^1 without
# it) with the same rules (#433). Any other event (publish.yml's call),
# and a push whose base can't be found or diffed, runs everything.
set -eu

everything() {
  echo code=true
  exit 0
}

case ${GITHUB_EVENT_NAME:-} in
  pull_request) base=HEAD^1 ;;
  push)
    # Only a push to main is diffed; a tag push runs everything.
    [ "${GITHUB_REF:-}" = refs/heads/main ] || everything
    base=${BASE_SHA:-HEAD^1}
    case $base in *[!0]*) ;; *) everything ;; esac
    if ! git cat-file -e "$base^{commit}" 2> /dev/null; then
      git fetch -q --no-tags --depth=1 origin "$base" 2> /dev/null || everything
    fi
    ;;
  *) everything ;;
esac

code=false
files=$(git diff --no-renames --name-only "$base" HEAD) || everything
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case $f in
    CHANGELOG.md) code=true ;;
    # Generated from the doc comments; test/reference.test.ts checks them.
    docs/*-reference.md) code=true ;;
    # What test/reference.test.ts also reads: the guides' headings and
    # examples (@see anchors, verbatim widget examples) and the screenshots.
    docs/jupyter-api.md | docs/widgets.md | docs/images/widgets/*) code=true ;;
    *.md | docs/* | site/* | LICENSE) ;;
    *) code=true ;;
  esac
done <<EOF2
$files
EOF2

echo "code=$code"
