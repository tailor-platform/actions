#!/bin/sh
# Fake tailor-sdk for generate-check tests.
# Set FAKE_GENERATE_DIRTY=1 to simulate a generate run that produces uncommitted changes.
case "$1" in
  generate)
    if [ "${FAKE_GENERATE_DIRTY:-}" = "1" ]; then
      echo "generated" > .generated
    fi
    ;;
  *)
    echo "::error::fake tailor-sdk: unsupported command: $1" >&2
    exit 1
    ;;
esac
