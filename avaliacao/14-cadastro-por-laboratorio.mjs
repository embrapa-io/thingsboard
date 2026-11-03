// O pesquisador cadastra dispositivos só no próprio laboratório? Papel de grupo "Edição"
// (CREATE, WRITE, DELETE, atributos e token) sobre o grupo do laboratório L1 da unidade A.
// Testa criar, mover, ler token e excluir em L1, em L2 (mesma unidade) e na unidade B.
// Age na Central de desenvolvimento, só com entidades de prefixo próprio, apagadas no fim.
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

const P = 'rbac14'
const out = []
const log = (id, esperado, desc, r) => {
  const ok = (r.status === 200) === esperado
  out.push({ id, ok })
  console.log(`${ok ? '✅' : '❌'} ${id} ${desc} (esperado ${esperado ? 'permitir' : 'negar'}): HTTP ${msg(r)}`)
}

const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
}

const quem = must(await T('GET', '/api/auth/user'), 'auth')
if (quem.authority !== 'TENANT_ADMIN') throw new Error('a chave precisa ser de administrador do tenant')
await limpar()

try {
  // --- cenário: unidade A com L1 e L2; unidade B com L3
  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'A')
  const B = must(await T('POST', '/api/customer', { title: `${P} Unidade B` }), 'B')
  const grp = async (dono, name, type) => must(await T('POST', '/api/entityGroup', { name: `${P} ${name}`, type, ownerId: dono.id }), name)
  const L1 = await grp(A, 'LOC L1', 'DEVICE'), L2 = await grp(A, 'LOC L2', 'DEVICE'), L3 = await grp(B, 'LOC L3', 'DEVICE')
  const dev = async (g, nome) => must(await T('POST', `/api/device?entityGroupId=${g.id.id}`, { name: `${P}-${nome}`, type: 'default' }), nome)
  const d2 = await dev(L2, 'l2-sensor')

  const edicao = must(await T('POST', '/api/role', { name: `${P} Edição`, type: 'GROUP',
    permissions: ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'READ_CREDENTIALS'] }), 'papel')
  const interf = must(await T('POST', '/api/role', { name: `${P} Interface`, type: 'GENERIC',
    permissions: { PROFILE: ['ALL'], DEVICE_PROFILE: ['READ'], WIDGET_TYPE: ['READ'], WIDGETS_BUNDLE: ['READ'], TB_RESOURCE: ['READ'] } }), 'interface')
  const resp = await grp(A, 'L1 Responsáveis', 'USER')
  must(await T('POST', '/api/groupPermission', { roleId: edicao.id, userGroupId: resp.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'permissão')
  must(await T('POST', '/api/groupPermission', { roleId: interf.id, userGroupId: resp.id }), 'permissão interface')

  const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${resp.id.id}`,
    { email: `${P}-responsavel@tb44.local`, authority: 'CUSTOMER_USER', customerId: A.id }), 'usuário')
  const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
  const pwd = crypto.randomBytes(12).toString('base64url')
  must(await call('POST', '/api/noauth/activate?sendActivationMail=false', '', { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'ativar')
  const tok = must(await call('POST', '/api/auth/login', '', { username: u.email, password: pwd }), 'login').token
  const U = (m, p, body) => call(m, p, 'Bearer ' + tok, body)

  // --- casos
  let r = await U('POST', `/api/device?entityGroupId=${L1.id.id}`, { name: `${P}-meu-sensor`, type: 'default' })
  log('D1', true, 'cria sensor no próprio laboratório (L1)', r)
  const meu = r.json
  if (meu) {
    log('D1b', true, `o sensor nasce com a unidade como dona (${meu.customerId && meu.customerId.id === A.id.id ? 'sim' : 'não'})`,
      { status: meu.customerId && meu.customerId.id === A.id.id ? 200 : 0, text: '' })
    r = await U('GET', `/api/device/${meu.id.id}/credentials`)
    log('D2', true, 'lê o token do próprio sensor', r)
    r = await U('POST', '/api/device', { ...meu, label: 'renomeado' })
    log('D3', true, 'edita o próprio sensor', r)
  }
  r = await U('GET', `/api/deviceProfileInfos${page}`)
  log('D4', true, 'lista os perfis de dispositivo (diálogo de cadastro)', r)
  r = await U('POST', `/api/device?entityGroupId=${L2.id.id}`, { name: `${P}-invasor-l2`, type: 'default' })
  log('N1', false, 'cria sensor em outro laboratório da MESMA unidade (L2)', r)
  r = await U('POST', `/api/device?entityGroupId=${L3.id.id}`, { name: `${P}-invasor-l3`, type: 'default' })
  log('N2', false, 'cria sensor em laboratório de OUTRA unidade (L3)', r)
  r = await U('POST', '/api/device', { name: `${P}-sem-grupo`, type: 'default' })
  log('N3', false, 'cria sensor sem indicar o grupo (cairia em "All" da unidade)', r)
  if (meu) {
    r = await U('POST', `/api/entityGroup/${L2.id.id}/addEntities`, [meu.id.id])
    log('N4', false, 'põe o próprio sensor também no grupo da L2', r)
  }
  r = await U('POST', `/api/entityGroup/${L1.id.id}/addEntities`, [d2.id.id])
  log('N5', false, 'traz um sensor da L2 para o próprio laboratório', r)
  r = await U('GET', `/api/device/${d2.id.id}/credentials`)
  log('N6', false, 'lê o token de um sensor da L2', r)
  r = await U('POST', '/api/device', { ...d2, label: 'invadido' })
  log('N7', false, 'edita um sensor da L2', r)
  r = await U('DELETE', `/api/device/${d2.id.id}`)
  log('N8', false, 'exclui um sensor da L2', r)
  if (meu) {
    r = await U('DELETE', `/api/device/${meu.id.id}`)
    log('D5', true, 'exclui o próprio sensor', r)
  }
} finally {
  await limpar()
}
console.log(JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length }))
