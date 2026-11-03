// Cria a conta de serviço do telemetry-gateway e troca TB_TELEMETRY_TOKEN no thingsboard/.env
// pela chave de API dela. A conta é um usuário do tenant com um único papel: ler dispositivos
// e telemetria (Serviço · Telemetria). Nunca imprime chaves.
//
// Sem argumentos só SIMULA. Com --aplicar, grava. Pode rodar de novo: se a chave do .env já é
// desta conta, não muda nada.
//
//   node servico-telemetria.mjs [--aplicar]
//
// Depois de aplicar, recrie o contêiner: docker compose up -d telemetry-gateway
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T, call, must, page, list, TELEMETRIA } from './lib.mjs'

const APLICAR = process.argv.includes('--aplicar')
const passo = (txt) => console.log(`${APLICAR ? '→' : '[simulação]'} ${txt}`)
const porNome = (itens, nome, campo = 'name') => itens.find(x => x[campo] === nome)
const ENV_TB = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')

const quem = must(await T('GET', '/api/auth/user'), 'auth')
if (quem.authority !== 'TENANT_ADMIN') throw new Error('a chave precisa ser de administrador do tenant')

// --- papel
const def = TELEMETRIA.papel
let papel = porNome(list(await T('GET', `/api/roles${page}`)), def.name)
if (!papel || JSON.stringify(papel.permissions) !== JSON.stringify(def.permissions)) {
  passo(`${papel ? 'atualizar' : 'criar'} papel "${def.name}"`)
  if (APLICAR) papel = must(await T('POST', '/api/role', papel ? { ...papel, permissions: def.permissions } : def), def.name)
}

// --- grupo do tenant com o papel
let grupo = porNome(list(await T('GET', `/api/entityGroups/USER${page}`)), TELEMETRIA.grupo)
if (!grupo) {
  passo(`criar grupo de usuários do tenant "${TELEMETRIA.grupo}"`)
  if (APLICAR) grupo = must(await T('POST', '/api/entityGroup', { name: TELEMETRIA.grupo, type: 'USER' }), 'grupo')
}
if (grupo && papel) {
  const perms = list(await T('GET', `/api/userGroup/${grupo.id.id}/groupPermissions`))
  if (!perms.some(p => p.roleId && p.roleId.id === papel.id.id)) {
    passo(`dar o papel "${def.name}" ao grupo`)
    if (APLICAR) must(await T('POST', '/api/groupPermission', { roleId: papel.id, userGroupId: grupo.id }), 'permissão')
  }
}

// --- conta
let conta = list(await T('GET', `/api/user/users${page}&textSearch=${encodeURIComponent(TELEMETRIA.conta)}`)).find(u => u.email === TELEMETRIA.conta)
if (!conta) {
  passo(`criar a conta de serviço ${TELEMETRIA.conta}`)
  if (APLICAR) {
    conta = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${grupo.id.id}`,
      { email: TELEMETRIA.conta, authority: 'TENANT_ADMIN', firstName: 'Serviço', lastName: 'Telemetria',
        additionalInfo: { description: 'Usada pelo telemetry-gateway para ler telemetria. Não é de uma pessoa.' } }), 'conta de serviço')
    // ativa com uma senha aleatória que ninguém conhece; o acesso é só pela chave de API
    const link = await T('GET', `/api/user/${conta.id.id}/activationLink`)
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null,
      { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: crypto.randomBytes(24).toString('base64url') + 'aA1!' }), 'ativar conta de serviço')
  }
}

// --- chave no .env do ThingsBoard
const env = readFileSync(ENV_TB, 'utf8')
const linha = env.match(/^TB_TELEMETRY_TOKEN=(.*)$/m)
const atual = linha ? linha[1].trim().replace(/^"|"$/g, '') : ''
const dono = atual ? (await call('GET', '/api/auth/user', 'ApiKey ' + atual)).json : null
if (dono && dono.email === TELEMETRIA.conta) {
  console.log('TB_TELEMETRY_TOKEN já é a chave da conta de serviço.')
} else {
  passo(`gerar a chave de API da conta (revogando as anteriores) e gravar em TB_TELEMETRY_TOKEN; hoje ela é de ${dono ? dono.authority : 'ninguém'}`)
  if (APLICAR) {
    for (const k of list(await T('GET', `/api/apiKeys/${conta.id.id}${page}`))) await T('DELETE', `/api/apiKey/${k.id.id}`)
    const r = must(await T('POST', '/api/apiKey', { userId: conta.id, description: 'telemetry-gateway', enabled: true }), 'chave de API')
    const valor = String(typeof r === 'string' ? r : (r.value || r.token || r.apiKey || '')).replace(/^ApiKey /, '')
    if (!valor) throw new Error('a resposta de /api/apiKey não trouxe o valor da chave')
    const teste = (await call('GET', '/api/auth/user', 'ApiKey ' + valor)).json
    if (!teste || teste.email !== TELEMETRIA.conta) throw new Error('a chave nova não autenticou como a conta de serviço')
    writeFileSync(ENV_TB, linha ? env.replace(/^TB_TELEMETRY_TOKEN=.*$/m, 'TB_TELEMETRY_TOKEN=' + valor) : env.replace(/\n?$/, '\nTB_TELEMETRY_TOKEN=' + valor + '\n'))
    console.log('TB_TELEMETRY_TOKEN atualizado. Recrie o contêiner: docker compose up -d telemetry-gateway')
  }
}

console.log(APLICAR ? '\nConcluído.' : '\nSimulação concluída. Rode com --aplicar para gravar.')
