'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createAuthGateway, isManagerAttribute } = require('../src/server')

const response = (status, data) => ({
  status,
  text: async () => data === null ? '' : JSON.stringify(data)
})

const start = async (fetchImpl, env = {}) => {
  const server = createAuthGateway({
    fetchImpl,
    env: {
      TB_URL: 'http://thingsboard.test',
      TB_GATEWAY_TOKEN: 'gateway-token',
      ...env
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, baseUrl: 'http://127.0.0.1:' + address.port }
}

const post = (baseUrl, path, body) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

test('manager attribute only accepts the real boolean true', () => {
  assert.equal(isManagerAttribute([{ key: 'manager', value: true }]), true)
  assert.equal(isManagerAttribute([{ key: 'manager', value: 'true' }]), false)
  assert.equal(isManagerAttribute([{ key: 'manager', value: 1 }]), false)
  assert.equal(isManagerAttribute([]), false)
})

test('login returns tokens only for a manager', async t => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/login')) return response(200, { token: 'user-token', refreshToken: 'refresh-token' })
    if (url.endsWith('/api/auth/user')) {
      assert.equal(options.headers.Authorization, 'Bearer user-token')
      return response(200, { id: { id: 'user-1' } })
    }
    if (url.includes('/api/plugins/telemetry/USER/user-1/')) {
      assert.equal(options.headers['X-Authorization'], 'ApiKey gateway-token')
      return response(200, [{ key: 'manager', value: true }])
    }
    throw new Error('unexpected upstream URL ' + url)
  }
  const { server, baseUrl } = await start(fetchImpl)
  t.after(() => server.close())

  const result = await post(baseUrl, '/api/auth/login', { username: 'manager@example.test', password: 'secret' })
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { token: 'user-token', refreshToken: 'refresh-token' })
})

test('login denies a missing manager without returning tokens', async t => {
  const fetchImpl = async url => {
    if (url.endsWith('/api/auth/login')) return response(200, { token: 'user-token', refreshToken: 'refresh-token' })
    if (url.endsWith('/api/auth/user')) return response(200, { id: { id: 'user-2' } })
    if (url.includes('/api/plugins/telemetry/USER/user-2/')) return response(200, [{ key: 'manager', value: 'true' }])
    throw new Error('unexpected upstream URL ' + url)
  }
  const { server, baseUrl } = await start(fetchImpl)
  t.after(() => server.close())

  const result = await post(baseUrl, '/api/auth/login', { username: 'user@example.test', password: 'secret' })
  assert.equal(result.status, 403)
  assert.deepEqual(await result.json(), { message: 'Manager access required' })
})

test('internal authorization fails closed when the gateway credential is unavailable', async t => {
  const fetchImpl = async () => response(200, { id: { id: 'user-1' } })
  const { server, baseUrl } = await start(fetchImpl, { TB_GATEWAY_TOKEN: '' })
  t.after(() => server.close())

  const result = await fetch(baseUrl + '/internal/authorize', {
    headers: { Authorization: 'Bearer user-token' }
  })
  assert.equal(result.status, 503)
})
