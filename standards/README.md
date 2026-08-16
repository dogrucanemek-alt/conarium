# Standards work

Internet-Draft sources authored from this codebase.

## draft-dogru-scitt-disclosure-evidence

Defines two evidence payloads for auditable data disclosure, designed to be
registered as Signed Statements on a SCITT (RFC 9943) Transparency Service:

- **Transformation Evidence** — a signed, per-disclosure statement of which
  protected classes were transformed before disclosure (action + count, never
  values). Implemented here as the receipt `masking` field.
- **Coverage Reconciliation** — a procedure and signed result comparing the
  data source's own activity counters against a receipt set over a window,
  surfacing activity for which no receipt exists. Implemented here as
  `conarium-reconcile`.

The draft defines payloads only: no new receipt format, no new transparency
mechanism, no new signature format.

**Status:** individual submission. Not adopted by an IETF working group, and it
carries no formal standing — an Internet-Draft is a dated public record, not a standard.
It is published so the receipt format can be implemented without us.
Submitted to the IETF Datatracker on 2026-08-15. Current revision:
<https://datatracker.ietf.org/doc/draft-dogru-scitt-disclosure-evidence/>

**`-03` is prepared here and has not been submitted.** The published revision is
`-02`; the `-03` sources in this directory are the working copy. It corrects two
overclaims found in review of `-02` on the SCITT mailing list — a clean
reconciliation described as coverage of the source activity, and Transformation
Evidence described as proof of the transformation rather than the Issuer's
assertion of it — and adds the outcome vocabulary, mapping profiles, and exclusion
rules that follow from that exchange.

Source is kramdown-rfc markdown. To build txt/xml locally:

```
gem install kramdown-rfc
pip install xml2rfc
kramdown-rfc standards/draft-dogru-scitt-disclosure-evidence-03.md > draft.xml
xml2rfc --text draft.xml -o draft.txt
```

On Windows, `xml2rfc` imports WeasyPrint at startup and fails if its GTK libraries
are absent. WeasyPrint is only needed for PDF output; uninstalling it lets the text
and XML paths work.

or paste the file into <https://author-tools.ietf.org/>.
