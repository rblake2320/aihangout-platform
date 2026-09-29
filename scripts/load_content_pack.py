#!/usr/bin/env python3
"""Load a sanitized content pack into a D1 environment as a dedicated bot account.

Safety properties, in order of importance:
  1. Refuses to run unless sanitize_content_pack.py exits 0 on the pack.
  2. Defaults to --env staging. Production requires --env production AND --i-mean-it.
  3. Idempotent: a problem with the same title under the bot account is skipped,
     so re-running does not duplicate content.
  4. Emits SQL to stdout with --dry-run and writes nothing.

The bot account is a normal user row with a deliberately unusable password hash --
content is loaded server-side, so the account never needs to log in. That keeps the
authorship attributable without creating a credential.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
DB = {"staging": "aihangout-staging", "production": "aihangout-database",
      "development": "aihangout-dev"}

BOT_USER = "eval-discipline-bot"
BOT_EMAIL = "eval-discipline-bot@bots.invalid"   # RFC 2606 reserved TLD, unroutable
BOT_HASH = "!bot-no-login"                       # not a valid hash -> cannot authenticate


def q(s) -> str:
    """SQL single-quote literal."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def sanitize_or_die(pack: Path) -> None:
    r = subprocess.run([sys.executable, str(HERE / "sanitize_content_pack.py"), str(pack)],
                       capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        sys.exit("REFUSING TO LOAD: the pack failed the sanitizer. Nothing was written.")


def build_update_sql(pack: dict) -> list:
    """Refresh the TEXT of already-loaded entries, matched by title.

    Needed because the insert path is idempotent on title, which silently means
    'never updates'. A corrected pack would scan clean locally and leave the old
    wording live — the same class of defect as a stale document sitting beside a
    newer one. --update is how a correction actually lands.
    """
    stmts = []
    for p in pack["problems"]:
        sol = p.get("solution") or {}
        tags = json.dumps(p.get("tags", []))
        stmts.append(
            "UPDATE problems SET "
            f"description = {q(p['description'])}, ai_context = {q(p.get('ai_context'))}, "
            f"tags = {q(tags)}, category = {q(p.get('category'))} "
            f"WHERE title = {q(p['title'])} AND agent_name = {q(BOT_USER)};"
        )
        if sol.get("solution_text"):
            stmts.append(
                "UPDATE solutions SET "
                f"solution_text = {q(sol['solution_text'])}, "
                f"code_snippet = {q(sol.get('code_snippet'))}, "
                f"why_explanation = {q(sol.get('why_explanation'))} "
                f"WHERE agent_name = {q(BOT_USER)} AND problem_id = "
                f"(SELECT id FROM problems WHERE title = {q(p['title'])});"
            )
    return stmts


def build_sql(pack: dict) -> list:
    stmts = [
        # bot account, idempotent
        f"INSERT OR IGNORE INTO users (username, email, password_hash, ai_agent_type, reputation) "
        f"VALUES ({q(BOT_USER)}, {q(BOT_EMAIL)}, {q(BOT_HASH)}, 'ai', 0);"
    ]
    for p in pack["problems"]:
        sol = p.get("solution") or {}
        tags = json.dumps(p.get("tags", []))
        # problem, skipped if an identically-titled one already exists for the bot
        stmts.append(
            "INSERT INTO problems (user_id, title, description, category, difficulty, status, "
            "ai_context, tags, industry, impact_level, time_to_solve, is_public, solver_type, agent_name) "
            f"SELECT u.id, {q(p['title'])}, {q(p['description'])}, {q(p.get('category'))}, "
            f"{q(p.get('difficulty','medium'))}, 'open', {q(p.get('ai_context'))}, {q(tags)}, "
            f"{q(p.get('industry','Technology'))}, {q(p.get('impact_level','medium'))}, "
            f"{q(p.get('time_to_solve','2-5 days'))}, TRUE, 'ai', {q(BOT_USER)} "
            f"FROM users u WHERE u.username = {q(BOT_USER)} "
            f"AND NOT EXISTS (SELECT 1 FROM problems x WHERE x.title = {q(p['title'])});"
        )
        if sol.get("solution_text"):
            stmts.append(
                "INSERT INTO solutions (problem_id, user_id, solution_text, code_snippet, "
                "why_explanation, is_verified, solver_type, agent_name) "
                f"SELECT pr.id, u.id, {q(sol['solution_text'])}, {q(sol.get('code_snippet'))}, "
                f"{q(sol.get('why_explanation'))}, FALSE, 'ai', {q(BOT_USER)} "
                f"FROM problems pr JOIN users u ON u.username = {q(BOT_USER)} "
                f"WHERE pr.title = {q(p['title'])} "
                f"AND NOT EXISTS (SELECT 1 FROM solutions s WHERE s.problem_id = pr.id "
                f"AND s.user_id = u.id);"
            )
    return stmts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pack")
    ap.add_argument("--env", default="staging", choices=list(DB))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--update", action="store_true",
                    help="refresh text of already-loaded entries (insert path is title-idempotent)")
    ap.add_argument("--i-mean-it", action="store_true",
                    help="required for --env production")
    a = ap.parse_args()

    if a.env == "production" and not a.i_mean_it:
        return print("production requires --i-mean-it (content becomes publicly visible)") or 2

    pack_path = Path(a.pack)
    sanitize_or_die(pack_path)
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    stmts = build_update_sql(pack) if a.update else build_sql(pack)
    print(f"\npack: {pack.get('pack')} v{pack.get('version')} — "
          f"{len(pack['problems'])} problems, {len(stmts)} statements, env={a.env}")

    if a.dry_run:
        print("\n--- DRY RUN, nothing written ---")
        for s in stmts:
            print(s[:160] + ("..." if len(s) > 160 else ""))
        return 0

    sql_file = HERE / f".load_{pack.get('pack')}_{a.env}.sql"
    sql_file.write_text("\n".join(stmts), encoding="utf-8")
    # shell=True: on Windows `npx` is a .cmd shim and is not directly executable
    # via CreateProcess. Arguments are fixed strings from an allow-list above, not
    # user input, so there is no injection surface here.
    cmd = (f'npx wrangler d1 execute {DB[a.env]} --env {a.env} '
           f'--remote --file "{sql_file}" --yes')
    print("running: " + cmd)
    r = subprocess.run(cmd, cwd=HERE.parent, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=600, shell=True)
    tail = (r.stdout or "")[-900:] + (r.stderr or "")[-900:]
    # wrangler emits emoji; a cp1252 console cannot encode them and print() would
    # raise AFTER the load already succeeded, making a success look like a failure.
    sys.stdout.write(tail.encode("ascii", "replace").decode("ascii") + "\n")
    sql_file.unlink(missing_ok=True)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
