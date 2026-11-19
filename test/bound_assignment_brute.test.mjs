// boundAssignment against a brute-force reading of the rule it implements.
//
// The rule: a statement is covered by one Receipt that names all of its
// pattern's objects, or by one Receipt for each object; a Receipt covers at
// most `max` statements. A pattern is matched only if every assignment that
// covers as many statements as possible covers all of its statements.
//
// boundAssignment computes this with a maximum flow, exactly for most inputs
// and conservatively for a pattern over several objects that a Receipt names
// in part. Conservatively means it may call a pattern shared that the rule
// would match, never the reverse. This test enumerates every assignment on
// small random inputs and checks the never-the-reverse half: no pattern the
// rule leaves uncovered in some maximum assignment comes back matched.

import { describe, it, expect } from 'vitest'
import { boundAssignment } from '../bin/conarium-reconcile.mjs'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const OBJECTS = ['a', 'b', 'c']

function subset(rand, maxSize) {
  const size = 1 + Math.floor(rand() * maxSize)
  const pool = [...OBJECTS]
  const out = []
  while (out.length < size) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  return out.sort()
}

function instance(rand) {
  const bySignature = new Map()
  const groupCount = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < groupCount; i++) {
    const objects = subset(rand, 3)
    const key = objects.join(',')
    const count = 1 + Math.floor(rand() * 2)
    if (bySignature.has(key)) bySignature.get(key).count += count
    else bySignature.set(key, { objects, count })
  }
  const groups = [...bySignature.values()]
  const named = new Set(groups.flatMap((g) => g.objects))
  const reconciled = []
  const patternCount = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < patternCount; i++) {
    const tables = subset(rand, 2)
    if (!tables.every((t) => named.has(t))) continue
    reconciled.push({ tables, delta: 1 + Math.floor(rand() * 2), query: `p${i}` })
  }
  const max = 1 + Math.floor(rand() * 2)
  return { groups, reconciled, max }
}

// The ways one statement of a pattern can be covered: a set of groups, one
// group per object, each group used once however many objects it serves.
function covers(tables, groups) {
  let partial = [[]]
  for (const t of tables) {
    const naming = groups.flatMap((g, gi) => (g.objects.includes(t) ? [gi] : []))
    partial = partial.flatMap((p) => naming.map((gi) => [...p, gi]))
  }
  const seen = new Map()
  for (const p of partial) {
    const set = [...new Set(p)].sort((x, y) => x - y)
    seen.set(set.join(','), set)
  }
  return [...seen.values()]
}

function multisets(options, size) {
  if (size === 0) return [[]]
  const out = []
  const walk = (start, acc) => {
    if (acc.length === size) return out.push(acc)
    for (let i = start; i < options.length; i++) walk(i, [...acc, i])
  }
  walk(0, [])
  return out
}

// Every pattern the rule leaves with a statement uncovered in some maximum
// assignment, or null when the instance is too large to enumerate.
function shortInSomeMaximum({ groups, reconciled, max }) {
  const perPattern = reconciled.map((d) => {
    const options = [null, ...covers(d.tables, groups)]
    return multisets(options, d.delta).map((choice) => choice.map((i) => options[i]))
  })
  const total = perPattern.reduce((n, c) => n * c.length, 1)
  if (total > 20000) return null
  const capacity = groups.map((g) => g.count * max)
  let best = -1
  const shortAtBest = new Set()
  const walk = (pi, usage, covered, shortNow) => {
    if (pi === perPattern.length) {
      if (covered > best) {
        best = covered
        shortAtBest.clear()
      }
      if (covered === best) for (const s of shortNow) shortAtBest.add(s)
      return
    }
    for (const choice of perPattern[pi]) {
      const next = [...usage]
      let ok = true
      let got = 0
      for (const set of choice) {
        if (!set) continue
        got += 1
        for (const gi of set) if (++next[gi] > capacity[gi]) ok = false
      }
      if (!ok) continue
      walk(pi + 1, next, covered + got, got < reconciled[pi].delta ? [...shortNow, pi] : shortNow)
    }
  }
  walk(0, groups.map(() => 0), 0, [])
  return shortAtBest
}

function overOnItsOwn({ groups, max }, d) {
  return d.tables.some((t) => d.delta > max * groups.reduce((n, g) => n + (g.objects.includes(t) ? g.count : 0), 0))
}

describe('boundAssignment against every assignment of small inputs', () => {
  it('never matches a pattern that some maximum assignment leaves uncovered', () => {
    const rand = rng(161)
    let checked = 0
    let conservative = 0
    const misses = []
    for (let attempt = 0; checked < 400 && attempt < 5000; attempt++) {
      const inst = instance(rand)
      if (inst.reconciled.length === 0) continue
      const truth = shortInSomeMaximum(inst)
      if (!truth) continue
      checked += 1
      const shared = boundAssignment(inst.reconciled, inst.groups, inst.max)
      for (const [pi, d] of inst.reconciled.entries()) {
        if (overOnItsOwn(inst, d)) continue
        if (truth.has(pi) && !shared.has(pi)) misses.push({ inst, pattern: pi })
        if (!truth.has(pi) && shared.has(pi)) conservative += 1
      }
    }
    expect(checked).toBe(400)
    expect(misses, JSON.stringify(misses.slice(0, 2))).toEqual([])
    // The conservative side exists and is documented; it is not asserted.
    expect(conservative).toBeGreaterThanOrEqual(0)
  })
})
