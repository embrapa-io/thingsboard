// Combinações de RBAC da 4.4 para o Embrapa I/O: um tenant (Embrapa), um customer
// por unidade, localidades dentro da unidade, os dois perfis do Embrapa I/O
// (Maintainer e Developer) e o gestor da unidade com acesso privilegiado.
// Cada modelo monta o mesmo cenário e compara o que cada pessoa consegue fazer
// com o comportamento desejado. O histórico de telemetria fica de fora: ver o
// RESTRITO-isolamento.md e o 08-historico-websocket.mjs.
//
// Uso: node 07-modelos-rbac.mjs [--manter]
//   --manter  não apaga o cenário no fim (para explorar pelo navegador; senha
//             dos usuários em TB44_RBAC7_PASSWORD, se definida no .env)
import crypto from 'node:crypto'
import { ENV, api, login, sleep } from './lib.mjs'

const P = 'rbac7'
const MANTER = process.argv.includes('--manter')
const out = []
const log = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${msg}`) }
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const ten = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD)
const T = (m, p, body) => api(m, p, { token: ten, body })
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []

// ---------------------------------------------------------------- limpeza
const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  const custs = list(await T('GET', `/api/customers${page}&textSearch=${P}`))
  // sub-customers primeiro
  for (const c of custs.filter(c => c.parentCustomerId)) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const c of custs.filter(c => !c.parentCustomerId)) await T('DELETE', `/api/customer/${c.id.id}`)
  for (const type of ['DEVICE', 'USER']) {
    for (const g of list(await T('GET', `/api/entityGroups/${type}${page}`)).filter(g => g.name.startsWith(P))) await T('DELETE', `/api/entityGroup/${g.id.id}`)
  }
  for (const r of list(await T('GET', `/api/roles${page}&textSearch=${P}`))) await T('DELETE', `/api/role/${r.id.id}`)
}
await limpar()

// ---------------------------------------------------------------- utilitários
const customer = async (title, parent) => must(await T('POST', '/api/customer',
  parent ? { title, parentCustomerId: parent.id, ownerId: parent.id } : { title }), 'customer ' + title)
const groupOf = async (owner, type, name) => list(await T('GET', `/api/entityGroups/${owner.id.entityType}/${owner.id.id}/${type}${page}`)).find(g => g.name === name)
const group = async (name, type, owner) => must(await T('POST', '/api/entityGroup',
  { name: `${P} ${name}`, type, ...(owner ? { ownerId: owner.id } : {}) }), 'grupo ' + name)
const device = async (name, g) => must(await T('POST', `/api/device?entityGroupId=${g.id.id}`, { name: `${P}-${name}`, type: 'default' }), 'device ' + name)
const addTo = (g, ids) => T('POST', `/api/entityGroup/${g.id.id}/addEntities`, ids)
const perm = (role, ug, eg) => T('POST', '/api/groupPermission',
  { roleId: role.id, userGroupId: ug.id, ...(eg ? { entityGroupId: eg.id, entityGroupType: eg.type } : {}) })
const senha = () => ENV.TB44_RBAC7_PASSWORD || crypto.randomBytes(15).toString('base64url')
const user = async (email, g, cust, authority = 'CUSTOMER_USER') => {
  const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${g.id.id}`,
    { email: `${P}-${email}@tb44.local`, authority, ...(cust ? { customerId: cust.id } : {}) }), 'user ' + email)
  const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
  const activateToken = new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken')
  const pwd = senha()
  must(await api('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken, password: pwd } }), 'activate')
  return { ...u, token: await login(u.email, pwd) }
}
const as = (u, m, p, body) => api(m, p, { token: u.token, body })
const role = async (name, type, permissions) => must(await T('POST', '/api/role', { name: `${P} ${name}`, type, permissions }), 'role ' + name)

// ---------------------------------------------------------------- papéis
const OPS_RESP = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CREDENTIALS', 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'RPC_CALL']
const OPS_MEMB = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY']
const R = {
  resp: await role('Responsável pela localidade', 'GROUP', OPS_RESP),
  memb: await role('Membro da localidade', 'GROUP', OPS_MEMB),
  respG: await role('Responsável (genérico)', 'GENERIC', { DEVICE: OPS_RESP, DEVICE_GROUP: ['READ', 'ADD_TO_GROUP', 'REMOVE_FROM_GROUP'] }),
  membG: await role('Membro (genérico)', 'GENERIC', { DEVICE: OPS_MEMB, DEVICE_GROUP: ['READ'] }),
  tele: await role('Leitor de telemetria', 'GENERIC', { DEVICE: ['READ', 'READ_TELEMETRY'] }),
  usr: await role('Leitor de usuários', 'GENERIC', { USER: ['READ', 'READ_ATTRIBUTES'] })
}

// Compartilhar um grupo de uma unidade com um grupo de usuários de outra.
// Tenta a permissão direta; se for recusada, usa a rota de compartilhamento.
const shareLog = []
const share = async (eg, ug, ugOwner, roleObj, by = null) => {
  const call = (m, p, b) => by ? as(by, m, p, b) : T(m, p, b)
  let r = await call('POST', '/api/groupPermission', { roleId: roleObj.id, userGroupId: ug.id, entityGroupId: eg.id, entityGroupType: eg.type })
  if (r.status === 200) { shareLog.push(`direta ${r.status}`); return r }
  const first = r.status + ' ' + (r.json && r.json.message)
  r = await call('POST', `/api/entityGroup/${eg.id.id}/share`, { ownerId: ugOwner.id, allUserGroup: false, userGroupIds: [ug.id], readElseWrite: true, roleIds: [roleObj.id] })
  shareLog.push(`direta ${first}; share ${r.status}`)
  return r
}

// ---------------------------------------------------------------- comportamento desejado
// all = ver, configurar (atributo compartilhado), comando (RPC) e token; read = só ver
const IDEAL = {
  gestorA: { aL1a: 'all', aL1b: 'all', aL2: 'all', b1: 'none' },
  mantA: { aL1a: 'all', aL1b: 'all', aL2: 'none', b1: 'none' },
  devA: { aL1a: 'read', aL1b: 'read', aL2: 'none', b1: 'none' },
  outroA: { aL1a: 'none', aL1b: 'none', aL2: 'read', b1: 'none' },
  duploA: { aL1a: 'read', aL1b: 'read', aL2: 'read', b1: 'none' },
  mantB: { aL1a: 'read', aL1b: 'read', aL2: 'none', b1: 'all' }
}
const CRIA = { gestorA: true, mantA: true, devA: false, outroA: false, duploA: false, mantB: true }
const PAD = { all: 'VCRK', read: 'V---', none: '----' }

const avaliar = async (m, S) => {
  const linhas = []
  let erros = 0
  for (const [p, exp] of Object.entries(IDEAL)) {
    const u = S.users[p]
    const got = {}
    for (const [k, d] of Object.entries(S.devices)) {
      const id = d.id.id
      const v = (await as(u, 'GET', `/api/device/${id}`)).status === 200
      const c = (await as(u, 'POST', `/api/plugins/telemetry/DEVICE/${id}/SHARED_SCOPE`, { intervalo: 60 })).status === 200
      const r = (await as(u, 'POST', `/api/plugins/rpc/oneway/${id}`, { method: 'setValve', params: { open: false }, persistent: true, timeout: 5000 })).status === 200
      const kk = (await as(u, 'GET', `/api/device/${id}/credentials`)).status === 200
      got[k] = (v ? 'V' : '-') + (c ? 'C' : '-') + (r ? 'R' : '-') + (kk ? 'K' : '-')
    }
    const vis = list(await as(u, 'GET', `/api/user/devices${page}`)).map(d => Object.keys(S.devices).find(k => S.devices[k].id.id === d.id.id)).filter(Boolean).sort()
    const visExp = Object.keys(exp).filter(k => exp[k] !== 'none').sort()
    // criação no grupo da própria localidade (ou da própria unidade, para quem é da B)
    const alvo = S.createIn[p]
    let cria = null
    if (alvo) {
      const r = await as(u, 'POST', `/api/device?entityGroupId=${alvo.id.id}`, { name: `${P}-${m}-criado-${p}`, type: 'default' })
      cria = r.status === 200
      if (cria) cria = (await as(u, 'DELETE', `/api/device/${r.json.id.id}`)).status === 200 ? 'cria+apaga' : 'cria'
      else cria = `não (${r.status})`
    }
    const difs = Object.keys(exp).filter(k => got[k] !== PAD[exp[k]])
    const visOk = JSON.stringify(vis) === JSON.stringify(visExp)
    const criaOk = CRIA[p] === (typeof cria === 'string' && cria.startsWith('cria'))
    erros += difs.length + (visOk ? 0 : 1) + (criaOk ? 0 : 1)
    linhas.push({ pessoa: p, ...got, lista: vis.join(',') + (visOk ? '' : ' ≠'), cria: cria + (criaOk ? '' : ' ≠') })
    log(`${m}-${p}`, difs.length === 0 && visOk && criaOk,
      `${Object.entries(got).map(([k, v]) => `${k}=${v}${v === PAD[exp[k]] ? '' : '≠' + PAD[exp[k]]}`).join(' ')} | lista [${vis}]${visOk ? '' : '≠[' + visExp + ']'} | criar: ${cria}`)
  }
  console.table(linhas)
  return erros
}

// ---------------------------------------------------------------- cenário comum
// A unidade A tem duas localidades (L1 com 2 sensores, L2 com 1); a unidade B tem 1 sensor.
// Pessoas: gestorA (gestor da A), mantA e devA (Maintainer e Developer da L1),
// outroA (Developer da L2), duploA (Developer na L1 e na L2) e mantB (Maintainer
// da B que colabora com a L1).
const resumo = {}
const montar = {}

// C1: unidade aberta. Papéis genéricos na unidade inteira; o perfil vira o papel.
montar.C1 = async () => {
  const A = await customer(`${P} C1 Unidade A`), B = await customer(`${P} C1 Unidade B`)
  const gA = await group('C1 dispositivos A', 'DEVICE', A), gB = await group('C1 dispositivos B', 'DEVICE', B)
  const devices = { aL1a: await device('C1-a-l1-1', gA), aL1b: await device('C1-a-l1-2', gA), aL2: await device('C1-a-l2-1', gA), b1: await device('C1-b-1', gB) }
  const mant = await group('C1 Mantenedores A', 'USER', A), dev = await group('C1 Desenvolvedores A', 'USER', A)
  const mantBg = await group('C1 Mantenedores B', 'USER', B), colab = await group('C1 Colaboradores B', 'USER', B)
  await perm(R.respG, mant); await perm(R.membG, dev); await perm(R.respG, mantBg)
  await share(gA, colab, B, R.memb)
  const admA = await groupOf(A, 'USER', 'Customer Administrators')
  const users = {
    gestorA: await user('c1-gestor-a', admA, A), mantA: await user('c1-mant-a', mant, A), devA: await user('c1-dev-a', dev, A),
    outroA: await user('c1-outro-a', dev, A), duploA: await user('c1-duplo-a', dev, A), mantB: await user('c1-mant-b', mantBg, B)
  }
  await addTo(colab, [users.mantB.id.id])
  return { A, B, devices, users, createIn: { gestorA: gA, mantA: gA, devA: gA, outroA: gA, duploA: gA, mantB: gB } }
}

// C2: localidade como grupo. Um grupo de dispositivos e dois de usuários
// (Responsáveis e Equipe) por localidade, todos da unidade; colaboração por compartilhamento.
montar.C2 = async () => {
  const A = await customer(`${P} C2 Unidade A`), B = await customer(`${P} C2 Unidade B`)
  const L1 = await group('C2 LOC L1', 'DEVICE', A), L2 = await group('C2 LOC L2', 'DEVICE', A), LB = await group('C2 LOC B1', 'DEVICE', B)
  const devices = { aL1a: await device('C2-a-l1-1', L1), aL1b: await device('C2-a-l1-2', L1), aL2: await device('C2-a-l2-1', L2), b1: await device('C2-b-1', LB) }
  const l1R = await group('C2 L1 Responsáveis', 'USER', A), l1E = await group('C2 L1 Equipe', 'USER', A), l2E = await group('C2 L2 Equipe', 'USER', A)
  const bR = await group('C2 B1 Responsáveis', 'USER', B), bColab = await group('C2 B Colaboradores L1', 'USER', B)
  await perm(R.resp, l1R, L1); await perm(R.memb, l1E, L1); await perm(R.memb, l2E, L2); await perm(R.resp, bR, LB)
  const sh = await share(L1, bColab, B, R.memb)
  log('C2-share', sh.status === 200, `compartilhar LOC L1 (unidade A) com grupo de usuários da unidade B: ${shareLog.at(-1)}`)
  const admA = await groupOf(A, 'USER', 'Customer Administrators')
  const users = {
    gestorA: await user('c2-gestor-a', admA, A), mantA: await user('c2-mant-a', l1R, A), devA: await user('c2-dev-a', l1E, A),
    outroA: await user('c2-outro-a', l2E, A), duploA: await user('c2-duplo-a', l1E, A), mantB: await user('c2-mant-b', bR, B)
  }
  await addTo(l2E, [users.duploA.id.id]); await addTo(bColab, [users.mantB.id.id])
  return { A, B, L1, L2, LB, l1E, devices, users, createIn: { gestorA: L1, mantA: L1, devA: L1, outroA: L2, duploA: L1, mantB: LB } }
}

// C3: derivação como sub-customer. Cada localidade é um sub-customer da unidade,
// dono dos próprios sensores; papéis genéricos no escopo do sub-customer.
montar.C3 = async () => {
  const A = await customer(`${P} C3 Unidade A`), B = await customer(`${P} C3 Unidade B`)
  const sL1 = await customer(`${P} C3 A-L1`, A), sL2 = await customer(`${P} C3 A-L2`, A)
  const L1 = await group('C3 LOC L1', 'DEVICE', sL1), L2 = await group('C3 LOC L2', 'DEVICE', sL2), LB = await group('C3 LOC B1', 'DEVICE', B)
  const devices = { aL1a: await device('C3-a-l1-1', L1), aL1b: await device('C3-a-l1-2', L1), aL2: await device('C3-a-l2-1', L2), b1: await device('C3-b-1', LB) }
  const l1R = await group('C3 L1 Responsáveis', 'USER', sL1), l1E = await group('C3 L1 Equipe', 'USER', sL1)
  const l2E = await group('C3 L2 Equipe', 'USER', sL2), l1VerL2 = await group('C3 L1 com acesso à L2', 'USER', sL1)
  const bR = await group('C3 B1 Responsáveis', 'USER', B), bColab = await group('C3 B Colaboradores L1', 'USER', B)
  await perm(R.respG, l1R); await perm(R.membG, l1E); await perm(R.membG, l2E); await perm(R.respG, bR)
  await share(L2, l1VerL2, sL1, R.memb)
  const sh = await share(L1, bColab, B, R.memb)
  log('C3-share', sh.status === 200, `compartilhar LOC L1 (sub-customer da A) com grupo da unidade B: ${shareLog.at(-1)}`)
  const admA = await groupOf(A, 'USER', 'Customer Administrators')
  const users = {
    gestorA: await user('c3-gestor-a', admA, A), mantA: await user('c3-mant-a', l1R, sL1), devA: await user('c3-dev-a', l1E, sL1),
    outroA: await user('c3-outro-a', l2E, sL2), duploA: await user('c3-duplo-a', l1E, sL1), mantB: await user('c3-mant-b', bR, B)
  }
  await addTo(l1VerL2, [users.duploA.id.id]); await addTo(bColab, [users.mantB.id.id])
  return { A, B, sL1, devices, users, createIn: { gestorA: L1, mantA: L1, devA: L1, outroA: L2, duploA: L1, mantB: LB } }
}

// C5: posse no tenant (estado deixado pelo upgrade). Sensores do tenant em grupos
// do tenant por localidade; usuários das unidades recebem papéis de grupo.
montar.C5 = async () => {
  const A = await customer(`${P} C5 Unidade A`), B = await customer(`${P} C5 Unidade B`)
  const L1 = await group('C5 LOC A-L1', 'DEVICE'), L2 = await group('C5 LOC A-L2', 'DEVICE'), LB = await group('C5 LOC B1', 'DEVICE')
  const devices = { aL1a: await device('C5-a-l1-1', L1), aL1b: await device('C5-a-l1-2', L1), aL2: await device('C5-a-l2-1', L2), b1: await device('C5-b-1', LB) }
  const l1R = await group('C5 L1 Responsáveis', 'USER', A), l1E = await group('C5 L1 Equipe', 'USER', A), l2E = await group('C5 L2 Equipe', 'USER', A)
  const bR = await group('C5 B1 Responsáveis', 'USER', B), bColab = await group('C5 B Colaboradores L1', 'USER', B)
  await perm(R.resp, l1R, L1); await perm(R.memb, l1E, L1); await perm(R.memb, l2E, L2); await perm(R.resp, bR, LB)
  const sh = await perm(R.memb, bColab, L1)
  log('C5-share', sh.status === 200, `papel de grupo da unidade B direto num grupo do tenant: HTTP ${sh.status}`)
  const admA = await groupOf(A, 'USER', 'Customer Administrators')
  const users = {
    gestorA: await user('c5-gestor-a', admA, A), mantA: await user('c5-mant-a', l1R, A), devA: await user('c5-dev-a', l1E, A),
    outroA: await user('c5-outro-a', l2E, A), duploA: await user('c5-duplo-a', l1E, A), mantB: await user('c5-mant-b', bR, B)
  }
  await addTo(l2E, [users.duploA.id.id]); await addTo(bColab, [users.mantB.id.id])
  return { A, B, L1, devices, users, createIn: { gestorA: L1, mantA: L1, devA: L1, outroA: L2, duploA: L1, mantB: LB } }
}

const S = {}
for (const m of ['C1', 'C2', 'C3', 'C5']) {
  console.log(`\n=== ${m}`)
  S[m] = await montar[m]()
  resumo[m] = await avaliar(m, S[m])
  log(`${m}-resumo`, null, `${resumo[m]} diferenças em relação ao comportamento desejado`)
}

// ---------------------------------------------------------------- gestor da unidade
console.log('\n=== Gestor da unidade (privilégios fora dos perfis do Embrapa I/O)')
for (const m of ['C2', 'C3']) {
  const s = S[m], g = s.users.gestorA
  const alvoUser = m === 'C2' ? s.l1E : await groupOf(s.sL1, 'USER', `${P} C3 L1 Equipe`)
  const cust = m === 'C2' ? s.A : s.sL1
  let r = await as(g, 'POST', `/api/user?sendActivationMail=false&entityGroupId=${alvoUser.id.id}`, { email: `${P}-${m.toLowerCase()}-novo-pelo-gestor@tb44.local`, authority: 'CUSTOMER_USER', customerId: cust.id })
  log(`${m}-G1`, r.status === 200, `gestor cria usuário na equipe da localidade: HTTP ${r.status} ${r.status === 200 ? '' : (r.json && r.json.message) || ''}`)
  r = await as(g, 'GET', `/api/ruleChains${page}`)
  log(`${m}-G2`, r.status === 403, `gestor lista rule chains: HTTP ${r.status}`)
  r = await as(g, 'GET', `/api/device/${s.devices.b1.id.id}`)
  log(`${m}-G3`, r.status === 403, `gestor da A lê sensor da B: HTTP ${r.status}`)
}
{
  const s = S.C2, g = s.users.gestorA
  const ugB = await groupOf(s.B, 'USER', `${P} C2 B1 Responsáveis`)
  const r = await share(s.L2, ugB, s.B, R.memb, g)
  log('C2-G4', r.status === 200, `gestor da A compartilha LOC L2 com a unidade B, sem o administrador do tenant: ${shareLog.at(-1)}`)
  const sub = await as(S.C3.users.gestorA, 'POST', '/api/customer', { title: `${P} C3 A-L3 criada pelo gestor`, parentCustomerId: S.C3.A.id, ownerId: S.C3.A.id })
  log('C3-G5', sub.status === 200, `gestor da A cria um sub-customer (nova derivação): HTTP ${sub.status}`)
}

// ---------------------------------------------------------------- armadilha do grupo padrão
{
  const s = S.C2
  const padrao = await groupOf(s.A, 'USER', 'Customer Users')
  const u = await user('c2-padrao-a', padrao, s.A)
  const id = s.devices.aL2.id.id
  const ops = [(await as(u, 'GET', `/api/device/${id}/credentials`)).status, (await as(u, 'POST', `/api/plugins/rpc/oneway/${id}`, { method: 'setValve', params: {}, persistent: true, timeout: 5000 })).status]
  const vis = list(await as(u, 'GET', `/api/user/devices${page}`)).filter(d => d.name.startsWith(`${P}-C2`)).length
  log('C2-T0', null, `usuário posto no grupo padrão "Customer Users" vê ${vis} sensores da unidade; token: HTTP ${ops[0]}; comando: HTTP ${ops[1]}`)
}

// ---------------------------------------------------------------- C4: projeto espelhado em grupos
console.log('\n=== C4: projeto como grupo (sensores e pessoas de unidades diferentes)')
{
  const s = S.C2
  let r = await addTo(s.L1, [s.devices.b1.id.id])
  log('C4-P1', null, `pôr sensor da B num grupo da A: HTTP ${r.status} ${(r.json && r.json.message) || ''}`)
  const prj = await group('C4 PRJ projeto-1', 'DEVICE')
  r = await addTo(prj, [s.devices.aL1a.id.id, s.devices.b1.id.id])
  const n = list(await T('GET', `/api/entityGroup/${prj.id.id}/entities${page}`)).length
  log('C4-P2', null, `grupo do tenant com sensores da A e da B: HTTP ${r.status}, ${n} no grupo ${(r.json && r.json.message) || ''}`)
  const prjU = await group('C4 PRJ projeto-1 equipe', 'USER')
  r = await addTo(prjU, [s.users.mantA.id.id, s.users.mantB.id.id])
  log('C4-P3', null, `grupo de usuários do tenant com pessoas da A e da B: HTTP ${r.status} ${(r.json && r.json.message) || ''}`)
  const ugA = await groupOf(s.A, 'USER', `${P} C2 L1 Equipe`)
  r = await addTo(ugA, [s.users.mantB.id.id])
  log('C4-P4', null, `pôr usuário da B num grupo de usuários da A: HTTP ${r.status} ${(r.json && r.json.message) || ''}`)
}

// ---------------------------------------------------------------- contas de serviço
console.log('\n=== Contas de serviço com papéis genéricos mínimos')
{
  const svc = await group('svc telemetria', 'USER'), svcU = await group('svc usuarios', 'USER')
  await perm(R.tele, svc); await perm(R.usr, svcU)
  const tel = await user('svc-telemetria', svc, null, 'TENANT_ADMIN'), aut = await user('svc-auth', svcU, null, 'TENANT_ADMIN')
  const d = S.C2.devices.aL1a.id.id, uid = S.C2.users.mantA.id.id
  const now = Date.now()
  const st = async (u, m, p, b) => (await as(u, m, p, b)).status
  log('S1', null, `telemetria: ler sensor ${await st(tel, 'GET', `/api/device/${d}`)}, histórico ${await st(tel, 'GET', `/api/plugins/telemetry/DEVICE/${d}/values/timeseries?keys=x&startTs=${now - 3600000}&endTs=${now}`)}, ` +
    `gravar atributo ${await st(tel, 'POST', `/api/plugins/telemetry/DEVICE/${d}/SHARED_SCOPE`, { a: 1 })}, token ${await st(tel, 'GET', `/api/device/${d}/credentials`)}, ` +
    `comando ${await st(tel, 'POST', `/api/plugins/rpc/oneway/${d}`, { method: 'x', params: {}, persistent: true, timeout: 5000 })}, usuários ${await st(tel, 'GET', `/api/user/users${page}`)}, rule chains ${await st(tel, 'GET', `/api/ruleChains${page}`)}`)
  log('S2', null, `auth: ler usuário ${await st(aut, 'GET', `/api/user/${uid}`)}, atributos do usuário ${await st(aut, 'GET', `/api/plugins/telemetry/USER/${uid}/values/attributes/SERVER_SCOPE`)}, ` +
    `ler sensor ${await st(aut, 'GET', `/api/device/${d}`)}, token de outro usuário ${await st(aut, 'GET', `/api/user/${uid}/token`)}`)
  // Embrapa I/O calculando o que a pessoa pode ver: token do usuário obtido pelo administrador
  const tk = await T('GET', `/api/user/${uid}/token`)
  const vis = list(await api('GET', `/api/user/devices${page}`, { token: tk.json && tk.json.token })).map(x => x.name).filter(n => n.startsWith(`${P}-C2`))
  log('S3', tk.status === 200 && vis.length === 2, `serviço obtém o token do Maintainer da L1 e lista o que ele vê: ${vis.join(', ')}`)
}

// ---------------------------------------------------------------- Edge e troca de posse
console.log('\n=== Edge e troca de posse')
{
  const edge = list(await T('GET', `/api/edges${page}`))[0]
  const L1 = S.C2.L1
  let r = await T('POST', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`)
  log('E1', r.status === 200, `atribuir ao ${edge.name} o grupo LOC L1, que pertence à unidade: HTTP ${r.status}`)
  let found = []
  try {
    const et = await login(ENV.TB44_TENANT_EMAIL, ENV.TB44_TENANT_PASSWORD, ENV.TB44_EDGE_URL || 'http://127.0.0.1:9293')
    for (let i = 0; i < 12 && found.length < 2; i++) {
      await sleep(5000)
      found = list(await api('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}-C2-a-l1`, { token: et, base: ENV.TB44_EDGE_URL || 'http://127.0.0.1:9293' })).map(d => d.name + (d.customerId && d.customerId.id === S.C2.A.id.id ? ' (dono: unidade A)' : ''))
    }
    log('E2', found.length === 2, `sensores da L1 no Edge após a atribuição: ${found.join(', ') || 'nenhum em 60 s'}`)
  } catch (e) { log('E2', false, `Edge inacessível: ${e.message.slice(0, 120)}`) }
  await T('DELETE', `/api/edge/${edge.id.id}/entityGroup/${L1.id.id}/DEVICE`)

  const d = S.C5.devices.aL1a
  r = await T('POST', `/api/owner/CUSTOMER/${S.C5.A.id.id}/DEVICE/${d.id.id}`)
  const after = (await T('GET', `/api/device/${d.id.id}`)).json
  const still = list(await T('GET', `/api/entityGroup/${S.C5.L1.id.id}/entities${page}`)).some(x => x.id.id === d.id.id)
  log('O1', r.status === 200 && after.customerId && after.customerId.id === S.C5.A.id.id,
    `troca de dono tenant → unidade: HTTP ${r.status}, customerId ${after.customerId && after.customerId.id === S.C5.A.id.id ? 'preenchido' : 'vazio'}, continua no grupo do tenant: ${still ? 'sim' : 'não'}`)
}

console.log('\nResumo (diferenças em relação ao desejado):', JSON.stringify(resumo))
if (!MANTER) { await limpar(); console.log('cenário removido') } else console.log('cenário mantido (--manter)')
console.log(JSON.stringify({ pass: out.filter(o => o.ok === true).length, fail: out.filter(o => o.ok === false).length, info: out.filter(o => o.ok === null).length }))
