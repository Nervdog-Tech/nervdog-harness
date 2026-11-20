#!/usr/bin/env node
// Logging proxy that refuses every request and prints its target. Usage:
//   node offline/egress-proxy.mjs [port]          # default 18999
//   HTTPS_PROXY=http://127.0.0.1:18999 HTTP_PROXY=http://127.0.0.1:18999 NO_PROXY= dsh web
// Loopback destinations bypass the proxy, so only off-machine targets appear.
import http from 'node:http'

const port = Number(process.argv[2] ?? 18999)
const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} HTTP ${req.method} ${req.url}`)
  res.writeHead(502)
  res.end()
})
server.on('connect', (req, socket) => {
  console.log(`${new Date().toISOString()} CONNECT ${req.url}`)
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
})
server.listen(port, '127.0.0.1', () => console.log(`egress proxy on http://127.0.0.1:${port}`))
