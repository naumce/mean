# Documents

Drop reference material here — a CV, a job description, notes, code examples.

The app lists everything in this folder on its setup screen. Nothing is read
until the brief mentions it by name:

```
This is a coding challenge. Draw on @api-examples.py for house style,
and check @cv.md before claiming I have experience with something.
```

A file sitting here costs nothing. Only what the brief `@mentions` is sent,
which is what makes keeping a large notes file around practical.

## What can be read

Text formats: `.md`, `.txt`, `.json`, `.csv`, `.yaml`, `.toml`, and source
files (`.rs`, `.py`, `.js`, `.ts`, `.go`, `.java`, `.cs`, `.sql`, and friends).

PDF and Word are listed but greyed out. Export them to `.md` or `.txt` — in
Word, *Save As → Plain Text*; for a PDF, copy the text out. Reading them
directly is worth doing later; it is not worth blocking on now.

## Limits

400 KB per file. Not a technical ceiling — a guard against one oversized file
quietly becoming the most expensive thing in every question of the session.
The token estimate under the brief shows what you are about to commit to.

## Privacy

The contents of this folder are gitignored. Nothing here leaves the machine
unless a brief mentions it, and then only to whichever model API is configured.
