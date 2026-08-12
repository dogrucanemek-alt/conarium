'use strict'

/**
 * pm2 ecosystem for the anchoring service.
 * `pm2 status` saying online is not a health check — probe GET /healthz.
 */
module.exports = {
  apps: [
    {
      name: 'conarium-anchor',
      script: 'bin/conarium-anchor-service.mjs',
      cwd: process.cwd(),
      interpreter: 'node',
      env: {
        CONARIUM_ANCHOR_HOST: '127.0.0.1',
        CONARIUM_ANCHOR_PORT: '8797',
      },
      // Real secrets live in the process environment / EnvironmentFile, not here.
    },
  ],
}
