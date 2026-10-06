# Copy, per destination

A design fails on its words far more often than on its colours. This file is GENERATED
from `lib/presets.js` by `vendor/copy-doc.mjs`: for every destination it lays out that
preset’s own starter, reads the type size each role actually gets, and divides the usable
width by it, so the budgets below are the destination’s own numbers rather than a guess.

The advance is 0.5em - the average the package’s checks measure with - so treat a budget as
**right to about ten percent**, and let the render be the authority. A line that fits the
budget and still overflows is a render’s job to catch, which is why the loop is
write → render → LOOK.

## The formulas

**The headline states a fact, not a mood.** It is the one line a person reads at feed
scale, so it has to survive being 25% of its size:

- *What changed*: "Nineteen plugins, one row each." / "Version 2 is out."
- *What it costs*: "One command, no config." / "Free for one machine."
- *What it refuses*: "No core patches." / "No account required."
- *Who it is for*: "For teams that read PDFs." / "For people who ship on Friday."

**The subhead carries the detail the headline dropped** - the audience, the constraint, the
date - and never restates the headline in smaller words.

**The eyebrow is a category, not a sentence**: a product name, a section, a date. Two or
three words, upper case, letter-spaced, in the muted ink.

**The CTA is a promise or an address, never both.** "Read the notes" or
"github.com/you/repo" - and if it is an address it is the shortest one that resolves.

## The rules that come from the lints

- One idea per text layer. Two sentences in one node is a composition that will wrap
  unpredictably; the `SIBLING_EDGE` rule wants them aligned, not merged.
- A headline is 3× the body size or it is a subtitle (`LOW_CONTRAST` and the gates in every
  style pack both lean on that ratio).
- Write the words BEFORE you style them: a style changes the palette and the metrics, and
  a line that only just fitted will not fit afterwards.
- Never write text whose contrast you have not checked: the muted ink is for the second
  voice, the accent is for one word, and `canvas_render` will name the ratio if you are wrong.

## The budgets, per destination

### github-social — GitHub social preview (1280×640)

- usable width: **1184px** (margin 48px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 113px | ~20 characters | ~3 words |
| body | 35px | ~67 characters | ~11 words |
| caption | 24px | ~98 characters | ~16 words |
- headline: **12–20 characters** (1–3 words) for a single line; two lines doubles it.
- subhead: **40–67 characters** and never more than two lines.
- where it goes: the repository page: Settings → General → Social preview → Upload an image

### github-readme — GitHub README header (1280×320)

- usable width: **1200px** (margin 40px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 56px | ~42 characters | ~7 words |
| body | 18px | ~133 characters | ~22 words |
| caption | 13px | ~184 characters | ~30 words |
- headline: **26–42 characters** (4–7 words) for a single line; two lines doubles it.
- subhead: **79–133 characters** and never more than two lines.
- where it goes: the top of README.md

### og — Open Graph card (1200×630)

- usable width: **1072px** (margin 64px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 111px | ~19 characters | ~3 words |
| body | 34px | ~63 characters | ~10 words |
| caption | 23px | ~93 characters | ~15 words |
- headline: **11–19 characters** (1–3 words) for a single line; two lines doubles it.
- subhead: **37–63 characters** and never more than two lines.
- where it goes: og:image in the page head

### linkedin-personal-banner — LinkedIn profile banner (1584×396)

- usable width: **1488px** (margin 48px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 70px | ~42 characters | ~7 words |
| body | 22px | ~135 characters | ~22 words |
| caption | 15px | ~198 characters | ~33 words |
- headline: **26–42 characters** (4–7 words) for a single line; two lines doubles it.
- subhead: **81–135 characters** and never more than two lines.
- where it goes: the profile: pencil → Edit background

### linkedin-company-banner — LinkedIn company page cover (1128×191)

- usable width: **1080px** (margin 24px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 36px | ~60 characters | ~10 words |
| body | 18px | ~120 characters | ~20 words |
| caption | 13px | ~166 characters | ~27 words |
- headline: **37–60 characters** (6–10 words) for a single line; two lines doubles it.
- subhead: **72–120 characters** and never more than two lines.
- where it goes: the Page admin view: Edit page → Cover image

### linkedin-post — LinkedIn post image (1200×627)

- usable width: **1088px** (margin 56px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 110px | ~19 characters | ~3 words |
| body | 34px | ~64 characters | ~10 words |
| caption | 23px | ~94 characters | ~15 words |
- headline: **11–19 characters** (1–3 words) for a single line; two lines doubles it.
- subhead: **38–64 characters** and never more than two lines.
- where it goes: a post

### linkedin-square — LinkedIn square post (1200×1200)

- usable width: **1008px** (margin 96px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 132px | ~15 characters | ~2 words |
| body | 41px | ~49 characters | ~8 words |
| caption | 28px | ~72 characters | ~12 words |
- headline: **9–15 characters** (1–2 words) for a single line; two lines doubles it.
- subhead: **29–49 characters** and never more than two lines.
- where it goes: a post

### linkedin-carousel-page — LinkedIn carousel page (1080×1350)

- usable width: **936px** (margin 72px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 119px | ~15 characters | ~2 words |
| body | 37px | ~50 characters | ~8 words |
| caption | 25px | ~74 characters | ~12 words |
- headline: **9–15 characters** (1–2 words) for a single line; two lines doubles it.
- subhead: **30–50 characters** and never more than two lines.
- where it goes: a document post (PDF) or a set of images

### x-post — X / Twitter post image (1600×900)

- usable width: **1440px** (margin 80px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 158px | ~18 characters | ~3 words |
| body | 49px | ~58 characters | ~9 words |
| caption | 33px | ~87 characters | ~14 words |
- headline: **11–18 characters** (1–3 words) for a single line; two lines doubles it.
- subhead: **34–58 characters** and never more than two lines.
- where it goes: a post

### poster-a3 — A3 poster (300 dpi) (3508×4961)

- usable width: **3088px** (margin 210px each side)
- what fits the full width:

| role | size | one line | roughly |
|---|---|---|---|
| display | 386px | ~16 characters | ~2 words |
| body | 119px | ~51 characters | ~8 words |
| caption | 81px | ~76 characters | ~12 words |
- headline: **9–16 characters** (1–2 words) for a single line; two lines doubles it.
- subhead: **30–51 characters** and never more than two lines.
- where it goes: a print shop or a large-format printer

## Reading this before you write

Put the destination first: the canvas decides the budget, the budget decides the words,
and the words decide whether the composition can hold them. If a headline cannot be said
inside the budget, it is two designs - a banner and a README header - not one long line.
