# watch-backdrop

Whether anything the mod does puts a box over the video on the watch page.

`app-rules.captured.css` is a reduction of the shipped YouTube TV stylesheet,
captured verbatim. To refresh it against a newer app, save that stylesheet and
re-run the extractor:

```py
import re
src = open('main.css', encoding='utf-8').read()
rules = re.findall(r'([^{}]+)\{([^{}]*)\}', src)
KEEP = re.compile(r'(Vdm04|g511Kb|CPUvYc|app-quality-root|Gy3ftf|s3u3Oc|iLKnN|aeeFdf'
                  r'|ExC9Fb|SbI4Pb|wV7zuf|aNw44b|HVEgpe|video-stream|#container|#app-background)')
PAINTS = re.compile(r'background|z-index|position|height|width|top|left|right|bottom'
                    r'|content|display|opacity|transform')
for sel, body in rules:
    if KEEP.search(sel) and PAINTS.search(body):
        print(f'{sel.strip()}{{{body}}}')
```

`watch-chunk.captured.css` is the second capture, and the more important one.

**main.css is not the whole stylesheet.** The watch page ships its own in a
lazy-loaded chunk, and that chunk carries 320 `app-quality-root` selectors to
main.css's 231. Five fixes for "the video goes black when the controls come up"
were derived from main.css alone, and the rule actually doing it was never in
main.css:

```css
.XT6t8b{top:0;right:0;bottom:0;left:0;margin:auto;background-color:#0b0b0b;
        display:block;height:45rem;pointer-events:none;position:absolute;width:80rem}
.app-quality-root .XT6t8b{display:none}
```

To refresh it, save the watch page's chunk stylesheet and keep every rule whose
selector mentions `XT6t8b`, `G7qFFc`, `YceUtc`, `mWBAvd` or `iMpfAe`.

Three things to know about the captures.

**They are reductions, and a reduction can go stale.** A style whose selector
matches none of those names would not be in the file, and this harness would pass
while the app gained a new way to paint over the video. That is the price of not
vendoring half a megabyte of someone else's stylesheet; re-run the extractors
when the app updates.

**Derive from every stylesheet the page loads, not the first one you find.** That
is the specific mistake this directory exists to stop repeating, and it cost five
releases.

**The measurement is a screenshot, not a computed style.** The harness this
replaced asked `getComputedStyle(#container).backgroundColor` and nothing else,
which answers *which colour wins the cascade* and never *whether that colour
covers the video*. It was green before the fix it existed for, green after, and
would have been green under any diagnosis — which is how a commit shipped saying
it had fixed a black screen it had not touched. The positive control at the top
of the file is there for the same reason: without it, "the video is visible" and
"the measurement is broken" look identical.
