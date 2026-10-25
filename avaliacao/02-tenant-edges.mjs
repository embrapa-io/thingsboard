// Cria o tenant de teste, o administrador do tenant e as entidades Edge
// (TB44_EDGE_COUNT, padrão 1: o plano Free permite um Edge).
// Grava as chaves dos Edges no .env (sem imprimi-las).
import { appendFileSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { CFG, ENV, ENV_FILE, api, login } from './lib.mjs'

const sys = await login(ENV.TB44_SYSADMIN_EMAIL, ENV.TB44_SYSADMIN_PASSWORD)
let tenants = await api('GET', '/api/tenants?pageSize=50&page=0', { token: sys })
let tenant = (tenants.json.data || []).find(t => t.title === 'Embrapa IO teste')
if (!tenant) tenant = (await api('POST', '/api/tenant', { token: sys, body: { title: 'Embrapa IO teste' } })).json
console.log('tenant:', tenant.title, tenant.id.id)

let admin = (await api('GET', `/api/tenant/${tenant.id.id}/users?pageSize=50&page=0`, { token: sys })).json.data.find(u => u.email === ENV.TB44_TENANT_EMAIL)
if (!admin) {
  const created = await api('POST', '/api/user?sendActivationMail=false', { token: sys, body: { email: ENV.TB44_TENANT_EMAIL, authority: 'TENANT_ADMIN', tenantId: tenant.id } })
  if (created.status !== 200) throw new Error('user ' + created.status + ' ' + created.text.slice(0, 300))
  admin = created.json
  const link = await api('GET', `/api/user/${admin.id.id}/activationLink`, { token: sys })
  const activateToken = new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken')
  const act = await api('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken, password: ENV.TB44_TENANT_PASSWORD } })
  console.log('ativação do admin do tenant:', act.status)
}
const ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const env = readFileSync(ENV_FILE, 'utf8')
for (let n = 1; n <= CFG.edgeCount; n++) {
  const name = 'Edge0' + n
  const found = (await api('GET', `/api/tenant/edges?edgeName=${name}`, { token: ten }))
  let edge = found.status === 200 ? found.json : null
  if (!edge) {
    const r = await api('POST', '/api/edge', { token: ten, body: { name, type: 'fazenda', routingKey: crypto.randomUUID(), secret: crypto.randomBytes(15).toString('base64url') } })
    console.log(name, 'criação:', r.status, r.status === 200 ? '' : r.text.slice(0, 300))
    edge = r.json
  }
  if (edge && !env.includes('TB44_EDGE' + n + '_KEY=')) {
    appendFileSync(ENV_FILE,`TB44_EDGE${n}_KEY=${edge.routingKey}\nTB44_EDGE${n}_SECRET=${edge.secret}\n`)
  }
  console.log(name, edge && edge.id ? 'id ' + edge.id.id : 'não criado')
}
const usage = await api('GET', '/api/admin/licenseUsageInfo', { token: sys })
console.log('uso:', JSON.stringify(usage.json))
