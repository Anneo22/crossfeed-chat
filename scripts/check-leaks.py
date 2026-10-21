#!/usr/bin/env python3
"""Refuse personal home paths and non-placeholder email addresses in tracked text."""
from pathlib import Path
import re
import subprocess
import sys

homes = re.compile(r'/(?:Users|home)/[A-Za-z0-9._-]+(?:/|\b)')
emails = re.compile(r'[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})')
failed = False
for raw in subprocess.check_output(['git', 'ls-files', '-z']).split(b'\0'):
    if not raw:
        continue
    path = Path(raw.decode())
    try:
        data = path.read_bytes()
        if b'\0' in data:
            continue
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        continue
    # Security fixtures deliberately use this literal URL userinfo placeholder.
    email_text = re.sub(r'https?://user(?::pass)?@', 'https://', text)
    if homes.search(text) or any(m.group(1).lower() not in {'example.com', 'example.org', 'example.test'} for m in emails.finditer(email_text)):
        print(f'Personal data pattern in {path}', file=sys.stderr)
        failed = True
sys.exit(int(failed))
