---
name: research
description: Run a literature review the way it has to be run to be citable - scope the question, ladder the searches, triage a source by what it can actually support, verify every identifier by fetching it, extract what a builder can reuse, synthesize the state of the art, and write the result into a document whose references resolve. Covers venue and preprint hygiene, retractions, claim-to-source provenance, and the failure modes that turn a review into fiction.
whenToUse: Use when asked to research something, find papers, review the state of the art, compare techniques, gather evidence for a technical decision, or produce a literature review, annotated bibliography, reading list or citation list - and before writing any document that cites an external source.
---

# Research

A literature review is not a list of links. It is an **argument about what is
known**, backed by sources somebody else can open. Everything below exists to
keep two properties true: every claim traces to a source, and every source can
be reached by a reader who only has what you wrote.

## The one rule

**No identifier and no link you have not fetched.** A DOI, an ISBN, a page
number, an arXiv id, a venue, a year, an author list: if you did not read it on a
page you actually loaded, you do not write it. Search-result snippets are not
pages - they routinely report the wrong year, the wrong venue and a truncated
author list, and a model that has "seen" a paper in training will happily
complete a plausible DOI for it. A fabricated reference is worse than a missing
one: it survives review, gets cited onward, and destroys the document's
credibility the moment anyone clicks it.

**Every reference carries a link, and the link resolves.** A DOI is an
identifier; a reader needs an address. Each entry ends with the URL you loaded
(the publisher's landing page, the DOI under `https://doi.org/…`, the arXiv
abstract page, the conference's own presentation page) - never a search-result
URL, never a bare "Google Scholar" link, never a PDF mirror somebody uploaded.
Check it the same way you checked the identifier: fetch it, and if it does not
land on the document you are citing, fix it or drop the source. A reference whose
link 404s is a reference a reader cannot check, which is the same as no reference
and a worse look.

Two corollaries, both learned the hard way:

- **A citation you cannot resolve is deleted, not softened.** "A study found"
  with no resolvable source is a claim with no source. Delete it or find it.
- **Say what you could not verify.** `[identifier unverified]` or
  `[link not reachable]` beside a candidate is a professional result. A confident
  wrong DOI is not.

## Start from the decision, not the topic

Ask what the review is FOR. "Rust papers" is a topic; "which Rust verification
techniques can I put in a CI pipeline this quarter, and what do they cost?" is a
decision, and it changes what you search for, what counts as evidence, and when
you are finished. Write the question down, in one sentence, with its scope:
domain, time window, what is out of scope, and the reader you are writing for.

If the requester did not state the decision, state the one you are assuming and
proceed. A review that answers a question nobody asked is a reading list.

## The pipeline

Run the steps in order. Each one has an output that the next one consumes, and
that output is what makes the review auditable.

| # | Step | Output | Tools |
|---|---|---|---|
| 1 | Scope the question | one sentence + inclusion/exclusion rules | - |
| 2 | Search | a candidate ledger, unverified | `web_search` |
| 3 | Triage | rank, and a reason per candidate | judgement |
| 4 | Verify | title/venue/year/DOI confirmed **by fetching** | `web_fetch` |
| 5 | Extract | a per-source note, in your own words | `pdf_*` for full text |
| 6 | Synthesize | taxonomy, trend, gaps, build-ability | - |
| 7 | Write | the document, with references that resolve | `writing_write`, or a `.md` file |

Keep the ledger as you go. A review assembled from memory at the end is a
review with invented citations in it.

## Search: ladder the queries

One clever query finds one thing. A **ladder** finds the field:

1. **Named artefact.** The tool, project, standard or algorithm at the centre of
   the question (`"Kani" verifier`, `"Rust for Linux"`).
2. **Named venue + topic.** `Rust operating system IEEE Transactions on Software
   Engineering`, `Rust verification PLDI`. Venue-anchored queries are how you
   find peer-reviewed work instead of blog posts.
3. **Method + domain.** `empirical study Rust adoption`, `measurement study
   memory safety C C++`.
4. **Terminology the field uses** - found in the papers you already have, not
   invented. The introduction of a good paper names its own related work.
5. **Snowball, both directions.** Backward: the references of the best paper you
   found. Forward: fetch the publisher page and look at what cites it.
6. **The reviewer's queries.** `survey`, `systematic review`, `experience
   report`, `benchmark`, `dataset`, `replication` - these find the papers that
   summarise a field, which is what a state-of-the-art section needs.

Search in the language of the field, and then again in plain language: a paper
may say "memory-safe systems programming" where the requester said "Rust".

`reference/search.md` carries the query recipes, the venue families worth
targeting, and how to read a publisher page.

## Triage: match evidence to the claim

Not every source may support every claim. The rule is that the **strength of
the claim may not exceed the strength of the source**:

| Source | May support | May not support |
|---|---|---|
| Peer-reviewed paper (IEEE/ACM/Springer/Elsevier/USENIX) | method, measurement, comparison, negative result | that a tool is usable today |
| Systematic review / survey | the state of the art, the taxonomy, "field agrees" | a specific number from a primary paper |
| Preprint (arXiv and friends) | the frontier, "recent work proposes" | "it is established" |
| Standards, RFCs, official specs | what is required, what the interface is | performance or adoption |
| Official project docs / release notes | current API, current version, licence | research claims |
| Benchmarks, issue trackers, blog posts | engineering experience, a concrete failure | anything general |

Prefer the **most recent** work that is also **most authoritative**: a 2024
IEEE paper beats a 2019 one on the same question, and both beat a 2024 blog post
that reports them badly. When you must choose between recency and rigour, say
which you chose and why.

## Verify: fetch, then record the receipt

For every source that will appear in the document:

1. **Fetch the landing page** - publisher page, DOI resolver (`https://doi.org/…`)
   or arXiv abstract page. Not a search result.
2. Read off the **exact title, the author list, the venue, the year**, the
   **DOI** (or the arXiv id) and the **URL you actually loaded**. Every one of
   them goes into the reference: the URL is not decoration, it is how a reader
   gets to the paper.
3. Check that the thing you are citing **is the thing you read about**: same
   title, same authors. Two papers by the same group in the same year are the
   classic mix-up.
4. Record the **retrieval date** and re-check that the link still lands on the
   paper before you publish - a link that redirects to a different paper, a
   paywall home page or a 404 is a link to fix, not to ship.
5. Prefer the **publisher's own page** over any mirror, aggregator or PDF
   somebody re-uploaded: the publisher's page is the one that stays and the one
   that cannot be edited out from under your citation.
6. For anything load-bearing, check it is not **retracted** or **withdrawn**
   (the publisher page usually says so; `Retraction Watch` covers the rest).

`reference/citations.md` has the IEEE reference forms end to end - each with its
link - the "receipt" fields, and the checks that catch a paper that does not
exist.

## Extract: one note per source

Write a note for each source you keep, in your own words. Never paste an
abstract and call it a summary - the point of the step is that you understood
it, and an unsourced paraphrase of an abstract is how a wrong claim enters a
review.

```
Title:
Authors / Venue / Year / DOI:
Link I loaded (the URL that goes in the reference):
Claim it makes (one sentence, in my words):
Evidence (method, data, scale, baseline):
What it does NOT show (scope, threats to validity, what the authors say):
What I can reuse or build (technique, tool, dataset, number):
How I verified it (the pages fetched, and the date):
```

The "does not show" line is the one that keeps a state-of-the-art honest. Papers
are written by people who want to be believed; the limitations section is where
they tell you where the claim stops.

## Synthesize: build the picture, not the pile

A review is synthesis. Produce, in this order:

1. **A taxonomy** that groups the work by *what it does*, not by year or venue.
   The grouping is your contribution and it should be arguable.
2. **A trend** with evidence: what changed between the oldest and newest work,
   and what drove it.
3. **Agreement and disagreement**, named: "X and Y agree on Z; W reports the
   opposite under condition C."
4. **Gaps**, stated as work that does not exist or is not answered - not as work
   you did not find. "No paper measures the cost of C on real-time workloads" is
   a gap only if you searched for it.
5. **What a builder should do on Monday**, derived from the above, with the
   uncertainty attached.

Never average unrelated numbers into a conclusion. If paper A reports 3% and
paper B reports 40%, the finding is "the literature disagrees, and here is the
difference in their setups" - that is more useful than any mean.

## Write: the document is the deliverable

Unless asked otherwise, the review has this shape:

```
Title
Scope and question        - and what is out of scope
Method                    - queries run, venues searched, window, how sources were chosen and verified
Findings                  - the taxonomy / the table of sources
Per-source analysis       - the note, compressed: contribution, evidence, limits, reuse
Synthesis                 - trend, disagreement, gaps
Recommendation            - what to build or decide, with confidence and open questions
References                - IEEE style, every one verified, each with its DOI/URL
```

Write it into the **Writing tab** with `writing_write` (the `dsh-writing`
tools) so the requester gets a real editable document; a workbook-shaped
finding belongs in `writing_write` with `kind: "sheet"`. If this profile has no
such tool, write a `.md` file in the conversation folder - the Writing tab's
**Import** links it - and export a `.docx` when a file is wanted. Do not paste a
500-line review into chat as the deliverable; chat is where you report what you
produced and what you could not verify.

Cite in IEEE style by default (`[1]`, numbered in order of first mention). The
forms are in `reference/citations.md`, and **every one of them ends with a link**
- `doi: …` for the identifier and `[Online]. Available: …` for the address, so a
reader can click from the reference list to the paper. Every reference in the
list is mentioned in the text - a reference list with an uncited entry is a
reference list with padding.

## Failure modes to refuse

| Failure | What it looks like | The fix |
|---|---|---|
| Fabricated identifier | a DOI that resolves to a different paper, or 404s | fetch it; delete it if it does not resolve |
| Dead or wrong link | the reference carries a search URL, a mirror, or a link that moved | re-fetch it and put the page you landed on |
| Snippet-derived metadata | right title, wrong year or venue | read the landing page |
| Retracted source | the paper is withdrawn; the page says so | check the page, replace the source |
| Predatory / no-review venue | "International Journal of Advanced …", pay-to-publish, no editor | prefer venues the field actually cites |
| Claim inflation | "proves Rust eliminates memory bugs" | say what was measured, on what, at what scale |
| Recency theatre | a 2025 preprint cited as settled fact | label it as a preprint and as unsettled |
| Single-country, single-corpus result | one dataset, one vendor, one language | report the scope with the number |
| Citation padding | a list longer than the argument needs | one source per claim, the strongest |
| Silent gap | "no work exists" | say what you searched before claiming absence |
| Plagiarised prose | sentences from the abstract | your own words, or a quoted sentence with a page |

## Working files

- `reference/search.md` - query ladders, venue families, how to read a
  publisher or arXiv page, and how to snowball.
- `reference/citations.md` - IEEE reference forms, the receipt to record per
  source, DOI/URL hygiene, retraction checks, and the review's own citation
  block.

Provenance note for anything you produce: state the date you searched, because
"the latest work" is a claim about a moment, and the moment passes.
