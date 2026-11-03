// Utilitários do modelo de acesso (RBAC) da Central. Usa a chave de API do tenant do
// backend/.env (THINGSBOARD_TOKEN) e nunca a imprime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env')
export const ENV = Object.fromEntries(readFileSync(BACKEND_ENV, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
export const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
// Endereço da API visto de dentro do contêiner do ThingsBoard (usado pelos nós REST da regra)
export const BASE_INTERNA = process.env.TB_INTERNAL_URL || 'http://localhost:8080'

export const call = async (method, path, auth, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Authorization': auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
export const T = (method, path, body) => call(method, path, 'ApiKey ' + ENV.THINGSBOARD_TOKEN, body)
export const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
export const page = '?pageSize=1000&page=0'
export const list = r => (r.json && (r.json.data || r.json)) || []
export const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 160)))
export const sleep = ms => new Promise(r => setTimeout(r, ms))

// Nomes fixos do modelo. Os grupos de um laboratório usam o nome do asset como prefixo.
export const NOMES = {
  leitura: 'Laboratório · Leitura',
  edicao: 'Laboratório · Edição',
  interface: 'Interface',
  leituraUnidade: 'Unidade · Leitura',
  criacao: 'Unidade · Criação de laboratórios',
  servico: 'Serviço · Laboratórios',
  grupoServico: 'Serviço · Laboratórios',
  contaServico: 'servico.laboratorios@embrapa.local',
  // perfis de asset que representam um laboratório (localidade); a regra fica em todos
  perfis: (process.env.RBAC_PERFIS || 'Laboratório,Casa de vegetação,Campo experimental').split(',').map(s => s.trim()).filter(Boolean),
  regra: 'Embrapa · Criar laboratório',
  gestores: 'Gestores'
}
// Conta de serviço do telemetry-gateway: só lê dispositivos e telemetria, em todas as unidades.
// Substitui a chave de administrador do tenant em TB_TELEMETRY_TOKEN (thingsboard/.env).
export const TELEMETRIA = {
  papel: { name: 'Serviço · Telemetria', type: 'GENERIC', permissions: { DEVICE: ['READ', 'READ_TELEMETRY'] } },
  grupo: 'Serviço · Telemetria',
  conta: 'servico.telemetria@embrapa.local'
}
export const GRUPOS = lab => ({
  dispositivos: `${lab} · Dispositivos`,
  paineis: `${lab} · Painéis`,
  responsaveis: `${lab} · Responsáveis`,
  equipe: `${lab} · Equipe`
})

const LEITURA = ['READ', 'READ_ATTRIBUTES', 'READ_TELEMETRY']
// Recursos que o gestor lê na unidade. EDGE fica de fora: ler o Edge expõe a chave e o segredo dele.
const RECURSOS_UNIDADE = ['DEVICE', 'ASSET', 'DASHBOARD', 'ENTITY_VIEW', 'USER', 'ALARM', 'CUSTOMER',
  'DEVICE_GROUP', 'ASSET_GROUP', 'DASHBOARD_GROUP', 'USER_GROUP', 'ENTITY_VIEW_GROUP']
// CUSTOMER e OTA_PACKAGE: o diálogo de cadastro de dispositivo lê a própria unidade (campo
// Proprietário) e a lista de firmwares ao abrir; sem eles, a tela dá "Permissão negada".
// O papel é vinculado na unidade, então CUSTOMER só alcança a unidade da própria pessoa.
const RECURSOS_INTERFACE = ['DEVICE_PROFILE', 'ASSET_PROFILE', 'WIDGETS_BUNDLE', 'WIDGET_TYPE', 'TB_RESOURCE', 'CUSTOMER', 'OTA_PACKAGE']

export const PAPEIS = {
  leitura: { name: NOMES.leitura, type: 'GROUP', permissions: LEITURA },
  edicao: { name: NOMES.edicao, type: 'GROUP',
    permissions: [...LEITURA, 'CREATE', 'WRITE', 'WRITE_ATTRIBUTES', 'DELETE', 'READ_CREDENTIALS'] },
  interface: { name: NOMES.interface, type: 'GENERIC',
    permissions: { PROFILE: ['ALL'], ...Object.fromEntries(RECURSOS_INTERFACE.map(r => [r, ['READ']])) } },
  leituraUnidade: { name: NOMES.leituraUnidade, type: 'GENERIC',
    permissions: Object.fromEntries(RECURSOS_UNIDADE.map(r => [r, LEITURA])) },
  criacao: { name: NOMES.criacao, type: 'GENERIC', permissions: {
    ASSET: ['CREATE', 'READ', 'WRITE', 'READ_ATTRIBUTES', 'WRITE_ATTRIBUTES'],
    USER: ['READ', 'ADD_TO_GROUP', 'REMOVE_FROM_GROUP'],
    USER_GROUP: ['READ', 'WRITE', 'ADD_TO_GROUP', 'REMOVE_FROM_GROUP'] } },
  // Conta de serviço da regra: cria grupos e vínculos, lê papéis e usuários, põe pessoas em grupos.
  servico: { name: NOMES.servico, type: 'GENERIC', permissions: {
    PROFILE: ['ALL'],
    CUSTOMER: ['READ'],
    ASSET: ['READ', 'READ_ATTRIBUTES'],
    DEVICE_GROUP: ['CREATE', 'READ', 'WRITE'],
    DASHBOARD_GROUP: ['CREATE', 'READ', 'WRITE'],
    USER_GROUP: ['CREATE', 'READ', 'WRITE', 'ADD_TO_GROUP'],
    USER: ['READ', 'ADD_TO_GROUP'],
    ROLE: ['READ'],
    GROUP_PERMISSION: ['CREATE', 'READ'] } }
}
