#!/bin/sh
# Fake tailor for erd-export tests.
# Set FAKE_NAMESPACE_MISSING=1 to simulate a namespace not found in config.
# Set FAKE_NO_OUTPUT=1 to simulate a run that exits 0 but writes no file.
if [ "$1" != "tailordb" ] || [ "$2" != "erd" ] || [ "$3" != "export" ]; then
  echo "::error::fake tailor: unsupported command: $*" >&2
  exit 1
fi
shift 3

NAMESPACE=""
OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ "${FAKE_NAMESPACE_MISSING:-}" = "1" ]; then
  echo "Error: namespace '$NAMESPACE' not found in local config.db" >&2
  exit 1
fi

echo "Type: \"Fake\" loaded from tailordb/fake.ts"
echo "Type: \"Other\" loaded from tailordb/other.ts"

if [ "${FAKE_NO_OUTPUT:-}" = "1" ]; then
  exit 0
fi

mkdir -p "$OUTPUT/$NAMESPACE/dist"
echo "<html></html>" > "$OUTPUT/$NAMESPACE/dist/index.html"
