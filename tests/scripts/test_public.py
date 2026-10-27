import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("public_check", ROOT / "scripts/audit_public.py")
public_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public_check)


class PublicFiles(unittest.TestCase):
    def scan(self, path, content):
        with tempfile.TemporaryDirectory(prefix="astercite-public-") as directory:
            root = Path(directory)
            (root / "configs").mkdir()
            (root / "configs/model.example.json").write_text(json.dumps({"model": {"base_url": "", "model_id": ""}}), encoding="utf8")
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf8")
            with patch.object(public_check, "candidates", return_value=["configs/model.example.json", path]):
                return public_check.audit(root)

    def test_product_files_and_blank_configuration_pass(self):
        self.assertEqual(self.scan("README.md", "Install the app and configure your model.")["status"], "passed")

    def test_private_research_and_workspace_paths_are_rejected(self):
        for path in ["reproduce/report.json", "docs/results.md", "tests/evaluation/example.json", ".local/session.json", ".release-work/notes.md", "configs/model.local.json", ".env.production", "private.key", "history.bundle"]:
            with self.subTest(path=path):
                result = self.scan(path, "{}")
                self.assertEqual(result["status"], "failed")
                self.assertIn("private_path", [entry["reason"] for entry in result["findings"]])

    def test_credentials_are_rejected_without_echoing_their_values(self):
        value = "gh" + "p_" + "a" * 36
        result = self.scan("sample.txt", value)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn(value, json.dumps(result))

    def test_conversation_records_are_rejected(self):
        value = json.dumps({"type": "session" + "_meta", "payload": {}})
        self.assertEqual(self.scan("notes.jsonl", value)["status"], "failed")

    def test_personal_paths_and_email_are_rejected(self):
        for value in ["C:" + "\\Users\\" + "private\\notes", "person" + "@" + "mail.example.org"]:
            with self.subTest(category="personal_data"):
                self.assertEqual(self.scan("notes.txt", value)["status"], "failed")

    def test_documentation_placeholders_are_allowed(self):
        self.assertEqual(self.scan("guide.md", "https://user:pass@example.invalid")["status"], "passed")

    def test_vendor_path_is_not_a_personal_data_exemption(self):
        result=self.scan("web/vendor/pdf.worker.mjs", "person" + "@" + "mail.example.org")
        self.assertEqual(result["status"],"failed")
        self.assertIn("modified_vendor_release",[entry["reason"] for entry in result["findings"]])
        self.assertIn("personal_email",[entry["reason"] for entry in result["findings"]])


if __name__ == "__main__":
    unittest.main()
