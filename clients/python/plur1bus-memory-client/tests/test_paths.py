import json
import os
import sys
import unittest

from tests import FIXTURES_DIR

from plur1bus_memory_client import core_address, core_pid_path, core_token_path, default_home, is_absolute_home


def _load(name: str) -> list[dict]:
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as f:
        return json.load(f)


class PathsTest(unittest.TestCase):
    def test_core_address_matches_the_shared_vectors(self) -> None:
        vectors = _load("address-vectors.json")
        self.assertGreaterEqual(len(vectors), 10)
        platforms = {v["platform"] for v in vectors}
        self.assertTrue({"win32", "linux", "darwin"} <= platforms)
        for v in vectors:
            with self.subTest(home=v["home"], platform=v["platform"]):
                self.assertEqual(core_address(v["home"], v["platform"]), v["address"])

    def test_vectors_cover_the_review_focus_homes(self) -> None:
        homes = [v["home"] for v in _load("address-vectors.json")]
        self.assertIn("C:\\Users\\Jürgen A\\AppData\\Local\\PLUR1BUS", homes)
        self.assertTrue(any("\u0130" in h for h in homes), "a home containing U+0130")
        self.assertTrue(any(h.startswith("c:\\") for h in homes), "a lower-case drive letter")
        self.assertTrue(any(h.endswith("/") and h.startswith("/") for h in homes), "a POSIX home with a trailing '/'")

    def test_default_home_mirrors_resolve_home(self) -> None:
        for v in _load("home-vectors.json"):
            with self.subTest(v=v):
                got = default_home(v["env"], v["platform"], v["homeDir"], v.get("localAppData"), cwd=v["cwd"])
                self.assertEqual(got, v["home"])

    @unittest.skipIf(sys.platform == "win32", "a POSIX cwd")
    def test_default_home_uses_the_process_cwd_for_a_relative_home(self) -> None:
        self.assertEqual(default_home({"PLUR1BUS_HOME": "rel"}, "linux", "/h"), os.path.join(os.getcwd(), "rel"))

    def test_an_empty_plur1bus_home_counts_as_unset(self) -> None:
        self.assertEqual(default_home({"PLUR1BUS_HOME": ""}, "linux", "/h", cwd="/w"), "/h/.plur1bus")

    def test_run_files_live_under_run(self) -> None:
        self.assertEqual(core_token_path("/h/.plur1bus"), os.path.join("/h/.plur1bus", "run", "core.token"))
        self.assertEqual(core_pid_path("/h/.plur1bus"), os.path.join("/h/.plur1bus", "run", "core.pid"))

    def test_absolute_home_rules(self) -> None:
        self.assertTrue(is_absolute_home("/x", "linux"))
        self.assertFalse(is_absolute_home("x", "linux"))
        self.assertFalse(is_absolute_home("C:\\x", "linux"))
        self.assertTrue(is_absolute_home("C:\\x", "win32"))
        self.assertTrue(is_absolute_home("\\\\srv\\share", "win32"))
        self.assertFalse(is_absolute_home("rel\\x", "win32"))
        self.assertFalse(is_absolute_home("", "win32"))


if __name__ == "__main__":
    unittest.main()
