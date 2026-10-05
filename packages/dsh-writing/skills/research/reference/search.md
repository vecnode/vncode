# Search: finding the literature, and knowing when you have

The search is the part of a review that is easiest to fake and easiest to
criticise. Record it as you go, in a ledger, because the Method section of the
review is written from that ledger - and because the ledger is what proves you
looked before you claimed a gap.

## The candidate ledger

One line per candidate, appended as you find it. Nothing here is a citation yet;
the `verified` column is the gate.

```
| # | Title (as found) | Venue/Year (as found) | Where found | URL | Verified |
```

Verified means: **you fetched the page and the title, authors, venue, year and
DOI on it match what you wrote.** Until then the row says "no". A ledger with
ten rows of "no" is honest work; a document with ten unverified references is a
liability.

## The query ladder

Run these in order, and stop when two consecutive rungs return nothing new.

1. **Named artefact.** Everything in the field has a name: the tool, the
   language feature, the project, the standard, the algorithm, the benchmark.
   `"Kani" Rust verifier`, `"Rust for Linux"`, `"Wasm" sandbox`.
2. **Venue + topic.** Peer review leaves fingerprints: the venue's name in the
   query. `Rust IEEE Transactions on Software Engineering`,
   `Rust verification PLDI`, `memory safety USENIX Security`. Prefer the venue
   that owns the subfield over a generic one.
3. **Method + domain.** `empirical study developers Rust`, `measurement study
   vulnerabilities C C++ comparison`, `controlled experiment Rust ownership`.
4. **Field terminology.** Take the words from the papers you have - the
   introduction and related-work sections name the field for you. A query in the
   requester's words finds the same three blog posts; a query in the field's
   words finds the papers.
5. **Snowball, backward.** Open the best paper's reference list and pull the
   entries that are central to its argument.
6. **Snowball, forward.** On the publisher page (or Google Scholar, or the ACM/IEEE
   "cited by" tab) find what cites it. A recent survey citing your paper is the
   fastest route to the current state of the art.
7. **Reviewer's queries.** `survey`, `systematic literature review`, `mapping
   study`, `experience report`, `benchmark`, `dataset`, `replication`,
   `negative results`, `industrial case study`. These are the papers that
   summarise a field, and the ones a state-of-the-art section cites first.
8. **The adjacent field's name.** The same idea has a different name in the
   neighbouring community (formal methods call it "verification", systems calls
   it "safety", security calls it "memory safety", industry calls it
   "compliance"). Search each name.

### Time-boxing and saturation

- **Two rungs with no new sources means the search is saturating.** Say so in
  the Method section; that sentence is what makes the gap claim defensible.
- A **recent survey** in the field is worth more than twenty more search
  results: it is the search you did not have to run, by people who had more
  time. Read its table of included work.
- When the requester asks for "the latest", give the newest and the *most
  recent that is peer-reviewed* - and label which is which. A 2024 preprint is
  not "the state of the art" in the sense a decision-maker usually means.

## Venue families worth targeting

Target these by name in queries; the search engine rewards it.

| Family | Venues | Good for |
|---|---|---|
| IEEE software engineering | *IEEE Trans. Software Eng.* (TSE), *IEEE Software*, ICSE, FSE, ASE, ISSTA, MSR | empirical studies, developer behaviour, defect and security measurement |
| IEEE security | *IEEE S&P*, *IEEE Trans. Dependable Secure Comput.* (TDSC) | memory safety, exploitability, unsafe code |
| IEEE systems / architecture | *IEEE Trans. Comput.* (TC), *IEEE Micro*, HPCA, ISCA, MICRO, ASPLOS | runtime, allocators, concurrency, architecture support |
| IEEE real-time / embedded / industrial | RTSS, *IEEE Trans. Ind. Informat.*, *IEEE Internet Things J.*, *IEEE Embedded Syst. Lett.* | deterministic behaviour, certification, embedded deployment |
| IEEE/ACM programming languages | PLDI, POPL, OOPSLA, ECOOP | type systems, verification, soundness of abstractions |
| ACM systems | SOSP, OSDI, EuroSys, ASPLOS | kernel and server work in practice |
| USENIX | ATC, Security, OSDI, FAST | deployable systems and measurement |
| Springer / Elsevier journals | *Empir. Softw. Eng.* (EMSE), *J. Syst. Softw.* (JSS), *Inf. Softw. Technol.* (IST), *Form. Methods Syst. Des.* | longer empirical and formal work |
| Preprints | arXiv (`arXiv:…`), and the authors' own pages | the frontier, clearly labelled as preprint |

A paper in a venue you have never heard of is not automatically bad, but it
carries the burden of proof: check the editorial board, and check whether the
papers you already respect cite it.

## Reading a publisher or preprint page

Fetch the landing page and read **all** of it before you write anything down:

- Title, author list (**all** authors, and their order - it is alphabetical in
  some fields, which changes who the first author is).
- Venue, volume, issue, pages, month and year of **publication** (an
  "early access" date is not the issue date).
- **DOI**, and the licence (some papers cannot be redistributed).
- **Retraction or withdrawal notices** - usually a banner. Check it.
- The abstract, and the "Cited by" / "References" sections for snowballing.
- For arXiv: the **version** (`v1`, `v3`) and whether a published version now
  exists - cite the published one if it does, and note the arXiv id only if it
  is the only form.

If the full text is behind a paywall, the abstract plus the citation is still
usable for "recent work proposes"; it is not usable for a number. Say which
parts you could read.

## Full text, when you have it

- A PDF is read with the `pdf_*` tools: `pdf_info` first (is it a scan, how many
  pages), `pdf_find` to locate the numbers, `pdf_read` in `layout` mode for
  two-column papers and tables. Never read a PDF's bytes.
- Extract numbers from the **results tables**, not the abstract, when they
  disagree - and report which you used.
- Record the **page number** for anything you quote, so a reader can check it.

## Recording the search, for the Method section

Keep these four facts; they are the Method section:

1. **Queries actually run** (the ones that produced citations, not every try).
2. **Venues and indexes searched** and the **time window** used.
3. **Inclusion / exclusion rules** - language, venue type, window, what was
   dropped and why.
4. **The date of the search.** "The latest work" is a claim about a moment.
