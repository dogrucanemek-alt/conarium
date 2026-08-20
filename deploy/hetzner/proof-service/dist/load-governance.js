/**
 * Governance lives in @conarium-ai/core. This repo does not use its July
 * fork for /proof. Same resolve order as load-receipt-view.ts:
 * env → CONARIUM_ROOT → installed package (if it is not this site repo)
 * → sibling checkout. Missing → throw. Never fall back to ./governance.js.
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
function candidatePaths() {
    const out = [];
    const pinned = process.env.CONARIUM_CORE_GOVERNANCE?.trim();
    if (pinned)
        out.push(pinned);
    const root = process.env.CONARIUM_ROOT?.trim();
    if (root)
        out.push(join(root, 'dist', 'governance.js'));
    try {
        const require = createRequire(import.meta.url);
        const resolved = require.resolve('@conarium-ai/core/package.json');
        const selfPkg = join(HERE, '..', 'package.json');
        let same = false;
        try {
            same = realpathSync(resolved) === realpathSync(selfPkg);
        }
        catch {
            same = resolved === selfPkg;
        }
        if (!same)
            out.push(join(dirname(resolved), 'dist', 'governance.js'));
    }
    catch {
        /* not installed as a separate package */
    }
    out.push(join(HERE, '..', '..', 'conarium-public', 'dist', 'governance.js'));
    return out;
}
export function resolveGovernancePath() {
    for (const p of candidatePaths()) {
        if (p && existsSync(p))
            return p;
    }
    throw new Error('governance lives in @conarium-ai/core (dist/governance.js). Build that package, set CONARIUM_ROOT, or CONARIUM_CORE_GOVERNANCE. This repo does not use its local fork for /proof.');
}
export async function loadGovernance() {
    const spec = pathToFileURL(resolveGovernancePath()).href;
    return (await import(spec));
}
//# sourceMappingURL=load-governance.js.map