"""Observe an existing action after app restart; never create or approve actions.

Requires a named device and action. Keeps only companion TextView text, excluding
credential inputs. A bounded wait allows a real GET to finish without replaying it.
"""
import argparse
import datetime
import json
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--action', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    output = Path(args.evidence)
    output.mkdir(parents=True, exist_ok=False)

    def adb(*cmd):
        result = subprocess.run([args.adb, '-s', args.serial, *cmd],
                                capture_output=True, encoding='utf-8', timeout=30)
        if result.returncode:
            raise RuntimeError(f'ADB failed for {cmd[0]}: {result.returncode}')
        return result.stdout

    receipt = {'action_id': args.action, 'started_at': datetime.datetime.now(
        datetime.timezone.utc).isoformat(), 'status': 'FAIL', 'observations': []}
    try:
        if adb('get-state').strip() != 'device':
            raise RuntimeError('Named device is not connected')
        adb('shell', 'am', 'force-stop', 'com.aihangout.companion')
        adb('shell', 'am', 'start', '-n', 'com.aihangout.companion/.ui.MainActivity')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            adb('shell', 'uiautomator', 'dump', '/data/local/tmp/status-refresh-proof.xml')
            root = ET.fromstring(adb('shell', 'cat', '/data/local/tmp/status-refresh-proof.xml'))
            texts = [n.get('text', '') for n in root.iter('node')
                     if n.get('package') == 'com.aihangout.companion'
                     and n.get('class') == 'android.widget.TextView']
            text = '\n'.join(texts)
            receipt['observations'].append({'elapsed_observation': len(receipt['observations']),
                                            'text': text})
            # A1 observer verification must already exist: this script never creates it.
            matches = [line for line in text.splitlines() if args.action in line
                       and 'effectStatus=effect_verified' in line
                       and '[refreshed from server]' in line]
            if matches:
                receipt['status'] = 'PASS_DISPLAY_REFRESH_AFTER_RESTART'
                receipt['verified_line'] = matches[-1]
                break
            time.sleep(1)
        if receipt['status'] == 'FAIL':
            raise RuntimeError('Existing action did not display a fresh verified result within 30 seconds')
    except Exception as exc:
        receipt['error'] = str(exc)
        raise
    finally:
        receipt['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({'status': receipt['status'], 'receipt': str(output / 'receipt.json')}))


if __name__ == '__main__':
    main()
