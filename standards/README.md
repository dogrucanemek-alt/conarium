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

Source is kramdown-rfc markdown. To build txt/xml locally:

```
gem install kramdown-rfc
kdrfc standards/draft-dogru-scitt-disclosure-evidence-01.md
```

or paste the file into <https://author-tools.ietf.org/>.
