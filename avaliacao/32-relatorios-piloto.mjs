// Passo 8 do teste de ponta a ponta, exportação pelo módulo Relatórios do ThingsBoard PE, como piloto numa só
// localidade (decisão de 19/11):
//   0. a equipe técnica cria o papel genérico "Relatórios" e o atribui SÓ ao grupo de Responsáveis da Fazenda
//      Nhumirim. Papel genérico vale no nível em que é atribuído: aqui, a Embrapa Pantanal, e só para esse grupo;
//   1. o pesquisador do Pantanal, com a própria sessão do ThingsBoard, cria um modelo CSV com o medidor e a válvula,
//      gera o relatório e agenda a geração diária;
//   2. confere o CSV com o que está gravado, tenta pôr no modelo um sensor de outra Unidade e confere que os outros
//      (Cerrado, Pampa, integrante da Equipe) seguem sem acesso aos Relatórios;
//   3. prints da tela de Relatórios do ThingsBoard.
// Tokens de sessão não são impressos. Sem --manter, o agendamento criado é apagado no fim (o papel fica, para o
// piloto; tirar com --desfazer-papel).
//   node 32-relatorios-piloto.mjs [--manter] [--desfazer-papel]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'
import { login } from './_login.mjs'
import { T, call, list, page, must } from '../rbac/lib.mjs'

const PAPEL = 'Relatórios'
const PERMISSOES = {
  REPORT_TEMPLATE: ['READ', 'CREATE', 'WRITE', 'DELETE'],
  REPORT: ['READ', 'CREATE', 'DELETE'],
  JOB: ['READ', 'CREATE'], // a geração de relatório roda como uma tarefa (Job)
  SCHEDULER_EVENT: ['READ', 'CREATE', 'WRITE', 'DELETE']
}
const FUSO = 'America/Campo_Grande'
const NHUMIRIM = 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal'
const MODELO = 'Fazenda Nhumirim · Telemetria das últimas 24 h'
const PANTANAL = 'pesquisador.pantanal@embrapa.br'
const OUTROS = ['pesquisador.cerrado@embrapa.br', 'pesquisador.pampa@embrapa.br', 'integrante.pantanal@embrapa.br']
const SENSORES = [
  { nome: 'Medidor_Nivel_Reservatorio_Pantanal_02', titulo: 'Medidor de nível do reservatório', chaves: ['level', 'volume', 'flow'] },
  { nome: 'Valvula_Agua_Remota_Pantanal_01', titulo: 'Válvula de água remota', chaves: ['valveOpen', 'flow', 'pressure'] }
]
const API = 'http://localhost:8090'

const resultados = []
const verifica = (id, texto, ok, detalhe) => {
  resultados.push({ id, texto, ok, detalhe })
  console.log(`${ok ? 'PASS' : 'FALHA'} ${id} — ${texto}${detalhe ? ' | ' + detalhe : ''}`)
}
const usuario = async email => list(await T('GET', `/api/user/users?pageSize=10&page=0&textSearch=${encodeURIComponent(email)}`)).find(u => u.email === email)
const sessaoTb = async email => {
  const u = await usuario(email)
  const token = (await T('GET', `/api/user/${u.id.id}/token`)).json.token
  return { id: u.id.id, tb: (method, path, body) => call(method, path, 'Bearer ' + token, body) }
}
const genericas = async s => ((await s.tb('GET', '/api/permissions/allowedPermissions')).json || {}).userPermissions?.genericPermissions || {}

// ---------------- 0. papel e atribuição (equipe técnica)
const asset = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`)).find(a => a.name === NHUMIRIM)
const bruto = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
const grupos = typeof bruto === 'string' ? JSON.parse(bruto) : bruto

let papel = list(await T('GET', `/api/roles?pageSize=100&page=0&textSearch=${encodeURIComponent(PAPEL)}`)).find(r => r.name === PAPEL)
if (!papel) {
  papel = must(await T('POST', '/api/role', { name: PAPEL, type: 'GENERIC', permissions: PERMISSOES, additionalInfo: { description: 'Piloto de 19/11: modelos, geração e agendamento de relatórios. Atribuído só a grupos de Responsáveis.' } }), 'criar papel')
}
const vinculos = (await T('GET', `/api/userGroup/${grupos.responsaveis}/groupPermissions`)).json || []
const jaTem = (Array.isArray(vinculos) ? vinculos : []).some(g => (g.roleId && g.roleId.id) === papel.id.id)
if (process.argv.includes('--desfazer-papel')) {
  for (const g of (Array.isArray(vinculos) ? vinculos : []).filter(g => (g.roleId && g.roleId.id) === papel.id.id)) await T('DELETE', `/api/groupPermission/${g.id.id}`)
  console.log('atribuição do papel removida'); process.exit(0)
}
if (!jaTem) must(await T('POST', '/api/groupPermission', { roleId: papel.id, userGroupId: { entityType: 'ENTITY_GROUP', id: grupos.responsaveis } }), 'atribuir papel')
verifica('R0', `papel "${PAPEL}" atribuído só ao grupo de Responsáveis da Fazenda Nhumirim`, true, Object.entries(PERMISSOES).map(([r, o]) => `${r}: ${o.join('/')}`).join('; '))
await sleep(2000)

// ---------------- 1. o pesquisador do Pantanal
const pantanal = await sessaoTb(PANTANAL)
const perm = await genericas(pantanal)
verifica('R1', 'o pesquisador do Pantanal passa a ter permissão de relatórios', ['REPORT_TEMPLATE', 'REPORT', 'JOB', 'SCHEDULER_EVENT'].every(r => (perm[r] || []).includes('CREATE') || (perm[r] || []).includes('READ')),
  ['REPORT_TEMPLATE', 'REPORT', 'JOB', 'SCHEDULER_EVENT'].map(r => `${r}: ${(perm[r] || []).join('/') || '—'}`).join('; '))

const dispositivos = list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true`))
const idDe = nome => dispositivos.find(d => d.name === nome).id.id
const componente = (deviceId, titulo, chaves) => ({
  type: 'TIME_SERIES_TABLE', subType: null,
  dataSources: [{
    type: 'device', deviceId, entityAliasId: null, filterId: null,
    dataKeys: chaves.map(k => ({ name: k, type: 'timeseries', label: k, color: null, decimals: k === 'valveOpen' ? null : 1, units: null, aggregationType: null, timewindow: null, usePostProcessing: false, postFuncBody: null, settings: { columnWidth: null, header: null, cell: null, type: 'COLUMN' } })),
    latestDataKeys: []
  }],
  margins: { left: 0, right: 0, top: 20, bottom: 0 },
  showTableHeading: true,
  tableHeading: { text: titulo + ' (${entityName})', font: { size: 16, weight: 'normal', style: 'normal', family: 'Roboto' }, color: '#000', textAlignment: 'left', verticalAlignment: 'middle', height: 30 },
  tableSortOrder: { column: 'Timestamp', direction: 'DESC' },
  timewindow: { history: { historyType: 0, interval: 1000, timewindowMs: 86400000 }, aggregation: { type: 'NONE', limit: 2000 }, timezone: null },
  showTimestamp: true, timestampLabel: 'Timestamp', timestampPattern: 'yyyy-MM-dd HH:mm:ss',
  timestampColumnSettings: { columnWidth: null, header: null, cell: null, type: 'COLUMN' }
})
const configuracao = componentes => ({ format: 'CSV', namePattern: 'fazenda-nhumirim-%d{yyyy-MM-dd_HH-mm}', timeDataPattern: 'yyyy-MM-dd HH:mm:ss', entityAliases: [], filters: [], components: componentes })

// modelo (reaproveita o de uma rodada anterior)
const modelos = list(await pantanal.tb('GET', '/api/reportTemplateInfos/all?pageSize=100&page=0'))
let modelo = modelos.find(m => m.name === MODELO)
if (!modelo) {
  const r = await pantanal.tb('POST', '/api/reportTemplate', { name: MODELO, format: 'CSV', type: 'REPORT', description: 'Medidor de nível e válvula, todas as leituras das últimas 24 h.', configuration: configuracao(SENSORES.map(s => componente(idDe(s.nome), s.titulo, s.chaves))) })
  modelo = r.status === 200 ? r.json : null
  verifica('R2', 'o pesquisador do Pantanal cria o modelo CSV', !!modelo, r.status + ' ' + (r.json && r.json.message || ''))
} else verifica('R2', 'modelo CSV já existe (rodada anterior)', true)
if (!modelo) process.exit(1)
verifica('R3', 'o modelo fica na Embrapa Pantanal, não no tenant', modelo.ownerId && modelo.ownerId.entityType === 'CUSTOMER', modelo.ownerId && modelo.ownerId.entityType)
const visiveis = list(await pantanal.tb('GET', '/api/reportTemplateInfos/all?pageSize=100&page=0')).map(m => m.name)
verifica('R4', 'ele não vê os modelos da equipe técnica (tenant)', !visiveis.includes('testecsv') && !visiveis.includes('teste'), visiveis.join(' | '))

// sensor de outra Unidade no modelo
const alheio = await pantanal.tb('POST', '/api/reportTemplate', { name: 'Teste: sensor de outra Unidade', format: 'CSV', type: 'REPORT', configuration: configuracao([componente(idDe('Estacao_Meteorologica_Cerrado_01'), 'Estação do Cerrado', ['temperature'])]) })
let vazou = false
if (alheio.status === 200) {
  // salvou: o relatório gerado não pode trazer dados do Cerrado
  await pantanal.tb('POST', '/api/v2/report/request', { reportTemplateId: alheio.json.id, userId: pantanal.id, timezone: FUSO, makePublic: false })
  await sleep(15000)
  const r = list(await pantanal.tb('GET', '/api/v2/reportInfos/all?pageSize=20&page=0&sortProperty=createdTime&sortOrder=DESC')).find(x => x.templateId && x.templateId.id === alheio.json.id.id)
  if (r) {
    const conteudo = (await pantanal.tb('GET', `/api/v2/report/${r.id.id}/download`)).text || ''
    vazou = conteudo.trim().length > 0 && /\d/.test(conteudo)
    await pantanal.tb('DELETE', `/api/v2/report/${r.id.id}`)
  }
  await pantanal.tb('DELETE', `/api/reportTemplate/${alheio.json.id.id}`)
}
verifica('R5', 'um modelo com sensor de outra Unidade não traz dados dela', alheio.status !== 200 || !vazou, alheio.status === 200 ? `modelo aceito; dados do Cerrado no CSV: ${vazou}` : `modelo recusado (${alheio.status})`)

// gera o relatório sob demanda
const antes = Date.now()
const pedido = await pantanal.tb('POST', '/api/v2/report/request', { reportTemplateId: modelo.id, userId: pantanal.id, timezone: FUSO, makePublic: false })
let relatorio = null
for (let i = 0; i < 30 && !relatorio; i++) {
  await sleep(3000)
  relatorio = list(await pantanal.tb('GET', '/api/v2/reportInfos/all?pageSize=20&page=0&sortProperty=createdTime&sortOrder=DESC')).find(x => x.templateId && x.templateId.id === modelo.id.id && x.createdTime >= antes - 1000)
}
verifica('R6', 'o pesquisador gera o relatório e ele aparece na lista dele', pedido.status === 200 && !!relatorio, `${pedido.status}${relatorio ? ' · ' + relatorio.name : ''}`)
let csv = ''
if (relatorio) {
  const d = await pantanal.tb('GET', `/api/v2/report/${relatorio.id.id}/download`)
  csv = d.text || ''
  const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
  mkdirSync(pasta, { recursive: true })
  writeFileSync(join(pasta, '32-relatorio-fazenda-nhumirim.csv'), csv)
  verifica('R7', 'baixa o CSV do relatório', d.status === 200 && csv.length > 0, `${csv.split('\n').length} linhas, ${csv.length} bytes`)
}

// confere uma linha do CSV com o que está gravado: a leitura mais recente do medidor
if (csv) {
  const linhas = csv.split(/\r?\n/)
  const nivel = (await T('GET', `/api/plugins/telemetry/DEVICE/${idDe(SENSORES[0].nome)}/values/timeseries?keys=level,volume,flow&startTs=${Date.now() - 864e5}&endTs=${Date.now()}&limit=5000&agg=NONE`)).json
  const pontos = (nivel.level || []).length
  // procura no CSV uma linha do medidor com o mesmo nível de algum ponto gravado
  const amostra = (nivel.level || []).slice(5, 10).map(p => String(Number(p.value).toFixed(1)))
  const achou = amostra.filter(v => linhas.some(l => l.includes(v))).length
  verifica('R8', 'o CSV traz as leituras gravadas (amostra de 5 níveis encontrada no arquivo)', achou >= 4, `${achou}/5; ${pontos} leituras do medidor em 24 h`)
  verifica('R9', 'o CSV traz as colunas das duas tabelas, inclusive valveOpen como foi gravado', /level/.test(csv) && /valveOpen/.test(csv) && /true|false/.test(csv), linhas.slice(0, 3).join(' ⏎ ').slice(0, 160))
}

// agenda a geração diária (começa em 2 minutos, para conferir a primeira execução)
const inicio = Math.ceil((Date.now() + 120000) / 60000) * 60000
const evento = await pantanal.tb('POST', '/api/schedulerEvent', {
  name: 'Fazenda Nhumirim · CSV diário',
  type: 'generateReport',
  // a tela do ThingsBoard sempre pede a data de fim de uma repetição: aqui, o fim do piloto
  schedule: { timezone: FUSO, startTime: inicio, repeat: { type: 'DAILY', endsOn: new Date('2026-12-31T23:59:00-04:00').getTime() } },
  configuration: { reportTemplateId: modelo.id, userId: { entityType: 'USER', id: pantanal.id }, timezone: FUSO, makePublic: false }
})
verifica('R10', 'o pesquisador agenda a geração diária', evento.status === 200, `${evento.status} ${evento.json && (evento.json.message || evento.json.name)}`)
if (evento.status === 200) {
  let agendado = null
  for (let i = 0; i < 45 && !agendado; i++) {
    await sleep(5000)
    agendado = list(await pantanal.tb('GET', '/api/v2/reportInfos/all?pageSize=20&page=0&sortProperty=createdTime&sortOrder=DESC')).find(x => x.templateId && x.templateId.id === modelo.id.id && x.createdTime >= inicio - 5000)
  }
  verifica('R11', 'na hora marcada, o agendamento gera o relatório sozinho', !!agendado, agendado ? new Date(agendado.createdTime).toISOString() : 'nada em 3 min e 45 s')
}

// os outros continuam sem Relatórios
for (const email of OUTROS) {
  const s = await sessaoTb(email)
  const g = await genericas(s)
  const r = await s.tb('GET', '/api/reportTemplateInfos/all?pageSize=10&page=0')
  verifica(`R12-${email.split('@')[0].split('.')[1]}`, `${email.split('@')[0]} continua sem acesso aos Relatórios`, !g.REPORT_TEMPLATE && !g.SCHEDULER_EVENT && (r.status === 403 || list(r).length === 0), `permissão: ${(g.REPORT_TEMPLATE || []).join('/') || 'nenhuma'}; listar modelos: ${r.status}`)
}

// ---------------- 3. prints da tela de Relatórios, com a sessão do pesquisador
{
  const { token } = await login(PANTANAL)
  const sessao = await (await fetch(API + '/iot/thingsboard/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({}) })).json()
  const nav = await abrir(null, { largura: 1440, altura: 900 })
  try {
    // a URL leva o token da sessão: não é impressa nem gravada
    await nav.send('Page.navigate', { url: sessao.url })
    await nav.esperar(`!!localStorage.getItem('jwt_token')`, 30000)
    const base = await nav.js('location.origin')
    for (const [caminho, nome, espera] of [
      ['/reporting/templates', '80-pantanal-modelos-de-relatorio', 'mat-row, .mat-mdc-row'],
      ['/reporting/reports', '82-pantanal-relatorios-gerados', 'mat-row, .mat-mdc-row'],
      ['/reporting/scheduling', '83-pantanal-agendamento', 'mat-row, .mat-mdc-row']
    ]) {
      await nav.send('Page.navigate', { url: base + caminho })
      await nav.esperar(`document.querySelectorAll(${JSON.stringify(espera)}).length > 0`, 30000)
      await sleep(3000)
      await nav.print(nome)
    }
    await nav.send('Page.navigate', { url: base + '/reporting/templates/' + modelo.id.id })
    await sleep(9000)
    await nav.print('81-pantanal-modelo-no-construtor')
  } finally { nav.fechar() }
}

// limpeza: o agendamento sai, a não ser com --manter (o modelo e os relatórios gerados ficam)
if (evento.status === 200 && !process.argv.includes('--manter')) {
  const d = await pantanal.tb('DELETE', `/api/schedulerEvent/${evento.json.id.id}`)
  console.log(`(agendamento apagado: ${d.status})`)
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `32-relatorios-piloto-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(resultados, null, 2))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
