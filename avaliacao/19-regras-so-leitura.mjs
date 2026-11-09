// O pesquisador pode só LER rule chains, sem editar? (07/11) RULE_CHAIN só existe como papel
// genérico. Testa READ para usuário da unidade e para usuário do tenant, na Central, com
// entidades "rbac19" apagadas no fim. A rule chain de teste é criada pela plataforma.
// Credencial: THINGSBOARD_TOKEN (chave de API do tenant) do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV = Object.fromEntries(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const P = 'rbac19'
const call = async (method, path, auth, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Authorization': auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const T = (m, p, b) => call(m, p, 'ApiKey ' + ENV.THINGSBOARD_TOKEN, b)
const must = (r, w) => { if (r.status !== 200) throw new Error(w + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []
const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 120)))
const out = []
const log = (id, ok, t) => { out.push({ id, ok }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${t}`) }
const limpar = async () => {
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const g of list(await T('GET', '/api/entityGroups/USER')).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
  for (const r of list(await T('GET', `/api/ruleChains${page}&textSearch=${P}`))) await T('DELETE', `/api/ruleChain/${r.id.id}`)
}

await limpar()
try {
  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
  const rc = must(await T('POST', '/api/ruleChain', { name: `${P} regra de laboratório`, type: 'CORE' }), 'rule chain')
  const role = must(await T('POST', '/api/role', { name: `${P} Leitura de rule chains`, type: 'GENERIC', permissions: { RULE_CHAIN: ['READ'] } }), 'role')
  const ugU = must(await T('POST', '/api/entityGroup', { name: `${P} leitores (unidade)`, type: 'USER', ownerId: A.id }), 'ugU')
  const ugT = must(await T('POST', '/api/entityGroup', { name: `${P} leitores (tenant)`, type: 'USER' }), 'ugT')
  must(await T('POST', '/api/groupPermission', { roleId: role.id, userGroupId: ugU.id }), 'gpU')
  must(await T('POST', '/api/groupPermission', { roleId: role.id, userGroupId: ugT.id }), 'gpT')
  const user = async (nome, g, authority) => {
    const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${g.id.id}`, { email: `${P}-${nome}@tb44.local`, authority, ...(authority === 'CUSTOMER_USER' ? { customerId: A.id } : {}) }), nome)
    const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
    const pwd = crypto.randomBytes(12).toString('base64url')
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'activate')
    const token = must(await call('POST', '/api/auth/login', null, { username: u.email, password: pwd }), 'login').token
    return (m, p, b) => call(m, p, 'Bearer ' + token, b)
  }
  for (const [tag, quem, U] of [['U', 'usuário da unidade', await user('unidade', ugU, 'CUSTOMER_USER')], ['T', 'usuário do tenant', await user('tenant', ugT, 'TENANT_ADMIN')]]) {
    let r = await U('GET', `/api/ruleChains${page}`)
    log(`L1${tag}`, null, `${quem} com RULE_CHAIN: READ lista rule chains: HTTP ${msg(r)}${r.status === 200 ? ' — ' + list(r).length + ' visíveis (todas do tenant: ' + list(r).map(x => x.name).slice(0, 6).join(', ') + '…)' : ''}`)
    r = await U('GET', `/api/ruleChain/${rc.id.id}/metadata`)
    log(`L2${tag}`, null, `${quem} abre o conteúdo (nós e scripts) de uma rule chain: HTTP ${msg(r)}`)
    r = await U('POST', '/api/ruleChain', { ...rc, name: rc.name + ' (editada)' })
    log(`E1${tag}`, r.status !== 200, `${quem} renomeia a rule chain: HTTP ${msg(r)}`)
    r = await U('POST', '/api/ruleChain', { name: `${P} nova`, type: 'CORE' })
    log(`E2${tag}`, r.status !== 200, `${quem} cria rule chain: HTTP ${msg(r)}`)
  }
} finally { await limpar(); console.log('Limpeza feita.') }
const c = out.filter(o => o.ok !== null)
console.log(`${c.filter(o => o.ok).length} PASS de ${c.length} (+ ${out.length - c.length} informativos)`)
