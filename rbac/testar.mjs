// Teste de ponta a ponta do modelo por laboratório, com o token de cada pessoa:
// o gestor cria o laboratório (asset) e indica o responsável; a regra cria os grupos;
// o responsável cadastra e monta painéis; o integrante só lê; outra unidade não vê nada.
// Cria uma unidade de teste (prefixo rbac15) e apaga tudo no fim.
//
//   RBAC_PERFIL_TESTE="Laboratório (teste rbac)" node testar.mjs
import crypto from 'node:crypto'
import { T, call, must, page, list, msg, sleep, NOMES, GRUPOS } from './lib.mjs'

const P = 'rbac15'
const PERFIL = process.env.RBAC_PERFIL_TESTE || NOMES.perfis[0]
const out = []
const log = (id, esperado, desc, r) => {
  // negar só conta como 403: um 400/404 por id inválido não prova nada
  const ok = esperado ? r.status === 200 : r.status === 403
  out.push({ id, ok })
  console.log(`${ok ? '✅' : '❌'} ${id} ${desc} (esperado ${esperado ? 'permitir' : 'negar'}): HTTP ${msg(r)}`)
}
const verifica = (id, ok, desc) => { out.push({ id, ok }); console.log(`${ok ? '✅' : '❌'} ${id} ${desc}`) }

const papel = async nome => list(await T('GET', `/api/roles${page}&textSearch=${encodeURIComponent(nome)}`)).find(r => r.name === nome)
const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const a of list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/asset/${a.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
}

const perfil = list(await T('GET', `/api/assetProfileInfos${page}`)).find(p => p.name === PERFIL)
if (!perfil) throw new Error(`perfil de asset "${PERFIL}" não existe; rode o instalador`)
const [rLeituraUnidade, rCriacao, rInterface] = await Promise.all([NOMES.leituraUnidade, NOMES.criacao, NOMES.interface].map(papel))
await limpar()

try {
  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'A')
  const B = must(await T('POST', '/api/customer', { title: `${P} Unidade B` }), 'B')
  const gestores = must(await T('POST', '/api/entityGroup', { name: NOMES.gestores, type: 'USER', ownerId: A.id }), 'Gestores')
  for (const r of [rLeituraUnidade, rCriacao, rInterface]) must(await T('POST', '/api/groupPermission', { roleId: r.id, userGroupId: gestores.id }), 'vínculo ' + r.name)

  const pessoa = async (nome, unidade, grupo) => {
    const u = must(await T('POST', `/api/user?sendActivationMail=false${grupo ? '&entityGroupId=' + grupo.id.id : ''}`,
      { email: `${P}-${nome}@tb44.local`, authority: 'CUSTOMER_USER', customerId: unidade.id }), nome)
    const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
    const pwd = crypto.randomBytes(12).toString('base64url') + 'aA1!'
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'ativar')
    const tok = must(await call('POST', '/api/auth/login', null, { username: u.email, password: pwd }), 'login').token
    const fn = (m, p, body) => call(m, p, 'Bearer ' + tok, body)
    fn.user = u
    return fn
  }
  const gestor = await pessoa('gestor', A, gestores)
  const resp = await pessoa('responsavel', A, null)
  const integ = await pessoa('integrante', A, null)
  const outro = await pessoa('outra-unidade', B, null)

  // --- o gestor cria o laboratório
  const nomeLab = `${P}-Lab "Teste"`
  let r = await gestor('POST', '/api/asset', { name: nomeLab, assetProfileId: perfil.id, customerId: A.id })
  log('G1', true, 'gestor cria o asset do laboratório na unidade', r)
  const lab = r.json
  const attrs = async () => Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${lab.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value]))
  let a = {}
  for (let i = 0; i < 30 && !a.laboratorioStatus; i++) { await sleep(1000); a = await attrs() }
  verifica('R1', a.laboratorioStatus === 'criado', `a regra criou o laboratório (status: ${a.laboratorioStatus || 'nenhum em 30 s'}${a.laboratorioErro ? ', erro: ' + a.laboratorioErro : ''})`)
  const grupos = typeof a.laboratorioGrupos === 'string' ? JSON.parse(a.laboratorioGrupos) : a.laboratorioGrupos || {}
  const nomes = GRUPOS(nomeLab)
  const porTipo = async (tipo, nome) => {
    const gs = list(await T('GET', `/api/entityGroups/CUSTOMER/${A.id.id}/${tipo}${page}`))
    const g = gs.find(x => x.name === nome)
    if (!g) console.log(`   grupos ${tipo} da unidade: ${gs.map(x => JSON.stringify(x.name)).join(' | ')}`)
    return g
  }
  const gDisp = await porTipo('DEVICE', nomes.dispositivos), gPain = await porTipo('DASHBOARD', nomes.paineis)
  const gResp = await porTipo('USER', nomes.responsaveis), gEq = await porTipo('USER', nomes.equipe)
  if (!(gDisp && gPain && gResp && gEq)) throw new Error('grupos não encontrados')
  verifica('R2', !!(gDisp && gPain && gResp && gEq && gDisp.id.id === grupos.dispositivos),
    `os 4 grupos existem na unidade com os nomes esperados (${[gDisp, gPain, gResp, gEq].filter(Boolean).length}/4)`)
  const vinc = gResp && gEq ? [...list(await T('GET', `/api/userGroup/${gResp.id.id}/groupPermissions`)), ...list(await T('GET', `/api/userGroup/${gEq.id.id}/groupPermissions`))] : []
  verifica('R3', vinc.length === 6, `6 vínculos de papel criados (${vinc.length})`)

  // --- responsável: primeiro alguém de outra unidade (deve recusar), depois o certo
  const definirResp = async email => {
    await gestor('POST', `/api/plugins/telemetry/ASSET/${lab.id.id}/attributes/SERVER_SCOPE`, { responsavel: email })
    let x = {}
    for (let i = 0; i < 20; i++) { await sleep(1000); x = await attrs(); if (x.responsavelStatus && x.responsavel === email && (x.responsavelStatus === 'ok' || x.responsavelErro)) break }
    return x
  }
  a = await definirResp(outro.user.email)
  verifica('R4', a.responsavelStatus === 'erro' && /outra unidade|nenhum/.test(a.responsavelErro || ''), `responsável de outra unidade é recusado (${a.responsavelErro || a.responsavelStatus})`)
  await T('POST', `/api/plugins/telemetry/ASSET/${lab.id.id}/attributes/SERVER_SCOPE`, { responsavelStatus: '', responsavelErro: '' })
  a = await definirResp(resp.user.email)
  const membrosResp = gResp ? list(await T('GET', `/api/entityGroup/${gResp.id.id}/entities${page}`)) : []
  verifica('R5', a.responsavelStatus === 'ok' && membrosResp.some(m => m.id.id === resp.user.id.id), `a regra pôs o responsável no grupo (${a.responsavelStatus}${a.responsavelErro ? ': ' + a.responsavelErro : ''})`)

  // --- o gestor põe o integrante na Equipe
  r = await gestor('POST', `/api/entityGroup/${gEq.id.id}/addEntities`, [integ.user.id.id])
  log('G2', true, 'gestor põe o integrante na Equipe', r)
  r = await gestor('POST', `/api/entityGroup/${gResp.id.id}/addEntities`, [gestor.user.id.id])
  log('G3', true, 'gestor também pode se pôr em Responsáveis (é admin da unidade por desenho)', r)
  if (r.status === 200) await T('POST', `/api/entityGroup/${gResp.id.id}/deleteEntities`, [gestor.user.id.id])

  // relogin não é necessário: as permissões valem na próxima requisição
  // --- responsável
  r = await resp('POST', `/api/device?entityGroupId=${gDisp.id.id}`, { name: `${P}-sensor-1`, type: 'default' })
  log('P1', true, 'responsável cadastra sensor no laboratório', r)
  const dev = r.json
  r = await resp('GET', `/api/device/${dev?.id?.id}/credentials`)
  log('P2', true, 'responsável lê o token do sensor', r)
  r = await resp('POST', `/api/dashboard?entityGroupId=${gPain.id.id}`, { title: `${P} painel` })
  log('P3', true, 'responsável cria painel no laboratório', r)
  const painel = r.json
  // o diálogo de cadastro da interface lê a própria unidade (Proprietário) e os firmwares ao abrir
  r = await resp('GET', `/api/customer/${A.id.id}`)
  log('P6', true, 'responsável lê a própria unidade (campo Proprietário da tela)', r)
  r = await resp('GET', `/api/otaPackages${page}`)
  log('P7', true, 'responsável lista firmwares (diálogo de cadastro da tela)', r)
  r = await resp('GET', `/api/customer/${B.id.id}`)
  log('P8', false, 'responsável lê outra unidade', r)
  r = await resp('POST', `/api/plugins/rpc/oneway/${dev?.id?.id}`, { method: 'setPower', params: true })
  log('P4', false, 'responsável manda RPC direto', r)
  r = await resp('GET', `/api/ruleChains${page}`)
  log('P5', false, 'responsável lista rule chains', r)

  // --- integrante
  r = await integ('GET', `/api/device/${dev?.id?.id}`)
  log('I1', true, 'integrante vê o sensor', r)
  r = await integ('GET', `/api/dashboard/${painel?.id?.id}`)
  log('I2', true, 'integrante abre o painel', r)
  r = await integ('GET', `/api/device/${dev?.id?.id}/credentials`)
  log('I3', false, 'integrante lê o token', r)
  r = await integ('POST', `/api/device?entityGroupId=${gDisp.id.id}`, { name: `${P}-sensor-integrante`, type: 'default' })
  log('I4', false, 'integrante cadastra sensor', r)
  r = await integ('POST', `/api/plugins/telemetry/DEVICE/${dev?.id?.id}/attributes/SHARED_SCOPE`, { x: 1 })
  log('I5', false, 'integrante grava atributo', r)

  // --- gestor
  r = await gestor('GET', `/api/device/${dev?.id?.id}`)
  log('G4', true, 'gestor vê o sensor (leitura da unidade)', r)
  r = await gestor('GET', `/api/device/${dev?.id?.id}/credentials`)
  log('G5', false, 'gestor lê o token', r)
  r = await gestor('POST', `/api/plugins/rpc/oneway/${dev?.id?.id}`, { method: 'setPower', params: true })
  log('G6', false, 'gestor manda RPC', r)
  r = await gestor('POST', '/api/role', { name: `${P} papel do gestor`, type: 'GENERIC', permissions: { ALL: ['ALL'] } })
  log('G7', false, 'gestor cria papel', r)
  r = await gestor('POST', '/api/groupPermission', { roleId: rCriacao.id, userGroupId: gEq.id })
  log('G8', false, 'gestor vincula papéis', r)

  // --- outra unidade
  r = await outro('GET', `/api/device/${dev?.id?.id}`)
  log('O1', false, 'pessoa de outra unidade vê o sensor', r)
  r = await outro('GET', `/api/dashboard/${painel?.id?.id}`)
  log('O2', false, 'pessoa de outra unidade abre o painel', r)
  r = await outro('GET', `/api/asset/${lab.id.id}`)
  log('O3', false, 'pessoa de outra unidade vê o laboratório', r)
} finally {
  await limpar()
}
console.log(JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length }))
