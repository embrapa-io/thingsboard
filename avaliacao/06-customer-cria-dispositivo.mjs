// Customer user cadastrando os próprios dispositivos: papel de grupo com CREATE num
// grupo do customer (permitido) e no grupo do tenant (só o dono do grupo cria).
import { ENV, api, login } from './lib.mjs'

const out = []
const log = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${msg}`) }
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }

const ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const T = (m, p, body) => api(m, p, { token: ten, body })
const group = async (name, type, ownerId) => {
  const path = ownerId ? `/api/entityGroups/${ownerId.entityType}/${ownerId.id}/${type}?pageSize=100&page=0` : `/api/entityGroups/${type}?pageSize=100&page=0`
  const list = must(await T('GET', path), 'grupos ' + type)
  const found = (list.data || list).find(g => g.name === name)
  return found || must(await T('POST', '/api/entityGroup', { name, type, ...(ownerId ? { ownerId } : {}) }), 'grupo ' + name)
}

// Cenário do 04-rbac.mjs: customer Embrapa Gado de Corte, equipe-pasto-certo e ana
const cust = must(await T('GET', '/api/customers?pageSize=100&page=0'), 'customers').data.find(c => c.title === 'Embrapa Gado de Corte')
if (!cust) throw new Error('rode antes o 04-rbac.mjs')
const custOwner = { entityType: 'CUSTOMER', id: cust.id.id }
const uGroup = await group('equipe-pasto-certo', 'USER', custOwner)
const gTenant = await group('pasto-certo', 'DEVICE')
const gCust = await group('pasto-certo-dispositivos-da-unidade', 'DEVICE', custOwner)

const roles = must(await T('GET', '/api/roles?pageSize=100&page=0'), 'roles').data
const gestor = roles.find(x => x.name === 'Gestor de dispositivos do projeto') ||
  must(await T('POST', '/api/role', { name: 'Gestor de dispositivos do projeto', type: 'GROUP',
    permissions: ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CREDENTIALS', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'RPC_CALL'] }), 'role gestor')
for (const g of [gCust, gTenant]) {
  const r = await T('POST', '/api/groupPermission', { roleId: gestor.id, userGroupId: uGroup.id, entityGroupId: g.id, entityGroupType: 'DEVICE' })
  log('C0', r.status === 200 || r.status === 400, `papel "Gestor de dispositivos do projeto" no grupo ${g.name}: HTTP ${r.status}`)
}

const ana = await login('ana@tb44.local', ENV.TB44_ANA_PASSWORD)
const A = (m, p, body) => api(m, p, { token: ana, body })
const stamp = Date.now().toString(36)
const created = []

let r = await A('POST', `/api/device?entityGroupId=${gCust.id.id}`, { name: `sensor-ana-${stamp}`, type: 'default' })
if (r.status === 200) created.push(r.json)
log('C1', r.status === 200, `ana cria dispositivo no grupo do customer: HTTP ${r.status}${r.status === 200 ? ', dono ' + r.json.ownerId.entityType : ' ' + (r.json && r.json.message)}`)

if (r.status === 200) {
  const cred = await A('GET', `/api/device/${r.json.id.id}/credentials`)
  log('C2', cred.status === 200, `ana lê o token do dispositivo que criou: HTTP ${cred.status}`)
  const w = await A('POST', '/api/device', { ...r.json, label: 'renomeado pela ana' })
  log('C3', w.status === 200, `ana edita o dispositivo: HTTP ${w.status}`)
}

r = await A('POST', `/api/device?entityGroupId=${gTenant.id.id}`, { name: `sensor-ana-tenant-${stamp}`, type: 'default' })
if (r.status === 200) created.push(r.json)
log('C4', r.status !== 200, `ana tenta criar no grupo do TENANT (pasto-certo), mesmo com CREATE: HTTP ${r.status} ${(r.json && r.json.message) || ''}`)

r = await A('POST', '/api/device', { name: `sensor-ana-sem-grupo-${stamp}`, type: 'default' })
if (r.status === 200) created.push(r.json)
log('C5', null, `ana cria sem informar grupo: HTTP ${r.status} ${(r.json && r.json.message) || ''}`)

const vis = await A('GET', '/api/user/devices?pageSize=100&page=0')
log('C6', null, `dispositivos visíveis para ana: ${vis.json && vis.json.data ? vis.json.data.map(d => d.name).join(', ') : vis.status}`)

const sys = await login(ENV.TB44_SYSADMIN_EMAIL, ENV.TB44_SYSADMIN_PASSWORD)
const usage = (await api('GET', '/api/admin/licenseUsageInfo', { token: sys })).json
log('C7', null, `dispositivos contados na licença: ${usage.devicesCount}/${usage.maxDevices}`)

// Limpeza: os dispositivos de teste não ficam ocupando a cota de 100, e o papel de
// gestor sai do grupo do tenant para não alterar o cenário do 04-rbac.mjs
for (const d of created) await T('DELETE', `/api/device/${d.id.id}`)
const perms = must(await T('GET', `/api/userGroup/${uGroup.id.id}/groupPermissions`), 'groupPermissions')
for (const p of perms.filter(p => p.roleId.id === gestor.id.id && p.entityGroupId && p.entityGroupId.id === gTenant.id.id)) {
  await T('DELETE', `/api/groupPermission/${p.id.id}`)
}
console.log(JSON.stringify({ pass: out.filter(o => o.ok === true).length, fail: out.filter(o => o.ok === false).length, info: out.filter(o => o.ok === null).length, removidos: created.length }))
