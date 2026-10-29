// Segregação de regras na 4.4. Rule chains não têm grupo; campos calculados e
// regras de alarme ficam na própria entidade e têm as operações
// READ_CALCULATED_FIELD / WRITE_CALCULATED_FIELD. Testa se um Maintainer cria
// uma regra só nos sensores da própria localidade e se ela roda no Edge sem servidor.
import crypto from 'node:crypto'
import { CFG, ENV, api, login, sleep, docker } from './lib.mjs'

const P = 'rbac9'
const out = []
const log = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${msg}`) }
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const T = (m, p, body) => api(m, p, { token: ten, body })
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []
const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 120)))

const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const g of list(await T('GET', `/api/entityGroups/USER${page}`)).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
}
await limpar()

const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
const grp = async (name, type) => must(await T('POST', '/api/entityGroup', { name: `${P} ${name}`, type, ownerId: A.id }), name)
const L1 = await grp('LOC L1', 'DEVICE'), L2 = await grp('LOC L2', 'DEVICE')
const d1 = must(await T('POST', `/api/device?entityGroupId=${L1.id.id}`, { name: `${P}-l1-valvula`, type: 'default' }), 'd1')
const d2 = must(await T('POST', `/api/device?entityGroupId=${L2.id.id}`, { name: `${P}-l2-sensor`, type: 'default' }), 'd2')
const tok1 = must(await T('GET', `/api/device/${d1.id.id}/credentials`), 'cred').credentialsId

const OPS = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CREDENTIALS', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'RPC_CALL']
const role = async (name, type, permissions) => must(await T('POST', '/api/role', { name: `${P} ${name}`, type, permissions }), name)
const rResp = await role('Responsável com regras', 'GROUP', [...OPS, 'READ_CALCULATED_FIELD', 'WRITE_CALCULATED_FIELD'])
const rMemb = await role('Membro', 'GROUP', ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CALCULATED_FIELD'])
const rRules = await role('Editor de rule chains na unidade', 'GENERIC', { RULE_CHAIN: ['ALL'] })
const ugR = await grp('L1 Responsáveis', 'USER'), ugE = await grp('L1 Equipe', 'USER'), ugC = await grp('Editores de regras', 'USER')
await T('POST', '/api/groupPermission', { roleId: rResp.id, userGroupId: ugR.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' })
await T('POST', '/api/groupPermission', { roleId: rMemb.id, userGroupId: ugE.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' })
await T('POST', '/api/groupPermission', { roleId: rRules.id, userGroupId: ugC.id })
const user = async (nome, g) => {
  const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${g.id.id}`, { email: `${P}-${nome}@tb44.local`, authority: 'CUSTOMER_USER', customerId: A.id }), nome)
  const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
  const pwd = crypto.randomBytes(12).toString('base64url')
  must(await api('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd } }), 'activate')
  const token = await login(u.email, pwd)
  return (m, p, body) => api(m, p, { token, body })
}
const mant = await user('mant-a', ugR), dev = await user('dev-a', ugE), regras = await user('regras-a', ugC)
// Variante: o Maintainer como usuário do TENANT (autoridade TENANT_ADMIN), mas só com o
// papel de grupo sobre a L1. A documentação diz que CUSTOMER_USER nunca usa campos calculados.
const ugT = must(await T('POST', '/api/entityGroup', { name: `${P} L1 Responsáveis (usuários do tenant)`, type: 'USER' }), 'ugT')
await T('POST', '/api/groupPermission', { roleId: rResp.id, userGroupId: ugT.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' })
const mantT = await (async () => {
  const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${ugT.id.id}`, { email: `${P}-mant-tenant@tb44.local`, authority: 'TENANT_ADMIN' }), 'mantT')
  const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
  const pwd = crypto.randomBytes(12).toString('base64url')
  must(await api('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd } }), 'activate')
  const token = await login(u.email, pwd)
  return (m, p, body) => api(m, p, { token, body })
})()

// --- rule chains
let r = await regras('GET', `/api/ruleChains${page}`)
log('RC1', null, `usuário da unidade com papel genérico RULE_CHAIN: ALL lista rule chains: HTTP ${msg(r)}${r.status === 200 ? ', ' + list(r).length + ' visíveis' : ''}`)
r = await regras('POST', '/api/ruleChain', { name: `${P} regra da unidade`, type: 'CORE' })
log('RC2', null, `o mesmo usuário cria uma rule chain: HTTP ${msg(r)}`)
if (r.status === 200) await T('DELETE', `/api/ruleChain/${r.json.id.id}`)

// --- campos calculados e regras de alarme por entidade
// SCRIPT (TBEL): o SIMPLE só aceita fórmula matemática; no TBEL a chave do objeto vai entre aspas
const cf = (entityId, name = 'valvula') => ({ entityId, type: 'SCRIPT', name, configuration: { type: 'SCRIPT',
  arguments: { t: { refEntityKey: { key: 'temperatura', type: 'TS_LATEST' } } },
  expression: 'var v = 0; if (t < 20) { v = 1; } return {"valvula": v};',
  output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE' } } })
const prof = must(await T('GET', '/api/deviceProfileInfo/default'), 'perfil')
const alarme = { entityId: d1.id, type: 'ALARM', name: 'Temperatura alta', configuration: { type: 'ALARM',
  arguments: { t: { refEntityKey: { key: 'temperatura', type: 'TS_LATEST' } } },
  createRules: { CRITICAL: { condition: { type: 'SIMPLE', expression: { type: 'TBEL', expression: 'return t > 30;' } } } } } }
let cf1 = null
for (const [tag, quem, M] of [['', 'Maintainer (usuário da unidade)', mant], ['T', 'Maintainer (usuário do tenant, só papel de grupo)', mantT]]) {
  r = await M('POST', '/api/calculatedField', cf(d1.id, 'valvula' + tag))
  if (r.status === 200 && !cf1) cf1 = r.json
  log(`CF1${tag}`, null, `${quem} cria campo calculado num sensor da L1 (válvula abre se temperatura < 20): HTTP ${msg(r)}`)
  r = await M('POST', '/api/calculatedField', cf(d2.id, 'invasao' + tag))
  log(`CF2${tag}`, r.status !== 200, `${quem} cria campo calculado num sensor da L2: HTTP ${msg(r)}`)
  r = await M('POST', '/api/calculatedField', cf(prof.id, 'no-perfil' + tag))
  log(`CF5${tag}`, r.status !== 200, `${quem} cria regra no PERFIL de dispositivo (valeria para todos os sensores): HTTP ${msg(r)}`)
  r = await M('POST', '/api/calculatedField', { ...alarme, name: 'Temperatura alta' + tag })
  log(`AR1${tag}`, null, `${quem} cria regra de alarme num sensor da L1: HTTP ${msg(r)}`)
  r = await M('POST', '/api/calculatedField', { ...alarme, name: 'Alarme invasor' + tag, entityId: d2.id })
  log(`AR2${tag}`, r.status !== 200, `${quem} cria regra de alarme num sensor da L2: HTTP ${msg(r)}`)
  r = await M('GET', `/api/ruleChains${page}`)
  log(`RC3${tag}`, null, `${quem} lista rule chains: HTTP ${msg(r)}`)
}
r = await dev('POST', '/api/calculatedField', cf(d1.id, 'do-developer'))
log('CF3', r.status === 403, `Developer da L1 (só leitura de regras) cria campo calculado: HTTP ${msg(r)}`)
if (!cf1) {
  cf1 = must(await T('POST', '/api/calculatedField', cf(d1.id)), 'cf pelo administrador')
  log('CF1-adm', null, 'nenhum Maintainer criou a regra; o administrador do tenant (o backend do Embrapa I/O) a criou para o teste do Edge')
}

// --- funcionamento no servidor
const valvula = async (base, token) => {
  const x = await api('GET', `/api/plugins/telemetry/DEVICE/${d1.id.id}/values/attributes/SHARED_SCOPE?keys=valvula`, { token, base })
  const a = list(x)[0]
  return a ? String(a.value) : '(sem valor)'
}
await api('POST', `/api/v1/${tok1}/telemetry`, { body: { temperatura: 15 } })
await sleep(3000)
log('CF6', (await valvula(CFG.base, ten)) === '1', `no servidor, temperatura 15 → valvula = ${await valvula(CFG.base, ten)}`)

// --- Edge: sincronização e funcionamento sem servidor
const edge = list(await T('GET', `/api/edges${page}`))[0]
must(await T('POST', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`), 'atribuir ao Edge')
const et = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD, CFG.edge)
let noEdge = []
for (let i = 0; i < 12 && !noEdge.length; i++) {
  await sleep(5000)
  noEdge = list(await api('GET', `/api/calculatedFields${page}&entityType=DEVICE&entityId=${d1.id.id}`, { token: et, base: CFG.edge }))
}
log('E1', noEdge.length > 0, `regras do sensor da L1 no ${edge.name}: ${noEdge.map(c => c.name + ' (' + c.type + ')').join(', ') || 'nenhuma em 60 s'}`)

let ok = false
try {
  docker('stop', CFG.serverContainer)
  await sleep(3000)
  await api('POST', `/api/v1/${tok1}/telemetry`, { body: { temperatura: 25 } }, ).catch(() => {})
  await api('POST', `/api/v1/${tok1}/telemetry`, { body: { temperatura: 25 } , base: CFG.edge })
  await sleep(4000)
  const fechada = await valvula(CFG.edge, et)
  await api('POST', `/api/v1/${tok1}/telemetry`, { body: { temperatura: 12 }, base: CFG.edge })
  await sleep(4000)
  const aberta = await valvula(CFG.edge, et)
  ok = fechada === '0' && aberta === '1'
  log('E2', ok, `Edge com o servidor DESLIGADO: temperatura 25 → valvula = ${fechada}; temperatura 12 → valvula = ${aberta}`)
} finally {
  docker('start', CFG.serverContainer)
}
for (let i = 0; i < 40; i++) { try { await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD); break } catch { await sleep(5000) } }
const ten2 = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
await api('DELETE', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`, { token: ten2 })
if (cf1) await api('DELETE', `/api/calculatedField/${cf1.id.id}`, { token: ten2 })
const T2 = (m, p, body) => api(m, p, { token: ten2, body })
for (const d of list(await T2('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T2('DELETE', `/api/device/${d.id.id}`)
for (const u of list(await T2('GET', `/api/user/users${page}&textSearch=${P}`))) await T2('DELETE', `/api/user/${u.id.id}`)
for (const c of list(await T2('GET', `/api/customers${page}&textSearch=${P}`))) await T2('DELETE', `/api/customer/${c.id.id}`)
for (const g of list(await T2('GET', `/api/entityGroups/USER${page}`)).filter(g => g.name.startsWith(P))) await T2('DELETE', `/api/entityGroup/${g.id.id}`)
for (const x of list(await T2('GET', `/api/roles${page}&textSearch=${P}`))) await T2('DELETE', `/api/role/${x.id.id}`)
console.log(JSON.stringify({ pass: out.filter(o => o.ok === true).length, fail: out.filter(o => o.ok === false).length, info: out.filter(o => o.ok === null).length }))
