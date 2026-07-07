#!/bin/sh
# Fake tailor-sdk for erd-schema-export/preview/comment integration tests.
# Set FAKE_NAMESPACE_MISSING=1 to simulate a namespace not found in config
# (applies to both export and diff).
if [ "$1" != "tailordb" ] || [ "$2" != "erd" ]; then
  echo "::error::fake tailor-sdk: unsupported command: $*" >&2
  exit 1
fi
SUBCOMMAND="$3"
shift 3

NAMESPACE=""
OUTPUT=""
HEAD_HTML=""
BASE_HTML=""
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --head-html) HEAD_HTML="$2"; shift 2 ;;
    --base-html) BASE_HTML="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ "${FAKE_NAMESPACE_MISSING:-}" = "1" ]; then
  echo "Error: namespace '$NAMESPACE' not found in local config.db" >&2
  exit 1
fi

case "$SUBCOMMAND" in
  export)
    echo "Type: \"Fake\" loaded from tailordb/fake.ts"
    echo "Type: \"Other\" loaded from tailordb/other.ts"
    mkdir -p "$OUTPUT/$NAMESPACE/dist"
    echo "<html>export:$NAMESPACE</html>" > "$OUTPUT/$NAMESPACE/dist/index.html"
    ;;
  diff)
    {
      echo "<html>"
      echo "diff:$NAMESPACE"
      [ -n "$HEAD_HTML" ] && echo "head:$(cat "$HEAD_HTML")"
      [ -n "$BASE_HTML" ] && echo "base:$(cat "$BASE_HTML")"
      echo "</html>"
    } > "$OUTPUT"
    ;;
  *)
    echo "::error::fake tailor-sdk: unsupported erd subcommand: $SUBCOMMAND" >&2
    exit 1
    ;;
esac
