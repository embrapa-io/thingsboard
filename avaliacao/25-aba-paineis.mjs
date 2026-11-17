// Validação da aba Painéis no Embrapa I/O da Central (F4 do planejamento-aba-paineis.md), num Edge headless.
// Entra pelo código de e-mail (Mailpit), abre o diálogo "Dispositivos IoT" do projeto e tira os prints:
// Vinculados (botão Última telemetria e menu ⋮), Painéis, janela do assistente e "Exibir em tablet ou TV".
//   node 25-aba-paineis.mjs [email] [projeto]
// Padrão: fdsfds@embrapa.br (Responsável do PAVAP, Maintainer) no projeto teste1.
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login } from './_login.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EMAIL = process.argv[2] || 'fdsfds@embrapa.br'
const PROJECT = process.argv[3] || 'teste1'
const SITE = 'https://cpcg-237765.taild317c.ts.net'
const OUT = join(HERE, 'resultados')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const TAG = EMAIL.split('@')[0].replace(/[^a-z0-9]+/gi, '-')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (id, description, ok, detail) => {
  results.push({ id, description, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + id + ' — ' + description + (detail ? ' | ' + detail : ''))
}

mkdirSync(OUT, { recursive: true })
const auth = await login(EMAIL)
const user = { authenticated: true, name: EMAIL, email: EMAIL, picture: '', token: auth.token, embrapa: true }

const PORT = 9350
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1366,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-25-'))}`, 'about:blank'], { stdio: 'ignore' })

try {
  for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let n = 0; const pending = new Map(); const errors = []
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'erro no navegador')
    return r.result.result.value
  }
  const shot = async name => {
    const file = join(OUT, `25-${TAG}-${name}-${STAMP}.png`)
    writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
    return file
  }
  const waitFor = async (expression, ms = 20000) => {
    for (let t = 0; t < ms; t += 400) { if (await js(expression)) return true; await sleep(400) }
    return false
  }
  // Clica no primeiro elemento visível cujo texto bate com o padrão.
  const click = (selector, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.offsetParent !== null && x.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true })()`)
  const text = selector => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(x => x.offsetParent !== null).map(x => x.textContent.replace(/\\s+/g, ' ').trim())`)

  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: SITE + '/' })
  await sleep(3000)
  await js(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(user))}); true`)
  await send('Page.navigate', { url: SITE + '/home' })
  check('N0', 'tela inicial carrega com o login', await waitFor(`!!document.querySelector('.v-application') && location.pathname === '/home'`), EMAIL)
  await sleep(4000)

  // Abre o diálogo "Dispositivos IoT" pelo componente da tela inicial (o mesmo método do botão do cartão).
  const opened = await js(`(() => {
    const walk = vm => vm.$refs && vm.$refs.iot && typeof vm.projectIot === 'function' ? vm : vm.$children.map(walk).find(Boolean)
    const home = walk(document.querySelector('#app').__vue__)
    if (!home) return 'sem HomeScreen'
    const list = home.projects || home.allProjects || []
    const project = list.find(p => p.unix === ${JSON.stringify(PROJECT)})
    if (!project) return 'projeto não encontrado: ' + list.map(p => p.unix).join(',')
    home.projectIot(project); return 'ok'
  })()`)
  check('N1', 'diálogo Dispositivos IoT abre', opened === 'ok', opened)
  await waitFor(`!!document.querySelector('.iot-panel') && document.querySelectorAll('.linked-table tbody tr').length > 0`)
  await sleep(4000)

  // Vinculados
  const linkedButtons = await text('.linked-table .linked-actions .v-btn.success')
  check('V1', 'botão verde de cada dispositivo é "Última telemetria"', linkedButtons.length > 0 && linkedButtons.every(t => t.includes('Última telemetria')), linkedButtons.length + ' botões')
  check('V2', 'não sobra "Ver dados" nem Grafana na aba', !(await js(`document.querySelector('.iot-panel').innerText.includes('Ver dados')`)))
  const header = await text('.available-table th')
  check('V3', 'coluna de Disponíveis no singular', !header.length || header.some(t => t === 'Última leitura'), header.join(' / ') || 'tabela de Disponíveis não montada')
  await shot('vinculados')
  const menus = await js(`(async () => {
    const out = []
    const rows = [...document.querySelectorAll('.linked-table tbody tr')].filter(r => r.querySelector('.linked-actions'))
    for (const row of rows) {
      const name = row.querySelector('.device-title').textContent.trim()
      const buttons = [...row.querySelectorAll('.linked-actions .v-btn')]
      const more = buttons[buttons.length - 1]
      if (more.disabled) { out.push(name + ': ⋮ desabilitado'); continue }
      more.click(); await new Promise(r => setTimeout(r, 350))
      const items = [...document.querySelectorAll('.menuable__content__active .v-list-item')].map(i => (i.querySelector('.v-list-item__title') || i).textContent.trim())
      out.push(name + ': ' + items.join(' / '))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
      document.body.click(); await new Promise(r => setTimeout(r, 300))
    }
    return out
  })()`)
  menus.forEach(m => console.log('      ⋮ ' + m))
  check('V4', 'menu ⋮ não repete "Última telemetria"', menus.every(m => !m.includes('Última telemetria')))
  check('V5', '"Abrir no ThingsBoard" só em parte dos dispositivos (acesso no ThingsBoard)', menus.some(m => m.includes('Abrir no ThingsBoard')) || menus.every(m => !m.includes('Abrir no ThingsBoard')), menus.filter(m => m.includes('Abrir no ThingsBoard')).length + ' de ' + menus.length)

  // Última telemetria pelo botão verde
  await click('.linked-table .linked-actions .v-btn.success', 'Última telemetria')
  check('V6', 'botão abre a janela de última telemetria', await waitFor(`[...document.querySelectorAll('.v-dialog--active')].some(d => /telemetria/i.test(d.innerText))`, 8000))
  await sleep(1500); await shot('ultima-telemetria')
  // Fecha só a janela de telemetria (a última aberta), sem tocar no diálogo Dispositivos IoT.
  await js(`(() => { const d = [...document.querySelectorAll('.v-dialog--active')].filter(x => /telemetria/i.test(x.innerText) && !x.querySelector('.iot-panel')).pop(); const b = d && [...d.querySelectorAll('.v-btn')].find(x => /Fechar|close/i.test(x.innerText)); if (b) b.click(); return !!b })()`)
  await sleep(1000)
  check('V7', 'diálogo Dispositivos IoT continua aberto', await js(`!!document.querySelector('.iot-panel') && document.querySelector('.iot-panel').offsetParent !== null`))

  // Disponíveis: escolhe a primeira localidade com dispositivos para vincular
  await click('.iot-tabs .v-tab', 'Disponíveis')
  await sleep(1500)
  const picked = await js(`(async () => {
    const walk = vm => typeof vm.handleAssetChange === 'function' ? vm : vm.$children.map(walk).find(Boolean)
    const iot = walk(document.querySelector('#app').__vue__)
    if (!iot) return 'sem ProjectIot'
    for (let t = 0; t < 30 && iot.loadingAssets; t++) await new Promise(r => setTimeout(r, 300))
    for (const asset of iot.assetOptions) {
      iot.handleAssetChange(asset.id)
      for (let t = 0; t < 40 && (iot.loadingAvailable || !iot.available.length); t++) { await new Promise(r => setTimeout(r, 300)); if (!iot.loadingAvailable && t > 5) break }
      if (iot.available.length) return (asset.label || asset.name) + ': ' + iot.available.length + ' dispositivos'
    }
    return 'nenhuma localidade com dispositivos disponíveis (' + iot.assetOptions.length + ' localidades)'
  })()`)
  console.log('      Disponíveis: ' + picked)
  await sleep(800)
  const availableRows = (await text('.available-table tbody .device-title')).length
  if (availableRows) {
    const sortHeads = await text('.available-table th .sort-button')
    check('D1', 'Disponíveis com colunas ordenáveis', sortHeads.length === 3, sortHeads.join(' / '))
    const names = () => text('.available-table tbody .device-title')
    const isSortedNames = (list, dir = 1) => list.every((v, i) => i === 0 || dir * list[i - 1].localeCompare(v, 'pt-BR', { sensitivity: 'base' }) <= 0)
    check('D2', 'Disponíveis em ordem alfabética por padrão', isSortedNames(await names()), (await names()).length + ' linhas')
    await click('.available-table th .sort-button', 'Dispositivo'); await sleep(400)
    check('D3', 'clicar em "Dispositivo" inverte a ordem', isSortedNames(await names(), -1))
    await click('.available-table th .sort-button', 'Situação'); await sleep(400)
    const states = await text('.available-table tbody .state-pill')
    const rank = { Ativo: 0, Offline: 1, 'Não iniciado': 2 }
    check('D4', 'clicar em "Situação" põe os ativos primeiro', states.every((s, i) => i === 0 || rank[states[i - 1]] <= rank[s]), [...new Set(states)].join(' → '))
    const availableScroll = await js(`(() => { const w = document.querySelector('.available-table .v-data-table__wrapper'); const th = document.querySelector('.available-table thead th'); return getComputedStyle(w).overflowY + ' / ' + getComputedStyle(w).maxHeight + ' / ' + getComputedStyle(th).position + ' / ' + w.clientHeight + 'px de ' + w.scrollHeight + 'px' })()`)
    check('D5', 'Disponíveis rola por dentro com o cabeçalho fixo', /^auto \/ \d+px \/ sticky/.test(availableScroll), availableScroll)
    await shot('disponiveis')
  }

  // Painéis
  await click('.iot-tabs .v-tab', 'Painéis')
  await waitFor(`!!document.querySelector('.iot-dashboards') && !document.querySelector('.iot-dashboards .v-progress-linear')`)
  await sleep(2500)
  const tabCount = await js(`[...document.querySelectorAll('.iot-tabs .v-tab')].find(t => t.textContent.includes('Painéis')).textContent.replace(/\\s+/g, ' ')`)
  const rows = await text('.dash-table tbody tr')
  check('P1', 'aba Painéis lista os painéis das localidades do projeto', rows.length > 0, tabCount + ' | ' + rows.length + ' linhas')
  rows.forEach(r => console.log('      ' + r.slice(0, 140)))
  const alerts = await text('.iot-dashboards .v-alert')
  console.log('      avisos: ' + (alerts.join(' | ') || 'nenhum'))
  const aiLabel = await text('.dash-head .v-btn')
  console.log('      botão: ' + aiLabel.join(''))
  await shot('paineis')

  // Filtros em cascata
  const locDisabled = await js(`[...document.querySelectorAll('.dash-filters .v-select')].pop().classList.contains('v-input--is-disabled')`)
  check('P2', 'Localidade desabilitada até escolher a unidade', locDisabled)
  const scroll = await js(`(() => { const w = document.querySelector('.dash-table .v-data-table__wrapper'); const th = document.querySelector('.dash-table thead th'); return getComputedStyle(w).overflowY + ' / ' + getComputedStyle(w).maxHeight + ' / ' + getComputedStyle(th).position + ' / ' + w.clientHeight + 'px de ' + w.scrollHeight + 'px' })()`)
  check('P4', 'tabela de Painéis rola por dentro com o cabeçalho fixo, como Vinculados', /^auto \/ \d+px \/ sticky/.test(scroll), scroll)

  // Ordenação pelas colunas, como em Vinculados
  const titles = () => text('.dash-table tbody .dash-name')
  const places = () => text('.dash-table tbody .place-name')
  const isSorted = (list, dir = 1) => list.every((v, i) => i === 0 || dir * list[i - 1].localeCompare(v, 'pt-BR', { sensitivity: 'base' }) <= 0)
  check('S1', 'painéis em ordem alfabética por padrão', isSorted(await titles()), (await titles()).join(' · '))
  await click('.dash-table th .sort-button', 'Painel'); await sleep(400)
  check('S2', 'clicar em "Painel" inverte a ordem', isSorted(await titles(), -1), (await titles()).join(' · '))
  await click('.dash-table th .sort-button', 'Localidade'); await sleep(400)
  check('S3', 'clicar em "Localidade e unidade" ordena pela localidade', isSorted(await places()), (await places()).join(' · '))
  await click('.dash-table th .sort-button', 'Painel'); await sleep(400)
  const availableSort = await js(`document.querySelectorAll('.available-table th .sort-button').length`)
  console.log('      Disponíveis: ' + availableSort + ' colunas ordenáveis (0 = tabela não montada sem localidade escolhida)')

  // Janela do assistente
  await click('.dash-head .v-btn', 'assistente')
  await waitFor(`[...document.querySelectorAll('.v-dialog--active')].some(d => d.innerText.includes('Use com o seu assistente de IA'))`, 8000)
  await sleep(1000)
  const prompts = await text('.assistant-prompt p')
  const mcp = await text('.assistant-code')
  check('A1', 'janela do assistente com o endereço do MCP', mcp.length > 0 && !mcp[0].includes('não configurado'), mcp[0])
  check('A2', 'exemplos montados com os dados do projeto', prompts.length > 0, prompts.length + ' pedidos')
  prompts.forEach(p => console.log('      » ' + p))
  const intro = await js(`getComputedStyle(document.querySelector('.assistant-intro')).color`)
  check('A3', 'texto da janela em preto (0.87), como nas abas', intro === 'rgba(0, 0, 0, 0.87)', intro)
  await shot('assistente')
  await js(`[...document.querySelectorAll('.v-dialog--active .v-card__actions .v-btn')].find(b => /fechar/i.test(b.textContent)).click(); true`)
  await sleep(800)

  // Menu ⋮ do painel e "Exibir em tablet ou TV" (só abre a janela; não gera link)
  const dashMenu = await js(`(async () => {
    const row = [...document.querySelectorAll('.dash-table tbody tr')].find(r => r.querySelector('.dash-actions'))
    if (!row) return null
    const buttons = [...row.querySelectorAll('.dash-actions .v-btn')]
    buttons[buttons.length - 1].click(); await new Promise(r => setTimeout(r, 400))
    return [...document.querySelectorAll('.menuable__content__active .v-list-item')].map(i => (i.querySelector('.v-list-item__title') || i).textContent.trim())
  })()`)
  check('P3', 'menu ⋮ do painel', Array.isArray(dashMenu) && dashMenu.includes('Copiar link'), (dashMenu || []).join(' / '))
  if (dashMenu && dashMenu.includes('Exibir em tablet ou TV')) {
    await click('.menuable__content__active .v-list-item', 'Exibir em tablet ou TV')
    check('T1', 'janela "Exibir em tablet ou TV" abre', await waitFor(`[...document.querySelectorAll('.v-dialog--active')].some(d => d.innerText.includes('Exibir em tablet ou TV'))`, 8000))
    await sleep(800); await shot('tablet-tv')
  }

  check('E0', 'sem erros de JavaScript na página', errors.length === 0, errors.slice(0, 3).join(' | '))
  ws.close()
} finally {
  edge.kill()
}

const file = join(OUT, `25-${TAG}-${STAMP}.json`)
writeFileSync(file, JSON.stringify({ email: EMAIL, project: PROJECT, results }, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} PASS → ${file}`)
