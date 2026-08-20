# Exercise: one book, two books, two clocks

One class hour. A spreadsheet or twenty lines of shell is enough.
No product to install.

The student is not told the moral in advance. The three steps are
built so that the usual wrong answers fail in order.

---

## Files

Two CSVs. Times are naive local timestamps; treat them as
written on the clock named in the column header.

`desk.csv` — the mediator's book (the front-desk log). Custody:
the desk clerk. Columns: `desk_id`, `object`, `ts_desk`.

`source.csv` — the clinic EHR's own activity book. Custody: the
database. Columns: `stmt_id`, `object`, `ts_source`.

Window, stamped by the **source** clock: `2026-08-20 10:00:00`
through `2026-08-20 10:10:00`. An item is in the window on the
desk side only if `ts_desk` falls in that same civil interval.
That is a choice with a cost. Step 3 is the cost.

Declared correspondence, written on the board and not to be
invented later:

- Same `object` name is the match key.
- Multiplicity: one desk row naming an object accounts for every
  source row on that object inside the window.
- Skew bound: **undeclared** unless a later question declares one.
- Exclude `object = catalog` before comparing. Write the exclusion
  down. Do not drop anything else.

---

## The data

### `desk.csv`

```
desk_id,object,ts_desk
d1,patients,2026-08-20 10:01:00
d2,patients,2026-08-20 10:03:00
d3,labs,2026-08-20 10:04:28
d4,invoices,2026-08-20 10:06:00
```

### `source.csv`

```
stmt_id,object,ts_source
s1,patients,2026-08-20 10:01:02
s2,patients,2026-08-20 10:03:01
s3,labs,2026-08-20 10:04:30
s4,invoices,2026-08-20 10:06:02
s5,catalog,2026-08-20 10:08:00
s6,vitals,2026-08-20 10:09:10
```

Twelve rows. Every join can be done by eye.

---

## Step 1 — only the desk

Give the student `desk.csv` and the window. Do **not** give
`source.csv`.

**Q1.** In this window, was there a read of `vitals` that the
desk failed to log?

**Q2.** In this window, was every desk row the complete set of
clinic activity?

Write the answer as one of: *yes / no / cannot tell*. One
sentence of reason.

### Wrong answers this step is built to collect

- *"No, the desk has no `vitals` row, so no such read happened."*
  The desk does not testify to events it did not write. Absence
  from one book is not absence from the world.
- *"Yes, `vitals` is missing, so the log is incomplete."*
  Missing-from-desk is also what a read that never occurred
  looks like. Same file, two worlds.
- *"Yes, four rows and a clean sequence `d1–d4`, so the set is
  complete."* A sequence the desk assigned is silent about a
  row the desk never created.

**Expected.** Q1 cannot tell. Q2 cannot tell.

### Instructor note

One ledger. Integrity of `d1–d4` (contiguous ids, plausible
times) is a different question from completeness. Students who
reach for "the file looks intact" are doing the move the rest
of the hour exists to break.

---

## Step 2 — the second book

Give `source.csv`. Same window, same correspondence, skew still
undeclared.

**Q3.** Classify each source object that is not excluded:

| object    | class |
|-----------|--------|
| patients  |        |
| labs      |        |
| invoices  |        |
| vitals    |        |

Allowed classes: `attributed`, `observed-without-desk`,
`desk-without-source`, `excluded`, `indeterminate`.

**Q4.** Is the desk complete with respect to the source book
for this window?

**Q5.** Is the source book complete with respect to everything
that happened in the clinic?

### Wrong answers

- *Call `catalog` `observed-without-desk`.* It was excluded
  before comparison. The class is `excluded`, and the rule
  must be named.
- *Call `patients` a gap because 2 source rows vs 2 desk rows
  is a coincidence they then over-interpret, or the reverse:
  demand 1:1 and invent a gap.* The declared multiplicity
  already says one naming desk row clears the object. Two
  desk rows also clear it. Count-to-count is not the test.
- *Q5 = yes, because we now have two books.* Two books can
  both be short. The method never assumed either population
  complete.
- *`vitals` is `indeterminate` because we are being careful.*
  There is no desk row naming `vitals` anywhere in the file,
  in or out of the window. That is a genuine absence of a
  naming row, not a clock problem.

**Expected.**

| object    | class |
|-----------|--------|
| patients  | attributed |
| labs      | attributed |
| invoices  | attributed |
| catalog   | excluded |
| vitals    | observed-without-desk |

Q4: no — `vitals` is source activity with no desk row.
Q5: cannot tell. Nothing in either file speaks to a third
path (a replica, a backup, a role these counters do not see).

### Instructor note

Second ledger. Completeness of the desk *with respect to this
source book* is now decidable for `vitals`. Completeness of
either book with respect to the world is not. Students who
write "now we know everything" have overshot the method. The
hour is not over; the next step takes a decidable row away.

---

## Step 3 — the desk clock is wrong

Same window on the **source** clock. New fact, on the board:

> The desk clock was 6 minutes slow. The `desk.csv` you used
> in steps 1–2 had been aligned to source time so the join
> was readable. Rewrite every `ts_desk` six minutes earlier,
> then classify from those rewritten stamps. Do not correct
> them back. Skew is still undeclared.

Rewritten `desk.csv`:

```
desk_id,object,ts_desk
d1,patients,2026-08-20 09:55:00
d2,patients,2026-08-20 09:57:00
d3,labs,2026-08-20 09:58:28
d4,invoices,2026-08-20 10:00:00
```

Window is start-inclusive, end-exclusive: `[10:00:00, 10:10:00)`.
So `d4` at `10:00:00` is in; `d1`–`d3` are out.

**Q6.** Re-classify `patients`, `labs`, `invoices`, `vitals`.

**Q7.** A classmate says: "No exceptions we can prove, so the
window is clean." What is wrong with that sentence?

**Q8.** Declare a skew bound of 7 minutes and classify again.
Then declare a skew bound of 2 minutes and classify again.
What changed, and what is still forbidden?

### Wrong answers

- *Step 3 is "clean" because every source object except
  `vitals` has a desk row somewhere.* Those desk rows now sit
  outside the window. Attributed requires an *in-window* desk
  row. Out-of-window is not a silent match.
- *`patients` / `labs` / `invoices` are `observed-without-desk`
  (bypass).* The only naming desk rows exist, just not in the
  window. The method cannot tell a trailing desk clock from a
  late row. That class asserts a distinction it did not make.
- *`vitals` becomes `indeterminate` too, "because clocks."*
  `vitals` still has no naming desk row anywhere. A neighbour's
  clock does not make a genuine absence undecidable.
- *Q7's "clean" with `vitals` still sitting there.* Even the
  people who correctly leave `patients` undecided sometimes
  wash `vitals` out of the summary. The summary has an
  exception.
- *Q8: an undeclared bound in step 3 was "really" 6 minutes
  because we now know the offset.* Knowing after the fact is
  not a declaration that was bound into the result. Substituting
  it is the default the method refuses.

**Expected, skew undeclared.**

| object    | class |
|-----------|--------|
| patients  | indeterminate |
| labs      | indeterminate |
| invoices  | attributed |
| vitals    | observed-without-desk |

Q7: "clean" folds `indeterminate` into a pass and ignores
`vitals`. The honest summary is: one observed-without-desk
(`vitals`), two indeterminate (`patients`, `labs`), one
attributed (`invoices`), skew undeclared. That is a result.
It is not a weaker pass.

Q8: a 7-minute declared bound *still does not attribute* a
desk row that sits outside the window. The bound says how
far the boundary can be trusted, not where the boundary is.
Those items remain `indeterminate` (the bound is now declared,
so the *reason* is no longer "undeclared"; the membership
failure remains). A 2-minute bound cannot explain a 6-minute
offset as skew. It does not turn the item into
`observed-without-desk` by itself if a naming row exists
outside the window — the published rule keeps that case in
`indeterminate` and reports the offset. What a tight bound
changes is the standing of the explanation, not a licence to
print "clean".

### Instructor note

Two clocks. The discovery this step is for: a comparison that
could decide in step 2 cannot decide once membership is a
cross-clock question and the bound is undeclared. The student
who wants to say "clean" rather than `indeterminate` is
performing the commercial collapse. `vitals` is left in place
so they also cannot hide in universal indecision.

---

## Extension — the second book is short too

**Q9.** A nurse used a reporting replica whose statements never
increment this `source.csv`. A read of `labs` happened there
during the window. Which of your step-2 or step-3 classes
change? What do you write instead of "the desk missed `labs`"?

### Wrong answers

- *"Then we mark `labs` observed-without-desk."* The replica
  never touched this source book. S does not show the read.
  G does not show the read. Both books are short in the same
  place.
- *"The method is broken; throw it out."* The method's answer
  to a hole in both books is exactly the sentence students
  resist: we do not know. Adding a third book (the replica's
  own counters), under custody the first two do not share, is
  the same move as step 2, one layer out.

**Expected.** No class in the given files changes: the replica
read is on neither side. You write that completeness was
with respect to *this* source book, and that a path the book
does not count is out of scope. You do not upgrade a gap you
cannot see into a finding, and you do not call the window
clean because you cannot see it.

### Instructor note

Closed world is an assumption, not a result. Students who
want a third class — "true miss" vs "miss relative to S" —
have understood the method. The vocabulary they already have
is enough: every finding is relative to the two books and the
declaration in hand.

---

## Twenty-line check (optional)

If a machine is in the room, this is the whole classifier.
It is deliberately deaf to products.

```bash
# step 2: source objects in window, minus catalog
awk -F, 'NR>1 && $3>="2026-08-20 10:00:00" && $3<"2026-08-20 10:10:00" \
  && $2!="catalog" {print $2}' source.csv | sort -u > /tmp/s_obj

# desk objects in window
awk -F, 'NR>1 && $3>="2026-08-20 10:00:00" && $3<"2026-08-20 10:10:00" \
  {print $2}' desk.csv | sort -u > /tmp/g_in

# desk objects anywhere
awk -F, 'NR>1 {print $2}' desk.csv | sort -u > /tmp/g_all

echo "-- attributed --";      comm -12 /tmp/s_obj /tmp/g_in
echo "-- observed-without-desk --"
comm -23 /tmp/s_obj /tmp/g_all
echo "-- indeterminate (source obj, desk only outside window) --"
comm -23 /tmp/s_obj /tmp/g_in | comm -12 - /tmp/g_all
```

Step 3: run the same commands on the rewritten `desk.csv`.
`patients` and `labs` move from the first list to the third.
`invoices` stays attributed (`10:00:00` is in). `vitals`
stays on the second list. If `patients`/`labs` do not move,
the student corrected the clock. The exercise forbids that.

---

## What each step taught (do not hand this out first)

| Step | Concept |
|------|---------|
| 1 | Integrity of one book is not completeness. "Cannot tell" is an answer. |
| 2 | A second book under other custody can decide a miss *relative to that book*. Exclusion is declared, not felt. Multiplicity is not 1:1 counting. The world is still open. |
| 3 | The window sits on two clocks. Out-of-window naming is not bypass and not a pass. `indeterminate` is forbidden to become "clean". A neighbour's clock does not wash out a real absence (`vitals`). |
| 9 | A short second book is the same shape as a short first one. Do not print a finding you cannot see. |
