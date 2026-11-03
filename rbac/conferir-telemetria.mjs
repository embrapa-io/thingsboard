// Confere a chave do telemetry-gateway (TB_TELEMETRY_TOKEN): lê dispositivos e telemetria de
// todas as unidades e recebe 403 no resto. Nunca imprime chaves.
//
//   node conferir-telemetria.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T, call, list, TELEMETRIA } from './lib.mjs'

const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8')
const chave = 'ApiKey ' + (env.match(/^TB_TELEMETRY_TOKEN=(.*)$/m) || [, ''])[1].trim().replace(/^"|"$/g, '')
const S = (method, path, body) => call(method, path, chave, body)

const quem = (await S('GET', '/api/auth/user')).json
console.log('conta:', quem && quem.email, quem && quem.email === TELEMETRIA.conta ? 'ok' : 'ERRADA')

// um dispositivo de cada unidade, achado com a chave do tenant
const unidades = list(await T('GET', '/api/customers?pageSize=100&page=0'))
let falhas = 0
const espera = (rot, r, esperado) => {
  const ok = esperado === 200 ? r.status === 200 : r.status === 403 || r.status === 401
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${r.status} ${rot}`)
}
for (const u of unidades) {
  const d = list(await T('GET', `/api/customer/${u.id.id}/devices?pageSize=1&page=0`))[0]
  if (!d) continue
  espera(`telemetria · ${u.title}`, await S('GET', `/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries`), 200)
  espera(`credencial MQTT · ${u.title}`, await S('GET', `/api/device/${d.id.id}/credentials`), 403)
  espera(`gravar telemetria · ${u.title}`, await S('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/timeseries/ANY`, { teste: 1 }), 403)
  espera(`RPC · ${u.title}`, await S('POST', `/api/rpc/oneway/${d.id.id}`, { method: 'x', params: {} }), 403)
}
// a lista de usuários responde 200, mas vazia: a conta não lê usuários
const usuarios = await S('GET', '/api/user/users?pageSize=100&page=0')
espera('usuários (lista vazia)', usuarios.status === 200 && list(usuarios).length === 0 ? { status: 403 } : usuarios, 403)
espera('rule chains', await S('GET', '/api/ruleChains?pageSize=1&page=0'), 403)
espera('papéis', await S('GET', '/api/roles?pageSize=1&page=0'), 403)
console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo conforme.')
process.exit(falhas ? 1 : 0)
