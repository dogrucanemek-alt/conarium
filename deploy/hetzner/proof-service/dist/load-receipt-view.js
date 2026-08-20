/**
 * Receipt HTML lives in @conarium-ai/core. This repo does not keep a copy.
 * Same resolve order as engine version: env → CONARIUM_ROOT → installed
 * package (if it is not this site repo) → sibling checkout.
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
function candidatePaths() {
    const out = [];
    const pinned = process.env.CONARIUM_CORE_RECEIPT_VIEW?.trim();
    if (pinned)
        out.push(pinned);
    const root = process.env.CONARIUM_ROOT?.trim();
    if (root)
        out.push(join(root, 'dist', 'receipt-view.js'));
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
            out.push(join(dirname(resolved), 'dist', 'receipt-view.js'));
    }
    catch {
        /* not installed as a separate package */
    }
    out.push(join(HERE, '..', '..', 'conarium-public', 'dist', 'receipt-view.js'));
    return out;
}
export function resolveReceiptViewPath() {
    for (const p of candidatePaths()) {
        if (p && existsSync(p))
            return p;
    }
    throw new Error('receipt view lives in @conarium-ai/core (dist/receipt-view.js). Build that package, set CONARIUM_ROOT, or CONARIUM_CORE_RECEIPT_VIEW. This repo does not keep a copy.');
}
export async function loadReceiptView() {
    const spec = pathToFileURL(resolveReceiptViewPath()).href;
    return (await import(spec));
}
//# sourceMappingURL=load-receipt-view.js.map