"""Offline checks of the live stack helper's observer read (``LiveStack.memories``; HM2 CI round 3)."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from tests.live import stack

UNAVAILABLE = json.dumps({"error": "E_CORE_UNAVAILABLE", "schema": "error/1", "degraded": {"reason": "core-unavailable"}})
UNKNOWN = json.dumps({"error": "E_AGENT_UNKNOWN", "schema": "error/1"})


def _err(stdout: str) -> stack.CliError:
    return stack.CliError(["plur1bus", "--json", "--home", "h", "memory", "list"], 1, stdout, "")


class MemoriesTest(unittest.TestCase):
    def stack_with(self, *answers: object) -> tuple[stack.LiveStack, mock.Mock]:
        s = object.__new__(stack.LiveStack)  # no temp home, no binary: only the read logic is under test
        queue = list(answers)
        # ``cli(check=False)`` returns a CliError instead of raising it (a side_effect list would raise exceptions).
        cli = mock.Mock(side_effect=lambda *a, **kw: queue.pop(0))
        s.cli = cli  # type: ignore[method-assign]
        return s, cli

    def test_a_busy_core_is_read_again(self) -> None:
        s, cli = self.stack_with(_err(UNAVAILABLE), _err(UNAVAILABLE), {"items": [{"text": "grey cabinet"}]})
        with mock.patch.object(stack.time, "sleep"):
            self.assertEqual(s.memories("hermes-default"), [{"text": "grey cabinet"}])
        self.assertEqual(cli.call_count, 3)
        for call in cli.call_args_list:
            self.assertEqual(call.args, ("memory", "list", "--agent", "hermes-default"))
            self.assertEqual(call.kwargs, {"check": False})

    def test_a_core_that_stays_unavailable_fails_with_the_last_error(self) -> None:
        last = _err(UNAVAILABLE)
        s, cli = self.stack_with(_err(UNAVAILABLE), last)
        clock = iter([0.0, 0.1, 99.0])
        with mock.patch.object(stack.time, "sleep"), mock.patch.object(stack.time, "monotonic", lambda: next(clock)):
            with self.assertRaises(stack.CliError) as cm:
                s.memories("hermes-default", busy_s=1.0)
        self.assertIs(cm.exception, last)
        self.assertEqual(cli.call_count, 2)

    def test_any_other_failure_is_not_retried(self) -> None:
        for answer in (_err(UNKNOWN), _err("not json")):
            s, cli = self.stack_with(answer)
            with self.assertRaises(stack.CliError):
                s.memories("hermes-default")
            self.assertEqual(cli.call_count, 1)


if __name__ == "__main__":
    unittest.main()
