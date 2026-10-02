import json
import unittest

from plur1bus._client import pmc
from plur1bus.mapping import (
    CAPTURE_REQUEST_BUDGET,
    MAX_TURN_MESSAGES,
    SYSTEM_PROMPT_BLOCK,
    TOOL_METHODS,
    TOOL_SCHEMAS,
    TRUNCATED_MARKER,
    ToolArgsError,
    caller_for,
    fold_platform,
    session_key_for,
    tool_params,
    turn_messages,
)


class MappingTest(unittest.TestCase):
    def test_caller_for(self) -> None:
        self.assertEqual(caller_for("telegram", "42", "c-1").to_rpc(), {"channel": "cli", "accountId": "hermes:telegram", "userId": "42"})
        self.assertEqual(caller_for("cli", None, None).to_rpc()["accountId"], "hermes:cli")
        self.assertEqual(caller_for("cli", None, None).user_id, "local")
        self.assertEqual(caller_for(None, None, "chat-7").to_rpc(), {"channel": "cli", "accountId": "hermes:local", "userId": "chat-7"})
        self.assertEqual(caller_for("slack", "", "  ").user_id, "local")
        self.assertEqual(caller_for("x", "a\x00b\nc\x7f", None).user_id, "abc", "control characters stripped")
        self.assertEqual(len(caller_for("x", "u" * 500, None).user_id), 128)
        self.assertEqual(caller_for("x", 12345, None).user_id, "12345")

    def test_fold_platform(self) -> None:
        self.assertEqual(fold_platform("Telegram"), "telegram")
        self.assertEqual(fold_platform("home assistant"), "home-assistant")
        self.assertEqual(fold_platform(""), "local")
        self.assertEqual(fold_platform(None), "local")
        self.assertEqual(len(fold_platform("p" * 50)), 32)

    def test_session_key_for(self) -> None:
        self.assertEqual(session_key_for("s-1", None), "s-1")
        self.assertEqual(session_key_for("s-1", "agent:main:telegram:dm:42"), "agent:main:telegram:dm:42")
        self.assertEqual(session_key_for("", ""), "hermes")
        long_key = "k" * 400
        a, b = session_key_for("", long_key), session_key_for("", long_key + "x")
        self.assertEqual(len(a), 256)
        self.assertNotEqual(a, b, "a long key keeps a distinguishing hash")
        self.assertEqual(a, session_key_for("", long_key), "stable")

    def test_turn_messages_user_and_assistant_only(self) -> None:
        self.assertEqual(turn_messages("q", "a", None), [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}])
        self.assertEqual(turn_messages("q", "", None), [{"role": "user", "content": "q"}])
        self.assertEqual(turn_messages("", "", None), [])
        history = [
            {"role": "system", "content": "you are helpful"},
            {"role": "user", "content": "old"},
            {"role": "assistant", "content": "old answer"},
            {"role": "user", "content": [{"type": "text", "text": "new"}, {"type": "image_url"}]},
            {"role": "tool", "content": "tool output with secrets"},
            {"role": "assistant", "content": "new answer"},
        ]
        self.assertEqual(turn_messages("", "", history), [{"role": "user", "content": "new"}, {"role": "assistant", "content": "new answer"}])
        many = [{"role": "user", "content": "u"}] + [{"role": "assistant", "content": f"a{i}"} for i in range(100)]
        self.assertEqual(len(turn_messages("", "", many)), MAX_TURN_MESSAGES)

    def test_long_turn_is_trimmed_under_one_line(self) -> None:
        huge = "y" * (5 * 1024 * 1024)
        turn = turn_messages("question", huge, None)
        size = len(json.dumps(turn, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        self.assertLessEqual(size, CAPTURE_REQUEST_BUDGET)
        self.assertTrue(turn[1]["content"].endswith(TRUNCATED_MARKER))
        self.assertEqual(turn[0]["content"], "question")
        caller = caller_for("cli", None, None)
        line = pmc.encode_request(1, "memory.capture", {"caller": caller.to_rpc(), "agentId": "hermes-x" * 8, "sessionKey": "s" * 256, "messages": turn, "wait": False})
        self.assertLessEqual(len(line), pmc.MAX_LINE)
        # Multi-byte and escaped characters are accounted in bytes, not characters.
        wide = turn_messages("\u00e4" * (3 * 1024 * 1024), '"\\\x01' * (1024 * 1024), None)
        size = len(json.dumps(wide, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        self.assertLessEqual(size, CAPTURE_REQUEST_BUDGET)
        self.assertTrue(any(m["content"].endswith(TRUNCATED_MARKER) for m in wide))

    def test_system_prompt_block_is_fixed_ascii(self) -> None:
        self.assertTrue(SYSTEM_PROMPT_BLOCK.isascii())
        self.assertIn("PLUR1BUS", SYSTEM_PROMPT_BLOCK)

    def test_tool_table(self) -> None:
        self.assertEqual(
            TOOL_METHODS,
            {
                "plur1bus_memory_list": "memory.list",
                "plur1bus_memory_show": "memory.show",
                "plur1bus_memory_forget": "memory.forget",
                "plur1bus_memory_correct": "memory.correct",
                "plur1bus_memory_share": "memory.share",
            },
        )
        self.assertEqual(set(TOOL_SCHEMAS), set(TOOL_METHODS))
        for name, schema in TOOL_SCHEMAS.items():
            self.assertEqual(schema["name"], name)
            self.assertEqual(schema["parameters"]["type"], "object")

    def test_tool_params(self) -> None:
        self.assertEqual(tool_params("plur1bus_memory_list", {}), {})
        self.assertEqual(tool_params("plur1bus_memory_list", {"topic": "x", "limit": 5, "junk": 1}), {"topic": "x", "limit": 5})
        self.assertEqual(tool_params("plur1bus_memory_share", {"id": "m", "target": "user"}), {"id": "m", "target": "user"})
        for name, args in (
            ("plur1bus_memory_list", {"limit": 0}),
            ("plur1bus_memory_list", {"limit": True}),
            ("plur1bus_memory_show", {}),
            ("plur1bus_memory_show", {"id": ""}),
            ("plur1bus_memory_correct", {"id": "m", "text": "t" * 8001}),
            ("plur1bus_memory_share", {"id": "m", "target": "all"}),
            ("plur1bus_memory_forget", "m-1"),
        ):
            with self.subTest(name=name, args=args), self.assertRaises(ToolArgsError):
                tool_params(name, args)


if __name__ == "__main__":
    unittest.main()
