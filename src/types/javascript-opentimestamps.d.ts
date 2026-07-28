declare module 'javascript-opentimestamps' {
  export class OpSHA256 {
    constructor()
  }
  export const Ops: { OpSHA256: typeof OpSHA256 }
  export class DetachedTimestampFile {
    static fromHash(op: OpSHA256, hash: Buffer | Uint8Array): DetachedTimestampFile
    static deserialize(bytes: Buffer | Uint8Array): DetachedTimestampFile
    serializeToBytes(): Buffer | Uint8Array
    fileDigest?(): Buffer | Uint8Array
  }
  export function stamp(detached: DetachedTimestampFile): Promise<void>
  export function upgrade(detached: DetachedTimestampFile): Promise<boolean>
  export function verify(
    detachedOts: DetachedTimestampFile,
    detached: DetachedTimestampFile,
    opts?: { ignoreBitcoinNode?: boolean; timeout?: number },
  ): Promise<Record<string, { timestamp?: number; height?: number }> | undefined>
}
