'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { createTelemetryGateway } = require('../src/server')

const SECRET = 'test-secret-with-at-least-thirty-two-characters'
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const DEVICE_A = '9d99bc90-c644-11f1-b7db-19719deed9d3'
const DEVICE_B = '9db90460-c644-11f1-b7db-19719deed9d3'
const DEVICE_C = '9e3f4b60-c644-11f1-b7db-19719deed9d3'

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

const token = (claims, { secret = SECRET, alg = 'HS256' } = {}) => {
  const head = encode({ alg, typ: 'JWT' })
  const body = encode({ iss: 'embrapa-io', aud: 'telemetry', exp: Math.floor(NOW / 1000) + 3600, ...claims })
  const signature = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url')
  return head + '.' + body + '.' + signature
}

const projectToken = (devices = [DEVICE_A, DEVICE_B], extra = {}) => token({ scope: 'project', sub: 'teste1', devices, ...extra })
const deviceToken = (device = DEVICE_C, extra = {}) => token({ scope: 'device', sub: device, project: 'teste1', ...extra })

const start = async (env = {}) => {
  const server = createTelemetryGateway({
    clock: () => NOW,
    env: { TELEMETRY_JWT_SECRET: SECRET, TB_TELEMETRY_TOKEN: 'service-key', ...env }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port }
}

const authorize = (baseUrl, uri, bearer, method = 'GET') => fetch(baseUrl + '/internal/authorize', {
  headers: {
    'X-Original-URI': uri,
    'X-Original-Method': method,
    ...(bearer ? { Authorization: 'Bearer ' + bearer } : {})
  }
})

const gateway = async t => {
  const { server, baseUrl } = await start()
  t.after(() => server.close())
  return baseUrl
}

test('project token reaches a listed device and gets a normalized query', async t => {
  const baseUrl = await gateway(t)
  const start = NOW - 24 * 3600 * 1000
  const result = await authorize(baseUrl, `/telemetry/DEVICE/${DEVICE_A}/values/timeseries?keys=temperature,humidity&startTs=${start}&endTs=${NOW}&agg=avg&interval=60000`, projectToken())

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

test('project token cannot reach a device outside its list', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, `/telemetry/DEVICE/${DEVICE_C}/values/timeseries?keys=temperature`, projectToken())
  assert.equal(result.status, 403)
  assert.equal(result.headers.get('x-telemetry-authorization'), null)
})

test('project token requires the device id in the path', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, '/telemetry/values/timeseries?keys=temperature', projectToken())
  assert.equal(result.status, 403)
})

test('device token uses its own subject when the path has no device', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, '/telemetry/keys/timeseries', deviceToken())
  assert.equal(result.status, 204)
  assert.equal(result.headers.get('x-telemetry-path'), `DEVICE/${DEVICE_C}/keys/timeseries`)
  assert.equal(result.headers.get('x-telemetry-query'), '')
})

test('device token cannot reach another device', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, `/telemetry/DEVICE/${DEVICE_A}/keys/timeseries`, deviceToken())
  assert.equal(result.status, 403)
})

test('latest values pass without a period', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, '/telemetry/values/timeseries?keys=level&useStrictDataTypes=true', deviceToken())
  assert.equal(result.status, 204)
  assert.equal(result.headers.get('x-telemetry-query'), 'keys=level&useStrictDataTypes=true')
})

test('periods longer than the maximum are clipped to the most recent days', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, `/telemetry/values/timeseries?keys=level&startTs=0&endTs=${NOW}&limit=9999`, deviceToken())
  assert.equal(result.status, 204)
  const query = new URLSearchParams(result.headers.get('x-telemetry-query'))
  assert.equal(Number(query.get('startTs')), NOW - 31 * 24 * 3600 * 1000)
  assert.equal(query.get('limit'), '500')
  assert.equal(query.get('agg'), 'NONE')
})

test('unknown or repeated parameters are refused', async t => {
  const baseUrl = await gateway(t)
  assert.equal((await authorize(baseUrl, '/telemetry/values/timeseries?keys=level&entityType=TENANT', deviceToken())).status, 403)
  assert.equal((await authorize(baseUrl, '/telemetry/values/timeseries?keys=a&keys=b', deviceToken())).status, 403)
  assert.equal((await authorize(baseUrl, '/telemetry/values/timeseries?keys=a%20b', deviceToken())).status, 403)
  assert.equal((await authorize(baseUrl, '/telemetry/values/timeseries?keys=a&startTs=1', deviceToken())).status, 403)
})

test('only telemetry read paths are allowed', async t => {
  const baseUrl = await gateway(t)
  assert.equal((await authorize(baseUrl, `/telemetry/DEVICE/${DEVICE_C}/timeseries/delete`, deviceToken())).status, 403)
  assert.equal((await authorize(baseUrl, `/telemetry/DEVICE/${DEVICE_C}/values/attributes`, deviceToken())).status, 403)
  assert.equal((await authorize(baseUrl, '/telemetry/../api/tenant/devices', deviceToken())).status, 403)
})

test('writes are refused', async t => {
  const baseUrl = await gateway(t)
  const result = await authorize(baseUrl, '/telemetry/values/timeseries?keys=level', deviceToken(), 'POST')
  assert.equal(result.status, 403)
})

test('invalid tokens are refused with 401', async t => {
  const baseUrl = await gateway(t)
  const uri = '/telemetry/keys/timeseries'
  assert.equal((await authorize(baseUrl, uri, null)).status, 401)
  assert.equal((await authorize(baseUrl, uri, deviceToken(DEVICE_C, { exp: Math.floor(NOW / 1000) - 1 }))).status, 401)
  assert.equal((await authorize(baseUrl, uri, token({ scope: 'device', sub: DEVICE_C }, { secret: 'another-secret-with-at-least-32-characters' }))).status, 401)
  assert.equal((await authorize(baseUrl, uri, token({ scope: 'device', sub: DEVICE_C }, { alg: 'none' }))).status, 401)
  assert.equal((await authorize(baseUrl, uri, deviceToken(DEVICE_C, { iss: 'someone-else' }))).status, 401)
  assert.equal((await authorize(baseUrl, uri, deviceToken(DEVICE_C, { aud: 'other' }))).status, 401)
  assert.equal((await authorize(baseUrl, uri, token({ scope: 'tenant', sub: DEVICE_C }))).status, 401)
})

test('gateway fails closed without a strong secret or service credential', async t => {
  const weak = await start({ TELEMETRY_JWT_SECRET: 'short' })
  t.after(() => weak.server.close())
  assert.equal((await authorize(weak.baseUrl, '/telemetry/keys/timeseries', deviceToken())).status, 503)

  const missing = await start({ TB_TELEMETRY_TOKEN: '' })
  t.after(() => missing.server.close())
  assert.equal((await authorize(missing.baseUrl, '/telemetry/keys/timeseries', deviceToken())).status, 503)
})

test('health reports configuration state', async t => {
  const baseUrl = await gateway(t)
  const result = await fetch(baseUrl + '/health')
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { status: 'ok' })
})
