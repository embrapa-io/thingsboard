'use strict'

const crypto = require('node:crypto')
const http = require('node:http')

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_RANGE_DAYS = 31
const DEFAULT_MAX_POINTS = 500
const MIN_SECRET_LENGTH = 32
const MAX_KEYS = 50
// Comandos (RPC) pela chave de aplicação
const MAX_RPC_BODY = 8 * 1024
const MAX_RPC_PARAMS = 4 * 1024
const DEFAULT_RPC_TIMEOUT_MS = 10000
const DEFAULT_RPC_PER_MINUTE = 30

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const uuidPattern = new RegExp('^' + UUID + '$')
const devicePathPattern = new RegExp('^/telemetry/DEVICE/(' + UUID + ')/(values|keys)/timeseries$')
const ownPathPattern = /^\/telemetry\/(values|keys)\/timeseries$/
const rpcPathPattern = new RegExp('^/rpc/twoway/(' + UUID + ')$')
const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const methodPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
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

const getApiKey = request => String(request.headers['x-api-key'] || '').trim()

// Chave de aplicação (aba Aplicações do Embrapa I/O): o backend confere a chave a cada
// consulta, sem cache, para que trocar ou revogar valha na hora. Antes de um comando
// (commands), o backend também diz quais dispositivos a chave pode comandar agora.
const verifyApiKey = async (key, { backendUrl, secret, fetchImpl }, { commands = false } = {}) => {
  if (!/^ioa_[a-z0-9]{8,124}$/.test(key)) deny(401, 'invalid key')

  let response
  try {
    response = await fetchImpl(backendUrl + '/iot/apps/internal/authorize' + (commands ? '?commands=1' : ''), {
      headers: { 'X-Telemetry-Gateway': secret, 'X-API-Key': key },
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    deny(503, 'backend unavailable')
  }

  if (response.status === 401) deny(401, 'invalid key')
  if (response.status !== 200) deny(503, 'backend refused key check')

  const body = await response.json().catch(() => null)
  if (!body || typeof body.app !== 'string' || !Array.isArray(body.devices)) deny(503, 'invalid key check response')

  const list = body.devices.filter(device => device && typeof device.id === 'string' && uuidPattern.test(device.id))
  const commandList = Array.isArray(body.commandDevices) ? body.commandDevices : []
  return {
    scope: 'app',
    subject: body.app,
    devices: new Set(list.map(device => device.id.toLowerCase())),
    list: list.map(device => ({ id: device.id.toLowerCase(), name: String(device.name || ''), label: String(device.label || '') })),
    // só os que a chave também lê
    commandDevices: new Set(commandList
      .filter(id => typeof id === 'string' && uuidPattern.test(id))
      .map(id => id.toLowerCase())
      .filter(id => list.some(device => device.id.toLowerCase() === id)))
  }
}

const readBody = (request, max) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  // acima do limite, descarta o resto (sem cortar a conexão) para ainda responder 413
  request.on('data', chunk => {
    size += chunk.length
    if (size > max) return reject(new Denied(413, 'body too large'))
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', () => reject(new Denied(400, 'invalid body')))
})

// Corpo do comando: {"method": "...", "params": ...}. Só esses dois campos seguem para o
// ThingsBoard; timeout e persistência são do gateway.
const parseCommand = raw => {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    deny(400, 'invalid json')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) deny(400, 'invalid body')
  if (typeof body.method !== 'string' || !methodPattern.test(body.method)) deny(400, 'invalid method')
  const params = body.params === undefined ? {} : body.params
  const paramsText = JSON.stringify(params)
  if (paramsText.length > MAX_RPC_PARAMS) deny(400, 'params too large')
  return { method: body.method, params, paramsText }
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

  return deny(401, 'invalid scope')
}

const resolveTarget = (pathname, grant) => {
  const own = pathname.match(ownPathPattern)
  if (own) {
    if (grant.scope !== 'device') deny(403, 'device id required for app keys')
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

const createTelemetryGateway = ({ env = process.env, clock = Date.now, log = () => {}, fetchImpl = fetch } = {}) => {
  const secret = String(env.TELEMETRY_JWT_SECRET || '')
  const serviceToken = String(env.TB_TELEMETRY_TOKEN || '').trim()
  const backendUrl = String(env.BACKEND_URL || 'http://app:3000').replace(/\/$/, '')
  const issuer = String(env.TELEMETRY_JWT_ISSUER || 'embrapa-io')
  const audience = String(env.TELEMETRY_JWT_AUDIENCE || 'telemetry')
  const maxRangeDays = Number(env.TELEMETRY_MAX_RANGE_DAYS) > 0 ? Number(env.TELEMETRY_MAX_RANGE_DAYS) : DEFAULT_MAX_RANGE_DAYS
  const maxPoints = Number.isInteger(Number(env.TELEMETRY_MAX_POINTS)) && Number(env.TELEMETRY_MAX_POINTS) > 0 ? Number(env.TELEMETRY_MAX_POINTS) : DEFAULT_MAX_POINTS
  const ready = secret.length >= MIN_SECRET_LENGTH && serviceToken.length > 0
  // Comandos: credencial própria (Serviço · Comandos), separada da de leitura
  const rpcToken = String(env.TB_RPC_TOKEN || '').trim()
  const thingsboardUrl = String(env.THINGSBOARD_URL || 'http://thingsboard:8080').replace(/\/$/, '')
  const requestedTimeout = Number(env.RPC_TIMEOUT_MS)
  // o ThingsBoard aceita no mínimo 5 s
  const rpcTimeout = Number.isInteger(requestedTimeout) ? Math.min(Math.max(requestedTimeout, 5000), 60000) : DEFAULT_RPC_TIMEOUT_MS
  const rpcPerMinute = Number.isInteger(Number(env.RPC_MAX_PER_MINUTE)) && Number(env.RPC_MAX_PER_MINUTE) > 0 ? Number(env.RPC_MAX_PER_MINUTE) : DEFAULT_RPC_PER_MINUTE
  const rpcReady = secret.length >= MIN_SECRET_LENGTH && rpcToken.length > 0

  // Limite de comandos por aplicação numa janela de 1 minuto (além do limite do nginx)
  const recent = new Map()
  const takeSlot = (appId, now) => {
    const times = (recent.get(appId) || []).filter(time => now - time < 60000)
    if (times.length >= rpcPerMinute) {
      recent.set(appId, times)
      deny(429, 'too many commands')
    }
    times.push(now)
    recent.set(appId, times)
  }

  // Manda o comando e espera a resposta do dispositivo (two-way)
  const callDevice = async (deviceId, command) => {
    let response
    try {
      response = await fetchImpl(thingsboardUrl + '/api/plugins/rpc/twoway/' + deviceId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authorization': 'ApiKey ' + rpcToken },
        body: JSON.stringify({ method: command.method, params: command.params, timeout: rpcTimeout }),
        signal: AbortSignal.timeout(rpcTimeout + 5000)
      })
    } catch {
      return { ok: false, status: 504, error: 'O ThingsBoard não respondeu' }
    }
    const text = await response.text().catch(() => '')
    if (response.ok) return { ok: true, status: 200, body: text }
    if (response.status === 504 || response.status === 408) {
      return { ok: false, status: 504, error: 'O dispositivo não respondeu em ' + Math.round(rpcTimeout / 1000) + ' s' }
    }
    return { ok: false, status: 502, error: 'O ThingsBoard recusou o comando (' + response.status + ')' }
  }

  // Grava no histórico da aplicação; uma falha aqui não muda a resposta do comando
  const record = async entry => {
    try {
      const response = await fetchImpl(backendUrl + '/iot/apps/internal/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telemetry-Gateway': secret },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(3000)
      })
      if (response.status !== 201) log({ result: 'history_failed', status: response.status })
    } catch {
      log({ result: 'history_failed', status: 0 })
    }
  }

  const sendJson = (response, status, body) => {
    response.writeHead(status, jsonHeaders)
    response.end(JSON.stringify(body))
  }

  const RPC_MESSAGES = {
    400: 'Invalid command',
    401: 'Invalid key',
    403: 'This key cannot send commands to this device',
    413: 'Command too large',
    429: 'Too many commands, try again in a minute',
    503: 'Unavailable'
  }

  // JWT de projeto ou de dispositivo no Authorization, ou chave de aplicação no X-API-Key
  const grantFor = async (request, now) => {
    const key = getApiKey(request)
    if (key) return verifyApiKey(key, { backendUrl, secret, fetchImpl })

    const token = getBearerToken(request)
    if (!token) deny(401, 'missing token')
    return verifyToken(token, { secret, issuer, audience, now })
  }

  const authorize = async request => {
    // Sem segredo ou sem credencial de serviço, a camada falha fechada.
    if (!ready) deny(503, 'gateway not configured')

    const method = String(request.headers['x-original-method'] || '').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') deny(403, 'method not allowed')

    const now = clock()
    const grant = await grantFor(request, now)

    const original = new URL(String(request.headers['x-original-uri'] || '/'), 'http://telemetry')
    // A leitura fica sob /applications/telemetry/... (o antigo /telemetry/... saiu)
    const prefixed = original.pathname.match(/^\/applications(\/telemetry\/.*)$/)
    if (!prefixed) deny(403, 'path not allowed')
    const target = resolveTarget(prefixed[1], grant)
    const query = normalizeQuery(target.resource, original.searchParams, {
      maxRangeMs: maxRangeDays * DAY_MS,
      maxPoints,
      now
    })

    return { grant, target, query }
  }

  const handler = async (request, response) => {
    const url = new URL(request.url || '/', 'http://telemetry-gateway')

    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, jsonHeaders)
      return response.end(JSON.stringify({ status: ready ? 'ok' : 'unconfigured', commands: rpcReady ? 'ok' : 'unconfigured' }))
    }

    // Comando pela chave de aplicação (POST /applications/rpc/twoway/<id> no nginx). O gateway
    // atende de ponta a ponta: confere a chave e o dispositivo no backend, valida o corpo,
    // limita a frequência, chama o ThingsBoard e grava o histórico.
    const rpcPath = url.pathname.match(rpcPathPattern)
    if (rpcPath) {
      let grant = null
      let deviceId = rpcPath[1].toLowerCase()
      try {
        if (request.method !== 'POST') deny(405, 'method not allowed')
        if (!rpcReady) deny(503, 'commands not configured')
        const key = getApiKey(request)
        if (!key) deny(401, 'missing key')
        const command = parseCommand(await readBody(request, MAX_RPC_BODY))
        grant = await verifyApiKey(key, { backendUrl, secret, fetchImpl }, { commands: true })
        if (!grant.commandDevices.has(deviceId)) deny(403, 'device not allowed for commands')
        takeSlot(grant.subject, clock())

        const result = await callDevice(deviceId, command)
        await record({
          app: grant.subject,
          device: deviceId,
          method: command.method,
          params: command.paramsText,
          ok: result.ok,
          response: result.ok ? result.body : '',
          error: result.ok ? '' : result.error
        })
        log({ result: result.ok ? 'command_ok' : 'command_failed', scope: grant.scope, subject: grant.subject, device: deviceId, method: command.method, status: result.status })

        if (!result.ok) {
          return sendJson(response, result.status, { message: result.status === 504 ? 'The device did not respond in time' : 'ThingsBoard refused the command' })
        }
        // a resposta do dispositivo volta como veio (JSON, quando for)
        let isJson = true
        try { JSON.parse(result.body) } catch { isJson = false }
        response.writeHead(200, { 'Content-Type': (isJson ? 'application/json' : 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' })
        return response.end(result.body)
      } catch (error) {
        const status = error instanceof Denied ? error.status : 503
        log({ result: 'denied', status, reason: error instanceof Denied ? error.reason : 'internal error', resource: 'rpc', subject: grant ? grant.subject : undefined, device: deviceId })
        return sendJson(response, status, { message: RPC_MESSAGES[status] || (status === 405 ? 'Method not allowed' : 'Unavailable') })
      }
    }

    // Lista os dispositivos que a chave de aplicação lê (GET /telemetry/devices)
    if (request.method === 'GET' && url.pathname === '/devices') {
      try {
        if (!ready) deny(503, 'gateway not configured')
        const key = getApiKey(request)
        if (!key) deny(401, 'missing key')
        const grant = await verifyApiKey(key, { backendUrl, secret, fetchImpl })
        log({ result: 'allowed', scope: grant.scope, subject: grant.subject, resource: 'devices' })
        response.writeHead(200, jsonHeaders)
        return response.end(JSON.stringify(grant.list))
      } catch (error) {
        const status = error instanceof Denied ? error.status : 503
        log({ result: 'denied', status, reason: error instanceof Denied ? error.reason : 'internal error' })
        response.writeHead(status, jsonHeaders)
        return response.end(JSON.stringify({ message: status === 401 ? 'Invalid key' : 'Unavailable' }))
      }
    }

    if (request.method === 'GET' && url.pathname === '/internal/authorize') {
      try {
        const { grant, target, query } = await authorize(request)
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
