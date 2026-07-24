"""Seed the registry with a dense narrow domain: Windows + bash agent-tooling
failures. Density in one domain is the answer to the cold-start trap — an
agent working in this niche should usually HIT on lookup.

Run: ``pathbook-seed [db_path]`` (default ./pathbook.db). Idempotent: records
that already exist are skipped. FRP-PORT001 is seeded and then promoted to
``reproduced`` via a real signed outcome report, matching its live state.
"""

from __future__ import annotations

import sys
from typing import Any

from .authoring import make_outcome_report, make_record
from .registry import Registry, RegistryError
from .signing import Keypair

SEEDS: list[dict[str, Any]] = [
    dict(
        record_id="FRP-PORT001",
        title="Stale port.txt / lock file blocks server restart (Windows + bash)",
        error_signature="OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted",
        trigger_yaml=(
            "when: restarting a local dev server on Windows\n"
            "symptom: bind fails with WinError 10048\n"
            "context: previous run left port.txt / lock file behind"
        ),
        remediation_yaml=(
            "steps:\n"
            "  - python: pathlib.Path('port.txt').unlink(missing_ok=True)\n"
            "  - remove any stale .lock file for the server\n"
            "  - restart the server process"
        ),
        verify_yaml="check: server starts and binds; new port.txt is written",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'taskkill /IM python.exe /F  # kills every python process incl. unrelated agents'\n"
            "  - 'rebooting: works but wastes minutes and loses session state'\n"
            "  - 'changing the port: hides the stale-lock root cause; breaks clients pinned to it'"
        ),
        ecosystem="python", runtime="windows-bash", token_savings_estimate=4000,
    ),
    dict(
        record_id="FRP-WIN032",
        title="WinError 32: file locked by another process during delete/rename",
        error_signature="PermissionError: [WinError 32] The process cannot access the file because it is being used by another process",
        trigger_yaml="when: deleting/renaming a file on Windows\nsymptom: WinError 32\ncontext: editor, indexer, or a previous run still holds a handle",
        remediation_yaml=(
            "steps:\n"
            "  - retry with backoff (0.2s, 0.5s, 1s) — most locks are transient (AV scan, indexer)\n"
            "  - if persistent: close the owning process handle first (identify via sysinternals handle.exe)\n"
            "  - for temp/log files: rename target to <name>.stale-<pid> instead of delete, clean up next run"
        ),
        verify_yaml="check: the delete/rename succeeds on retry",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'immediate infinite retry loop without backoff: spins CPU, keeps the lock contended'\n"
            "  - 'taskkill /F on explorer.exe or antivirus: destructive, does not release most handles'"
        ),
        ecosystem="python", runtime="windows-bash", token_savings_estimate=3000,
    ),
    dict(
        record_id="FRP-CHARMAP01",
        title="'charmap' codec UnicodeEncodeError printing to Windows console",
        error_signature="UnicodeEncodeError: 'charmap' codec can't encode character '\\u2713' in position 0: character maps to <undefined>",
        trigger_yaml="when: printing unicode (checkmarks, emoji, box-drawing) from Python on Windows\nsymptom: UnicodeEncodeError charmap",
        remediation_yaml=(
            "steps:\n"
            "  - set env PYTHONIOENCODING=utf-8 for the process\n"
            "  - or launch python with -X utf8\n"
            "  - \"persistent (PowerShell): [Environment]::SetEnvironmentVariable('PYTHONIOENCODING','utf-8','User')\""
        ),
        verify_yaml="check: the same print statement emits without exception",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'stripping all unicode from output: destroys information, breaks downstream parsers'\n"
            "  - 'sys.setdefaultencoding hacks: removed since Python 3, dead end'"
        ),
        ecosystem="python", runtime="windows-bash", token_savings_estimate=1500,
    ),
    dict(
        record_id="FRP-CRLF001",
        title="bash script fails with '\\r: command not found' (CRLF line endings)",
        error_signature="line 2: $'\\r': command not found",
        trigger_yaml="when: running a .sh script on Windows via git-bash/WSL\nsymptom: \"$'\\\\r': command not found or bad interpreter\"",
        remediation_yaml=(
            "steps:\n"
            "  - convert the file: sed -i 's/\\r$//' script.sh  (or dos2unix script.sh)\n"
            "  - prevent recurrence: git config core.autocrlf input; add '*.sh text eol=lf' to .gitattributes"
        ),
        verify_yaml="check: bash script.sh runs past line 1; file(1) no longer reports CRLF",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'editing the script in notepad to \"fix\" it: resaves with CRLF, loops the failure'\n"
            "  - 'core.autocrlf true for repos with shell scripts: reintroduces CRLF on checkout'"
        ),
        ecosystem="shell", runtime="windows-bash", token_savings_estimate=2000,
    ),
    dict(
        record_id="FRP-WINPY001",
        title="'python' not found in Git Bash on Windows (py launcher installed)",
        error_signature="bash: python: command not found",
        trigger_yaml="when: invoking python from git-bash on Windows\nsymptom: command not found though Python is installed",
        remediation_yaml=(
            "steps:\n"
            "  - use the launcher: py -3 instead of python\n"
            "  - or alias in ~/.bashrc: alias python='winpty py -3'\n"
            "  - or add %LOCALAPPDATA%\\Programs\\Python\\Python3xx to PATH"
        ),
        verify_yaml="check: python --version (or py -3 --version) prints a version",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'installing a second Python from the MS Store: creates the app-alias shim conflict'\n"
            "  - 'copying python.exe into System32: PATH pollution, breaks upgrades'"
        ),
        ecosystem="python", runtime="windows-bash", token_savings_estimate=1800,
    ),
    dict(
        record_id="FRP-WIN005",
        title="pip install fails with WinError 5 Access is denied (file in use / no perms)",
        error_signature="PermissionError: [WinError 5] Access is denied",
        trigger_yaml="when: pip install/upgrade on Windows\nsymptom: WinError 5 during file replacement\ncontext: target package is imported by a running process, or system site-packages",
        remediation_yaml=(
            "steps:\n"
            "  - stop processes importing the package (your running server/agent)\n"
            "  - pip install --user, or use a venv (python -m venv .venv)\n"
            "  - for upgrades of pip itself: python -m pip install --upgrade pip"
        ),
        verify_yaml="check: pip install completes; import of the package succeeds in a fresh interpreter",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'blanket admin elevation for every pip call: masks the venv problem, pollutes system site-packages'\n"
            "  - 'deleting site-packages directories by hand while python runs: half-installed state'"
        ),
        ecosystem="python", runtime="windows-bash", package_name="pip", token_savings_estimate=2500,
    ),
    dict(
        record_id="FRP-WIN206",
        title="WinError 206 / path too long on deep node_modules or nested build dirs",
        error_signature="FileNotFoundError: [WinError 206] The filename or extension is too long",
        trigger_yaml="when: installing/removing deeply nested dirs (node_modules, build trees) on Windows\nsymptom: WinError 206 or ENAMETOOLONG",
        remediation_yaml=(
            "steps:\n"
            "  - enable long paths (admin PowerShell): Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -Value 1\n"
            "  - git: git config --system core.longpaths true\n"
            "  - for removal of an existing too-deep tree: robocopy empty_dir target /MIR"
        ),
        verify_yaml="check: the failing file operation succeeds after the setting + new shell",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'del /s /q on the tree: fails on the same long paths that caused the error'\n"
            "  - 'moving the project to C:\\ root as a fix: mitigation, not remediation; recurs on deeper nesting'"
        ),
        ecosystem="node", runtime="windows-bash", token_savings_estimate=2200,
    ),
    dict(
        record_id="FRP-WINEP001",
        title="uvicorn/dev-server reload loop leaves orphaned child holding the port",
        error_signature="ERROR: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000): only one usage of each socket address",
        trigger_yaml="when: uvicorn --reload (or similar) crashed on Windows\nsymptom: next start cannot bind; no visible python window",
        remediation_yaml=(
            "steps:\n"
            "  - find the holder: netstat -ano | findstr :8000  -> PID\n"
            "  - kill exactly that PID: taskkill /PID <pid> /F\n"
            "  - restart the server; prefer --reload-dir to limit watcher scope"
        ),
        verify_yaml="check: netstat shows the port free, server binds",
        failed_attempts_yaml=(
            "do_not:\n"
            "  - 'taskkill /IM python.exe /F: kills unrelated python processes (agents, notebooks)'\n"
            "  - 'switching to a random port each restart: leaks one orphan per crash'"
        ),
        ecosystem="python", runtime="windows-bash", package_name="uvicorn", token_savings_estimate=3500,
    ),
]


def seed(registry: Registry, author_key: Keypair, author_id: str = "pathbook-seed") -> dict[str, Any]:
    added, skipped = [], []
    for spec in SEEDS:
        record = make_record(author_key, author_id=author_id, source="seed:windows-bash-v1", **spec)
        try:
            registry.contribute(record)
            added.append(spec["record_id"])
        except RegistryError as e:
            if e.code == "duplicate_id":
                skipped.append(spec["record_id"])
            else:
                raise
    # Promote FRP-PORT001 to `reproduced` with a real, signed, independent
    # outcome report — mirroring its live trust state.
    promoted = False
    if "FRP-PORT001" in added:
        verifier = Keypair.generate()
        application = registry.execute(
            "FRP-PORT001",
            executor_id="seed-verifier-1",
            executor_public_key=verifier.public_hex,
            allow_untrusted=True,
        )
        report = make_outcome_report(
            verifier, reporter_id="seed-verifier-1", pathbook_id="FRP-PORT001",
            outcome="success", verify_passed=True,
            application_id=application["application_id"],
            details="Reproduced on Windows 11 + git-bash: unlink(missing_ok=True) freed the bind.",
        )
        result = registry.report_outcome(report)
        promoted = result["trust_tier"] == "reproduced"
    return {"added": added, "skipped": skipped, "frp_port001_promoted": promoted}


def main() -> None:  # pathbook-seed entry point
    db = sys.argv[1] if len(sys.argv) > 1 else "pathbook.db"
    registry = Registry(db)
    result = seed(registry, Keypair.generate())
    print(f"seeded {len(result['added'])} pathbook(s) into {db}; "
          f"skipped {len(result['skipped'])} existing; "
          f"FRP-PORT001 -> reproduced: {result['frp_port001_promoted']}")


if __name__ == "__main__":
    main()
