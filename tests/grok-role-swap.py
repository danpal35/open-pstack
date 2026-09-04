"""Check artifacts from a live Grok-parent writer/reviewer swap in T3.

Usage: python3 tests/grok-role-swap.py /path/to/verification-project [evidence-directory]
The project has grok-writer/ and terra-writer/, each with calc.py and check.py.
Receipts and final responses are under evidence/. Run the writers, then review
each implementation with the other model, through the installed runner.
"""

import json
from pathlib import Path
import subprocess
import sys


def verify(root, evidence):
    expected = {
        ("grok-writer", "isolated-write", "grok"): ("grok-4.6", "high"),
        ("terra-writer", "isolated-write", "codex"): ("gpt-5.6-terra", "medium"),
        ("grok-writer", "read-only", "codex"): ("gpt-5.6-terra", "medium"),
        ("terra-writer", "read-only", "grok"): ("grok-4.6", "high"),
    }
    found = set()
    for path in sorted(evidence.rglob("*.json")):
        receipt = json.loads(path.read_text())
        if not isinstance(receipt, dict) or "schemaVersion" not in receipt:
            continue
        key = (Path(receipt["cwd"]).name, receipt["mode"], receipt["provider"])
        if key not in expected:
            continue
        assert receipt["parent"] == "grok", (path, "wrong parent")
        assert receipt["status"] == "complete", (path, receipt["status"])
        assert receipt["exitCode"] == 0, (path, "child failed")
        assert (receipt["model"], receipt["effort"]) == expected[key], path
        if receipt["provider"] == "grok":
            assert receipt["modelVerified"] is True, path
            assert receipt["modelEvidence"] == "provider-report", path
            argv = receipt["argv"]
            sandbox = argv[argv.index("--sandbox") + 1]
            permission = argv[argv.index("--permission-mode") + 1]
            if receipt["mode"] == "read-only":
                assert (sandbox, permission) == ("read-only", "auto"), path
            else:
                assert (sandbox, permission) == ("workspace", "acceptEdits"), path
            assert "--always-approve" not in argv, path
        else:
            assert receipt["modelEvidence"] in ("provider-report", "pinned-argv"), path
        output = Path(receipt["outputPath"]).read_text().strip()
        assert output, path
        if receipt["mode"] == "read-only":
            assert "PASS" in output and "FAIL" not in output, (path, "review did not pass")
        assert key not in found, (path, "duplicate route; select one evidence directory")
        assert Path(receipt["cwd"]).resolve() == root / key[0], path
        found.add(key)
        print(f"PASS {key}: {receipt['model']}@{receipt['effort']} parent=grok")
    assert found == set(expected), f"Missing successful routes: {set(expected) - found}"
    for directory in ("grok-writer", "terra-writer"):
        result = subprocess.run(
            [sys.executable, "check.py"], cwd=root / directory,
            check=True, text=True, capture_output=True,
        )
        assert result.stdout.strip() == "PASS", directory
        print(f"PASS {directory}/check.py")


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve()
    evidence = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else root / "evidence"
    verify(root, evidence)
