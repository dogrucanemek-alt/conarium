# @conarium-ai/mask

The masking engine of Conarium as a library. Same source as `@conarium-ai/core`; this package is only that engine.

```bash
npm install @conarium-ai/mask
```

```js
import { maskField } from '@conarium-ai/mask'

const text = 'mail ayse.yilmaz@example.com TCKN 10000000146'
const r = maskField(text, { pipeline: 'text', only: ['tckn'] })
console.log(JSON.stringify({ text: r.text, classes: r.classes, masked: r.masked }, null, 2))
```

Real output of that example:

```
{
  "text": "mail ayse.yilmaz@example.com TCKN [MASKED_PII]",
  "classes": {
    "email": 1,
    "tckn": 1
  },
  "masked": {
    "tckn": 1
  }
}
```

`maskField` reports these class names: `email`, `entity-email`, `phone`, `tckn`, `card`, `ssn`, `iban`, `mrz`, `ip`, `secret`, `connection`, `bearer`, `labelled-secret`, `name`, `embedded`, `custom`.

A detector misses what it does not recognise. See `LIMITATIONS.md` in the repository.
