// Utilitários da avaliação do ThingsBoard 4.4. Lê credenciais do .env e nunca as imprime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '.env')
export const ENV = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
// Endereços e contêineres do ambiente testado. Os padrões são os do ambiente isolado de 2026-10-21.
export const CFG = {
  base: ENV.TB44_BASE_URL || 'http://127.0.0.1:9290',
  mqtt: ENV.TB44_MQTT_URL || 'mqtt://127.0.0.1:18883',
  edge: ENV.TB44_EDGE_URL || 'http://127.0.0.1:9293',
  edgeMqtt: ENV.TB44_EDGE_MQTT_URL || 'mqtt://127.0.0.1:19893',
  serverContainer: ENV.TB44_SERVER_CONTAINER || 'embrapa-tb44-test-thingsboard-1',
  edgeContainer: ENV.TB44_EDGE_CONTAINER || 'embrapa-tb44-test-edge1-1',
  edgeCount: Number(ENV.TB44_EDGE_COUNT || 1)
}
export const BASE = CFG.base
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export const api = async (method, path, { token, body, base = BASE } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Authorization'] = 'Bearer ' + token
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
export const login = async (username, password, base = BASE) => {
  const r = await api('POST', '/api/auth/login', { body: { username, password }, base })
  if (r.status !== 200) throw new Error('login ' + username + ': ' + r.status + ' ' + r.text.slice(0, 160))
  return r.json.token
}
export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
