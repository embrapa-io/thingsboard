// Instala na Central o modelo de acesso por laboratório. Só ACRESCENTA: não altera nem
// remove papéis, grupos ou usuários existentes (a migração dos laboratórios atuais é outro script).
//
//   papéis: Laboratório · Leitura, Laboratório · Edição, Interface,
//           Unidade · Leitura, Unidade · Criação de laboratórios, Serviço · Laboratórios
//   conta de serviço (usuário do tenant com papel mínimo) e a chave de API dela
//   perfil de asset "Laboratório" com a rule chain "Embrapa · Criar laboratório"
//
// Sem argumentos só SIMULA. Com --aplicar, grava. Pode rodar de novo: reaproveita o que existe,
// atualiza as permissões dos papéis e regrava a rule chain.
//
//   node instalar.mjs [--aplicar]
import crypto from 'node:crypto'
import { T, call, must, page, list, msg, NOMES, PAPEIS } from './lib.mjs'
import { montarRegra } from './regra-laboratorio.mjs'

const APLICAR = process.argv.includes('--aplicar')
const passo = (txt) => console.log(`${APLICAR ? '→' : '[simulação]'} ${txt}`)
const porNome = (itens, nome, campo = 'name') => itens.find(x => x[campo] === nome)

const quem = must(await T('GET', '/api/auth/user'), 'auth')
if (quem.authority !== 'TENANT_ADMIN') throw new Error('a chave precisa ser de administrador do tenant')

// --- papéis
const papeis = {}
const existentes = list(await T('GET', `/api/roles${page}`))
for (const [chave, def] of Object.entries(PAPEIS)) {
  const atual = porNome(existentes, def.name)
  const igual = atual && atual.type === def.type && JSON.stringify(atual.permissions) === JSON.stringify(def.permissions)
  if (igual) { papeis[chave] = atual.id.id; continue }
  passo(`${atual ? 'atualizar' : 'criar'} papel "${def.name}"`)
  if (APLICAR) papeis[chave] = must(await T('POST', '/api/role', atual ? { ...atual, permissions: def.permissions } : def), def.name).id.id
  else papeis[chave] = atual ? atual.id.id : `simulado-${chave}`
}

// --- conta de serviço
const gruposTenant = list(await T('GET', `/api/entityGroups/USER${page}`))
let grupoServico = porNome(gruposTenant, NOMES.grupoServico)
if (!grupoServico) {
  passo(`criar grupo de usuários do tenant "${NOMES.grupoServico}"`)
  if (APLICAR) grupoServico = must(await T('POST', '/api/entityGroup', { name: NOMES.grupoServico, type: 'USER' }), 'grupo serviço')
}
if (grupoServico) {
  const perms = APLICAR || !String(grupoServico.id.id).startsWith('simulado') ? list(await T('GET', `/api/userGroup/${grupoServico.id.id}/groupPermissions`)) : []
  if (!perms.some(p => p.roleId && p.roleId.id === papeis.servico)) {
    passo(`dar o papel "${NOMES.servico}" ao grupo da conta de serviço`)
    if (APLICAR) must(await T('POST', '/api/groupPermission', { roleId: { entityType: 'ROLE', id: papeis.servico }, userGroupId: grupoServico.id }), 'permissão serviço')
  }
}
let conta = list(await T('GET', `/api/user/users${page}&textSearch=${encodeURIComponent(NOMES.contaServico)}`)).find(u => u.email === NOMES.contaServico)
if (!conta) {
  passo(`criar a conta de serviço ${NOMES.contaServico}`)
  if (APLICAR) {
    conta = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${grupoServico.id.id}`,
      { email: NOMES.contaServico, authority: 'TENANT_ADMIN', firstName: 'Serviço', lastName: 'Laboratórios',
        additionalInfo: { description: 'Usada pela rule chain "Embrapa · Criar laboratório". Não é de uma pessoa.' } }), 'conta de serviço')
    // ativa com uma senha aleatória que ninguém conhece; o acesso é só pela chave de API
    const link = await T('GET', `/api/user/${conta.id.id}/activationLink`)
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null,
      { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: crypto.randomBytes(24).toString('base64url') + 'aA1!' }), 'ativar conta de serviço')
  }
}
// --- perfil de asset e rule chain
const componentes = async (tipo) => (await T('GET', `/api/components/${tipo}?ruleChainType=CORE`)).json || []
const def = (lista, classe) => lista.find(c => c.clazz.endsWith(classe)).configurationDescriptor.nodeDefinition.defaultConfiguration
const defaults = {
  rest: def(await componentes('EXTERNAL'), 'TbRestApiCallNode'),
  salvar: def(await componentes('ACTION'), 'TbMsgAttributesNode'),
  ler: def(await componentes('ENRICHMENT'), 'TbGetAttributesNode'),
  raiz: def(await componentes('FLOW'), 'TbRuleChainInputNode')
}
const cadeias = list(await T('GET', `/api/ruleChains${page}&type=CORE`))
const raizId = cadeias.find(c => c.root).id.id
let regra = porNome(cadeias, NOMES.regra)
if (!regra) {
  passo(`criar a rule chain "${NOMES.regra}"`)
  if (APLICAR) regra = must(await T('POST', '/api/ruleChain', { name: NOMES.regra, type: 'CORE', debugMode: false }), 'rule chain')
}
// Chave de API da conta de serviço. O Secrets storage desta instalação não tem chave de
// criptografia ("Encryption failed"), então a chave vai no cabeçalho dos nós REST, visível só
// para quem lê rule chains (admins do tenant). Reaproveita a que já está na regra; se não houver,
// revoga as chaves antigas da conta e gera uma nova.
let chave = null
if (regra && regra.id) {
  const atual = (await T('GET', `/api/ruleChain/${regra.id.id}/metadata`)).json
  const no = atual && (atual.nodes || []).find(n => n.type.endsWith('TbRestApiCallNode'))
  chave = no && no.configuration.headers && no.configuration.headers['X-Authorization']
  if (chave && !chave.startsWith('ApiKey ')) chave = null
}
if (!chave) {
  passo('gerar a chave de API da conta de serviço (revogando as anteriores)')
  if (APLICAR) {
    for (const k of list(await T('GET', `/api/apiKeys/${conta.id.id}${page}`))) await T('DELETE', `/api/apiKey/${k.id.id}`)
    const r = must(await T('POST', '/api/apiKey', { userId: conta.id, description: 'Rule chain Embrapa · Criar laboratório', enabled: true }), 'chave de API')
    const valor = typeof r === 'string' ? r : (r.value || r.token || r.apiKey)
    if (!valor) throw new Error('a resposta de /api/apiKey não trouxe o valor da chave')
    chave = valor.startsWith('ApiKey ') ? valor : 'ApiKey ' + valor
  } else chave = 'ApiKey (simulada)'
}
const metadata = montarRegra({ papeis, defaults, raizId, chave })
passo(`gravar os ${metadata.nodes.length} nós da rule chain`)
if (APLICAR) must(await T('POST', '/api/ruleChain/metadata', { ruleChainId: regra.id, ...metadata }), 'nós da rule chain')

const perfisExistentes = list(await T('GET', `/api/assetProfileInfos${page}`))
const regraId = regra && regra.id ? regra.id.id : null
for (const nome of NOMES.perfis) {
  let perfil = porNome(perfisExistentes, nome)
  if (perfil) perfil = must(await T('GET', `/api/assetProfile/${perfil.id.id}`), 'perfil')
  if (perfil && perfil.defaultRuleChainId && perfil.defaultRuleChainId.id !== regraId) {
    console.log(`⚠️  o perfil "${nome}" já usa outra rule chain; não foi alterado`)
    continue
  }
  if (perfil && perfil.defaultRuleChainId) continue
  passo(`${perfil ? 'ligar' : 'criar'} o perfil de asset "${nome}" à rule chain`)
  if (APLICAR) must(await T('POST', '/api/assetProfile', { ...(perfil || { name: nome, description: 'Laboratório de uma unidade. Ao criar, a regra cria os grupos e as permissões.' }),
    defaultRuleChainId: regra.id }), 'perfil de asset ' + nome)
}

console.log(APLICAR ? '\nInstalação concluída.' : '\nSimulação concluída. Rode com --aplicar para gravar.')
console.log(JSON.stringify({ papeis }, null, 1))
