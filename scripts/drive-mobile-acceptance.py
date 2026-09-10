"""Submit one named companion form on one explicitly selected test device.

Does not approve actions or retry submissions. Reads credentials only from a
private operator file; neither those credentials nor the UI XML are printed.
"""
import argparse
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--adb', required=True)
p.add_argument('--serial', required=True)
p.add_argument('--operator-file', required=True)
p.add_argument('--agent-name', required=True)
p.add_argument('--button', required=True, choices=[
    'Enroll + run one battery-status check',
    'Ask AI for help (backend model diagnosis -> web approval)',
])
a = p.parse_args()
credentials = json.loads(Path(a.operator_file).read_text(encoding='utf-8-sig'))

def adb(*args):
    r = subprocess.run([a.adb, '-s', a.serial, *args], capture_output=True,
                       text=True, encoding='utf-8', timeout=30)
    if r.returncode:
        # The command might contain a credential: never echo command or stderr.
        raise RuntimeError(f'ADB operation failed with exit {r.returncode}')
    return r.stdout

def nodes():
    adb('shell', 'uiautomator', 'dump', '/data/local/tmp/companion-acceptance.xml')
    root = ET.fromstring(adb('shell', 'cat', '/data/local/tmp/companion-acceptance.xml'))
    return [n for n in root.iter('node') if n.get('package') == 'com.aihangout.companion']

def tap(node):
    bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not bounds or node.get('enabled') != 'true':
        raise RuntimeError('Target is disabled or has invalid bounds')
    x, y, x2, y2 = map(int, bounds.groups())
    if x2 <= x or y2 <= y:
        raise RuntimeError('Target has no visible area')
    adb('shell', 'input', 'tap', str((x + x2)//2), str((y + y2)//2))

for index, value in enumerate([credentials['email'], credentials['password'], a.agent_name]):
    if not re.fullmatch(r'[A-Za-z0-9@._+\-]+', value):
        raise RuntimeError('Field value requires an input method this bounded driver does not support')
    fields = [n for n in nodes() if n.get('class') == 'android.widget.EditText']
    if len(fields) != 3:
        raise RuntimeError('Expected exactly three companion input fields; no input submitted')
    tap(fields[index])
    adb('shell', 'input', 'keycombination', '113', '29')
    adb('shell', 'input', 'text', value)
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
buttons = [n for n in nodes() if n.get('class') == 'android.widget.Button' and n.get('text') == a.button]
if len(buttons) != 1:
    raise RuntimeError('Named submit button absent or ambiguous; nothing submitted')
tap(buttons[0])
print(json.dumps({'serial': a.serial, 'button': a.button,
                  'observation': 'one tap command accepted; application outcome must be read separately'}))
