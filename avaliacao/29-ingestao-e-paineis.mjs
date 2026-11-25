// Passo 5 do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md): ingestão e painéis.
//   I. Ingestão (critério 3.9.1 da qualificação): os dados simulados chegam ao ThingsBoard, ficam
//      persistidos e associados ao dispositivo, à Unidade, à localidade e ao projeto. Cada pesquisador lê a
//      última telemetria dos 7 sensores do projeto, inclusive os das outras Unidades.
//   P. Painéis: um por bioma (decisão de 19/11). Os pesquisadores do Cerrado e do Pampa criam o painel da
//      própria localidade pela mesma rota que o MCP usa (prévia, depois criação). O do Pantanal fica para o
//      passo 6, pelo assistente de IA. Cada painel fica no grupo "· Painéis" da localidade e só aparece
//      para quem é daquela Unidade.
// Prints em relatorio-ponta-a-ponta/img/5*.png. Pode rodar de novo: reaproveita os painéis já criados.
//   node 29-ingestao-e-paineis.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'
import { login } from './_login.mjs'
import { T, list, page } from '../rbac/lib.mjs'

const UNIX = 'pecuaria-corte'
const API = 'http://localhost:8090'
const CERRADO = 'pesquisador.cerrado@embrapa.br', PAMPA = 'pesquisador.pampa@embrapa.br', PANTANAL = 'pesquisador.pantanal@embrapa.br'
const LOCAL = {
  cerrado: { unidade: 'Embrapa Gado de Corte', local: 'Campo experimental da Embrapa Gado de Corte – Campo Grande/MS' },
  pampa: { unidade: 'Embrapa Pecuária Sul', local: 'Campo experimental Fazenda Cinco Cruzes – Bagé/RS' },
  pantanal: { unidade: 'Embrapa Pantanal', local: 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal' }
}
// Tabela 3.1 da qualificação: tipo de dispositivo e as chaves que o simulador envia
const SENSORES = [
  { nome: 'Estacao_Meteorologica_Cerrado_01', bioma: 'cerrado', tipo: 'Estação meteorológica', chaves: ['temperature', 'humidity', 'rainfall', 'windSpeed', 'atmosphericPressure'] },
  { nome: 'Sensor_Rumen_Cerrado_11', bioma: 'cerrado', tipo: 'Sensor ruminal', chaves: ['rumenTemperature', 'activity', 'battery'] },
  { nome: 'Colar_GPS_Pampa_07', bioma: 'pampa', tipo: 'Colar GPS', chaves: ['latitude', 'longitude', 'speed', 'battery'] },
  { nome: 'Balanca_Passagem_Pampa_03', bioma: 'pampa', tipo: 'Balança de passagem', chaves: ['weight', 'animalCount', 'battery'] },
  { nome: 'Sensor_Solo_Pastagem_Pampa_04', bioma: 'pampa', tipo: 'Sensor de solo', chaves: ['soilMoisture', 'soilTemperature', 'conductivity'] },
  { nome: 'Medidor_Nivel_Reservatorio_Pantanal_02', bioma: 'pantanal', tipo: 'Medidor de nível', chaves: ['level', 'volume', 'flow'] },
  { nome: 'Valvula_Agua_Remota_Pantanal_01', bioma: 'pantanal', tipo: 'Válvula de água (atuador)', chaves: ['valveOpen', 'flow', 'pressure'] }
]
const IOT = `typeof vm.handleAssetChange === 'function' && typeof vm.linkDevice === 'function'`
const HOME = `typeof vm.projectIot === 'function' && typeof vm.projectTeam === 'function'`

const resultados = []
const verifica = (id, texto, ok, detalhe) => {
  resultados.push({ id, texto, ok, detalhe })
  console.log(`${ok ? 'PASS' : 'FALHA'} ${id} — ${texto}${detalhe ? ' | ' + detalhe : ''}`)
}
const tokens = {}
const tokenDe = async email => (tokens[email] ||= (await login(email)).token)
const api = async (email, method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tokenDe(email) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, json }
}
const abrirIot = async (nav, aba) => {
  await nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(UNIX)}); if (!p) return false; vm.projectIot(p); return true`)
  await nav.esperar(`!!document.querySelector('.iot-panel')`)
  await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).loadingAssets === false`, 20000)
  await nav.vm(IOT, `vm.tab = ${aba}; return true`)
  await sleep(3500)
}
const ultimoPonto = async (id, chave) => {
  const r = (await T('GET', `/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=${chave}`)).json
  return r && r[chave] && r[chave][0] ? Number(r[chave][0].ts) : 0
}

// ---------------- I. Ingestão
const clientes = list(await T('GET', `/api/customers${page}`))
const assets = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`))
const dispositivos = list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true`))
const gruposDe = async local => {
  const asset = assets.find(a => a.name === local)
  const bruto = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
  return typeof bruto === 'string' ? JSON.parse(bruto) : bruto
}
const grupos = {}
for (const [bioma, l] of Object.entries(LOCAL)) grupos[bioma] = await gruposDe(l.local)
const membrosDispositivos = {}
for (const [bioma, g] of Object.entries(grupos)) membrosDispositivos[bioma] = new Set(list(await T('GET', `/api/entityGroup/${g.dispositivos}/entities${page}`)).map(e => e.id.id))

const vinculados = (await api(CERRADO, 'GET', `/iot/devices/linked/${UNIX}`)).json
const listaVinculados = Array.isArray(vinculados) ? vinculados : (vinculados && vinculados.devices) || []
const agora = Date.now()
const inicio = {}
const tabela = []

for (const s of SENSORES) {
  const d = dispositivos.find(x => x.name === s.nome)
  if (!d) { verifica(`I0-${s.nome}`, `${s.nome} existe no ThingsBoard`, false); continue }
  s.id = d.id.id
  const chaves = (await T('GET', `/api/plugins/telemetry/DEVICE/${s.id}/keys/timeseries`)).json || []
  const ultimos = (await T('GET', `/api/plugins/telemetry/DEVICE/${s.id}/values/timeseries?keys=${s.chaves.join(',')}`)).json || {}
  const idade = Math.min(...s.chaves.map(k => ultimos[k] && ultimos[k][0] ? agora - Number(ultimos[k][0].ts) : Infinity))
  const hora = ((await T('GET', `/api/plugins/telemetry/DEVICE/${s.id}/values/timeseries?keys=${s.chaves[0]}&startTs=${agora - 3600e3}&endTs=${agora}&limit=100000&agg=NONE`)).json || {})[s.chaves[0]] || []
  const antigo = ((await T('GET', `/api/plugins/telemetry/DEVICE/${s.id}/values/timeseries?keys=${s.chaves[0]}&startTs=${agora - 400 * 864e5}&endTs=${agora}&limit=1&orderBy=ASC&agg=NONE`)).json || {})[s.chaves[0]] || []
  const dias = antigo[0] ? (agora - Number(antigo[0].ts)) / 864e5 : 0
  // cobertura dos últimos 7 dias: pontos recebidos / esperados (1 por minuto). Falhas indicam a Central parada.
  const semana = ((await T('GET', `/api/plugins/telemetry/DEVICE/${s.id}/values/timeseries?keys=${s.chaves[0]}&startTs=${agora - 7 * 864e5}&endTs=${agora}&limit=100000&agg=NONE`)).json || {})[s.chaves[0]] || []
  const cobertura = semana.length / (7 * 1440)
  const unidade = clientes.find(c => c.id.id === (d.customerId && d.customerId.id))
  const vinculo = listaVinculados.find(x => x.id === s.id)
  inicio[s.nome] = await ultimoPonto(s.id, s.chaves[0])

  verifica(`I1-${s.bioma}`, `${s.tipo}: envia as chaves esperadas`, s.chaves.every(k => chaves.includes(k)), s.chaves.filter(k => !chaves.includes(k)).join(', ') || s.chaves.join(', '))
  verifica(`I2-${s.bioma}`, `${s.tipo}: leitura recente (menos de 3 min)`, idade < 180e3, `${Math.round(idade / 1000)} s`)
  verifica(`I3-${s.bioma}`, `${s.tipo}: telemetria persistida (≥ 50 pontos na última hora, histórico de ≥ 7 dias)`, hora.length >= 50 && dias >= 7, `${hora.length} pontos/h, ${dias.toFixed(1)} dias`)
  verifica(`I4-${s.bioma}`, `${s.tipo}: pertence à ${LOCAL[s.bioma].unidade} e ao grupo de dispositivos da localidade`, unidade && unidade.title === LOCAL[s.bioma].unidade && membrosDispositivos[s.bioma].has(s.id), unidade ? unidade.title : 'sem Unidade')
  verifica(`I5-${s.bioma}`, `${s.tipo}: vinculado ao projeto com a Unidade e a localidade certas`, !!vinculo && vinculo.unit === LOCAL[s.bioma].unidade && (vinculo.assets || []).includes(LOCAL[s.bioma].local), vinculo ? `${vinculo.unit} · ${(vinculo.assets || []).join(', ')} · por ${vinculo.linkedBy}` : 'não vinculado')
  tabela.push({ tipo: s.tipo, nome: s.nome, unidade: unidade && unidade.title, chaves: s.chaves.join(', '), pontosHora: hora.length, desde: antigo[0] ? new Date(Number(antigo[0].ts)).toISOString().slice(0, 10) : null, dias: Number(dias.toFixed(1)), cobertura7d: Number((cobertura * 100).toFixed(1)), idadeSegundos: Math.round(idade / 1000) })
}

// cada pesquisador lê a última telemetria dos 7 sensores do projeto, inclusive os das outras Unidades
for (const email of [CERRADO, PAMPA, PANTANAL]) {
  const lidos = await Promise.all(SENSORES.filter(s => s.id).map(async s => {
    const r = await api(email, 'GET', `/iot/devices/${UNIX}/${encodeURIComponent(s.id)}/latest-telemetry`)
    return r.status === 200 && r.json && Object.keys(r.json.values || {}).length > 0
  }))
  verifica(`I6-${email.split('@')[0].split('.')[1]}`, `${email} lê, pelo projeto, a última telemetria dos 7 sensores das três Unidades`, lidos.every(Boolean), `${lidos.filter(Boolean).length}/7`)
}

// prints: cada pesquisador abre a última telemetria de um sensor de outro bioma
const VER = [
  [CERRADO, 'Medidor de nível do reservatório do Pantanal 02', '50-cerrado-ultima-telemetria-medidor-do-pantanal'],
  [PAMPA, 'Estação meteorológica do Cerrado 01', '51-pampa-ultima-telemetria-estacao-do-cerrado'],
  [PANTANAL, 'Colar GPS do Pampa 07', '52-pantanal-ultima-telemetria-colar-do-pampa']
]
for (const [email, rotulo, print] of VER) {
  const nav = await abrir(email)
  try {
    await nav.inicio(); await abrirIot(nav, 1)
    const ok = await nav.vm(IOT, `const d = vm.linked.find(d => (d.label || d.name) === ${JSON.stringify(rotulo)}); if (!d) return false; vm.openLatestTelemetry(d); return true`)
    await sleep(3500)
    const texto = await nav.js(`[...document.querySelectorAll('.v-dialog--active')].map(d => d.innerText).join(' ').slice(-600)`)
    await nav.print(print)
    verifica(`I7-${print.slice(0, 2)}`, `${email.split('@')[0]} vê na tela a última telemetria de "${rotulo}"`, ok && /\d/.test(texto), ok ? 'diálogo aberto' : 'sensor não encontrado')
  } finally { nav.fechar() }
}

// ---------------- P. Painéis por bioma
const PAINEIS = [
  {
    email: CERRADO, bioma: 'cerrado', print: 53,
    spec: s => ({
      title: 'Cerrado · Clima e saúde ruminal', period: '24h',
      blocks: [
        { type: 'latest_value', title: 'Temperatura do ar', sources: [{ deviceId: s.Estacao_Meteorologica_Cerrado_01, keys: ['temperature'] }] },
        { type: 'latest_value', title: 'Umidade do ar', sources: [{ deviceId: s.Estacao_Meteorologica_Cerrado_01, keys: ['humidity'] }] },
        { type: 'latest_value', title: 'Temperatura ruminal', sources: [{ deviceId: s.Sensor_Rumen_Cerrado_11, keys: ['rumenTemperature'] }] },
        { type: 'time_series', title: 'Clima nas últimas 24 h', sources: [{ deviceId: s.Estacao_Meteorologica_Cerrado_01, keys: ['temperature', 'humidity'] }] },
        { type: 'time_series', title: 'Ruminal: temperatura e atividade', sources: [{ deviceId: s.Sensor_Rumen_Cerrado_11, keys: ['rumenTemperature', 'activity'] }] }
      ]
    })
  },
  {
    email: PAMPA, bioma: 'pampa', print: 55,
    spec: s => ({
      title: 'Pampa · Pesagem, pastejo e solo', period: '24h',
      blocks: [
        { type: 'latest_value', title: 'Último peso', sources: [{ deviceId: s.Balanca_Passagem_Pampa_03, keys: ['weight'] }] },
        { type: 'latest_value', title: 'Animais pesados', sources: [{ deviceId: s.Balanca_Passagem_Pampa_03, keys: ['animalCount'] }] },
        { type: 'latest_value', title: 'Umidade do solo', sources: [{ deviceId: s.Sensor_Solo_Pastagem_Pampa_04, keys: ['soilMoisture'] }] },
        { type: 'time_series', title: 'Peso na balança', sources: [{ deviceId: s.Balanca_Passagem_Pampa_03, keys: ['weight'] }] },
        { type: 'time_series', title: 'Solo da pastagem', sources: [{ deviceId: s.Sensor_Solo_Pastagem_Pampa_04, keys: ['soilMoisture', 'soilTemperature'] }] },
        { type: 'table', title: 'Colar GPS: posição e velocidade', sources: [{ deviceId: s.Colar_GPS_Pampa_07, keys: ['latitude', 'longitude', 'speed'] }] }
      ]
    })
  }
]
const ids = Object.fromEntries(SENSORES.map(s => [s.nome, s.id]))
const criados = {}

for (const p of PAINEIS) {
  const spec = p.spec(ids)
  const groupId = grupos[p.bioma].paineis
  const previa = await api(p.email, 'POST', '/iot/dashboards', { spec, groupId, dryRun: true })
  verifica(`P1-${p.bioma}`, `prévia do painel "${spec.title}" no grupo de painéis da localidade`, previa.status === 200 && previa.json && previa.json.dryRun === true && previa.json.widgets === spec.blocks.length,
    previa.json ? `${previa.json.widgets} widgets em "${previa.json.group && previa.json.group.name}"` : String(previa.status))

  const existentes = (await api(p.email, 'GET', '/iot/dashboards')).json
  const lista = Array.isArray(existentes) ? existentes : (existentes && existentes.dashboards) || []
  let painel = lista.find(x => x.title === spec.title)
  if (!painel) {
    const r = await api(p.email, 'POST', '/iot/dashboards', { spec, groupId })
    painel = r.status === 200 ? r.json : null
    verifica(`P2-${p.bioma}`, `painel "${spec.title}" criado pelo pesquisador`, !!painel, String(r.status))
  } else verifica(`P2-${p.bioma}`, `painel "${spec.title}" já existe (rodada anterior)`, true)
  criados[p.bioma] = painel && { id: painel.id, title: spec.title }
}

// quem vê qual painel na aba Painéis do projeto: cada um só o da própria localidade
const titulos = Object.fromEntries(Object.entries(criados).map(([k, v]) => [k, v && v.title]))
for (const [email, bioma] of [[CERRADO, 'cerrado'], [PAMPA, 'pampa'], [PANTANAL, 'pantanal']]) {
  const r = await api(email, 'GET', `/iot/projects/${UNIX}/dashboards`)
  const vistos = ((r.json && r.json.dashboards) || []).map(d => d.title + (d.editable ? ' (edita)' : ''))
  const proprio = titulos[bioma]
  const alheios = Object.entries(titulos).filter(([b]) => b !== bioma).map(([, t]) => t)
  verifica(`P3-${bioma}`, `na aba Painéis, ${email.split('@')[0]} vê ${proprio ? 'o painel da própria localidade, editável, e' : ''} nenhum painel de outra Unidade`,
    r.status === 200 && (!proprio || vistos.includes(proprio + ' (edita)')) && !alheios.some(t => vistos.some(v => v.startsWith(t))), vistos.join(' | ') || 'nenhum painel')
}

// prints: a aba Painéis e o painel aberto no ThingsBoard pelo botão "Abrir"
for (const p of PAINEIS) {
  const painel = criados[p.bioma]
  if (!painel) continue
  const nav = await abrir(p.email, { largura: 1440, altura: 900 })
  try {
    await nav.inicio(); await abrirIot(nav, 2)
    await sleep(2000)
    await nav.print(`${p.print}-${p.bioma}-aba-paineis`)
    const sessao = await api(p.email, 'POST', '/iot/thingsboard/session', { target: { type: 'dashboard', id: painel.id } })
    if (sessao.status === 200) {
      // a URL leva o token da sessão: não é impressa nem gravada
      await nav.send('Page.navigate', { url: sessao.json.url })
      const abriu = await nav.esperar(`location.pathname.includes('/dashboards/') && document.querySelectorAll('tb-widget, .tb-widget').length > 0`, 45000)
      await sleep(8000)
      await nav.print(`${p.print + 1}-${p.bioma}-painel-no-thingsboard`)
      const widgets = await nav.js(`document.querySelectorAll('tb-widget, .tb-widget').length`)
      verifica(`P4-${p.bioma}`, `o botão "Abrir" leva ao painel no ThingsBoard, com os widgets`, abriu && widgets > 0, `${widgets} widgets`)
    } else verifica(`P4-${p.bioma}`, 'sessão do ThingsBoard pelo Embrapa I/O', false, String(sessao.status))
  } finally { nav.fechar() }
}

// ---------------- I8. dados novos chegaram durante o teste
const novos = await Promise.all(SENSORES.filter(s => s.id).map(async s => (await ultimoPonto(s.id, s.chaves[0])) > inicio[s.nome]))
verifica('I8', 'chegaram leituras novas dos 7 sensores durante o teste', novos.every(Boolean), `${novos.filter(Boolean).length}/7`)

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `29-ingestao-e-paineis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ resultados, tabela, paineis: criados }, null, 2))
console.log('\n' + tabela.map(t => `${t.tipo} | ${t.unidade} | ${t.pontosHora} pts/h | desde ${t.desde} (${t.dias} dias) | 7 dias: ${t.cobertura7d}% | ${t.idadeSegundos} s`).join('\n'))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
