"""The fixed shutdown deadline bounds every remaining journal append, including its lock wait."""
import unittest
from types import SimpleNamespace
from unittest import mock

import plur1bus


class ShutdownBudgetTest(unittest.TestCase):
    def test_an_append_finishing_after_the_deadline_does_not_start_another_capture(self) -> None:
        provider = plur1bus.Plur1busMemoryProvider()
        clock = [100.0]
        journal = mock.Mock()
        provider._journal = journal

        def append(entry, *, timeout):
            clock[0] += 0.2

        journal.append.side_effect = append
        first, second = {"id": "first"}, {"id": "second"}
        with mock.patch.object(plur1bus, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            provider._journal_append([first, second], timeout=0.1, deadline=100.1)
        self.assertEqual(journal.append.call_count, 1)
        self.assertEqual(journal.append.call_args.args, (first,))
        self.assertEqual(provider.lost, 1)
        journal.bump.assert_called_once_with(timeout=0.0, lost=1)

    def test_each_capture_lock_wait_uses_only_the_remaining_total_budget(self) -> None:
        provider = plur1bus.Plur1busMemoryProvider()
        clock = [100.0]
        journal = mock.Mock()
        provider._journal = journal

        def append(entry, *, timeout):
            clock[0] += 0.1

        journal.append.side_effect = append
        with mock.patch.object(plur1bus, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            provider._journal_append([{"id": "first"}, {"id": "second"}], timeout=0.5, deadline=100.4)
        waits = [call.kwargs["timeout"] for call in journal.append.call_args_list]
        self.assertEqual(len(waits), 2)
        self.assertAlmostEqual(waits[0], 0.4)
        self.assertAlmostEqual(waits[1], 0.3)
        self.assertEqual(provider.lost, 0)
