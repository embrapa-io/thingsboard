// Regra de controle criada pelo próprio pesquisador no ThingsBoard: o Responsável
// da localidade (usuário do tenant só com papel de grupo) cria no HVAC um campo
// calculado que lê a temperatura do sensor da sala e liga/desliga o HVAC com
// histerese. Testa no servidor e no Edge com o servidor desligado, com o HVAC
// conectado por MQTT ao Edge recebendo o comando por push.
import crypto from 'node:crypto'
import mqtt from 'mqtt'
import { CFG, ENV, api, login, sleep, docker } from './lib.mjs'

const P = 'rbac10'
const out = []
const log = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${msg}`) }
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []
let ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const T = (m, p, body) => api(m, p, { token: ten, body })

const limpar = async T => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const g of list(await T('GET', `/api/entityGroups/USER${page}`)).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
}
await limpar(T)

// --- cenário: unidade A, localidade L1 com o sensor da sala e o HVAC
const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
const L1 = must(await T('POST', '/api/entityGroup', { name: `${P} LOC Sala 1`, type: 'DEVICE', ownerId: A.id }), 'L1')
const sensor = must(await T('POST', `/api/device?entityGroupId=${L1.id.id}`, { name: `${P}-sala1-temperatura`, type: 'default' }), 'sensor')
const hvac = must(await T('POST', `/api/device?entityGroupId=${L1.id.id}`, { name: `${P}-sala1-hvac`, type: 'default' }), 'hvac')
const tokSensor = must(await T('GET', `/api/device/${sensor.id.id}/credentials`), 'cred').credentialsId
const tokHvac = must(await T('GET', `/api/device/${hvac.id.id}/credentials`), 'cred').credentialsId
const role = must(await T('POST', '/api/role', { name: `${P} Responsável com regras`, type: 'GROUP',
  permissions: ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CREDENTIALS', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'RPC_CALL', 'READ_CALCULATED_FIELD', 'WRITE_CALCULATED_FIELD'] }), 'role')
const ug = must(await T('POST', '/api/entityGroup', { name: `${P} Sala 1 Responsáveis`, type: 'USER' }), 'ug')
must(await T('POST', '/api/groupPermission', { roleId: role.id, userGroupId: ug.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'perm')
const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${ug.id.id}`, { email: `${P}-responsavel@tb44.local`, authority: 'TENANT_ADMIN' }), 'user')
const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
const pwd = crypto.randomBytes(12).toString('base64url')
must(await api('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd } }), 'activate')
const R = (m, p, body) => api(m, p, { token: tok.resp, body })
const tok = { resp: await login(u.email, pwd) }

// --- o Responsável define o alvo e cria a regra no HVAC
let r = await R('POST', `/api/plugins/telemetry/DEVICE/${hvac.id.id}/SERVER_SCOPE`, { alvo: 24 })
log('H0', r.status === 200, `Responsável grava o alvo (atributo de servidor alvo = 24) no HVAC: HTTP ${r.status}`)
const regra = {
  entityId: hvac.id, type: 'SCRIPT', name: 'Controle de temperatura da sala', configuration: {
    type: 'SCRIPT',
    arguments: {
      temp: { refEntityId: sensor.id, refEntityKey: { key: 'temperatura', type: 'TS_LATEST' } },
      alvo: { refEntityKey: { key: 'alvo', type: 'ATTRIBUTE', scope: 'SERVER_SCOPE' }, defaultValue: '24' },
      // A regra não recebe o próprio resultado como argumento; a histerese usa o
      // estado que o HVAC confirma (atributo de cliente), como recomenda o guia de SCADA
      estado: { refEntityKey: { key: 'estado', type: 'ATTRIBUTE', scope: 'CLIENT_SCOPE' }, defaultValue: 'false' }
    },
    expression: 'var on = (estado == true || estado == "true"); if (temp > alvo + 0.5) { on = true; } if (temp < alvo - 0.5) { on = false; } return {"ligado": on};',
    output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE',
      strategy: { type: 'IMMEDIATE', saveAttribute: true, sendWsUpdate: true, processCfs: true, updateAttributesOnlyOnValueChange: true } }
  }
}
r = await R('POST', '/api/calculatedField', regra)
log('H1', r.status === 200, `Responsável cria no HVAC a regra que lê a temperatura do sensor da sala: HTTP ${r.status}${r.status === 200 ? '' : ' ' + (r.json && r.json.message)}`)
if (r.status !== 200) process.exit(1)

const estado = async (base, token) => {
  const a = list(await api('GET', `/api/plugins/telemetry/DEVICE/${hvac.id.id}/values/attributes/SHARED_SCOPE?keys=ligado`, { token, base }))[0]
  return a ? String(a.value) : '(sem valor)'
}
const temp = async (v, base = CFG.base) => { await api('POST', `/api/v1/${tokSensor}/telemetry`, { body: { temperatura: v }, base }); await sleep(4000) }

// HVAC simulado: recebe `ligado` por push e confirma o que aplicou no atributo de cliente `estado`
const recebidos = []
const hvacMqtt = url => new Promise(res => {
  const c = mqtt.connect(url, { username: tokHvac, reconnectPeriod: 2000, connectTimeout: 8000 })
  c.on('message', (_t, msg) => {
    const s = msg.toString(); recebidos.push(s)
    const m = JSON.parse(s); const v = m.ligado !== undefined ? m.ligado : (m.shared && m.shared.ligado)
    if (v !== undefined) c.publish('v1/devices/me/attributes', JSON.stringify({ estado: v }), { qos: 1 })
  })
  c.on('connect', () => c.subscribe('v1/devices/me/attributes', { qos: 1 }, () => res(c)))
  c.on('error', () => res(c))
})

// --- no servidor: histerese em torno de 24 °C
let cli = await hvacMqtt(CFG.mqtt)
const seq = [[26, 'true'], [24.2, 'true'], [23, 'false'], [24.3, 'false'], [25, 'true']]
const got = []
for (const [v, exp] of seq) { await temp(v); got.push([v, await estado(CFG.base, ten), exp]) }
cli.end(true)
log('H2', got.every(([, g, e]) => g === e), `servidor: ${got.map(([v, g, e]) => `${v} °C → ${g}${g === e ? '' : ' (esperado ' + e + ')'}`).join('; ')}`)

// --- no Edge, com o servidor desligado e o HVAC conectado por MQTT
const edge = list(await T('GET', `/api/edges${page}`))[0]
must(await T('POST', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`), 'atribuir L1 ao Edge')
const et = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD, CFG.edge)
let regrasEdge = []
for (let i = 0; i < 12 && !regrasEdge.length; i++) { await sleep(5000); regrasEdge = list(await api('GET', `/api/DEVICE/${hvac.id.id}/calculatedFields${page}`, { token: et, base: CFG.edge })) }
log('H3', regrasEdge.length > 0, `regra do HVAC no ${edge.name}: ${regrasEdge.map(c => c.name).join(', ') || 'não chegou em 60 s'}`)

recebidos.length = 0
cli = await hvacMqtt(CFG.edgeMqtt)

try {
  docker('stop', CFG.serverContainer)
  await sleep(3000)
  // o HVAC estava ligado (25 °C); offline: desliga, fica na zona morta, liga de novo
  const off = []
  for (const [v, exp] of [[22, 'false'], [24.4, 'false'], [27, 'true']]) { await temp(v, CFG.edge); off.push([v, await estado(CFG.edge, et), exp]) }
  log('H4', off.every(([, g, e]) => g === e), `Edge com o servidor DESLIGADO: ${off.map(([v, g, e]) => `${v} °C → ${g}${g === e ? '' : ' (esperado ' + e + ')'}`).join('; ')}`)
  log('H5', recebidos.some(m => m.includes('"ligado":true')) && recebidos.some(m => m.includes('"ligado":false')),
    `o HVAC, conectado ao Edge por MQTT, recebeu por push: ${recebidos.join(' ') || 'nada'}`)
} finally {
  docker('start', CFG.serverContainer)
  cli.end(true)
}

// --- servidor de volta: o estado decidido offline sobe para a Central?
for (let i = 0; i < 60; i++) { try { ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD); break } catch { await sleep(5000) } }
let central = ''
for (let i = 0; i < 18 && central !== 'true'; i++) { await sleep(5000); central = await estado(CFG.base, ten) }
log('H6', central === 'true', `depois de religar a Central, o estado do HVAC nela (último decidido offline: true): ligado = ${central}`)

const T2 = (m, p, body) => api(m, p, { token: ten, body })
await T2('DELETE', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`)
await limpar(T2)
console.log(JSON.stringify({ pass: out.filter(o => o.ok === true).length, fail: out.filter(o => o.ok === false).length }))
