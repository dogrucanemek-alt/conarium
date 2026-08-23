# External uses of this draft's terms

A list of public records that used, cited, or adopted wording from
`draft-dogru-scitt-disclosure-evidence`. It is a repository file, not
part of the Internet-Draft.

**Kind labels.** There is no independent implementation of Transformation
Evidence or Coverage Reconciliation on file. `reproduction` means a
second party ran the author-supplied checkers and vectors. `citation`
means a public mention. `wording adopted` means another project used
this draft's phrasing. None of these rows is kind 2 or kind 3
(independent implementation).

| Who | What | URL | Kind |
| --- | --- | --- | --- |
| Joel Hillier (Certisyn) | Ran `@conarium-ai/core@0.2.41` on Node 22 / Linux. Reported 13/13. Classified the run as a reproduction of the author-supplied checkers and vectors, and said it establishes nothing about the wire format. | https://mailarchive.ietf.org/arch/msg/scitt/eIUdjp_Y1DdobB2E7-uAvcT--Qg | reproduction |
| Joel Hillier (Certisyn) | Announcing `draft-hillier-coverage-attestation` on the SCITT list (20 August 2026), described its disposition vocabulary as this draft's standing ladder "now aimed at a very different question". The author's own statement; not an implementation of this draft. | https://mailarchive.ietf.org/arch/msg/scitt/CxN3gJRyOux_6wAhRYaF-hKgrF0 | wording adopted |
| Henri Sirkkavaara (Vaara) | The Vaara conformance page and `conformance/reproductions.json` credit Emek Can Doğru (SCITT list, 21 August 2026) for the observation that a truncated chain verifies clean. The sentence "removal is detectable relative to a retained head" on that page was proposed by Iman Schrock on the list (20 August 2026) and endorsed by this project; it is not this draft's wording. | https://vaara.io/conformance.html · https://github.com/vaaraio/vaara/blob/main/conformance/reproductions.json · https://mailarchive.ietf.org/arch/msg/scitt/FCGoJyeKRwM3FrkvSQvN7uegP5A | citation |
| Nenad Vasic (Elara Protocol) | Elara `site/receipts/SIGNING.md` records this project's OpenSSL 3.5.1 / 3.5.6 ML-DSA-65 key-parsing observation and names it as the first verification of Elara bundles with non-Elara code. That is this project verifying Elara, not Elara implementing this draft. | https://github.com/navigatorbuilds/elara-mesh/blob/main/site/receipts/SIGNING.md | citation |

Rows removed on verification (23 August 2026): a "Pablo Play" row claiming a
merge of the receipt-set completeness discussion. His list messages of 19–20
August 2026 concern argentum-core and do not cite this draft. No record, no row.
