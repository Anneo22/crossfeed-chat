#!/usr/bin/env python3
"""Validate the editable README SVG, or copy an explicitly supplied source.

The logo-only SVG is its own source. The title and subtitle belong in README.md.
"""
from pathlib import Path
import argparse
import shutil
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, help='Copy an approved logo-only header SVG')
args = parser.parse_args()
target = HERE / 'readme-header.svg'
source = args.source or target
text = source.read_text()
svg = ET.fromstring(text)
if '<text' in text or 'prefers-color-scheme:dark' not in text or 'prefers-reduced-motion:reduce' not in text:
    parser.error('The header must be logo-only and support both themes and reduced motion')
for node in svg.iter():
    href = node.get('href', node.get('{http://www.w3.org/1999/xlink}href', ''))
    if href and not href.startswith(('data:', '#')):
        parser.error('The header must not request external assets')
if args.source and source.resolve() != target.resolve():
    shutil.copyfile(source, target)
print('README header validated: logo-only, self-contained, themed, reduced-motion aware')
