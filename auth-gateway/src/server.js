'use strict'

const http = require('node:http')

const DEFAULT_MAX_BODY_BYTES = 32 * 1024
const DEFAULT_TIMEOUT_MS = 3000

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
}

const readBody = (request, maxBytes) => new Promise((resolve, reject) => {
  let body = ''
  let size = 0
  let settled = false

  const fail = error => {
    if (settled) return
    settled = true
    reject(error)
  }

  request.setEncoding('utf8')
  request.on('data', chunk => {
    size += Buffer.byteLength(chunk)
    if (size > maxBytes) {
      fail(Object.assign(new Error('request body too large'), { status: 413 }))
      request.destroy()
      return
    }
    body += chunk
  })
  request.on('end', () => {
    if (!settled) {
      settled = true
      resolve(body)
    }
  })
  request.on('error', fail)
})

const sendJson = (response, status, payload, extraHeaders = {}) => {
  const data = JSON.stringify(payload)
  response.writeHead(status, { ...jsonHeaders, ...extraHeaders, 'Content-Length': Buffer.byteLength(data) })
  response.end(data)
}

const sendEmpty = (response, status, extraHeaders = {}) => {
  response.writeHead(status, { ...extraHeaders, 'Content-Length': '0' })
  response.end()
}

const getBearerToken = request => {
  const value = String(request.headers.authorization || '')
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

const parseJsonBody = async (request, maxBytes) => {
  const raw = await readBody(request, maxBytes)
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('invalid json')
    error.status = 400
    throw error
  }
}

const createRequester = ({ fetchImpl, baseUrl, timeoutMs }) => async (path, options = {}) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(baseUrl + path, {
      ...options,
      signal: controller.signal
    })
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { message: 'invalid upstream response' }
      }
    }
    return { status: response.status, headers: response.headers, data }
  } finally {
    clearTimeout(timer)
  }
}

const getEntityId = user => {
  if (!user || !user.id) return ''
  if (typeof user.id === 'string') return user.id
  return String(user.id.id || '')
}

const isManagerAttribute = attributes => {
  if (!Array.isArray(attributes)) return false
  const attribute = attributes.find(item => item && item.key === 'manager')
  return Boolean(attribute && attribute.value === true)
}

const createAuthGateway = ({ env = process.env, fetchImpl = global.fetch } = {}) => {
  const baseUrl = String(env.TB_URL || 'http://thingsboard:8080').replace(/\/+$/, '')
  const gatewayToken = String(env.TB_GATEWAY_TOKEN || '').trim()
  const timeoutMs = Number.isFinite(Number(env.TB_REQUEST_TIMEOUT_MS)) && Number(env.TB_REQUEST_TIMEOUT_MS) > 0
    ? Number(env.TB_REQUEST_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
  const maxBodyBytes = Number.isFinite(Number(env.AUTH_GATEWAY_MAX_BODY_BYTES)) && Number(env.AUTH_GATEWAY_MAX_BODY_BYTES) > 0
    ? Number(env.AUTH_GATEWAY_MAX_BODY_BYTES)
    : DEFAULT_MAX_BODY_BYTES
  const requestUpstream = createRequester({ fetchImpl, baseUrl, timeoutMs })

  const checkManager = async accessToken => {
    if (!accessToken) return { kind: 'invalid' }
    if (!gatewayToken) return { kind: 'unavailable' }

    let userResponse
    try {
      userResponse = await requestUpstream('/api/auth/user', {
        headers: { Authorization: 'Bearer ' + accessToken }
      })
    } catch {
      return { kind: 'unavailable' }
    }

    if (userResponse.status === 401 || userResponse.status === 403) return { kind: 'invalid' }
    if (userResponse.status < 200 || userResponse.status >= 300) return { kind: 'unavailable' }

    const userId = getEntityId(userResponse.data)
    if (!userId) return { kind: 'unavailable' }

    let attributesResponse
    try {
      const path = '/api/plugins/telemetry/USER/' + encodeURIComponent(userId) + '/values/attributes/SERVER_SCOPE?keys=manager'
      attributesResponse = await requestUpstream(path, {
        headers: { 'X-Authorization': 'ApiKey ' + gatewayToken }
      })
    } catch {
      return { kind: 'unavailable' }
    }

    if (attributesResponse.status < 200 || attributesResponse.status >= 300) return { kind: 'unavailable' }
    return { kind: isManagerAttribute(attributesResponse.data) ? 'manager' : 'forbidden' }
  }

  const authenticateResponse = async ({ path, body }) => {
    let upstream
    try {
      upstream = await requestUpstream(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch {
      return { status: 503, payload: { message: 'Authentication service unavailable' } }
    }

    if (upstream.status === 401 || upstream.status === 403) {
      return { status: 401, payload: { message: 'Authentication failed' } }
    }
    if (upstream.status < 200 || upstream.status >= 300 || !upstream.data || !upstream.data.token) {
      return { status: 503, payload: { message: 'Authentication service unavailable' } }
    }

    const decision = await checkManager(upstream.data.token)
    if (decision.kind === 'manager') return { status: upstream.status, payload: upstream.data }
    if (decision.kind === 'forbidden') return { status: 403, payload: { message: 'Manager access required' } }
    if (decision.kind === 'invalid') return { status: 401, payload: { message: 'Authentication failed' } }
    return { status: 503, payload: { message: 'Authorization service unavailable' } }
  }

  const authorizeRequest = async request => {
    const decision = await checkManager(getBearerToken(request))
    if (decision.kind === 'manager') return { status: 204 }
    if (decision.kind === 'forbidden') return { status: 403 }
    if (decision.kind === 'invalid') return { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    return { status: 503 }
  }

  const handler = async (request, response) => {
    const url = new URL(request.url || '/', 'http://auth-gateway')

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { status: 'ok' })
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/internal/authorize') {
      const result = await authorizeRequest(request)
      if (result.status === 204) return sendEmpty(response, 204)
      return sendJson(response, result.status, { message: result.status === 403 ? 'Manager access required' : 'Authorization failed' }, result.headers)
    }

    if (request.method === 'POST' && (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/token')) {
      try {
        const body = await parseJsonBody(request, maxBodyBytes)
        const result = await authenticateResponse({ path: url.pathname, body })
        return sendJson(response, result.status, result.payload)
      } catch (error) {
        const status = error.status || 400
        return sendJson(response, status, { message: status === 413 ? 'Request body too large' : 'Invalid request' })
      }
    }

    return sendJson(response, 404, { message: 'Not found' })
  }

  return http.createServer((request, response) => {
    handler(request, response).catch(() => sendJson(response, 503, { message: 'Authorization service unavailable' }))
  })
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000)
  createAuthGateway().listen(port, '0.0.0.0', () => {
    process.stdout.write('auth-gateway listening on ' + port + '\n')
  })
}

module.exports = {
  createAuthGateway,
  isManagerAttribute
}
