// Torna pessoas Responsáveis por localidades na Central de desenvolvimento.
// O Responsável precisa ser usuário do tenant (só essa autoridade cria regras),
// então uma conta de unidade é recriada com o mesmo e-mail. O script preserva:
//   - os acessos de leitura que a pessoa já tinha (Equipe, Colaboradores, DISP ·),
//     em grupos equivalentes do tenant;
//   - as relações AccessibleBy, refeitas para o id novo, mais as das localidades
//     em que ela passa a ser Responsável (o backend do Embrapa I/O calcula o escopo por elas).
// Sem --aplicar, só simula. Pode rodar de novo.
//
//   node 12-definir-responsaveis.mjs "email=Localidade A|Localidade B" "email2=unidade:Embrapa X" [--aplicar]
//
// Localidade = nome do asset (o grupo é `LOC · <nome>`); `unidade:<título>` = todas as localidades da unidade.
// Credencial: THINGSBOARD_TOKEN do backend/.env; nunca é impressa. A senha da conta nova
// é definida pelo link de ativação (Usuários → conta → "Display activation link").
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APLICAR = process.argv.includes('--aplicar')
const PEDIDOS = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => {
  const [email, alvo] = a.split('=')
  return { email: email.trim().toLowerCase(), alvos: (alvo || '').split('|').map(s => s.trim()).filter(Boolean) }
})
if (!PEDIDOS.length || PEDIDOS.some(p => !p.alvos.length)) {
  console.error('uso: node 12-definir-responsaveis.mjs "email=Localidade|..." "email=unidade:Título" [--aplicar]')
  process.exit(2)
}
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
const idDe = x => x.id.id
let seq = 0
const fazer = async (descricao, fn) => {
  console.log(`${APLICAR ? '→' : '[simulação]'} ${descricao}`)
  if (APLICAR) return fn()
  return { id: { id: `simulado-${++seq}`, entityType: 'USER' } }
}

// --- estado atual
const quem = await must('GET', '/api/auth/user')
const tenant = { entityType: 'TENANT', id: quem.tenantId.id }
const unidades = lista(await must('GET', '/api/customers' + page)).filter(c => c.title !== 'Public')
const assets = lista(await must('GET', '/api/assetInfos/all' + page + '&includeCustomers=true'))
const papeis = lista(await must('GET', '/api/roles' + page))
const papel = nome => papeis.find(r => r.name === nome) || (() => { throw new Error(`papel "${nome}" não existe; rode o 11 antes`) })()
const membro = papel('Membro da localidade')

const unidadeDoAsset = a => {
  const n = (a.groups || []).map(g => g.name).find(n => n.endsWith(' Assets'))
  return n ? unidades.find(u => u.title === n.slice(0, -' Assets'.length)) : null
}
const gruposDoDono = async (dono, tipo) => lista(await must('GET', `/api/entityGroups/${dono.entityType}/${dono.id}/${tipo}${page}`))
const gruposTenantUser = await gruposDoDono(tenant, 'USER')
const gruposDeSensores = new Map()
for (const u of unidades) for (const g of await gruposDoDono({ entityType: 'CUSTOMER', id: idDe(u) }, 'DEVICE')) gruposDeSensores.set(idDe(g), g)

const localidadesDe = alvo => {
  if (alvo.startsWith('unidade:')) {
    const titulo = alvo.slice('unidade:'.length).trim()
    const achadas = assets.filter(a => unidadeDoAsset(a)?.title === titulo)
    if (!achadas.length) throw new Error(`unidade "${titulo}" sem localidades`)
    return achadas
  }
  const a = assets.find(a => a.name === alvo) || assets.filter(a => a.name.includes(alvo)).reduce((x, y, i, arr) => arr.length === 1 ? y : x, null)
  if (!a) throw new Error(`localidade "${alvo}" não encontrada (ou ambígua)`)
  return [a]
}

const garantirGrupoTenant = async nome => {
  const g = gruposTenantUser.find(x => x.name === nome)
  if (g) return g
  const novo = await fazer(`criar grupo de usuários do tenant "${nome}"`, () => must('POST', '/api/entityGroup', { name: nome, type: 'USER', ownerId: tenant }))
  gruposTenantUser.push({ ...novo, name: nome })
  return { ...novo, name: nome }
}
const garantirPermissao = async (grupo, papelX, grupoSensores, descricao) => {
  const atuais = String(idDe(grupo)).startsWith('simulado-') ? [] : lista(await must('GET', `/api/userGroup/${idDe(grupo)}/groupPermissions`))
  if (atuais.some(p => p.roleId.id === idDe(papelX) && p.entityGroupId?.id === idDe(grupoSensores))) return
  await fazer(descricao, () => must('POST', '/api/groupPermission', { roleId: papelX.id, userGroupId: grupo.id, entityGroupId: grupoSensores.id, entityGroupType: 'DEVICE' }))
}

for (const pedido of PEDIDOS) {
  console.log(`\n=== ${pedido.email}`)
  const usuario = lista(await must('GET', `/api/user/users${page}&textSearch=${encodeURIComponent(pedido.email)}`)).find(u => u.email.toLowerCase() === pedido.email)
  if (!usuario) throw new Error(`${pedido.email} não existe na Central`)
  const locs = pedido.alvos.flatMap(localidadesDe)
  const idsLocs = new Set(locs.map(idDe))

  // Grupos de destino: Responsáveis das localidades pedidas
  const destino = []
  for (const a of locs) {
    const g = gruposTenantUser.find(x => x.name === `${a.name} · Responsáveis`)
    if (!g) throw new Error(`grupo "${a.name} · Responsáveis" não existe; rode o 11 antes`)
    destino.push({ grupo: g, rotulo: `Responsável por "${a.name}"` })
  }

  // Leituras que a pessoa já tinha, fora das localidades em que vira Responsável
  const relacoes = lista(await must('GET', `/api/relations?toId=${idDe(usuario)}&toType=USER&relationType=AccessibleBy&relationTypeGroup=COMMON`))
  if (usuario.authority === 'CUSTOMER_USER') {
    const dono = { entityType: 'CUSTOMER', id: usuario.customerId.id }
    for (const g of (await gruposDoDono(dono, 'USER')).filter(g => !g.groupAll)) {
      const membros = lista(await must('GET', `/api/entityGroup/${idDe(g)}/users${page}`))
      if (!membros.some(m => idDe(m) === idDe(usuario))) continue
      for (const p of lista(await must('GET', `/api/userGroup/${idDe(g)}/groupPermissions`))) {
        const sensores = p.entityGroupId && gruposDeSensores.get(p.entityGroupId.id)
        if (!sensores) continue
        const loc = assets.find(a => sensores.name === `LOC · ${a.name}`)
        if (loc && idsLocs.has(idDe(loc))) continue // o papel de Responsável já cobre
        const nome = loc ? `${loc.name} · Colaboradores` : `${sensores.name} · Equipe`
        const gt = await garantirGrupoTenant(nome)
        await garantirPermissao(gt, membro, sensores, `"${nome}" (tenant) vê "${sensores.name}" (Membro)`)
        destino.push({ grupo: gt, rotulo: `mantém leitura de "${sensores.name}"` })
      }
    }
  }

  // Conta: recriar como usuário do tenant, se ainda for de unidade
  let conta = usuario
  if (usuario.authority === 'CUSTOMER_USER') {
    const unidade = unidades.find(u => idDe(u) === usuario.customerId.id)?.title
    // Atributos de servidor somem com a conta; o auth-gateway, por exemplo, exige `manager`
    const atributos = lista(await must('GET', `/api/plugins/telemetry/USER/${idDe(usuario)}/values/attributes/SERVER_SCOPE`))
    await fazer(`apagar a conta de unidade (${unidade}) de ${usuario.email}`, () => must('DELETE', `/api/user/${idDe(usuario)}`))
    conta = await fazer(`recriar ${usuario.email} como usuário do tenant (TENANT_ADMIN), em "${destino[0].grupo.name}"`, () => must('POST',
      `/api/user?sendActivationMail=false&entityGroupId=${idDe(destino[0].grupo)}`, {
        email: usuario.email, firstName: usuario.firstName, lastName: usuario.lastName, authority: 'TENANT_ADMIN',
        additionalInfo: { ...(usuario.additionalInfo || {}), unidadeOrigem: unidade }
      }))
    if (atributos.length) {
      await fazer(`copiar atributos de servidor da conta antiga: ${atributos.map(a => a.key).join(', ')}`, () => must('POST',
        `/api/plugins/telemetry/USER/${idDe(conta)}/SERVER_SCOPE`, Object.fromEntries(atributos.map(a => [a.key, a.value]))))
    }
  } else if (usuario.authority !== 'TENANT_ADMIN') {
    throw new Error(`${usuario.email}: autoridade ${usuario.authority} não suportada`)
  }

  // Grupos
  const jaEm = new Set()
  if (!String(idDe(conta)).startsWith('simulado-') && conta === usuario) {
    for (const g of gruposTenantUser) {
      if (String(idDe(g)).startsWith('simulado-')) continue
      if (lista(await must('GET', `/api/entityGroup/${idDe(g)}/users${page}`)).some(m => idDe(m) === idDe(conta))) jaEm.add(idDe(g))
    }
  } else if (destino[0]) jaEm.add(idDe(destino[0].grupo))
  for (const { grupo, rotulo } of destino) {
    if (jaEm.has(idDe(grupo))) continue
    await fazer(`colocar em "${grupo.name}" (${rotulo})`, () => must('POST', `/api/entityGroup/${idDe(grupo)}/addEntities`, [idDe(conta)]))
    jaEm.add(idDe(grupo))
  }

  // Relações AccessibleBy usadas pelo backend: as antigas, refeitas, e as das novas localidades
  const origens = new Map(relacoes.map(r => [r.from.id, r.from]))
  for (const a of locs) origens.set(idDe(a), a.id)
  const atuais = conta === usuario ? new Set(relacoes.map(r => r.from.id)) : new Set()
  for (const [id, from] of origens) {
    if (atuais.has(id)) continue
    const nome = assets.find(a => idDe(a) === id)?.name || `${from.entityType} ${id}`
    await fazer(`relação AccessibleBy: "${nome}" → ${usuario.email}`, () => must('POST', '/api/relation',
      { from, to: { entityType: 'USER', id: idDe(conta) }, type: 'AccessibleBy', typeGroup: 'COMMON' }))
  }
}
console.log(APLICAR ? '\nAplicado. A senha das contas recriadas é definida pelo link de ativação.' : '\nSimulação: nada foi gravado. Para gravar, rode com --aplicar.')
