// Passo 6 do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md): o pesquisador do Pantanal pede a um
// assistente de IA (ChatGPT desktop, pelo MCP do Embrapa I/O) um painel com o nível do reservatório e a válvula.
// A conversa é feita por uma pessoa (prints dela); este script confere o resultado depois:
//   - o painel foi criado pela rota do MCP, em nome do pesquisador do Pantanal (registro de versões);
//   - fica no grupo de painéis da Fazenda Nhumirim e usa só os sensores dela;
//   - mostra nível e válvula como leitura: nenhum widget de comando (o assistente não mexe no atuador);
//   - na aba Painéis, o pesquisador edita, o integrante da Equipe só vê e as outras Unidades não veem;
//   - o integrante não consegue alterar o painel pela rota do MCP.
// Prints em relatorio-ponta-a-ponta/img/6[5-8]-*.png.
//   node 30-painel-pelo-assistente.mjs
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'
import { login } from './_login.mjs'
import { T, list, page } from '../rbac/lib.mjs'

const UNIX = 'pecuaria-corte'
const API = 'http://localhost:8090'
const CERRADO = 'pesquisador.cerrado@embrapa.br', PAMPA = 'pesquisador.pampa@embrapa.br', PANTANAL = 'pesquisador.pantanal@embrapa.br'
const INTEGRANTE = 'integrante.pantanal@embrapa.br'
const NHUMIRIM = 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal'
const SENSORES_PANTANAL = ['Medidor_Nivel_Reservatorio_Pantanal_02', 'Valvula_Agua_Remota_Pantanal_01']
// tipos de widget da lista fechada da rota de painéis; nenhum deles envia comando ao dispositivo
const LEITURA = ['system.time_series_chart', 'system.cards.timeseries_table', 'system.cards.value_card', 'system.digital_gauges.gauge_justgage']
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
// Registro de versões dos painéis (Mongo do Embrapa I/O), lido dentro do contêiner: a senha fica lá.
const versoes = () => JSON.parse(execFileSync('docker', ['exec', 'io-db-1', 'sh', '-c',
  `mongosh --quiet "mongodb://io:$MONGO_NON_ROOT_PASSWORD@localhost:27017/io" --eval 'JSON.stringify(db.iotdashboardversions.find({ email: "${PANTANAL}" }, { dashboardId: 1, action: 1, created: 1, "spec.title": 1 }).sort({ _id: 1 }).toArray())'`], { encoding: 'utf8' }).trim())
const abrirIot = async (nav, aba) => {
  await nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(UNIX)}); if (!p) return false; vm.projectIot(p); return true`)
  await nav.esperar(`!!document.querySelector('.iot-panel')`)
  await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).loadingAssets === false`, 20000)
  await nav.vm(IOT, `vm.tab = ${aba}; return true`)
  await sleep(5000)
}

// --- o painel e quem o criou
const registros = versoes()
const criacao = registros.filter(v => v.action === 'create').at(-1)
verifica('V1', 'há um painel criado pela rota do MCP em nome do pesquisador do Pantanal', !!criacao, criacao ? `"${criacao.spec && criacao.spec.title}" em ${criacao.created}` : 'nenhum registro')
if (!criacao) process.exit(1)
const id = criacao.dashboardId
const ajustes = registros.filter(v => v.dashboardId === id && v.action !== 'create')

const asset = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`)).find(a => a.name === NHUMIRIM)
const bruto = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
const grupos = typeof bruto === 'string' ? JSON.parse(bruto) : bruto
const noGrupo = list(await T('GET', `/api/entityGroup/${grupos.paineis}/dashboards${page}`)).some(d => d.id.id === id)
verifica('V2', 'o painel fica no grupo de painéis da Fazenda Nhumirim', noGrupo)

const painel = (await T('GET', `/api/dashboard/${id}`)).json
const config = painel.configuration || {}
const spec = (config.embrapaIo && config.embrapaIo.spec) || { blocks: [] }
const dispositivos = list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true`))
const nomeDe = new Map(dispositivos.map(d => [d.id.id, d.name]))
const fontes = spec.blocks.flatMap(b => b.sources.map(s => ({ nome: nomeDe.get(s.deviceId), chaves: s.keys, tipo: b.type, titulo: b.title })))
const chaves = new Set(fontes.flatMap(f => f.chaves.map(k => f.nome + ':' + k)))
verifica('V3', 'usa só os sensores da Fazenda Nhumirim', fontes.length > 0 && fontes.every(f => SENSORES_PANTANAL.includes(f.nome)), [...new Set(fontes.map(f => f.nome))].join(', '))
verifica('V4', 'mostra o nível do reservatório e o estado da válvula', chaves.has('Medidor_Nivel_Reservatorio_Pantanal_02:level') && chaves.has('Valvula_Agua_Remota_Pantanal_01:valveOpen'),
  fontes.map(f => `${f.tipo} "${f.titulo}": ${f.nome.split('_').slice(0, 2).join(' ')} ${f.chaves.join('/')}`).join('; '))
const tipos = Object.values(config.widgets || {}).map(w => w.typeFullFqn)
verifica('V5', 'nenhum widget de comando: a válvula aparece só como leitura', tipos.length > 0 && tipos.every(t => LEITURA.includes(t)), `${tipos.length} widgets: ${[...new Set(tipos)].map(t => t.split('.').pop()).join(', ')}`)
verifica('V6', 'ajustes pedidos ao assistente ficaram registrados (podem ser desfeitos)', true, ajustes.length ? ajustes.map(a => a.action).join(', ') : 'nenhum ajuste pedido')

// --- quem vê o painel
const veem = {}
for (const email of [PANTANAL, INTEGRANTE, CERRADO, PAMPA]) {
  const r = await api(email, 'GET', `/iot/projects/${UNIX}/dashboards`)
  const d = ((r.json && r.json.dashboards) || []).find(x => x.id === id)
  veem[email] = d ? (d.editable ? 'edita' : 'só vê') : 'não vê'
}
verifica('V7', 'na aba Painéis: o pesquisador do Pantanal edita, o integrante só vê, Cerrado e Pampa não veem',
  veem[PANTANAL] === 'edita' && veem[INTEGRANTE] === 'só vê' && veem[CERRADO] === 'não vê' && veem[PAMPA] === 'não vê',
  Object.entries(veem).map(([e, v]) => `${e.split('@')[0]}: ${v}`).join('; '))
const alteracao = await api(INTEGRANTE, 'PUT', `/iot/dashboards/${id}`, { spec: { title: spec.title + ' (alterado)', period: spec.period, blocks: spec.blocks }, dryRun: true })
verifica('V8', 'o integrante não consegue alterar o painel pela rota do MCP', alteracao.status === 403, `${alteracao.status} ${alteracao.json && alteracao.json.code}`)

// --- prints do lado do Embrapa I/O e do ThingsBoard
for (const [email, n, nome] of [[PANTANAL, 65, 'pantanal'], [INTEGRANTE, 67, 'integrante']]) {
  const nav = await abrir(email, { largura: 1440, altura: 900 })
  try {
    await nav.inicio(); await abrirIot(nav, 2)
    await nav.print(`${n}-${nome}-aba-paineis`)
    const sessao = await api(email, 'POST', '/iot/thingsboard/session', { target: { type: 'dashboard', id } })
    if (sessao.status === 200) {
      // a URL leva o token da sessão: não é impressa nem gravada
      await nav.send('Page.navigate', { url: sessao.json.url })
      const abriu = await nav.esperar(`location.pathname.includes('/dashboards/') && document.querySelectorAll('tb-widget, .tb-widget').length > 0`, 45000)
      await sleep(8000)
      await nav.print(`${n + 1}-${nome}-painel-no-thingsboard`)
      verifica(`V9-${nome}`, `${email.split('@')[0]} abre o painel no ThingsBoard pelo botão "Abrir"`, abriu)
    } else verifica(`V9-${nome}`, 'sessão do ThingsBoard pelo Embrapa I/O', false, String(sessao.status))
  } finally { nav.fechar() }
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `30-painel-pelo-assistente-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ resultados, painel: { id, title: painel.title, spec } }, null, 2))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
