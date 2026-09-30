"""CLI of the scratch provider: ``hermes <name> status|selftest`` (spike only)."""

import json
import os

_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))


def _log(event):
    path = os.environ.get("SCRATCH_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"provider": _NAME, "hook": "cli", "event": event}) + "\n")


def scratch_command(args):
    sub = getattr(args, "scratch_action", None) or "status"
    _log("command:" + sub)
    print("%s %s: ok (scratch provider, no backend)" % (_NAME, sub))
    return 0


def register_cli(subparser):
    _log("register_cli")
    subs = subparser.add_subparsers(dest="scratch_action")
    subs.add_parser("status", help="Print scratch provider status")
    subs.add_parser("selftest", help="Run the scratch provider self-test")
    subparser.set_defaults(func=scratch_command)
