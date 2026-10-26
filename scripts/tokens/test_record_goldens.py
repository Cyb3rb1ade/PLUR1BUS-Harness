"""Protect reference provenance and read-only golden checks without network access."""
import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("record-goldens.py")


def recorder():
    spec = importlib.util.spec_from_file_location("record_goldens", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordGoldensTests(unittest.TestCase):
    def test_changed_source_bytes_refuse_reference_recording(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = pathlib.Path(scratch) / "ranks"
            path.write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                recorder().verified_bytes(path, "0" * 64)

    def test_check_reports_drift_without_rewriting_existing_or_missing_files(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = pathlib.Path(scratch) / "counts.json"
            module = recorder()
            with self.assertRaisesRegex(ValueError, "stale"):
                module.write_or_check(path, {"cases": []}, True)
            self.assertFalse(path.exists())
            module.write_or_check(path, {"cases": []}, False)
            module.write_or_check(path, {"cases": []}, True)
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "stale"):
                module.write_or_check(path, {"cases": [{"tokens": 1}]}, True)
            self.assertEqual(path.read_bytes(), before)

    def test_different_token_ids_with_equal_counts_are_refused(self):
        with self.assertRaisesRegex(ValueError, "token-ID mismatch"):
            recorder().verify_token_ids(
                lambda _text: [1, 2], lambda _text: [2, 1], ["same token count"]
            )

    def test_duplicate_fixture_ids_are_refused(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            recorder().validate_texts({"version": 1, "texts": [
                {"id": "same", "text": "A"}, {"id": "same", "text": "B"},
            ]})


if __name__ == "__main__":
    unittest.main()
