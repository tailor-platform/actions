#!/usr/bin/env bash
# Usage: is-ghes.sh <server-url>
# Prints "false" for GitHub.com and GHE.com (Enterprise Cloud), "true" for GitHub Enterprise Server.
set -euo pipefail

case "$1" in
  https://github.com|https://*.ghe.com) echo false ;;
  *) echo true ;;
esac
