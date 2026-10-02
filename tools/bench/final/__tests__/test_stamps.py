# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Arm code stamps (stamps.py): stable, content-sensitive, same algorithm as final.code_stamp."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import stamps as ST  # noqa: E402


class Stamps(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.root = Path(self._t.name)
        self.a, self.b = self.root / "a.py", self.root / "b.py"
        self.a.write_text("A = 1\n")
        self.b.write_text("B = 2\n")

    def tearDown(self):
        self._t.cleanup()

    def stamp(self, env=None, files=None):
        return ST.stamp_files(self.root, files or [self.a, self.b], env or {"K": "1"})["sha1"]

    def test_stable_when_nothing_changes(self):
        self.assertEqual(self.stamp(), self.stamp())
        self.assertEqual(len(self.stamp()), 16)

    def test_changes_when_a_listed_file_changes(self):
        before = self.stamp()
        self.b.write_text("B = 3\n")
        self.assertNotEqual(before, self.stamp())

    def test_unlisted_file_does_not_matter_and_env_does(self):
        before = self.stamp()
        (self.root / "c.py").write_text("C = 1\n")
        self.assertEqual(before, self.stamp())
        self.assertNotEqual(before, self.stamp(env={"K": "2"}))

    def test_algorithm_is_path_bytes_then_env_json(self):
        h = hashlib.sha1()
        for f, b in (("a.py", b"A = 1\n"), ("b.py", b"B = 2\n")):
            h.update(f.encode())
            h.update(b)
        h.update(json.dumps({"K": "1"}, sort_keys=True).encode())
        self.assertEqual(self.stamp(), h.hexdigest()[:16])

    def test_arm_files_exist_and_v2_lists_its_code(self):
        for arm in ("A", "B", "C", "V2"):
            for f in ST.arm_files(arm):
                self.assertTrue(f.exists(), f"{arm}: {f}")
        names = {f.name for f in ST.arm_files("V2")}
        self.assertTrue({"run_v2.py", "finalize_v2.py", "viewpoints.py", "pipeline.py", "rule.py", "worker.mjs"} <= names)

    def test_arm_stamp_env_sensitivity_and_header(self):
        s0 = ST.arm_stamp("V2", {})
        self.assertEqual(s0["sha1"], ST.arm_stamp("V2", {})["sha1"])
        self.assertNotEqual(s0["sha1"], ST.arm_stamp("V2", {"V2_SUGGEST_ONLY": "1"})["sha1"])
        line = ST.header_line({**s0, "arm": "V2", "git": {"sha": "abc", "dirty": True}}, "deadbeef")
        self.assertEqual(line, f"# prereg deadbeef arm V2 stamp {s0['sha1']} git abc+dirty")

    def test_final_py_uses_the_shared_algorithm(self):
        src = (Path(__file__).resolve().parents[1] / "final.py").read_text()
        self.assertIn("_stamps.arm_stamp(arm, wall_s=WALL_S)", src)
        self.assertNotIn("hashlib.sha1()", src.split("def code_stamp")[1].split("def t5_rule_ok")[0])


if __name__ == "__main__":
    unittest.main()
