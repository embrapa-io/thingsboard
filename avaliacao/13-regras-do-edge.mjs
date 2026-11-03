// Dá para liberar ao pesquisador só as rule chains do Edge? Rule chains não têm grupo,
// mas o Edge tem (grupo EDGE). Testa se um papel sobre o Edge — de grupo (ALL no grupo
// do Edge) ou genérico (EDGE: ALL) — alcança as rule chains atribuídas a ele.
// Age na Central de desenvolvimento, sem destruir nada: cria um Edge só de cadastro
// (sem contêiner), uma rule chain de Edge e uma CORE de teste, e apaga tudo no fim.
// A rule chain raiz do tenant só é LIDA.
//
// Credencial: THINGSBOARD_TOKEN (chave de API do tenant) do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env')
const ENV = Object.fromEntries(readFileSync(BACKEND_ENV, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'

const call = async (method, path, auth, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Authorization': auth },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const T = (m, p, body) => call(m, p, 'ApiKey ' + ENV.THINGSBOARD_TOKEN, body)
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []
const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 120)))

const P = 'rbac13'
const out = []
const log = (id, concedeu, desc, r) => {
  out.push({ id, concedeu, desc, status: r.status })
  console.log(`${concedeu ? '🔓' : '🔒'} ${id} ${desc}: HTTP ${msg(r)}`)
}

const limpar = async () => {
  for (const e of list(await T('GET', `/api/edgeInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/edge/${e.id.id}`)
  for (const c of list(await T('GET', `/api/ruleChains${page}&type=EDGE&textSearch=${P}`))) await T('DELETE', `/api/ruleChain/${c.id.id}`)
  for (const c of list(await T('GET', `/api/ruleChains${page}&type=CORE&textSearch=${P}`))) await T('DELETE', `/api/ruleChain/${c.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const g of list(await T('GET', `/api/entityGroups/USER${page}`)).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
}

const quem = must(await T('GET', '/api/auth/user'), 'auth')
if (quem.authority !== 'TENANT_ADMIN') throw new Error('a chave precisa ser de administrador do tenant')
await limpar()

try {
  // --- cenário
  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
  const gEdge = must(await T('POST', '/api/entityGroup', { name: `${P} Edges da unidade A`, type: 'EDGE', ownerId: A.id }), 'grupo EDGE')
  const edge = must(await T('POST', `/api/edge?entityGroupId=${gEdge.id.id}`, { name: `${P}-edge`, type: 'default', customerId: A.id,
    routingKey: crypto.randomUUID(), secret: crypto.randomBytes(15).toString('base64url') }), 'edge')
  const rce = must(await T('POST', '/api/ruleChain', { name: `${P} regra do Edge`, type: 'EDGE' }), 'rule chain EDGE')
  must(await T('POST', `/api/edge/${edge.id.id}/ruleChain/${rce.id.id}`), 'atribuir rule chain ao Edge')
  const rcc = must(await T('POST', '/api/ruleChain', { name: `${P} regra CORE`, type: 'CORE' }), 'rule chain CORE')
  const meta = must(await T('GET', `/api/ruleChain/${rce.id.id}/metadata`), 'metadata')
  const raiz = list(await T('GET', `/api/ruleChains${page}&type=CORE`)).find(c => c.root)
  const edgeRaiz = edge.rootRuleChainId

  const role = async (name, type, permissions) => must(await T('POST', '/api/role', { name: `${P} ${name}`, type, permissions }), name)
  const rGrupoAll = await role('ALL no grupo do Edge', 'GROUP', ['ALL'])
  const rGrupoRead = await role('READ no grupo do Edge', 'GROUP', ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY'])
  const rGenEdge = await role('EDGE: ALL', 'GENERIC', { EDGE: ['ALL'], PROFILE: ['ALL'] })

  const ativar = async (u) => {
    const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
    const pwd = crypto.randomBytes(12).toString('base64url')
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', '', { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'ativar')
    const tok = must(await call('POST', '/api/auth/login', '', { username: u.email, password: pwd }), 'login').token
    return (m, p, body) => call(m, p, 'Bearer ' + tok, body)
  }
  const pessoa = async (nome, authority, perm) => {
    const ug = must(await T('POST', '/api/entityGroup', { name: `${P} ${nome}`, type: 'USER', ...(authority === 'CUSTOMER_USER' ? { ownerId: A.id } : {}) }), 'grupo ' + nome)
    must(await T('POST', '/api/groupPermission', { roleId: perm.role.id, userGroupId: ug.id, ...(perm.grupo ? { entityGroupId: perm.grupo.id, entityGroupType: 'EDGE' } : {}) }), 'permissão ' + nome)
    const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${ug.id.id}`,
      { email: `${P}-${nome}@tb44.local`, authority, ...(authority === 'CUSTOMER_USER' ? { customerId: A.id } : {}) }), 'usuário ' + nome)
    return ativar(u)
  }
  const pessoas = [
    ['U1', 'usuário da unidade com ALL no grupo do Edge', await pessoa('u1-unidade-grupo', 'CUSTOMER_USER', { role: rGrupoAll, grupo: gEdge })],
    ['U2', 'usuário do tenant com ALL no grupo do Edge', await pessoa('u2-tenant-grupo', 'TENANT_ADMIN', { role: rGrupoAll, grupo: gEdge })],
    ['U3', 'usuário do tenant com papel genérico EDGE: ALL', await pessoa('u3-tenant-generico', 'TENANT_ADMIN', { role: rGenEdge })]
  ]

  // --- credenciais do Edge: quem só lê o Edge vê a chave e o segredo? Com eles, um Edge
  // falso conectaria no lugar do verdadeiro e receberia tudo o que está atribuído a ele.
  const U0 = await pessoa('u0-unidade-leitura', 'CUSTOMER_USER', { role: rGrupoRead, grupo: gEdge })
  for (const [id, quemE, U] of [['U0', 'usuário da unidade só com leitura no grupo do Edge', U0], ...pessoas]) {
    const r = await U('GET', `/api/edge/${edge.id.id}`)
    const vaza = r.status === 200 && !!(r.json.secret || r.json.routingKey)
    log(`${id}-K1`, vaza, `${quemE} vê a chave/segredo do Edge` + (r.status === 200 ? ` (routingKey: ${r.json.routingKey ? 'sim' : 'não'}, secret: ${r.json.secret ? 'sim' : 'não'})` : ''), r)
    const l = await U('GET', `/api/customer/${A.id.id}/edgeInfos${page}`)
    const vazaL = l.status === 200 && list(l).some(e => e.secret || e.routingKey)
    log(`${id}-K2`, vazaL, `${quemE} vê a chave/segredo pela listagem da unidade (${list(l).length} Edges)`, l)
  }

  // --- casos
  for (const [id, quemE, U] of pessoas) {
    console.log(`\n${id}: ${quemE}`)
    let r = await U('GET', `/api/edge/${edge.id.id}`)
    log(`${id}-E0`, r.status === 200, 'controle: lê o Edge', r)
    r = await U('GET', `/api/edge/${edge.id.id}/ruleChains${page}`)
    log(`${id}-E1`, r.status === 200, 'lista as rule chains atribuídas ao Edge' +
      (r.status === 200 ? ` (${list(r).map(c => c.name + (c.configuration ? ', com configuração' : '')).join('; ') || 'vazia'})` : ''), r)
    r = await U('GET', `/api/ruleChain/${rce.id.id}`)
    log(`${id}-E2`, r.status === 200, 'lê a rule chain atribuída ao Edge', r)
    r = await U('GET', `/api/ruleChain/${rce.id.id}/metadata`)
    log(`${id}-E3`, r.status === 200, 'lê os nós da rule chain atribuída ao Edge', r)
    r = await U('POST', '/api/ruleChain/metadata', meta)
    log(`${id}-E4`, r.status === 200, 'regrava os nós da rule chain atribuída ao Edge (conteúdo igual)', r)
    if (edgeRaiz) {
      r = await U('GET', `/api/ruleChain/${edgeRaiz.id}`)
      log(`${id}-E5`, r.status === 200, 'lê a rule chain raiz do Edge', r)
    }
    r = await U('POST', '/api/ruleChain', { name: `${P} criada por ${id}`, type: 'EDGE' })
    log(`${id}-E6`, r.status === 200, 'cria uma rule chain de Edge', r)
    r = await U('GET', `/api/ruleChains${page}&type=EDGE`)
    log(`${id}-E7`, r.status === 200, 'lista as rule chains de Edge do tenant', r)
    r = await U('DELETE', `/api/edge/${edge.id.id}/ruleChain/${rce.id.id}`)
    log(`${id}-E8`, r.status === 200, 'desatribui a rule chain do Edge', r)
    if (r.status === 200) must(await T('POST', `/api/edge/${edge.id.id}/ruleChain/${rce.id.id}`), 'reatribuir')
    r = await U('POST', `/api/edge/${edge.id.id}/ruleChain/${rcc.id.id}`)
    log(`${id}-E9`, r.status === 200, 'atribui ao Edge uma rule chain CORE que não era dele', r)
    if (r.status === 200) await T('DELETE', `/api/edge/${edge.id.id}/ruleChain/${rcc.id.id}`)
    r = await U('GET', `/api/ruleChain/${raiz.id.id}`)
    log(`${id}-E10`, r.status === 200, 'lê a rule chain raiz do tenant (servidor)', r)
  }
} finally {
  await limpar()
}

const regras = out.filter(o => /-E([1-9]|10)$/.test(o.id))
console.log('\n' + JSON.stringify({
  concedidos_sobre_regras: regras.filter(o => o.concedeu).map(o => o.id),
  negados_sobre_regras: regras.filter(o => !o.concedeu).length,
  credenciais_do_edge_expostas: out.filter(o => /-K\d$/.test(o.id) && o.concedeu).map(o => o.id),
  controle_edge_visivel: out.filter(o => /-E0$/.test(o.id) && o.concedeu).map(o => o.id)
}))
