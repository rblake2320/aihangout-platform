"""Execute shipped PowerShell entrypoints with isolated fake npm/npx processes.

No network or Cloudflare action occurs. This proves command sequencing and exit
handling, not build validity or deployment success.
"""
import json
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    shell = shutil.which('pwsh')
    if not shell or os.name != 'nt':
        raise SystemExit('This native Windows regression requires pwsh and Windows.')
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    results = []
    for target in ('staging', 'prod'):
        for fail in ('build', 'dry-run', 'deploy', 'none'):
            with tempfile.TemporaryDirectory(prefix='aihangout-deploy-') as folder:
                root = Path(folder)
                scripts = root / 'scripts'
                scripts.mkdir()
                for name in (f'deploy-{target}.ps1', 'deploy-native.ps1'):
                    if name == 'deploy-native.ps1' and not (source / name).exists():
                        continue  # Original scripts did not have this helper.
                    shutil.copy2(source / name, scripts / name)
                calls = root / 'calls.txt'
                (root / 'npm.cmd').write_text(
                    '@echo off\necho build>>"%DEPLOY_TEST_CALLS%"\n'
                    + ('exit /b 23\n' if fail == 'build' else 'exit /b 0\n'))
                (root / 'npx.cmd').write_text(
                    '@echo off\nif "%~5"=="--dry-run" (\n'
                    'echo dry-run>>"%DEPLOY_TEST_CALLS%"\n'
                    + ('exit /b 24\n' if fail == 'dry-run' else 'exit /b 0\n')
                    + ')\necho deploy>>"%DEPLOY_TEST_CALLS%"\n'
                    + ('exit /b 25\n' if fail == 'deploy' else 'exit /b 0\n'))
                env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                           DEPLOY_TEST_CALLS=str(calls))
                run = subprocess.run([shell, '-NoProfile', '-File', str(scripts / f'deploy-{target}.ps1')],
                                     input='yes\n', text=True, capture_output=True, env=env,
                                     cwd=root, timeout=30)
                actual = calls.read_text().splitlines() if calls.exists() else []
                expected = ['build'] if fail == 'build' else (
                    ['build', 'dry-run'] if fail == 'dry-run' else ['build', 'dry-run', 'deploy'])
                passed = actual == expected and ((run.returncode == 0) == (fail == 'none'))
                passed = passed and ((('Deploy complete.' in run.stdout) == (fail == 'none')))
                results.append(dict(target=target, failure=fail, calls=actual,
                                    exit_code=run.returncode, passed=passed))
                if not passed:
                    print(run.stdout, run.stderr)
    receipt = json.dumps({'scope': 'native subprocess sequencing; npm/npx are fixtures',
                         'source': str(source),
                         'cases': results, 'passed': all(r['passed'] for r in results)}, indent=2)
    print(receipt)
    if args.receipt:
        with args.receipt.open('x', encoding='utf-8') as output:
            output.write(receipt + '\n')
    return 0 if all(r['passed'] for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
