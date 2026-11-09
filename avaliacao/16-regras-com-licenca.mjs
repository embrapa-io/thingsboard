// A chave Free muda a segregação de regras? Camilo suspeitou (reunião de 03/11) que as
// restrições de rule chain vinham da falta da licença. Repete na Central, já com a chave
// Free ativa (07/11), os casos centrais do 09 (sem a parte do Edge: o Free só tem 1 vaga
// de Edge e ela está ocupada). Cria entidades com prefixo "rbac16" e apaga tudo no fim.
// Credencial: THINGSBOARD_TOKEN (chave de API do tenant) do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env')
const ENV = Object.fromEntries(readFileSync(BACKEND_ENV, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const P = 'rbac16'

const call = async (method, path, auth, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Authorization': auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const T = (m, p, body) => call(m, p, 'ApiKey ' + ENV.THINGSBOARD_TOKEN, body)
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []
const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 140)))
const out = []
const log = (id, ok, text) => { out.push({ id, ok }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${text}`) }

const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const g of list(await T('GET', `/api/entityGroups/USER`)).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
  for (const r of list(await T('GET', `/api/ruleChains${page}&textSearch=${P}`))) await T('DELETE', `/api/ruleChain/${r.id.id}`)
}

const lic = await T('GET', '/api/admin/licenseUsageInfo')
console.log('Licença/uso:', lic.status === 200 ? JSON.stringify(lic.json).slice(0, 200) : 'HTTP ' + lic.status)

await limpar()
try {
  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
  const grp = async (name, type, owner = A.id) => must(await T('POST', '/api/entityGroup', { name: `${P} ${name}`, type, ...(owner ? { ownerId: owner } : {}) }), name)
  const L1 = await grp('LOC L1', 'DEVICE'), L2 = await grp('LOC L2', 'DEVICE')
  const d1 = must(await T('POST', `/api/device?entityGroupId=${L1.id.id}`, { name: `${P}-l1-valvula`, type: 'default' }), 'd1')
  const d2 = must(await T('POST', `/api/device?entityGroupId=${L2.id.id}`, { name: `${P}-l2-sensor`, type: 'default' }), 'd2')

  const OPS = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'READ_CALCULATED_FIELD', 'WRITE_CALCULATED_FIELD']
  const role = async (name, type, permissions) => must(await T('POST', '/api/role', { name: `${P} ${name}`, type, permissions }), name)
  const rResp = await role('Responsável com regras', 'GROUP', OPS)
  const rRules = await role('Editor de rule chains', 'GENERIC', { RULE_CHAIN: ['ALL'] })
  const ugR = await grp('L1 Responsáveis', 'USER'), ugC = await grp('Editores de regras', 'USER')
  const ugT = await grp('L1 Responsáveis (tenant)', 'USER', null)
  must(await T('POST', '/api/groupPermission', { roleId: rResp.id, userGroupId: ugR.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'gp1')
  must(await T('POST', '/api/groupPermission', { roleId: rRules.id, userGroupId: ugC.id }), 'gp2')
  must(await T('POST', '/api/groupPermission', { roleId: rResp.id, userGroupId: ugT.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'gp3')

  const user = async (nome, g, authority) => {
    const body = { email: `${P}-${nome}@tb44.local`, authority, ...(authority === 'CUSTOMER_USER' ? { customerId: A.id } : {}) }
    const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${g.id.id}`, body), nome)
    const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
    const pwd = crypto.randomBytes(12).toString('base64url')
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'activate')
    const token = must(await call('POST', '/api/auth/login', null, { username: u.email, password: pwd }), 'login').token
    return (m, p, b) => call(m, p, 'Bearer ' + token, b)
  }
  const mant = await user('mant-unidade', ugR, 'CUSTOMER_USER')
  const regras = await user('regras-unidade', ugC, 'CUSTOMER_USER')
  const mantT = await user('mant-tenant', ugT, 'TENANT_ADMIN')

  const cf = (entityId, name) => ({ entityId, type: 'SCRIPT', name, configuration: { type: 'SCRIPT',
    arguments: { t: { refEntityKey: { key: 'temperatura', type: 'TS_LATEST' } } },
    expression: 'var v = 0; if (t < 20) { v = 1; } return {"valvula": v};',
    output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE' } } })
  const prof = must(await T('GET', '/api/deviceProfileInfo/default'), 'perfil')

  let r = await regras('GET', `/api/ruleChains${page}`)
  log('RC1', r.status !== 200, `usuário da unidade com papel genérico RULE_CHAIN: ALL lista rule chains: HTTP ${msg(r)}`)
  r = await regras('POST', '/api/ruleChain', { name: `${P} regra da unidade`, type: 'CORE' })
  log('RC2', r.status !== 200, `o mesmo usuário cria uma rule chain: HTTP ${msg(r)}`)
  r = await mantT('GET', `/api/ruleChains${page}`)
  log('RC3T', r.status !== 200, `usuário do tenant só com papel de grupo lista rule chains: HTTP ${msg(r)}`)

  r = await mant('POST', '/api/calculatedField', cf(d1.id, 'valvula-unidade'))
  log('CF1', null, `usuário da unidade com WRITE_CALCULATED_FIELD na L1 cria regra num sensor da L1: HTTP ${msg(r)}`)
  r = await mantT('POST', '/api/calculatedField', cf(d1.id, 'valvula-tenant'))
  log('CF1T', r.status === 200, `usuário do tenant só com papel de grupo cria regra num sensor da L1: HTTP ${msg(r)}`)
  r = await mantT('POST', '/api/calculatedField', cf(d2.id, 'invasao'))
  log('CF2T', r.status !== 200, `o mesmo usuário cria regra num sensor da L2: HTTP ${msg(r)}`)
  r = await mantT('POST', '/api/calculatedField', cf(prof.id, 'no-perfil'))
  log('CF5T', r.status !== 200, `o mesmo usuário cria regra no perfil de dispositivo: HTTP ${msg(r)}`)
} finally {
  await limpar()
  console.log('Limpeza feita.')
}
const checked = out.filter(o => o.ok !== null)
console.log(`${checked.filter(o => o.ok).length} PASS de ${checked.length} (+ ${out.length - checked.length} informativos)`)
