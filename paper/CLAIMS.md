# Claims table — Two ledgers, one window

Every numeric expression and every measured / sampled / declared / not-measured label in `paper/two-ledgers-one-window.md`. Gate reads this table. A number that is not a row here is a miss.

Format: `sentence | file:line | kind`

| sentence | file:line | kind |
|---|---|---|
| this paper states that distinction as two propositions | paper/two-ledgers-one-window.md:9 | declared (structure of K3) |
| under seven stated assumptions (declared) | paper/two-ledgers-one-window.md:9 | declared |
| one of five outcome classes (declared) | paper/two-ledgers-one-window.md:9 | declared |
| twelve published table lines (measured) | paper/two-ledgers-one-window.md:9 | measured (desk.csv 5 lines + source.csv 7 lines) |
| two worlds in which R is the same | paper/two-ledgers-one-window.md:15 | declared (K1 §1) |
| two worlds that share R | paper/two-ledgers-one-window.md:17 | declared (K1 §1 / P1) |
| a four-step comparison (declared) | paper/two-ledgers-one-window.md:19 | declared (K1 §3) |
| two books and one window | paper/two-ledgers-one-window.md:19 | declared (K1 title / setup) |
| seven assumptions (declared) | paper/two-ledgers-one-window.md:23 | declared (K3 A1–A7) |
| A1 | paper/two-ledgers-one-window.md:25 | declared (K3) |
| A2 | paper/two-ledgers-one-window.md:27 | declared (K3) |
| A3 | paper/two-ledgers-one-window.md:29 | declared (K3) |
| A4 | paper/two-ledgers-one-window.md:31 | declared (K3) |
| A5; for example 7 in one world and 8 in the other (declared, illustrative) | paper/two-ledgers-one-window.md:33 | declared, illustrative (K3); frequency of A5 failure: not measured |
| A6 | paper/two-ledgers-one-window.md:35 | declared (K3) |
| A7; two occurrences / two members | paper/two-ledgers-one-window.md:37 | declared (K3) |
| frequency of the failure is not measured | paper/two-ledgers-one-window.md:39 | not measured (K3 / K4) |
| assumptions A1–A7; two worlds W0, W1 | paper/two-ledgers-one-window.md:44 | declared (K3 P1, verbatim) |
| A2, A6, W0, W1, A1, A5, A4, A3, A7 | paper/two-ledgers-one-window.md:48 | declared (proof sketch from A1–A7) |
| A1–A7; two books | paper/two-ledgers-one-window.md:50 | declared |
| Proposition 2a / 2b | paper/two-ledgers-one-window.md:54–58 | declared (K3, verbatim) |
| pair (measured multiplicity, undeclared skew) incomparable with (undeclared multiplicity, measured skew) (declared, illustrative) | paper/two-ledgers-one-window.md:62 | declared, illustrative (K4) |
| two operator-declared books | paper/two-ledgers-one-window.md:64 | declared (K3 account-claim) |
| the two books differ by 3 rows | paper/two-ledgers-one-window.md:68 | declared, illustrative (K3/K4 table) |
| therefore 3 accesses were not recorded | paper/two-ledgers-one-window.md:69 | declared, illustrative (K3/K4 table) |
| two accounts, two custodians | paper/two-ledgers-one-window.md:75 | declared (K1 §2) |
| a pair of pg_stat_statements snapshots | paper/two-ledgers-one-window.md:77 | declared (K1 §2) |
| four steps | paper/two-ledgers-one-window.md:85 | declared (K1 §3) |
| S at t0 and t1; two clocks | paper/two-ledgers-one-window.md:87 | declared (K1 §3) |
| default of one-to-one; default of zero skew | paper/two-ledgers-one-window.md:89 | declared (K1 §3) |
| exactly one outcome | paper/two-ledgers-one-window.md:93 | declared (K1 §3) |
| S at 10:00 and 10:10; patients rose by 3; labs by 1; two in-window rows | paper/two-ledgers-one-window.md:95 | declared, illustrative (K1 §3 example) |
| five outcome classes | paper/two-ledgers-one-window.md:97 | declared (K1 §4) |
| all three produce the same shape | paper/two-ledgers-one-window.md:103 | declared (K1 §4: bypass / sink / scope) |
| two facts force the fifth class | paper/two-ledgers-one-window.md:115 | declared (K1 §5) |
| a third, operational, reason | paper/two-ledgers-one-window.md:121 | declared (K1 §5) |
| source window 2026-08-20 10:00:00 through 2026-08-20 10:10:00 (declared) | paper/two-ledgers-one-window.md:129 | declared (K2) |
| four desk rows and six source rows (measured); two files are twelve lines (measured); twelve rows (declared) | paper/two-ledgers-one-window.md:133 | measured (CSV line counts); declared (K2 “Twelve rows”) |
| desk timestamps 10:01:00, 10:03:00, 10:04:28, 10:06:00 | paper/two-ledgers-one-window.md:137–140 | measured (desk.csv) |
| source timestamps 10:01:02, 10:03:01, 10:04:30, 10:06:02, 10:08:00, 10:09:10 | paper/two-ledgers-one-window.md:144–149 | measured (source.csv) |
| Step 1 | paper/two-ledgers-one-window.md:151 | declared (K2) |
| classify.mjs (measured: 43 lines) | paper/two-ledgers-one-window.md:153 | measured (file line count) |
| Step 2 classification table | paper/two-ledgers-one-window.md:155–161 | declared (answer-key.json); reproduced (classify.mjs) |
| a third path | paper/two-ledgers-one-window.md:163 | declared (K2 Q5) |
| desk clock was 6 minutes slow (declared); d4 at 10:00:00; d1–d3 outside | paper/two-ledgers-one-window.md:165 | declared (K2 step 3) |
| Step 3 classification table | paper/two-ledgers-one-window.md:167–173 | declared (answer-key.json); reproduced (classify.mjs) |
| one observed-without-receipt; two indeterminate; one attributed | paper/two-ledgers-one-window.md:174 | declared (K2 expected summary); reproduced |
| skew bound of 7 minutes (declared, illustrative); bound of 2 minutes; 6-minute offset | paper/two-ledgers-one-window.md:176 | declared, illustrative (K2 Q8) |
| exits 0 (declared); five source calls (declared, from the tool's positive case); one naming receipt | paper/two-ledgers-one-window.md:187 | declared (LIMITATIONS.md reconcile-object-attribution / test/reconcile_cli.test.mjs) |
| two clocks | paper/two-ledgers-one-window.md:192 | declared (K1 / LIMITATIONS trailing-clock) |
| two papers that scan named | paper/two-ledgers-one-window.md:199 | declared (K5: Sello + Auditable Agents) |
| United States patent 7,770,032 B2; expired | paper/two-ledgers-one-window.md:201 | declared (K5); confirmed Google Patents Expired — Lifetime |
| the three remedies proposed there (declared) | paper/two-ledgers-one-window.md:203 | declared (K5 / Sello) |
| Sello v0.1 | paper/two-ledgers-one-window.md:203 | declared (K5) |
| scan dated 6 August 2026 (declared), amended 19 August 2026 (declared) | paper/two-ledgers-one-window.md:205 | declared (K5) |
| commit befdced (declared); artefacts of section 10 | paper/two-ledgers-one-window.md:205 | declared (K5) |
| RFC 9943 | paper/two-ledgers-one-window.md:209 | declared (opened rfc-editor / datatracker) |
| two searches; HTTP 403 (declared, from the scan) | paper/two-ledgers-one-window.md:211 | declared (K5 limitations) |
| version 0.2.46 (declared) | paper/two-ledgers-one-window.md:219 | declared (package.json) |
| draft-dogru-scitt-disclosure-evidence-06; RFC 9943 | paper/two-ledgers-one-window.md:220 | declared (K6 front matter) |
| thirteen receipt cases; eight JCS preimages; six RFC 8785 pairs (declared); 3,000 of 100,000,000 (sampled, N=3000 of M=100000000) | paper/two-ledgers-one-window.md:221 | declared (test-vectors/README.md); sampled (jcs/rfc8785/PROVENANCE.md) |
| swh:1:snp:bc6105f9b58a09866928df917e27c7fa50d21ed2; main at d35ccee4; tags through v0.2.37 | paper/two-ledgers-one-window.md:222 | measured (archive API, 22 Aug 2026, gate pass; snapshot predates this preprint's commit) |
| verifiers/go/ (declared); second implementation | paper/two-ledgers-one-window.md:223 | declared (tree path) |
| seven assumptions (declared); five classes (declared) | paper/two-ledgers-one-window.md:227 | declared |
