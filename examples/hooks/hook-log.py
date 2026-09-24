#!/usr/bin/env python3
"""Reference hook helper: log one line, or inject one line, for any hook event.

This file is **not loaded by anything**. It is a copy-paste reference: the three
window examples under `examples/hooks/` write each hook as a self-contained
one-liner on purpose, so a single file can be lifted out whole. When you would
rather not repeat that command 7 times, drop this script next to your hook files
and call it instead.

    python3 "$CLAUDE_PROJECT_DIR/.dsh/hooks/hook-log.py" chat
    python3 "$CLAUDE_PROJECT_DIR/.dsh/hooks/hook-log.py" construct --say "先读再改"

It reads the hook payload from stdin and decides what the event allows:

    event            what this script does
    ---------------  --------------------------------------------------------
    SessionStart     log; may inject (--say)
    UserPromptSubmit log; may inject (--say)
    PostToolUse      log; may inject (--say)
    SubagentStart    log; may inject (--say)
    PreToolUse       log only — this event cannot inject
    Stop             log only; --say goes to stderr with exit 2 (steer-continue)
    SubagentStop     log only — the runtime discards this event's output

Log path: `$DSH_HOOK_TRACE`, default `$CLAUDE_PROJECT_DIR/.dsh/hook-trace.log`. The
host does not forward `DSH_HOOK_TRACE` to hook commands, and the hook sandbox
mounts a private `/tmp`, so the default stays inside the workspace root.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

# Events whose output the runtime ignores. Saying something here is a mistake,
# so the script says so instead of pretending it worked.
OBSERVE_ONLY = frozenset({"SubagentStop"})
# Events that cannot carry additionalContext.
NO_INJECT = frozenset({"PreToolUse", "Stop", "SubagentStop"})
# The one event where injected text travels as a steering reason instead.
STEER = frozenset({"Stop"})

INTERESTING = (
    "source", "tool_name", "prompt", "cwd", "session_id",
    "stop_hook_active", "description", "subagent_type",
)


def summarize(payload: dict, event: str, window: str) -> str:
    for key in INTERESTING:
        value = payload.get(key)
        if value in (None, ""):
            continue
        text = " ".join(str(value).split())
        return f"{window} {event} {key}={text[:160]}"
    return f"{window} {event}"


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if a != "--say"]
    window = args[0] if args else "hook"
    say = argv[-1] if "--say" in argv and len(argv) > 2 and argv[-1] != "--say" else None

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as error:
        payload = {"unparsed_stdin": raw[:200], "error": str(error)}

    event = str(payload.get("event") or "")
    line = summarize(payload, event or "?", window)
    stamp = datetime.datetime.now().isoformat(timespec="seconds")
    with open(os.environ.get("DSH_HOOK_TRACE") or os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".dsh", "hook-trace.log"), "a") as sink:
        sink.write(f"{stamp} {line}\n")

    if say is None or event in OBSERVE_ONLY:
        return 0
    if event in NO_INJECT:
        if event in STEER:
            print(f"{say}（由 hook 要求继续）", file=sys.stderr)
            return 2
        print(f"hook-log.py: {event} cannot inject; --say ignored", file=sys.stderr)
        return 0
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": event, "additionalContext": say},
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
