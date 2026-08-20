#!/usr/bin/env node
// NEDEN BU DOSYA VAR:
// deploy/hetzner-proof-route.mjs icinde "yalnizca dogrudan calistirilirsa dinle" guard'i
// bulunuyor (kazara deploy'u onlemek icin konmus; bilerek dokunmuyoruz). pm2 ise script'i
// kendi ProcessContainer wrapper'i ile calistirdigi icin process.argv[1] beklenen deger
// olmuyor, guard false donuyor ve surec pm2'de "online" gorunup HIC DINLEMIYOR.
// 29 Tem 2026 deploy'unda tam bu yasandi: online, 0 restart, log bos, port kapali.
// Bu baslatici dinlemeyi ACIKCA yapar; guard kaynak dosyada korunur.
import { server } from './deploy/hetzner-proof-route.mjs'

const PORT = Number(process.env.CONARIUM_PROOF_PORT || 8794)
const HOST = process.env.CONARIUM_PROOF_HOST || '127.0.0.1'

server.listen(PORT, HOST, () => {
  console.error(`[conarium-proof] listening on http://${HOST}:${PORT}/proof`)
})
