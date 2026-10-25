// Teste do Edge 4.4 sem servidor: dispositivo atribuído ao Edge01, servidor
// desligado, Edge reiniciado sem conexão, telemetria publicada e lida no Edge.
import mqtt from 'mqtt'
import { CFG, ENV, api, login, sleep, docker } from './lib.mjs'
const EDGE = CFG.edge
const log = (id, ok, msg) => console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${msg}`)

const publish = (url, token, payload) => new Promise(resolve => {
  const c = mqtt.connect(url, { username: token, reconnectPeriod: 0, connectTimeout: 8000 })
  const done = r => { c.end(true); resolve(r) }
  c.on('connect', () => c.publish('v1/devices/me/telemetry', JSON.stringify(payload), { qos: 1 }, e => done(e ? e.message : 'ok')))
  c.on('error', e => done(e.message)); setTimeout(() => done('timeout'), 10000)
})
const waitUntil = async (fn, ms = 180000, every = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await sleep(every) } return null }
const edgeLogin = () => login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD, EDGE)
const latest = async (tok, id) => (await api('GET', `/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=nivel`, { token: tok, base: EDGE })).json

// 1. dispositivo no servidor, atribuído ao Edge01
const ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const edge = (await api('GET', '/api/tenant/edges?edgeName=Edge01', { token: ten })).json
let dev = (await api('GET', '/api/tenant/devices?deviceName=cocho-agua-01', { token: ten })).json
if (!dev || !dev.id) dev = (await api('POST', '/api/device', { token: ten, body: { name: 'cocho-agua-01', type: 'default' } })).json
// Na 4.4 (modelo da antiga PE) a atribuição ao Edge é por grupo de entidades.
const groups = (await api('GET', '/api/entityGroups/DEVICE?pageSize=100&page=0', { token: ten })).json
let group = ((groups && groups.data) || groups || []).find(g => g.name === 'fazenda-01')
if (!group) group = (await api('POST', '/api/entityGroup', { token: ten, body: { name: 'fazenda-01', type: 'DEVICE' } })).json
await api('POST', `/api/entityGroup/${group.id.id}/addEntities`, { token: ten, body: [dev.id.id] })
const asg = await api('POST', `/api/edge/${edge.id.id}/entityGroup/${group.id.id}/DEVICE`, { token: ten })
const cred = (await api('GET', `/api/device/${dev.id.id}/credentials`, { token: ten })).json
log('E1', asg.status === 200, `grupo fazenda-01 (com cocho-agua-01) atribuído ao Edge01 (HTTP ${asg.status})`)

// 2. com servidor no ar: publicar no broker do Edge e ler no Edge
let etok = await waitUntil(edgeLogin, 60000)
log('E2', !!etok, 'login local no Edge01 com o usuário sincronizado do tenant')
const onEdge = await waitUntil(async () => (await api('GET', `/api/device/${dev.id.id}`, { token: etok, base: EDGE })).status === 200, 120000)
log('E3', !!onEdge, 'dispositivo sincronizado do servidor para o Edge01')
log('E4', (await publish(CFG.edgeMqtt, cred.credentialsId, { nivel: 41 })) === 'ok', 'telemetria publicada no MQTT do Edge01 (servidor no ar)')
const v1 = await waitUntil(async () => { const j = await latest(etok, dev.id.id); return j && j.nivel && j.nivel[0].value == 41 }, 30000)
log('E5', !!v1, 'Edge01 processou e gravou a leitura (rule chain local)')

// 3. desligar o servidor e reiniciar o Edge sem conexão
docker('stop', CFG.serverContainer)
log('E6', null, 'servidor 4.4 desligado (simula fazenda sem internet)')
const t0 = Date.now()
docker('restart', CFG.edgeContainer)
const up = await waitUntil(async () => { etok = await edgeLogin(); return !!etok }, 300000, 5000)
log('E7', !!up, `Edge01 reiniciado SEM servidor e voltou a aceitar login em ${Math.round((Date.now() - t0) / 1000)} s`)
const pub = await waitUntil(async () => (await publish(CFG.edgeMqtt, cred.credentialsId, { nivel: 17 })) === 'ok', 120000, 5000)
log('E8', !!pub, 'telemetria publicada no Edge01 sem servidor')
const v2 = await waitUntil(async () => { const j = await latest(etok, dev.id.id); return j && j.nivel && j.nivel[0].value == 17 }, 60000)
log('E9', !!v2, 'Edge01 sem servidor continua processando e gravando (rule chain local)')
const logs = docker('logs', '--since', '10m', CFG.edgeContainer)
// "licenseVersion: 2" é só a configuração recebida do servidor; o que importa são erros ou encerramento.
const exits = logs.split('\n').filter(l => /Terminating application|critical License|Evaluation license|License Error|Stopping edge service/i.test(l))
log('E10', exits.length === 0 ? true : false, exits.length ? 'linhas de licença no log: ' + exits.slice(0, 3).join(' | ').slice(0, 300) : 'nenhuma mensagem de licença ou encerramento no log do Edge')

// 4. religar o servidor e conferir a sincronização da leitura feita offline
docker('start', CFG.serverContainer)
const synced = await waitUntil(async () => {
  const s = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
  const j = (await api('GET', `/api/plugins/telemetry/DEVICE/${dev.id.id}/values/timeseries?keys=nivel`, { token: s })).json
  return j && j.nivel && j.nivel[0].value == 17
}, 400000, 5000)
log('E11', !!synced, 'servidor religado recebeu do Edge01 a leitura feita sem conexão')
