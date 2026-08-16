# Contributing

A setting that reduces protection — relaxing a mask, turning a detector off,
raising a row cap, or departing from a profile default — must be noisy: write
it on the receipt or in the audit trail, warn from `conarium-doctor`, and
announce it at startup (stderr, never stdout). Silence is only for the
default that keeps the stronger behaviour. This applies to new settings too.
