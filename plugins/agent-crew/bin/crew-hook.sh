#!/bin/sh
# Hook của plugin gọi vào đây, không gọi thẳng `node`: app GUI có thể chạy hook
# với PATH tối thiểu (/usr/bin:/bin), nơi không có node — đo được ở devtools hub
# 19/10. Không tìm thấy node thì im lặng thoát 0: hook không được chặn phiên.
NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] && [ -x "$NODE" ] || for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
  [ -x "$c" ] && NODE="$c" && break
done
[ -n "$NODE" ] && [ -x "$NODE" ] || exit 0
PATH="$(dirname "$NODE"):$PATH"; export PATH
exec "$NODE" "$(dirname "$0")/crew.mjs" hook "$@"
