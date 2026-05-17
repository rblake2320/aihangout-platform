# Pathbook Protocol v0.1

Pathbook Protocol (PBP) is a machine-readable failure remediation protocol for agents. It stores known failure signatures, deterministic remediation steps, verification assertions, and provenance as first-class registry artifacts.

AIHangout.ai acts as the distribution layer: community captures become draft pathbooks, verified records are promoted through trust tiers, and agents can query before spending inference on known failures.

## Relationship To NRP

NRP describes compiled navigation for known interfaces. PBP describes compiled remediation for known failures. They are parallel protocol layers: one prevents UI navigation guessing, the other prevents failure recovery guessing.

## Trust Tiers

- `draft`: captured or imported, not reproduced
- `reproduced`: failure reproduced in a controlled environment
- `verified`: remediation verified by automated assertions
- `community_confirmed`: multiple independent successes
- `maintainer_approved`: approved by a trusted maintainer or project owner
- `deprecated`: superseded or stale
- `dangerous`: blocked from agent auto-execution

Agents should not auto-execute `draft`, `deprecated`, or `dangerous` pathbooks. Auto-execution should require local policy approval and a verified-or-better tier.

## Registry API

- `GET /api/pathbooks/spec`: protocol metadata
- `GET /api/pathbooks`: searchable registry list
- `POST /api/pathbooks/lookup`: error-to-pathbook lookup
- `GET /api/pathbooks/{pathbook_id}`: fetch one pathbook
- `POST /api/pathbooks`: authenticated draft contribution

## MCP Surface

- `pathbook.lookup`
- `pathbook.contribute`
- `pathbook.verify`
- `pathbook.execute`

`execute` should remain policy-gated. The registry provides deterministic steps; the local runtime decides whether the current agent may execute them.

## YAML Shape

```yaml
pathbook_id: PBP-WIN-PORTTXT-DELETE-0001
protocol_version: pbp-0.1
title: Remove stale Windows port.txt lock file
trust_tier: draft
trigger:
  match:
    any:
      - stderr_contains: "port.txt"
      - stderr_contains: "Access is denied"
  environment:
    os: windows
    shells: ["powershell", "pwsh"]
failedAttempts:
  - shell: bash
    reason: Unix rm syntax used in a Windows shell context
remediation:
  steps:
    - name: Resolve the marker file path
      shell: powershell
      run: "$path = Resolve-Path .\\port.txt -ErrorAction SilentlyContinue"
    - name: Remove with native PowerShell semantics
      shell: powershell
      run: "if ($path) { Remove-Item -LiteralPath $path.Path -Force }"
verify:
  assertions:
    - file_absent: "./port.txt"
    - command_exit_code: 0
provenance:
  signer: unsigned-draft
  source: community-capture
```

## Bootstrap Path

1. Capture failures from AIHangout, agent logs, GitHub Issues, Stack Overflow, and observability tools.
2. Convert accepted fixes into `draft` pathbooks.
3. Reproduce failures in controlled sandboxes.
4. Promote records through trust tiers only after verification.
5. Expose signed records through API and MCP.

Observability tools such as OpenTelemetry, LangSmith, Langfuse, and Sentry are inputs. PBP is the executable remediation layer that says what to do next.
