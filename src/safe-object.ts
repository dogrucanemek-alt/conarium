/**
 * Writes and reads that treat a key as an own property, always.
 *
 * `obj["__proto__"] = v` does not create a field — it changes the object's
 * prototype and the key vanishes. `obj["__proto__"]` as a read returns the
 * prototype getter, not an own value. These two helpers do neither.
 *
 * Do not switch object creation to Object.create(null): JSON.stringify,
 * instanceof, and several library paths treat null-prototype objects
 * differently. This file exists to keep existing objects well-behaved.
 */

export function setOwn(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

export function getOwn(obj: object, key: PropertyKey): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key)
  if (!desc || !('value' in desc)) return undefined
  return desc.value
}
