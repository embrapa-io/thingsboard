'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createTelemetryGateway } = require('../src/server')

const SECRET = 'test-secret-with-at-least-thirty-two-characters'
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const DEVICE_A = '9d99bc90-c644-11f1-b7db-19719deed9d3'
const DEVICE_B = '9db90460-c644-11f1-b7db-19719deed9d3'

// Chaves de aplicação: o backend é simulado; ele recebe o segredo compartilhado e a chave
const APP_KEY = 'ioa_' + 'k'.repeat(40)
const backendStub = calls => async (url, options) => {
  calls.push({ url, headers: options.headers })
  if (options.headers['X-API-Key'] !== APP_KEY) return new Response('{}', { status: 401 })
  return new Response(JSON.stringify({ app: 'app-1', devices: [{ id: DEVICE_A, name: 'Sensor_A', label: 'Sensor A' }] }), { status: 200 })
}

const startWithBackend = async (t, calls, fetchImpl = backendStub(calls), env = {}) => {
  const server = createTelemetryGateway({
    clock: () => NOW,
    fetchImpl,
    env: { TELEMETRY_JWT_SECRET: SECRET, TB_TELEMETRY_TOKEN: 'service-key', BACKEND_URL: 'http://backend:3000/', ...env }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return 'http://127.0.0.1:' + server.address().port
}

const authorizeWithKey = (baseUrl, uri, key, method = 'GET') => fetch(baseUrl + '/internal/authorize', {
  headers: { 'X-Original-URI': uri, 'X-Original-Method': method, ...(key ? { 'X-API-Key': key } : {}) }
})

const gateway = t => startWithBackend(t, [])
const read = (baseUrl, uri, method) => authorizeWithKey(baseUrl, uri, APP_KEY, method)
const A = `/applications/telemetry/DEVICE/${DEVICE_A}`

test('app key gets a normalized query for an allowed device', async t => {
  const baseUrl = await gateway(t)
  const start = NOW - 24 * 3600 * 1000
  const result = await read(baseUrl, `${A}/values/timeseries?keys=temperature,humidity&startTs=${start}&endTs=${NOW}&agg=avg&interval=60000`)

  assert.equal(result.status, 204)
  assert.equal(result.headers.get('x-telemetry-path'), `DEVICE/${DEVICE_A}/values/timeseries`)
  assert.equal(result.headers.get('x-telemetry-authorization'), 'ApiKey service-key')
  const query = new URLSearchParams(result.headers.get('x-telemetry-query'))
  assert.equal(query.get('keys'), 'temperature,humidity')
  assert.equal(query.get('agg'), 'AVG')
  assert.equal(query.get('limit'), '500')
  // 24 h em no máximo 500 pontos exige intervalo de pelo menos 172800 ms.
  assert.equal(query.get('interval'), '172800')
})

// Os JWTs (de projeto, do Grafana IoT, e de dispositivo, da antiga aba Consumo) foram retirados:
// só a chave de aplicação é aceita.
test('bearer tokens are no longer accepted', async t => {
  const baseUrl = await gateway(t)
  const result = await fetch(baseUrl + '/internal/authorize', {
    headers: { 'X-Original-URI': `${A}/values/timeseries`, 'X-Original-Method': 'GET', Authorization: 'Bearer a.b.c' }
  })
  assert.equal(result.status, 401)
  assert.equal(result.headers.get('x-telemetry-authorization'), null)
})

test('keys endpoint takes no parameters', async t => {
  const baseUrl = await gateway(t)
  const result = await read(baseUrl, `${A}/keys/timeseries`)
  assert.equal(result.status, 204)
  assert.equal(result.headers.get('x-telemetry-path'), `DEVICE/${DEVICE_A}/keys/timeseries`)
  assert.equal(result.headers.get('x-telemetry-query'), '')
  assert.equal((await read(baseUrl, `${A}/keys/timeseries?keys=a`)).status, 403)
})

test('latest values pass without a period', async t => {
  const baseUrl = await gateway(t)
  const result = await read(baseUrl, `${A}/values/timeseries?keys=level&useStrictDataTypes=true`)
  assert.equal(result.status, 204)
  assert.equal(result.headers.get('x-telemetry-query'), 'keys=level&useStrictDataTypes=true')
})

test('periods longer than the maximum are clipped to the most recent days', async t => {
  const baseUrl = await gateway(t)
  const result = await read(baseUrl, `${A}/values/timeseries?keys=level&startTs=0&endTs=${NOW}&limit=9999`)
  assert.equal(result.status, 204)
  const query = new URLSearchParams(result.headers.get('x-telemetry-query'))
  assert.equal(Number(query.get('startTs')), NOW - 31 * 24 * 3600 * 1000)
  assert.equal(query.get('limit'), '500')
  assert.equal(query.get('agg'), 'NONE')
})

test('unknown or repeated parameters are refused', async t => {
  const baseUrl = await gateway(t)
  assert.equal((await read(baseUrl, `${A}/values/timeseries?keys=level&entityType=TENANT`)).status, 403)
  assert.equal((await read(baseUrl, `${A}/values/timeseries?keys=a&keys=b`)).status, 403)
  assert.equal((await read(baseUrl, `${A}/values/timeseries?keys=a%20b`)).status, 403)
  assert.equal((await read(baseUrl, `${A}/values/timeseries?keys=a&startTs=1`)).status, 403)
})

test('only telemetry read paths are allowed', async t => {
  const baseUrl = await gateway(t)
  assert.equal((await read(baseUrl, `${A}/timeseries/delete`)).status, 403)
  assert.equal((await read(baseUrl, `${A}/values/attributes`)).status, 403)
  assert.equal((await read(baseUrl, '/applications/telemetry/../api/tenant/devices')).status, 403)
  // sem dispositivo no caminho não há o que ler
  assert.equal((await read(baseUrl, '/applications/telemetry/values/timeseries')).status, 403)
})

test('writes are refused', async t => {
  const baseUrl = await gateway(t)
  assert.equal((await read(baseUrl, `${A}/values/timeseries?keys=level`, 'POST')).status, 403)
})

test('gateway fails closed without a strong secret or service credential', async t => {
  const weak = await startWithBackend(t, [], undefined, { TELEMETRY_JWT_SECRET: 'short' })
  assert.equal((await read(weak, `${A}/keys/timeseries`)).status, 503)

  const missing = await startWithBackend(t, [], undefined, { TB_TELEMETRY_TOKEN: '' })
  assert.equal((await read(missing, `${A}/keys/timeseries`)).status, 503)
})

test('health reports configuration state', async t => {
  const baseUrl = await gateway(t)
  const result = await fetch(baseUrl + '/health')
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { status: 'ok', commands: 'unconfigured' })
})

test('app key reads only the devices the backend allows', async t => {
  const calls = []
  const baseUrl = await startWithBackend(t, calls)

  const allowed = await authorizeWithKey(baseUrl, `${A}/values/timeseries`, APP_KEY)
  assert.equal(allowed.status, 204)
  assert.equal(calls[0].url, 'http://backend:3000/iot/apps/internal/authorize')
  assert.equal(calls[0].headers['X-Telemetry-Gateway'], SECRET)

  assert.equal((await authorizeWithKey(baseUrl, `/applications/telemetry/DEVICE/${DEVICE_B}/values/timeseries`, APP_KEY)).status, 403)
})

test('missing, revoked, unknown or malformed app keys are refused', async t => {
  const calls = []
  const baseUrl = await startWithBackend(t, calls)
  const uri = `${A}/values/timeseries`

  assert.equal((await authorizeWithKey(baseUrl, uri, null)).status, 401)
  assert.equal((await authorizeWithKey(baseUrl, uri, 'ioa_' + 'z'.repeat(40))).status, 401)
  assert.equal((await authorizeWithKey(baseUrl, uri, 'not-a-key')).status, 401)
  // a chave malformada nem chega ao backend
  assert.equal(calls.length, 1)
})

test('app key check fails closed when the backend is down', async t => {
  const baseUrl = await startWithBackend(t, [], async () => { throw new Error('ECONNREFUSED') })
  assert.equal((await authorizeWithKey(baseUrl, `${A}/values/timeseries`, APP_KEY)).status, 503)
})

test('devices endpoint lists what the app key reads', async t => {
  const baseUrl = await startWithBackend(t, [])

  const listed = await fetch(baseUrl + '/devices', { headers: { 'X-API-Key': APP_KEY } })
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), [{ id: DEVICE_A, name: 'Sensor_A', label: 'Sensor A' }])

  assert.equal((await fetch(baseUrl + '/devices')).status, 401)
  assert.equal((await fetch(baseUrl + '/devices', { headers: { 'X-API-Key': 'ioa_' + 'z'.repeat(40) } })).status, 401)
})

test('the old /telemetry path is refused; reads live under /applications', async t => {
  const baseUrl = await startWithBackend(t, [])
  const allowed = await authorizeWithKey(baseUrl, `/applications/telemetry/DEVICE/${DEVICE_A}/values/timeseries`, APP_KEY)
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers.get('x-telemetry-path'), `DEVICE/${DEVICE_A}/values/timeseries`)
  assert.equal((await authorizeWithKey(baseUrl, `/telemetry/DEVICE/${DEVICE_A}/values/timeseries`, APP_KEY)).status, 403)
  assert.equal((await authorizeWithKey(baseUrl, `/applications/rpc/DEVICE/${DEVICE_A}/values/timeseries`, APP_KEY)).status, 403)
})

// Comandos (RPC two-way): backend e ThingsBoard simulados no mesmo fetch
const VALVE = DEVICE_A
const rpcStub = (calls, { tb = async () => new Response('{"open":true}', { status: 200 }), commandDevices = [VALVE] } = {}) => async (url, options = {}) => {
  calls.push({ url, options })
  if (url.startsWith('http://backend:3000/iot/apps/internal/authorize')) {
    if (options.headers['X-API-Key'] !== APP_KEY) return new Response('{}', { status: 401 })
    return new Response(JSON.stringify({
      app: 'app-1',
      devices: [{ id: VALVE, name: 'Valvula', label: 'Válvula' }, { id: DEVICE_B, name: 'Sensor_B', label: 'Sensor B' }],
      ...(url.endsWith('?commands=1') ? { commandDevices } : {})
    }), { status: 200 })
  }
  if (url === 'http://backend:3000/iot/apps/internal/commands') return new Response('{}', { status: 201 })
  if (url.startsWith('http://tb:8080/api/plugins/rpc/twoway/')) return tb(url, options)
  return new Response('{}', { status: 404 })
}

const startRpc = async (t, fetchImpl, env = {}) => {
  let now = NOW
  const server = createTelemetryGateway({
    clock: () => now,
    fetchImpl,
    env: { TELEMETRY_JWT_SECRET: SECRET, TB_TELEMETRY_TOKEN: 'service-key', TB_RPC_TOKEN: 'rpc-key', THINGSBOARD_URL: 'http://tb:8080/', BACKEND_URL: 'http://backend:3000', ...env }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, advance: ms => { now += ms } }
}

const send = (baseUrl, device, body, key = APP_KEY) => fetch(`${baseUrl}/rpc/twoway/${device}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body)
})

test('a command reaches ThingsBoard with the RPC credential and is recorded', async t => {
  const calls = []
  const { baseUrl } = await startRpc(t, rpcStub(calls))

  const result = await send(baseUrl, VALVE, { method: 'setValve', params: { open: true }, timeout: 1, persistent: true })
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { open: true })

  const tb = calls.find(call => call.url.startsWith('http://tb:8080/'))
  assert.equal(tb.url, `http://tb:8080/api/plugins/rpc/twoway/${VALVE}`)
  assert.equal(tb.options.headers['X-Authorization'], 'ApiKey rpc-key')
  // só method e params seguem; o timeout é do gateway
  assert.deepEqual(JSON.parse(tb.options.body), { method: 'setValve', params: { open: true }, timeout: 10000 })

  const history = calls.find(call => call.url.endsWith('/internal/commands'))
  assert.equal(history.options.headers['X-Telemetry-Gateway'], SECRET)
  assert.deepEqual(JSON.parse(history.options.body), { app: 'app-1', device: VALVE, method: 'setValve', params: '{"open":true}', ok: true, response: '{"open":true}', error: '' })
})

test('a device that does not answer in time gives 504 and a failed entry in the history', async t => {
  const calls = []
  const { baseUrl } = await startRpc(t, rpcStub(calls, { tb: async () => new Response('', { status: 504 }) }))

  const result = await send(baseUrl, VALVE, { method: 'setValve', params: { open: true } })
  assert.equal(result.status, 504)
  const history = JSON.parse(calls.find(call => call.url.endsWith('/internal/commands')).options.body)
  assert.equal(history.ok, false)
  assert.equal(history.error, 'O dispositivo não respondeu em 10 s')
})

test('commands only go to devices the backend allows, with a valid body and key', async t => {
  const calls = []
  const { baseUrl } = await startRpc(t, rpcStub(calls))

  // DEVICE_B é lido pela chave, mas não comandado
  assert.equal((await send(baseUrl, DEVICE_B, { method: 'setPower', params: { on: true } })).status, 403)
  assert.equal((await send(baseUrl, VALVE, { method: 'setValve' }, 'ioa_' + 'z'.repeat(40))).status, 401)
  assert.equal((await send(baseUrl, VALVE, { method: 'setValve' }, null)).status, 401)
  assert.equal((await send(baseUrl, VALVE, 'não é json')).status, 400)
  assert.equal((await send(baseUrl, VALVE, { method: '1abc' })).status, 400)
  assert.equal((await send(baseUrl, VALVE, { params: {} })).status, 400)
  assert.equal((await send(baseUrl, VALVE, { method: 'setValve', params: { blob: 'x'.repeat(5000) } })).status, 400)
  assert.equal((await send(baseUrl, VALVE, { method: 'setValve', params: { blob: 'x'.repeat(9000) } })).status, 413)
  assert.equal((await fetch(`${baseUrl}/rpc/twoway/${VALVE}`, { headers: { 'X-API-Key': APP_KEY } })).status, 405)
  // nada disso chegou ao ThingsBoard
  assert.equal(calls.filter(call => call.url.startsWith('http://tb:8080/')).length, 0)
})

test('commands are limited per application and minute', async t => {
  const { baseUrl, advance } = await startRpc(t, rpcStub([]), { RPC_MAX_PER_MINUTE: '2' })
  assert.equal((await send(baseUrl, VALVE, { method: 'getState' })).status, 200)
  assert.equal((await send(baseUrl, VALVE, { method: 'getState' })).status, 200)
  assert.equal((await send(baseUrl, VALVE, { method: 'getState' })).status, 429)
  advance(60001)
  assert.equal((await send(baseUrl, VALVE, { method: 'getState' })).status, 200)
})

test('commands fail closed without the RPC credential or when the backend cannot check', async t => {
  const missing = await startRpc(t, rpcStub([]), { TB_RPC_TOKEN: '' })
  assert.equal((await send(missing.baseUrl, VALVE, { method: 'getState' })).status, 503)

  const down = await startRpc(t, async url => url.includes('/authorize') ? new Response('{}', { status: 503 }) : new Response('{}', { status: 201 }))
  assert.equal((await send(down.baseUrl, VALVE, { method: 'getState' })).status, 503)
})
