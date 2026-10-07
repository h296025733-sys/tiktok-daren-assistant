from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_backend_entry_ai_runtime_self_test() -> None:
    repository_root = Path(__file__).resolve().parents[2]
    completed = subprocess.run(
        [
            sys.executable,
            str(repository_root / "packaging" / "backend_entry.py"),
            "--self-test-ai-runtime",
        ],
        cwd=repository_root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr or completed.stdout
    payload = json.loads(completed.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert payload["python_bits"] == 64
    assert "int8" in payload["cpu_compute_types"]
