# Fast Markdown Renderer

[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blueviolet)](https://make.fun)

A fast, dependency-free Markdown renderer written in plain JavaScript, built
for the make.fun `markdown-render-speed-02` competition. It renders Markdown
to HTML byte-identically to [marked](https://github.com/markedjs/marked)
18.1.3 (default options: GFM, no breaks, no pedantic mode), while aiming to be
noticeably faster than marked itself.

## How it works

- **Line-based block parser** — the input is split once and walked with a
  cursor; blocks (ATX/setext headings, fenced and indented code, blockquotes,
  lists, HTML blocks, tables, paragraphs) are recognised by small hand-written
  matchers, with no regex backtracking hot spots.
- **Single-pass inline scanner** — the inline parser jumps from one special
  character to the next and flushes plain text in bulk; emphasis is resolved
  with the CommonMark delimiter-run algorithm, and links, images, autolinks,
  GFM autolinks, code spans, entities, and hard/soft breaks are all handled
  inline.
- **No dependencies, no cache** — every call to `parse()` is independent and
  stateless; the module is a single ES module file (`parse.js`) plus a tiny
  driver (`main.ts`).

## Usage

```js
import { parse } from "./parse.js";

parse("# Hello\n\nThis is **Markdown**.");
// "<h1>Hello</h1>\n<p>This is <strong>Markdown</strong>.</p>\n"
```

The driver (`main.ts`) reads `cases.json` from the input directory and writes
`html.json` to the output directory, following the competition's contract.

## Compatibility

Output is byte-identical to marked 18.1.3 with default options on the
competition's practice set (720 cases), including its GFM extensions
(strikethrough, tables, task lists, extended autolinks) and its entity
handling.

## Credit

Marked is Copyright (c) 2011-2018, Christopher Jeffrey, and is released under
the MIT License. This project is an original reimplementation written for the
competition; it is not a fork of marked's source.

## License

MIT — see `LICENSE`.
