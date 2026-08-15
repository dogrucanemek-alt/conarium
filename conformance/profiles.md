# GACS profiles

A profile is a named slice of the suite. A procurement text can say
"the solution SHALL satisfy GACS-E1 and GACS-C1" without inventing a
score.

| Profile | Name | What it covers |
|---|---|---|
| GACS-D1 | Disclosure integrity | Receipt chain, signature, tamper, mid-chain deletion, sequence gaps |
| GACS-E1 | Enforcement | Table and column policy, row cap, masking |
| GACS-C1 | Coverage | Source-side reconciliation and tail pins |
| GACS-I1 | Bounded inference | Inference channels. Today these are listed, not claimed. |

The runner prints one block per profile. It does not add the blocks into
a grade.
