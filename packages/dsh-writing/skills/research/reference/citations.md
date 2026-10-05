# Citations: the receipt, the form, and the checks

A reference is a receipt for a claim. It has to be complete enough that a
reader with no access to your session can find the same document, and honest
enough that a reader who does find it recognises it.

## The link is part of the reference

Every entry ends with an address, and that address is **the page you loaded**:

- the publisher's landing page (`https://ieeexplore.ieee.org/document/…`,
  `https://dl.acm.org/doi/10.1145/…`, `https://www.usenix.org/conference/…`);
- or the DOI resolver under `https://doi.org/10.xxxx/yyyy`, which is the
  publisher's own redirect and the one form that survives a site redesign;
- or the arXiv abstract page (`https://arxiv.org/abs/2401.01234`), never the PDF.

Never: a search-results URL, a `scholar.google.com` link, a ResearchGate or
Semantic Scholar page, a mirror somebody re-uploaded, or a shortened link. Those
are the addresses that rot, that land on a login wall, or that quietly point at a
different paper - and a reader who cannot reach the source has been given a claim.

Re-fetch every link before the document is final. A link that no longer lands on
the paper is fixed or the source is dropped; it is never shipped as a maybe.

## The receipt: what to record per source

Record these **while the page is open**. Reconstructing them later is how wrong
years and wrong authors get into a reference list.

| Field | Why it matters |
|---|---|
| Exact title, as printed | the only reliable way to tell two similar papers apart |
| Full author list, in order | IEEE truncates at six with *et al.*; you cannot truncate what you did not read |
| Venue, spelled as the venue spells it | abbreviated journal names have official forms |
| Volume, issue, pages | the difference between a paper and a preprint |
| Year **and month** | IEEE style wants the month for journals |
| DOI | the resolvable identity; prefer it over a URL |
| URL **and access date** | **the link that goes in the reference**; required, DOI or not |
| Type | journal / conference / preprint / standard / report / website - it picks the form |
| What you actually read | abstract only, or full text; a paywalled abstract supports less |

## IEEE reference forms

Numbered `[1]`, `[2]`, … in the order the sources are **first mentioned** in the
text (not alphabetically, not by importance). The reference list is in that
order, and the in-text marker is the number in square brackets.

**Journal article**

```
[1] A. B. Author, C. D. Author, and E. F. Author, "Title of paper," Abbreviated
    Journal Name, vol. 12, no. 3, pp. 45-67, Mar. 2024, doi: 10.1109/TSE.2024.1234567.
    [Online]. Available: https://doi.org/10.1109/TSE.2024.1234567
```

**Conference paper**

```
[2] A. B. Author and C. D. Author, "Title of paper," in Proc. 46th Int. Conf.
    Software Engineering (ICSE), Lisbon, Portugal, 2024, pp. 101-112,
    doi: 10.1145/3597503.3639142. [Online]. Available:
    https://doi.org/10.1145/3597503.3639142
```

**Conference paper with its own open-access page** (USENIX, and the like) - the
venue's page is the better link, because it carries the BibTeX, the page range
and the PDF:

```
[3] A. B. Author, C. D. Author, and E. F. Author, "Title of paper," in Proc.
    2025 USENIX Annu. Tech. Conf. (USENIX ATC '25), Boston, MA, USA, Jul. 2025,
    pp. 1143-1159. [Online]. Available:
    https://www.usenix.org/conference/atc25/presentation/author
```

**Preprint (arXiv)** - say it is a preprint; do not dress it as a publication

```
[4] A. B. Author, C. D. Author, and E. F. Author, "Title of preprint," arXiv:2401.01234,
    2024. [Online]. Available: https://arxiv.org/abs/2401.01234
```

**Standard / specification**

```
[4] Systems and software engineering - Systems and software Quality Requirements
    and Evaluation (SQuaRE), ISO/IEC 25010:2023, 2023.
```

**Technical report**

```
[5] A. B. Author, "Title of report," Name of Institution, City, Country,
    Tech. Rep. TR-2024-07, 2024.
```

**Website / documentation** - last resort; never for a research claim

```
[6] Organization Name. "Title of page." Site Name. Accessed: Oct. 2, 2026.
    [Online]. Available: https://example.org/page
```

**Thesis**

```
[7] A. B. Author, "Title of thesis," Ph.D. dissertation, Dept. Comput. Sci.,
    Univ. Name, City, Country, 2024.
```

House rules that follow from the forms:

- **Six or more authors**: list the first author and *et al.* Fewer than six:
  list them all. "et al." is not a way to avoid reading the author list.
- **Titles in quotes, venue in italics.** Sentence case for the title, title
  case for the venue name.
- **Page ranges with an en dash** (`pp. 45-67`), and `p. 45` for a single page.
- **A DOI beats a URL**; a URL needs an access date; a bare "Google Scholar"
  link is not a reference.
- **One reference per claim.** If a sentence rests on two sources, cite both;
  if it rests on none, it is opinion and should read like one.

## The checks: before the reference list is final

Run every one of these on every entry. They are ordered by how often they catch
a real error.

1. **Resolve the identifier.** Open `https://doi.org/<doi>` (or the arXiv id, or
   the URL). It must land on the paper you described. A DOI that resolves
   elsewhere is a wrong DOI, not a typo to guess at.
2. **Resolve the LINK, and read where it lands.** Every reference carries a URL:
   fetch it. It must land on that paper's own page - not a search result, not a
   login wall, not a publisher home page, not a different paper by the same
   group. A link that has rotted is replaced with a working one or the source is
   dropped.
3. **Title match, character for character.** Subtitles and punctuation differ
   between the preprint and the published version; cite the version you read.
4. **Year sanity.** A paper "published" before the technology it studies
   existed is a mix-up. So is a year from the search snippet instead of the page.
5. **Author match.** Same group, same year, two papers is the classic swap.
6. **Venue match.** Workshop paper vs. main conference, journal vs. magazine,
   "companion" proceedings - they are different references.
7. **Retraction / withdrawal.** The publisher page carries the notice; add
   `Retraction Watch` for the cases where the page does not. A retracted source
   is deleted, not footnoted.
8. **Predatory-venue smell test.** No editorial board, an "international
   journal" with a two-week review promise, a fee on the acceptance letter, a
   venue none of your other sources cite. Prefer the venue the field cites.
9. **Every reference is cited, and every citation resolves.** A reference with
   no in-text mention is padding; an in-text `[12]` with no entry is a hole.
10. **Nothing quoted without a page.** Paraphrase in your own words; quote only
    with quotation marks, a page number and a reason.
11. **The gap claim has a search behind it.** "No work addresses X" needs the
    queries that failed to find it, in the Method section.
12. **One final pass, the way a reader does it.** Read the reference list alone,
   top to bottom, clicking each link - before the document is finished, not
   after somebody asks where a number came from.

## Provenance in the text

The reader should be able to tell, for each sentence that sounds like a fact,
where it came from. Three habits do most of the work:

- **Attribute stronger claims.** "Rust's borrow checker eliminates a class of
  use-after-free defects in the measured corpora [4]" beats "Rust is memory
  safe", and the citation is what makes the difference visible.
- **Label preprint and vendor material as such**, in the sentence: "a 2024
  preprint reports…", "the project's own documentation states…". The label is
  part of the claim.
- **Separate what the source says from what you conclude.** Your synthesis is
  allowed to be opinionated; it is not allowed to wear a citation it did not
  earn.

## The review's own citation block

When the deliverable is a document rather than a paper, still give it a short
block at the end so it can be cited in turn:

```
Rust Research: 10 Papers to Build On
Compiled <Month Year> from <venues searched>. Search window: <from>-<to>.
Every reference carries its DOI or arXiv id and the link it was read from;
all links were fetched and landed on the paper on <date>.
```

The date is not decoration: it says when "the latest" was true, and the link
sentence is the one a reader trusts - it claims exactly what was checked.
