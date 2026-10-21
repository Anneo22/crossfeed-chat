#!/usr/bin/env python3
"""Derive Chat's source tank from the live Crossfeed geometry."""
from pathlib import Path
import os, re

HERE = Path(__file__).resolve().parent
SOURCE = Path(os.environ['CROSSFEED_SOURCE_SVG']).read_text().strip()
PALETTES = {
    'light': dict(i='#14130F', p='#FAF9F4', t='#F1DFD4', h='#C4552A', paper='#FAF9F4'),
    'dark': dict(i='#E9E6DF', p='#141311', t='#301E15', h='#C4552A', paper='#141311'),
}
BUBBLE = 'M6 -24.6H8.4Q12 -24.6 12 -21V-4.192Q12 -0.592 8.4 -0.592H7.4L4.8 1.6V-0.592Q2.4 -0.592 2.4 -3V-21Q2.4 -24.6 6 -24.6Z'


def chat_body(uid):
    body = re.search(r'<svg[^>]*>(.*)</svg>', SOURCE, re.S).group(1)
    # Only the left tank and its clipping boundary change. All other geometry is copied.
    body = body.replace('<rect x="2.992" y="-24.008" width="8.415" height="22.823" rx="3.008"/>', f'<path d="{BUBBLE}"/>')
    body = body.replace('<rect x="2.4" y="-24.6" width="9.6" height="24.008" rx="3.6"', f'<path d="{BUBBLE}"')
    body = re.sub(r'<(?:style|title)\b[^>]*>.*?</(?:style|title)>', '', body, flags=re.S)
    body = re.sub(r'(<g id="source-tanks" transform=")[^"]*(")', r'\1translate(0 0)\2', body)
    if re.search(r'<(?:svg|image)\b', body):
        raise ValueError('Supply speech-tank geometry without embedded artwork')
    body = body.replace('<path class="cf-flow"', '<path visibility="hidden" class="cf-flow"')
    return body.replace('u15', uid)


def paint(body, palette):
    for key, value in palette.items():
        body = body.replace(f'var(--{key})', value)
    return body


for ground, palette in PALETTES.items():
    body = paint(chat_body(ground), palette)
    (HERE / f'mark-{ground}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 -27 50.5 29.5" width="56" height="28" role="img" aria-labelledby="title"><title id="title">Crossfeed Chat source tank</title>{body}</svg>\n')
    path = HERE / f'lockup-{ground}.svg'
    original = path.read_text()
    wordmark = re.search(r'<g id="literata-wordmark">.*?</g>', original, re.S).group(0)
    baseline = re.search(r'<path id="baseline"[^>]*/>', original).group(0)
    prefix = original.split('<path id="baseline"')[0]
    # Fit the canonical coordinates in the existing mark slot and keep the outlined type.
    path.write_text(prefix + baseline + f'<g transform="translate(-1.914 44.586) scale(1.276)">{paint(chat_body("lockup-"+ground),palette)}</g>' + wordmark + '</svg>\n')

style = ':root{--i:#14130F;--p:#FAF9F4;--t:#F1DFD4;--h:#C4552A}@media(prefers-color-scheme:dark){:root{--i:#E9E6DF;--p:#141311;--t:#301E15}}'
(HERE / 'mark.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 -27 50.5 29.5" width="56" height="28" role="img" aria-labelledby="title"><title id="title">Crossfeed Chat source tank</title><style>{style}</style>{chat_body("adaptive")}</svg>\n')
