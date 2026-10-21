#!/usr/bin/env python3
"""Build source-tank toolbar glyphs, marks, tab icons and the offline preview."""
from pathlib import Path
import base64, json, re, runpy
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
WORK = HERE / 'proofs'
WORK.mkdir(exist_ok=True)
runpy.run_path(str(HERE / 'build-marks.py'))
LIGHT = dict(ink='#14130F', paper='#FAF9F4', tint='#F1DFD4', accent='#C4552A')
DARK = dict(ink='#E9E6DF', paper='#141311', tint='#301E15', accent='#C4552A')
# Native pixel grids: half-pixel centre lines for odd strokes, integers for even.
DRAWINGS = {
    16: dict(bubble='M7.5 1.5H11.5Q14.5 1.5 14.5 4.5V9.5Q14.5 12.5 11.5 12.5H9.5L6.5 14.5V12.5Q4.5 12.5 4.5 10.5V4.5Q4.5 1.5 7.5 1.5Z', left=4.5, right=14.5, level=4.5, valve=(2.5,9.5,1.5), feed=.5, stroke=1, lever=1),
    32: dict(bubble='M14 3H24Q30 3 30 9V19Q30 25 24 25H19L13 29V25Q8 25 8 20V9Q8 3 14 3Z', left=8, right=30, level=9, valve=(4,19,3), feed=1, stroke=2, lever=2),
    48: dict(bubble='M21 4.5H36Q45 4.5 45 13.5V28.5Q45 37.5 36 37.5H28.5L19.5 43.5V37.5Q12 37.5 12 30V13.5Q12 4.5 21 4.5Z', left=12, right=45, level=13.5, valve=(6,28.5,4.5), feed=1.5, stroke=3, lever=3),
    128: dict(bubble='M54 10H104Q121 10 121 27V86Q121 103 104 103H82L49 118V103Q37 103 37 91V27Q37 10 54 10Z', left=37, right=121, level=28, valve=(17,81,10), feed=4, stroke=5, lever=7),
}


def icon(size, palette, uid):
    d = DRAWINGS[size]
    cx, cy, radius = d['valve']
    body = f"""<g id="square-chat-tank" transform="translate({size} 0) scale(-1 1)" stroke-linecap="round" stroke-linejoin="round" stroke-width="{d['stroke']}">
<defs><clipPath id="tank-{uid}"><path d="{d['bubble']}"/></clipPath></defs>
<path id="outgoing-feed" d="M{d['feed']} {cy}H{d['left']}" fill="none" stroke="var(--ink)"/>
<path id="chat-tank" d="{d['bubble']}" fill="var(--paper)"/>
<g clip-path="url(#tank-{uid})"><rect x="{d['left']}" y="{d['level']}" width="{d['right']-d['left']}" height="{size}" fill="var(--tint)"/>
<path id="fuel-level" d="M{d['left']} {d['level']}H{d['right']}" stroke="var(--accent)"/></g>
<path d="{d['bubble']}" fill="none" stroke="var(--ink)"/>
<g id="feed-valve"><circle cx="{cx}" cy="{cy}" r="{radius}" fill="var(--paper)" stroke="var(--ink)"/>
<path d="M{cx} {cy-d['lever']}V{cy+d['lever']}" stroke="var(--accent)"/></g></g>"""
    for key, value in palette.items():
        body = body.replace('var(--'+key+')', value)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-labelledby="title"><title id="title">Crossfeed Chat {size} pixel toolbar icon</title>{body}</svg>\n'


for ground, palette in [('light', LIGHT), ('dark', DARK)]:
    suffix = '' if ground == 'light' else '-dark'
    for size in DRAWINGS:
        (HERE / f'icon-{size}{suffix}.svg').write_text(icon(size, palette, f'{size}-{ground}'))
    (HERE / f'icon{suffix}.svg').write_text((HERE / f'icon-128{suffix}.svg').read_text())

def tab_icon(body, viewbox, title):
    # Dark fallback, light OS scheme swap, as in the canonical tab recipe.
    style = ':root{--i:#E9E6DF;--p:#141311;--t:#301E15;--h:#C4552A}@media(prefers-color-scheme:light){:root{--i:#14130F;--p:#FAF9F4;--t:#F1DFD4}}'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}"><title>{title}</title><style>{style}</style><rect width="16" height="16" rx="3" fill="var(--p)"/>{body}</svg>\n'

chat = icon(16, dict(ink='var(--i)', paper='var(--p)', tint='var(--t)', accent='var(--h)'), 'tab')
chat = re.search(r'<svg[^>]*>.*?</title>(.*)</svg>', chat, re.S).group(1)
(HERE / 'favicon.svg').write_text(tab_icon(chat, '0 0 16 16', 'Crossfeed Chat'))
# Native family 16 px drawing: two tanks, one high and one low, with a connecting valve.
parts = '<defs><clipPath id="l"><rect x="1" y="2" width="3" height="12" rx="1.5"/></clipPath><clipPath id="r"><rect x="12" y="2" width="3" height="12" rx="1.5"/></clipPath></defs><path d="M4.5 10.5H11.5" stroke="var(--i)" stroke-width="1"/>'
for x, level, side in [(0,5,'l'), (11,12,'r')]:
    parts += f'<rect x="{x+.5}" y="1.5" width="4" height="13" rx="2" fill="var(--p)"/><g clip-path="url(#{side})"><rect x="{x}" y="{level}" width="5" height="12" fill="var(--t)"/><path d="M{x} {level+.5}H{x+5}" stroke="var(--h)" stroke-width="1"/></g><rect x="{x+.5}" y="1.5" width="4" height="13" rx="2" fill="none" stroke="var(--i)" stroke-width="1"/>'
parts += '<circle cx="8" cy="10.5" r="1.6" fill="var(--p)" stroke="var(--i)" stroke-width="1"/><rect x="7.5" y="9.4" width="1" height="2.2" rx=".5" fill="var(--h)"/>'
console_tab = tab_icon(parts, '0 0 16 16', 'Crossfeed')
(HERE / 'console-tab.svg').write_text(console_tab)
# Theme-fixed proofs are only preview inputs, not alternate production recipes.
for ground in ['light','dark']:
    for name, svg in [('chat', (HERE/'favicon.svg').read_text()), ('console', console_tab)]:
        svg = re.sub(r'<style>.*?</style>', '', svg, flags=re.S)
        for k,v in [('i',LIGHT['ink'] if ground=='light' else DARK['ink']),('p',LIGHT['paper'] if ground=='light' else DARK['paper']),('t',LIGHT['tint'] if ground=='light' else DARK['tint']),('h',LIGHT['accent'])]:
            svg = svg.replace('var(--'+k+')',v)
        (WORK/f'tab-{name}-{ground}.svg').write_text(svg)

LOCKUP_WIDTH = float(re.search(r'viewBox="0 0 ([\d.]+) 48"', (HERE / 'lockup-light.svg').read_text()).group(1))
font_data = base64.b64encode((HERE / 'fonts/literata-wordmark.woff2').read_bytes()).decode('ascii')


def example(file, w, h):
    return (f'<article class="specimen"><h3><a href="{file}">{file}</a></h3><div class="pair">'+
            f'<figure><figcaption>Actual size · {w:g} × {h:g}</figcaption><div class="stage"><img src="{file}" width="{w}" height="{h}" alt="{file}, actual size"></div></figure>'+
            f'<figure><figcaption>4× · {w*4:g} × {h*4:g}</figcaption><div class="stage"><img src="{file}" width="{w*4}" height="{h*4}" alt="{file}, four times size"></div></figure></div></article>')

sections=[]
for ground in ['light','dark']:
    suffix = '' if ground == 'light' else '-dark'
    items = [example(f'mark-{ground}.svg',56,28)]
    if ground == 'light': items += [example('mark.svg',56,28)]
    items += [example(f'lockup-{ground}.svg',LOCKUP_WIDTH,48),example(f'icon{suffix}.svg',128,128)]
    for n in [16,32,48,128]: items += [example(f'icon-{n}{suffix}.svg',n,n)]
    for n in [16,32,48,128]: items += [example(f'icon-{n}{suffix}.png',n,n)]
    strips = []
    tabs = '<div class="tab-strip" aria-label="Browser tab icon proof">' + ''.join(f'<div class="tab"><img src="data:image/svg+xml,{quote((WORK/f"tab-{name}-{ground}.svg").read_text(), safe="")}" width="16" height="16" alt="{title} tab icon"><span>{title}</span></div>' for name,title in [('chat','Crossfeed Chat'),('console','Crossfeed')]) + '</div>'
    items.insert(0, tabs)
    for n in [16,32]:
        for zoom in [1,4]:
            strips.append(f'<figure class="toolbar-proof"><figcaption>{n} px toolbar · {zoom}×</figcaption><div class="toolbar-window"><div class="toolbar" style="--zoom:{zoom};--slot:{n}px" data-size="{n}" data-zoom="{zoom}" aria-label="{n} pixel Chrome toolbar approximation at {zoom} times"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8L10 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="address">chatgpt.com</span><img src="icon-{n}{suffix}.png" width="{n}" height="{n}" alt="Crossfeed Chat, {n} pixel source"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4H13M3 8H13M3 12H13" fill="none" stroke="currentColor" stroke-linecap="round"/></svg></div></div></figure>')
    sections.append(f'<section class="theme {ground}"><h2>{ground.title()}</h2><div class="toolbar-grid">'+''.join(strips)+'</div>'+''.join(items)+'</section>')

page=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crossfeed Chat · asset proof</title><style>
@font-face{{font-family:Literata;src:url(data:font/woff2;base64,{font_data});font-weight:200 900}}
:root{{--ground:#ECE9E1;--ink:#14130F;--muted:#56514A;--accent:#C4552A;color-scheme:light}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--ground);color:var(--ink);font:14px/1.5 system-ui,sans-serif;padding:32px}}
h1{{font:560 34px/1.15 Literata,serif;font-variation-settings:"opsz" 72;margin:0 0 12px}}h2{{font:560 25px/1.2 Literata,serif;margin:0 0 22px}}h3{{font:500 13px/1.4 system-ui,sans-serif;margin:0 0 10px}}
header p{{max-width:72ch;margin:0 0 10px}}.notes{{color:var(--muted)}}a{{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}}a:hover{{color:var(--accent)}}:focus-visible{{outline:2px solid var(--accent);outline-offset:4px}}::selection{{background:var(--accent);color:#FAF9F4}}
.theme{{padding:28px;margin-top:28px}}.light{{--paper:#FAF9F4;--ink:#14130F;--rule:#DDD8CC;--muted:#5A554C;background:var(--paper);color:var(--ink)}}.dark{{--paper:#141311;--ink:#E9E6DF;--rule:#37342E;--muted:#A6A199;background:var(--paper);color:var(--ink);color-scheme:dark}}
.tab-strip{{display:flex;gap:4px;margin:0 0 24px;padding:8px;background:var(--rule)}}.tab{{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--paper);border-radius:8px 8px 0 0;min-width:170px}}.toolbar-grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:28px}}.toolbar-window{{overflow:auto;scrollbar-color:var(--muted) var(--paper)}}.toolbar{{display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid var(--rule);width:270px;height:calc(var(--slot) + 20px);zoom:var(--zoom)}}.toolbar img,.toolbar svg{{flex-shrink:0}}.toolbar img{{image-rendering:pixelated}}.address{{flex:1;border:1px solid var(--rule);border-radius:18px;padding:5px 14px;font-size:12px;color:var(--muted)}}.back{{font-size:24px;line-height:1}}.specimen{{padding:20px 0;border-top:1px solid var(--rule)}}.pair{{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px}}figure{{margin:0;min-width:0}}figcaption{{font-size:12px;color:var(--muted);margin-bottom:12px;font-variant-numeric:tabular-nums}}.stage{{overflow:auto;padding:4px;scrollbar-color:var(--muted) var(--paper)}}img{{display:block;max-width:none}}footer{{margin-top:26px;color:var(--muted);max-width:72ch}}code{{font-size:12px}}
@media(max-width:760px){{body{{padding:16px}}.theme{{padding:20px 16px}}.pair{{grid-template-columns:1fr;gap:24px}}.toolbar-grid{{grid-template-columns:1fr}}h1{{font-size:28px}}}}
</style></head><body><header><h1>Crossfeed Chat*</h1><p>The toolbar glyph is a speech-bubble tank, full and feeding out through a valve on its right edge. The full left bubble supplies the low right tank in the wide mark.</p><p class="notes">Transparent exports, shown at their native size and 4×. Each icon size has its own square drawing. The 16 and 32 px sources use pixel-aligned strokes.</p><p class="notes">Light PNGs suit light toolbars; use the <code>-dark</code> set on dark toolbars. <code>mark.svg</code> follows the system colour scheme; the fixed variants work on an explicitly chosen ground.</p></header>{''.join(sections)}<footer>Literata 560, optical size 72, with the typed asterisk. Wordmarks are vector outlines and need no installed font. This sheet checks exported sizes and rendering; first-viewer recognition remains untested.</footer>
<script>window.REVIEW_LIBRARY={{project:'crossfeed-chat-assets',palettes:[{{id:'crossfeed-chat',name:'Crossfeed Chat',roles:{{ground:'#ECE9E1',surface:'#FAF9F4',ink:'#14130F',muted:'#56514A',accent:'#C4552A'}}}}],faces:[{{id:'literata',family:'Literata',role:'display',stack:'Literata, serif',licence:'web'}}],retired:[]}};</script></body></html>'''
(HERE/'preview.html').write_text(page)
print(json.dumps(dict(built='square vectors and preview.html',sizes=list(DRAWINGS))))
