// Implanta na Central de desenvolvimento os papéis e grupos da arquitetura C2
// ("localidade como grupo"), a partir do modelo herdado da 4.3:
//   asset da localidade + Contains → grupo `LOC · <localidade>` da unidade
//   AccessibleBy asset → pessoa     → `<localidade> · Equipe` (ou `· Colaboradores` na unidade da pessoa)
//   AccessibleBy device → pessoa    → `DISP · <sensor>` com o mesmo papel, sem ampliar o acesso
// Sem argumentos só SIMULA (lê tudo e lista o que faria). Com --aplicar, grava.
// Pode rodar de novo: o que já existe é reaproveitado. Mantém assets e relações
// AccessibleBy, que o backend do Embrapa I/O ainda usa para calcular o acesso.
//
//   node 11-implantar-rbac.mjs             simulação
//   node 11-implantar-rbac.mjs --aplicar   grava na Central
//
// Credencial: THINGSBOARD_TOKEN (chave de API do tenant) do backend/.env; nunca é impressa.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APLICAR = process.argv.includes('--aplicar')
const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env')
const ENV = Object.fromEntries(readFileSync(BACKEND_ENV, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const must = async (method, path, body) => {
  const r = await api(method, path, body)
  if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}
const page = '?pageSize=1000&page=0'
const lista = j => (j && (j.data || j)) || []

// --- papéis
const OPS_LOCALIDADE = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY']
const OPS_RESPONSAVEL = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY', 'READ_CREDENTIALS', 'CREATE', 'WRITE',
  'WRITE_ATTRIBUTES', 'DELETE', 'RPC_CALL', 'READ_CALCULATED_FIELD', 'WRITE_CALCULATED_FIELD']
// Gestor: tudo na unidade, menos Impersonate, Change Owner, claiming, devolver ao tenant e chaves de API
const OPS_GESTOR = ['CREATE', 'READ', 'WRITE', 'DELETE', 'RPC_CALL', 'READ_CREDENTIALS', 'WRITE_CREDENTIALS',
  'READ_ATTRIBUTES', 'WRITE_ATTRIBUTES', 'READ_TELEMETRY', 'WRITE_TELEMETRY', 'ADD_TO_GROUP', 'REMOVE_FROM_GROUP',
  'SHARE_GROUP', 'READ_CALCULATED_FIELD', 'WRITE_CALCULATED_FIELD']
const RECURSOS_GESTOR = ['ALARM', 'DEVICE', 'ASSET', 'CUSTOMER', 'DASHBOARD', 'ENTITY_VIEW', 'USER', 'EDGE',
  'SCHEDULER_EVENT', 'BLOB_ENTITY', 'REPORT', 'CUSTOMER_GROUP', 'DEVICE_GROUP', 'ASSET_GROUP', 'USER_GROUP',
  'ENTITY_VIEW_GROUP', 'DASHBOARD_GROUP', 'EDGE_GROUP', 'ROLE', 'GROUP_PERMISSION', 'AUDIT_LOG', 'NOTIFICATION']
const LEITURA_GESTOR = ['DEVICE_PROFILE', 'ASSET_PROFILE', 'WIDGETS_BUNDLE', 'WIDGET_TYPE', 'TB_RESOURCE', 'OTA_PACKAGE']
const PAPEIS = {
  responsavel: { name: 'Responsável pela localidade', type: 'GROUP', permissions: OPS_RESPONSAVEL },
  membro: { name: 'Membro da localidade', type: 'GROUP', permissions: OPS_LOCALIDADE },
  gestor: {
    name: 'Gestor da unidade', type: 'GENERIC', permissions: {
      PROFILE: ['ALL'],
      ...Object.fromEntries(RECURSOS_GESTOR.map(r => [r, OPS_GESTOR])),
      ...Object.fromEntries(LEITURA_GESTOR.map(r => [r, ['READ']]))
    }
  }
}

// --- registro do que foi (ou seria) feito
const feitos = []
const avisos = []
let seq = 0
const fazer = async (passo, descricao, fn) => {
  feitos.push({ passo, descricao })
  console.log(`${APLICAR ? '→' : '[simulação]'} ${passo}: ${descricao}`)
  if (APLICAR) return fn()
  return { id: { id: `simulado-${++seq}`, entityType: 'SIMULADO' } }
}
const avisar = msg => { avisos.push(msg); console.log('⚠️  ' + msg) }
const idDe = x => x.id.id
const simulado = x => String(idDe(x)).startsWith('simulado-')

// =====================================================================
// 1. Leitura do estado atual
// =====================================================================
const quem = await must('GET', '/api/auth/user')
if (quem.authority !== 'TENANT_ADMIN') throw new Error('a chave precisa ser de administrador do tenant')
const tenantId = quem.tenantId

const unidades = lista(await must('GET', '/api/customers' + page)).filter(c => c.title !== 'Public')
const unidadePorTitulo = new Map(unidades.map(c => [c.title, c]))
const unidadePorId = new Map(unidades.map(c => [idDe(c), c]))
const dispositivos = lista(await must('GET', '/api/deviceInfos/all' + page + '&includeCustomers=true'))
const dispPorId = new Map(dispositivos.map(d => [idDe(d), d]))
const assets = lista(await must('GET', '/api/assetInfos/all' + page + '&includeCustomers=true'))
const usuarios = lista(await must('GET', '/api/user/users' + page))
const usuarioPorId = new Map(usuarios.map(u => [idDe(u), u]))
const edges = lista(await must('GET', '/api/edges' + page))

// A migração da 4.3 deixou assets e sensores no tenant, em grupos "<Unidade> Assets/Devices"
const unidadeDoGrupo = (grupos, sufixo) => {
  const nomes = (grupos || []).map(g => g.name).filter(n => n.endsWith(' ' + sufixo))
  const achadas = nomes.map(n => unidadePorTitulo.get(n.slice(0, -sufixo.length - 1))).filter(Boolean)
  return achadas.length === 1 ? achadas[0] : null
}
const donoDe = x => x.ownerId && x.ownerId.entityType === 'CUSTOMER' ? unidadePorId.get(x.ownerId.id) : null
const unidadeDoAsset = a => donoDe(a) || unidadeDoGrupo(a.groups, 'Assets')
const unidadeDoUsuario = u => u.customerId && unidadePorId.get(u.customerId.id)

const relacoes = async (fromId, fromType, relationType) =>
  lista(await must('GET', `/api/relations?fromId=${fromId}&fromType=${fromType}&relationType=${relationType}&relationTypeGroup=COMMON`))

const localidades = []
for (const a of assets) {
  const unidade = unidadeDoAsset(a)
  const contem = (await relacoes(idDe(a), 'ASSET', 'Contains')).filter(r => r.to.entityType === 'DEVICE').map(r => dispPorId.get(r.to.id)).filter(Boolean)
  const pessoas = (await relacoes(idDe(a), 'ASSET', 'AccessibleBy')).filter(r => r.to.entityType === 'USER').map(r => usuarioPorId.get(r.to.id)).filter(Boolean)
  if (!unidade) { avisar(`localidade "${a.name}" sem unidade identificável; ignorada`); continue }
  localidades.push({ asset: a, unidade, sensores: contem, pessoas })
}
const localidadeDoSensor = new Map()
for (const l of localidades) for (const d of l.sensores) {
  if (localidadeDoSensor.has(idDe(d))) avisar(`sensor "${d.name}" está em duas localidades; fica na primeira (${localidadeDoSensor.get(idDe(d)).asset.name})`)
  else localidadeDoSensor.set(idDe(d), l)
}
const acessosPorSensor = []
for (const d of dispositivos) {
  for (const r of await relacoes(idDe(d), 'DEVICE', 'AccessibleBy')) {
    const u = usuarioPorId.get(r.to.id)
    if (u) acessosPorSensor.push({ sensor: d, pessoa: u })
  }
}
for (const d of dispositivos) if (!localidadeDoSensor.has(idDe(d))) avisar(`sensor "${d.name}" não pertence a nenhuma localidade; continua no tenant, sem acesso de pesquisadores`)

// Grupos de dispositivos que cada Edge recebe hoje: a troca de dono tira os sensores deles
const edgeDosSensores = new Map()
for (const e of edges) {
  for (const g of lista(await must('GET', `/api/allEntityGroups/edge/${idDe(e)}/DEVICE`))) {
    for (const d of lista(await must('GET', `/api/entityGroup/${idDe(g)}/entities${page}`))) {
      const id = d.id ? idDe(d) : d.entityId?.id
      if (id) edgeDosSensores.set(id, [...(edgeDosSensores.get(id) || []), e])
    }
  }
}

console.log(`\nCentral ${BASE}: ${unidades.length} unidades, ${localidades.length} localidades, ${dispositivos.length} sensores, ${usuarios.length} usuários, ${edges.length} Edge(s)`)
console.log(APLICAR ? 'MODO APLICAR: as mudanças serão gravadas.\n' : 'MODO SIMULAÇÃO: nada será gravado.\n')

// =====================================================================
// 2. Funções idempotentes
// =====================================================================
const papeisExistentes = lista(await must('GET', '/api/roles' + page))
const garantirPapel = async chave => {
  const p = PAPEIS[chave]
  const existente = papeisExistentes.find(r => r.name === p.name && r.type === p.type && (!r.ownerId || r.ownerId.entityType === 'TENANT'))
  if (existente) {
    const igual = JSON.stringify(existente.permissions) === JSON.stringify(p.permissions)
    if (igual) return existente
    return fazer('papel', `atualizar permissões de "${p.name}"`, () => must('POST', '/api/role', { ...existente, permissions: p.permissions }))
  }
  return fazer('papel', `criar papel ${p.type === 'GROUP' ? 'de grupo' : 'genérico'} "${p.name}"`, () => must('POST', '/api/role', p))
}

const gruposCache = new Map()
const gruposDoDono = async (dono, tipo) => {
  const k = `${dono.entityType}/${dono.id}/${tipo}`
  if (!gruposCache.has(k)) {
    gruposCache.set(k, dono.id.startsWith('simulado-') ? [] : lista(await must('GET', `/api/entityGroups/${dono.entityType}/${dono.id}/${tipo}${page}`)))
  }
  return gruposCache.get(k)
}
const nomeDono = dono => dono.entityType === 'TENANT' ? 'tenant' : unidadePorId.get(dono.id)?.title || dono.id
const garantirGrupo = async (dono, tipo, nome) => {
  const existentes = await gruposDoDono(dono, tipo)
  const g = existentes.find(x => x.name === nome)
  if (g) return g
  const novo = await fazer('grupo', `criar grupo ${tipo === 'USER' ? 'de usuários' : 'de sensores'} "${nome}" (dono: ${nomeDono(dono)})`,
    () => must('POST', '/api/entityGroup', { name: nome, type: tipo, ownerId: dono }))
  existentes.push({ ...novo, name: nome })
  return novo
}

const membrosCache = new Map()
const membros = async grupo => {
  if (simulado(grupo)) return new Set()
  if (!membrosCache.has(idDe(grupo))) {
    const itens = lista(await must('GET', `/api/entityGroup/${idDe(grupo)}/entities${page}`))
    membrosCache.set(idDe(grupo), new Set(itens.map(x => x.id ? idDe(x) : x.entityId?.id)))
  }
  return membrosCache.get(idDe(grupo))
}
const garantirMembro = async (grupo, entidade, rotulo, nomeGrupo, unidade) => {
  const atuais = await membros(grupo)
  if (atuais.has(idDe(entidade))) return
  await fazer('membro', `colocar ${rotulo} em "${nomeGrupo}"${unidade ? ` (${unidade})` : ''}`, () => must('POST', `/api/entityGroup/${idDe(grupo)}/addEntities`, [idDe(entidade)]))
  atuais.add(idDe(entidade))
}

const permissoesCache = new Map()
const garantirPermissao = async (grupoUsuarios, papel, grupoEntidades, descricao) => {
  let atuais = []
  if (!simulado(grupoUsuarios)) {
    if (!permissoesCache.has(idDe(grupoUsuarios))) permissoesCache.set(idDe(grupoUsuarios), lista(await must('GET', `/api/userGroup/${idDe(grupoUsuarios)}/groupPermissions`)))
    atuais = permissoesCache.get(idDe(grupoUsuarios))
  }
  const ja = atuais.find(p => p.roleId?.id === idDe(papel) && (grupoEntidades ? p.entityGroupId?.id === idDe(grupoEntidades) : !p.entityGroupId || p.entityGroupId.id === '13814000-1dd2-11b2-8080-808080808080'))
  if (ja) return
  const corpo = { roleId: papel.id, userGroupId: grupoUsuarios.id }
  if (grupoEntidades) Object.assign(corpo, { entityGroupId: grupoEntidades.id, entityGroupType: 'DEVICE' })
  await fazer('permissão', descricao, () => must('POST', '/api/groupPermission', corpo))
}

// =====================================================================
// 3. Plano
// =====================================================================
const tenant = { entityType: 'TENANT', id: tenantId.id }
const dono = c => ({ entityType: 'CUSTOMER', id: idDe(c) })

const papel = {
  responsavel: await garantirPapel('responsavel'),
  membro: await garantirPapel('membro'),
  gestor: await garantirPapel('gestor')
}

// Gestores: grupo próprio em cada unidade, com papel genérico (escopo = a unidade)
for (const u of unidades) {
  const g = await garantirGrupo(dono(u), 'USER', 'Gestores')
  await garantirPermissao(g, papel.gestor, null, `"Gestores" de ${u.title} recebe o papel genérico "Gestor da unidade"`)
}

// Localidades
const grupoLoc = new Map()
for (const l of localidades) {
  const nomeLoc = `LOC · ${l.asset.name}`
  const loc = await garantirGrupo(dono(l.unidade), 'DEVICE', nomeLoc)
  grupoLoc.set(idDe(l.asset), loc)

  for (const d of l.sensores) {
    const atual = donoDe(d)
    if (!atual || idDe(atual) !== idDe(l.unidade)) {
      await fazer('dono', `passar "${d.name}" do ${atual ? atual.title : 'tenant'} para ${l.unidade.title} (sai dos grupos do dono antigo)`,
        () => must('POST', `/api/owner/CUSTOMER/${idDe(l.unidade)}/DEVICE/${idDe(d)}`))
    }
    await garantirMembro(loc, d, `"${d.name}"`, nomeLoc)
  }

  const equipe = await garantirGrupo(dono(l.unidade), 'USER', `${l.asset.name} · Equipe`)
  await garantirPermissao(equipe, papel.membro, loc, `"${l.asset.name} · Equipe" vê "${nomeLoc}" (Membro)`)
  const resp = await garantirGrupo(tenant, 'USER', `${l.asset.name} · Responsáveis`)
  await garantirPermissao(resp, papel.responsavel, loc, `"${l.asset.name} · Responsáveis" administra "${nomeLoc}" e cria regras (Responsável)`)

  for (const p of l.pessoas) {
    const unidadePessoa = unidadeDoUsuario(p)
    if (!unidadePessoa) { avisar(`${p.email} tem acesso a "${l.asset.name}", mas não é usuário de unidade; ignorado`); continue }
    if (idDe(unidadePessoa) === idDe(l.unidade)) {
      await garantirMembro(equipe, p, p.email, `${l.asset.name} · Equipe`)
    } else {
      // Colaboração: grupo na unidade da pessoa, com permissão sobre o grupo da outra unidade
      const nome = `${l.asset.name} · Colaboradores`
      const colab = await garantirGrupo(dono(unidadePessoa), 'USER', nome)
      await garantirPermissao(colab, papel.membro, loc, `"${nome}" (${unidadePessoa.title}) vê "${nomeLoc}" (${l.unidade.title})`)
      await garantirMembro(colab, p, p.email, nome, unidadePessoa.title)
    }
  }

  // Edge: quem recebia algum sensor da localidade passa a receber o grupo da localidade
  const edgesDaLoc = new Map()
  for (const d of l.sensores) for (const e of edgeDosSensores.get(idDe(d)) || []) edgesDaLoc.set(idDe(e), e)
  for (const e of edgesDaLoc.values()) {
    const atribuidos = simulado(loc) ? [] : lista(await must('GET', `/api/allEntityGroups/edge/${idDe(e)}/DEVICE`))
    if (atribuidos.some(g => idDe(g) === idDe(loc))) continue
    const extras = l.sensores.filter(d => !(edgeDosSensores.get(idDe(d)) || []).some(x => idDe(x) === idDe(e)))
    await fazer('edge', `atribuir "${nomeLoc}" ao ${e.name}${extras.length ? ` (passa a receber também ${extras.map(d => d.name).join(', ')})` : ''}`,
      () => must('POST', `/api/edge/${idDe(e)}/entityGroup/${idDe(loc)}/DEVICE`))
  }
}

// Acesso a um único sensor: grupo só com ele, para não ampliar o acesso à localidade inteira
for (const { sensor, pessoa } of acessosPorSensor) {
  const l = localidadeDoSensor.get(idDe(sensor))
  const unidadePessoa = unidadeDoUsuario(pessoa)
  if (!l) { avisar(`${pessoa.email} tem acesso a "${sensor.name}", que não está em localidade; ignorado`); continue }
  if (!unidadePessoa) { avisar(`${pessoa.email} não é usuário de unidade; acesso a "${sensor.name}" ignorado`); continue }
  if (l.pessoas.some(p => idDe(p) === idDe(pessoa))) continue // já vê a localidade inteira
  const nomeDisp = `DISP · ${sensor.name}`
  const disp = await garantirGrupo(dono(l.unidade), 'DEVICE', nomeDisp)
  await garantirMembro(disp, sensor, `"${sensor.name}"`, nomeDisp)
  const nome = `${nomeDisp} · Equipe`
  const g = await garantirGrupo(dono(unidadePessoa), 'USER', nome)
  await garantirPermissao(g, papel.membro, disp, `"${nome}" (${unidadePessoa.title}) vê só "${sensor.name}" (Membro)`)
  await garantirMembro(g, pessoa, pessoa.email, nome, unidadePessoa.title)
}

// Grupos padrão vazios: "Customer Users" dá a unidade inteira, com token e comando
for (const u of unidades) {
  for (const g of (await gruposDoDono(dono(u), 'USER')).filter(g => ['Customer Users', 'Customer Administrators'].includes(g.name))) {
    const ids = [...await membros(g)]
    if (!ids.length) continue
    const emails = ids.map(id => usuarioPorId.get(id)?.email || id)
    await fazer('padrão', `tirar de "${g.name}" (${u.title}): ${emails.join(', ')}`,
      () => must('POST', `/api/entityGroup/${idDe(g)}/deleteEntities`, ids))
  }
}

// Quem fica sem nenhum acesso depois da migração
const comAcesso = new Set([...localidades.flatMap(l => l.pessoas), ...acessosPorSensor.map(a => a.pessoa)].map(idDe))
for (const u of usuarios.filter(u => u.authority === 'CUSTOMER_USER' && !comAcesso.has(idDe(u)))) {
  avisar(`${u.email} (${unidadeDoUsuario(u)?.title}) não tem localidade no Embrapa I/O: deixa de ver a unidade inteira e fica sem sensores`)
}

// =====================================================================
// 4. Resumo
// =====================================================================
const porPasso = feitos.reduce((a, f) => (a[f.passo] = (a[f.passo] || 0) + 1, a), {})
console.log(`\n${APLICAR ? 'Aplicado' : 'Simulado'}: ${feitos.length} mudanças ${JSON.stringify(porPasso)}; ${avisos.length} avisos.`)
console.log('Não mexe em: assets, relações AccessibleBy, grupos "<Unidade> Devices/Assets", Responsáveis (nenhum é conhecido) e contas de serviço.')
if (!APLICAR && feitos.length) console.log('Para gravar: faça o backup do banco e rode com --aplicar.')
