'use strict'

const crypto = require('node:crypto')
const http = require('node:http')

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_RANGE_DAYS = 31
const DEFAULT_MAX_POINTS = 500
const MIN_SECRET_LENGTH = 32
const MAX_PROJECT_DEVICES = 1000
const MAX_KEYS = 50

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const uuidPattern = new RegExp('^' + UUID + '$')
const devicePathPattern = new RegExp('^/telemetry/DEVICE/(' + UUID + ')/(values|keys)/timeseries$')
const ownPathPattern = /^\/telemetry\/(values|keys)\/timeseries$/
const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const aggregations = new Set(['NONE', 'AVG', 'MIN', 'MAX', 'SUM', 'COUNT'])

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
}

class Denied extends Error {
  constructor (status, reason) {
    super(reason)
    this.status = status
    this.reason = reason
  }
}

const deny = (status, reason) => { throw new Denied(status, reason) }

const base64urlJson = value => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

const sign = (input, secret) => crypto.createHmac('sha256', secret).update(input).digest()

const getBearerToken = request => {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : ''
}

const verifyToken = (token, { secret, issuer, audience, now }) => {
  const parts = token.split('.')
  if (parts.length !== 3) deny(401, 'malformed token')

  const header = base64urlJson(parts[0])
  if (!header || header.alg !== 'HS256') deny(401, 'unsupported algorithm')

  const expected = sign(parts[0] + '.' + parts[1], secret)
  let supplied
  try {
    supplied = Buffer.from(parts[2], 'base64url')
  } catch {
    deny(401, 'invalid signature')
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) deny(401, 'invalid signature')

  const claims = base64urlJson(parts[1])
  if (!claims || typeof claims !== 'object') deny(401, 'invalid claims')
  if (claims.iss !== issuer) deny(401, 'invalid issuer')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(audience)) deny(401, 'invalid audience')

  const seconds = Math.floor(now / 1000)
  if (!Number.isInteger(claims.exp) || claims.exp <= seconds) deny(401, 'expired token')
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds)) deny(401, 'token not active')

  if (claims.scope === 'device') {
    if (typeof claims.sub !== 'string' || !uuidPattern.test(claims.sub)) deny(401, 'invalid device subject')
    return { scope: 'device', subject: claims.sub, devices: new Set([claims.sub.toLowerCase()]) }
  }

  if (claims.scope === 'project') {
    if (typeof claims.sub !== 'string' || !claims.sub) deny(401, 'invalid project subject')
    if (!Array.isArray(claims.devices) || claims.devices.length > MAX_PROJECT_DEVICES) deny(401, 'invalid device list')
    const devices = new Set()
    for (const device of claims.devices) {
      if (typeof device !== 'string' || !uuidPattern.test(device)) deny(401, 'invalid device list')
      devices.add(device.toLowerCase())
    }
    return { scope: 'project', subject: claims.sub, devices }
  }

  return deny(401, 'invalid scope')
}

const resolveTarget = (pathname, grant) => {
  const own = pathname.match(ownPathPattern)
  if (own) {
    if (grant.scope !== 'device') deny(403, 'device id required for project tokens')
    return { deviceId: grant.subject.toLowerCase(), resource: own[1] }
  }

  const explicit = pathname.match(devicePathPattern)
  if (!explicit) deny(403, 'path not allowed')

  const deviceId = explicit[1].toLowerCase()
  if (!grant.devices.has(deviceId)) deny(403, 'device not allowed')
  return { deviceId, resource: explicit[2] }
}

const single = (params, name) => {
  const values = params.getAll(name)
  if (values.length > 1) deny(403, 'repeated parameter ' + name)
  return values.length ? values[0] : undefined
}

const integer = (value, name) => {
  if (!/^\d{1,16}$/.test(String(value))) deny(403, 'invalid ' + name)
  return Number(value)
}

const normalizeQuery = (resource, params, { maxRangeMs, maxPoints, now }) => {
  const output = new URLSearchParams()

  if (resource === 'keys') {
    if ([...params.keys()].length) deny(403, 'keys endpoint takes no parameters')
    return output
  }

  const allowed = new Set(['keys', 'startTs', 'endTs', 'interval', 'limit', 'agg', 'orderBy', 'useStrictDataTypes'])
  for (const name of params.keys()) {
    if (!allowed.has(name)) deny(403, 'parameter not allowed: ' + name)
  }

  const keysValue = single(params, 'keys')
  if (keysValue !== undefined) {
    const keys = keysValue.split(',').map(key => key.trim()).filter(Boolean)
    if (!keys.length || keys.length > MAX_KEYS || !keys.every(key => keyPattern.test(key))) deny(403, 'invalid keys')
    output.set('keys', keys.join(','))
  }

  const strict = single(params, 'useStrictDataTypes')
  if (strict !== undefined) {
    if (strict !== 'true' && strict !== 'false') deny(403, 'invalid useStrictDataTypes')
    output.set('useStrictDataTypes', strict)
  }

  const startValue = single(params, 'startTs')
  const endValue = single(params, 'endTs')

  if (startValue === undefined && endValue === undefined) {
    // Sem período, o ThingsBoard devolve o último valor de cada chave.
    for (const name of ['interval', 'limit', 'agg', 'orderBy']) {
      if (params.has(name)) deny(403, name + ' requires startTs and endTs')
    }
    return output
  }

  if (startValue === undefined || endValue === undefined) deny(403, 'startTs and endTs go together')
  if (keysValue === undefined) deny(403, 'keys required for a period query')

  const endTs = Math.min(integer(endValue, 'endTs'), now + 60 * 1000)
  let startTs = integer(startValue, 'startTs')
  if (startTs >= endTs) deny(403, 'startTs must precede endTs')
  // Períodos maiores que o permitido são recortados para os mais recentes.
  startTs = Math.max(startTs, endTs - maxRangeMs)

  const aggValue = single(params, 'agg')
  const agg = aggValue === undefined ? 'NONE' : aggValue.toUpperCase()
  if (!aggregations.has(agg)) deny(403, 'invalid agg')

  const limitValue = single(params, 'limit')
  const limit = limitValue === undefined ? maxPoints : Math.min(Math.max(integer(limitValue, 'limit'), 1), maxPoints)

  output.set('startTs', String(startTs))
  output.set('endTs', String(endTs))
  output.set('agg', agg)
  output.set('limit', String(limit))

  if (agg !== 'NONE') {
    const intervalValue = single(params, 'interval')
    const requested = intervalValue === undefined ? 0 : integer(intervalValue, 'interval')
    const minimum = Math.max(1000, Math.ceil((endTs - startTs) / maxPoints))
    output.set('interval', String(Math.max(requested, minimum)))
  }

  const orderBy = single(params, 'orderBy')
  if (orderBy !== undefined) {
    if (orderBy !== 'ASC' && orderBy !== 'DESC') deny(403, 'invalid orderBy')
    output.set('orderBy', orderBy)
  }

  return output
}

const createTelemetryGateway = ({ env = process.env, clock = Date.now, log = () => {} } = {}) => {
  const secret = String(env.TELEMETRY_JWT_SECRET || '')
  const serviceToken = String(env.TB_TELEMETRY_TOKEN || '').trim()
  const issuer = String(env.TELEMETRY_JWT_ISSUER || 'embrapa-io')
  const audience = String(env.TELEMETRY_JWT_AUDIENCE || 'telemetry')
  const maxRangeDays = Number(env.TELEMETRY_MAX_RANGE_DAYS) > 0 ? Number(env.TELEMETRY_MAX_RANGE_DAYS) : DEFAULT_MAX_RANGE_DAYS
  const maxPoints = Number.isInteger(Number(env.TELEMETRY_MAX_POINTS)) && Number(env.TELEMETRY_MAX_POINTS) > 0 ? Number(env.TELEMETRY_MAX_POINTS) : DEFAULT_MAX_POINTS
  const ready = secret.length >= MIN_SECRET_LENGTH && serviceToken.length > 0

  const authorize = request => {
    // Sem segredo ou sem credencial de serviço, a camada falha fechada.
    if (!ready) deny(503, 'gateway not configured')

    const method = String(request.headers['x-original-method'] || '').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') deny(403, 'method not allowed')

    const token = getBearerToken(request)
    if (!token) deny(401, 'missing token')

    const now = clock()
    const grant = verifyToken(token, { secret, issuer, audience, now })

    const original = new URL(String(request.headers['x-original-uri'] || '/'), 'http://telemetry')
    const target = resolveTarget(original.pathname, grant)
    const query = normalizeQuery(target.resource, original.searchParams, {
      maxRangeMs: maxRangeDays * DAY_MS,
      maxPoints,
      now
    })

    return { grant, target, query }
  }

  const handler = (request, response) => {
    const url = new URL(request.url || '/', 'http://telemetry-gateway')

    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, jsonHeaders)
      return response.end(JSON.stringify({ status: ready ? 'ok' : 'unconfigured' }))
    }

    if (request.method === 'GET' && url.pathname === '/internal/authorize') {
      try {
        const { grant, target, query } = authorize(request)
        log({ result: 'allowed', scope: grant.scope, subject: grant.subject, device: target.deviceId, resource: target.resource })
        response.writeHead(204, {
          'X-Telemetry-Path': 'DEVICE/' + target.deviceId + '/' + target.resource + '/timeseries',
          'X-Telemetry-Query': query.toString(),
          'X-Telemetry-Authorization': 'ApiKey ' + serviceToken,
          'Content-Length': '0'
        })
        return response.end()
      } catch (error) {
        const status = error instanceof Denied ? error.status : 503
        log({ result: 'denied', status, reason: error instanceof Denied ? error.reason : 'internal error' })
        response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store' })
        return response.end()
      }
    }

    response.writeHead(404, jsonHeaders)
    return response.end(JSON.stringify({ message: 'Not found' }))
  }

  return http.createServer(handler)
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000)
  // O log nunca inclui o token nem a credencial de serviço.
  const log = entry => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
  createTelemetryGateway({ log }).listen(port, '0.0.0.0', () => {
    process.stdout.write('telemetry-gateway listening on ' + port + '\n')
  })
}

module.exports = {
  createTelemetryGateway,
  normalizeQuery,
  verifyToken
}
