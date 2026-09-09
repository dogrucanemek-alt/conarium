# conarium

Launcher for the `conarium` command (the Conarium gateway).

```bash
npx conarium --help
```

This package contains no logic. It resolves `conarium` inside
[`@conarium-ai/core`](https://www.npmjs.com/package/@conarium-ai/core), runs it, and forwards
the exit code unchanged. Install `@conarium-ai/core` directly if you want the library
as well as the commands.

Conarium reports its result through exit codes, so the forwarding is the point:

| Exit | Meaning |
| --- | --- |
| `0` | the records in the file are intact |
| `13` | signature invalid, or unknown keyId |
| `14` | inclusion proof present and false |

Documentation: <https://conarium.dev> · Source: <https://github.com/dogrucanemek-alt/conarium>

MIT licensed.
