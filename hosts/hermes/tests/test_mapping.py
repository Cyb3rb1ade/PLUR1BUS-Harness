import json
import unittest

from plur1bus._client import pmc
from plur1bus.mapping import (
    CAPTURE_REQUEST_BUDGET,
    MAX_TURN_MESSAGES,
    SYSTEM_PROMPT_BLOCK,
    TOOL_METHODS,
    PLATFORM_TRUST,
    READ_ONLY_PROMPT_BLOCK,
    TOOL_SCHEMAS,
    TRUNCATED_MARKER,
    WRITE_TOOLS,
    IdentityRefused,
    ToolArgsError,
    caller_for,
    fold_platform,
    session_key_for,
    tool_params,
    trust_of,
    turn_messages,
)


class MappingTest(unittest.TestCase):
    def test_caller_for(self) -> None:
        self.assertEqual(caller_for("telegram", "42", "c-1").to_rpc(), {"channel": "cli", "accountId": "hermes:telegram", "userId": "42"})
        self.assertEqual(caller_for("cli", None, None).to_rpc()["accountId"], "hermes:cli")
        self.assertEqual(caller_for("cli", None, None).user_id, "local")
        self.assertEqual(caller_for("telegram", None, "chat-7").to_rpc(), {"channel": "cli", "accountId": "hermes:telegram", "userId": "chat-7"})
        self.assertEqual(caller_for("slack", "a\x00b\nc\x7f", None).user_id, "abc", "control characters stripped")
        self.assertEqual(len(caller_for("slack", "u" * 500, None).user_id), 128)
        self.assertEqual(caller_for("slack", 12345, None).user_id, "12345")

    def test_untrusted_platforms_are_claimed_and_never_alias_a_proved_user(self) -> None:
        for platform in ("email", "webhook", "sms", "some-new-platform"):
            self.assertEqual(trust_of(platform), "claimed", platform)
        a = caller_for("email", "boss@example.com", None)
        self.assertEqual(a.account_id, "hermes:email:claimed")
        self.assertRegex(a.user_id, r"^claimed-[0-9a-f]{32}$")
        self.assertNotIn("boss", a.user_id, "the claimed id is hashed, not echoed")
        self.assertEqual(a, caller_for("email", "boss@example.com", "other-chat"), "same claimed id, same identity")
        self.assertNotEqual(a, caller_for("email", "boss@example.org", None))
        # A sender who claims the id of a proved telegram user lands in another namespace.
        self.assertNotEqual(caller_for("webhook", "42", None).account_id, caller_for("telegram", "42", None).account_id)
        self.assertEqual(caller_for("Email", "x", None).account_id, "hermes:email:claimed")

    def test_trust_table_is_data(self) -> None:
        self.assertEqual(set(PLATFORM_TRUST.values()), {"trusted", "local"}, "only the believed platforms are listed")
        self.assertEqual(PLATFORM_TRUST["cli"], "local")
        self.assertEqual(trust_of(None), "local")

    def test_no_id_on_a_non_local_platform_is_refused_not_shared(self) -> None:
        for platform in ("telegram", "email", "webhook", "unknown"):
            for uid, cid in ((None, None), ("", "  "), ("\x00", "\n")):
                with self.assertRaises(IdentityRefused, msg=(platform, uid, cid)):
                    caller_for(platform, uid, cid)
        self.assertEqual(caller_for("cli", None, None).user_id, "local", "a local session has one user")

    def test_write_tools_are_the_three_that_change_or_share(self) -> None:
        self.assertEqual(WRITE_TOOLS, {"plur1bus_memory_forget", "plur1bus_memory_correct", "plur1bus_memory_share"})
        self.assertTrue(WRITE_TOOLS <= set(TOOL_METHODS))
        for word in ("forget", "correct", "share"):
            self.assertNotIn(word, READ_ONLY_PROMPT_BLOCK)
            self.assertIn(word, SYSTEM_PROMPT_BLOCK)

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
