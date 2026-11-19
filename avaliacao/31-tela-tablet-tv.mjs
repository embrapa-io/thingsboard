// Passo 7 do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md): o painel do Pantanal num tablet ou
// numa TV, pelo link da aba Painéis ("Exibir em tablet ou TV").
//   1. o pesquisador do Pantanal (Responsável) gera o link pela tela; o integrante da Equipe não consegue;
//   2. o link abre o painel sem login, em tamanho de tablet e de TV;
//   3. confere, com a sessão que o link abre, o que a tela promete: só lê, não manda comando e não vê outras
//      localidades;
//   4. o pesquisador revoga o link: ele deixa de abrir, e a tela que estava aberta perde a sessão.
// Os tokens de sessão nunca são impressos: as consultas da sessão do link são feitas de dentro da página.
// Prints em relatorio-ponta-a-ponta/img/7*.png.
//   node 31-tela-tablet-tv.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'
import { login } from './_login.mjs'
import { T, list, page } from '../rbac/lib.mjs'

const UNIX = 'pecuaria-multibiomas'
const API = 'http://localhost:8090'
const PANTANAL = 'pesquisador.pantanal@embrapa.br', INTEGRANTE = 'integrante.pantanal@embrapa.br'
const TITULO = 'Fazenda Nhumirim — Reservatório e válvula de água'
const NHUMIRIM = 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal'
const SENSORES_PANTANAL = ['Medidor_Nivel_Reservatorio_Pantanal_02', 'Valvula_Agua_Remota_Pantanal_01']
const IOT = `typeof vm.handleAssetChange === 'function' && typeof vm.linkDevice === 'function'`
const HOME = `typeof vm.projectIot === 'function' && typeof vm.projectTeam === 'function'`
const PAINEIS = `typeof vm.kioskChanged === 'function'`
const EMBED = `typeof vm.generate === 'function' && typeof vm.revoke === 'function'`

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
const abrirPaineis = async nav => {
  await nav.inicio()
  await nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(UNIX)}); if (!p) return false; vm.projectIot(p); return true`)
  await nav.esperar(`!!document.querySelector('.iot-panel')`)
  await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).loadingAssets === false`, 20000)
  await nav.vm(IOT, `vm.tab = 2; return true`)
  await nav.esperar(`!!window.__vm(vm => ${PAINEIS}) && (window.__vm(vm => ${PAINEIS}).dashboards || []).length > 0`, 20000)
  await sleep(1500)
}
const abrirEmbed = nav => nav.vm(PAINEIS, `const d = vm.dashboards.find(d => d.title === ${JSON.stringify(TITULO)}); if (!d) return false; vm.embed = d; return true`)
// Consulta a API do ThingsBoard com a sessão que o link abriu (token guardado pela própria página).
const comSessao = (nav, path) => nav.js(`(async () => {
  const t = localStorage.getItem('jwt_token'); if (!t) return { status: 0 }
  const r = await fetch(${JSON.stringify(path)}, { headers: { 'X-Authorization': 'Bearer ' + t } })
  let json = null; try { json = await r.json() } catch {}
  return { status: r.status, json }
})()`)
const abrirLink = async (url, largura, altura) => {
  const nav = await abrir(null, { largura, altura })
  await nav.send('Page.navigate', { url })
  const ok = await nav.esperar(`location.pathname.includes('/dashboard/') && document.querySelectorAll('tb-widget, .tb-widget').length > 0`, 45000)
  await sleep(9000)
  return { nav, ok }
}

// dados de referência (equipe técnica)
const dispositivos = list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true`))
const outraUnidade = dispositivos.find(d => d.name === 'Estacao_Meteorologica_Cerrado_01')
const asset = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`)).find(a => a.name === NHUMIRIM)
const bruto = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
const grupos = typeof bruto === 'string' ? JSON.parse(bruto) : bruto
const paineisDaLocalidade = new Set(list(await T('GET', `/api/entityGroup/${grupos.paineis}/dashboards${page}`)).map(d => d.id.id))

// --- 1. o Responsável gera o link pela tela
let link = null
let painelId = null
{
  const nav = await abrir(PANTANAL, { largura: 1440, altura: 900 })
  try {
    await abrirPaineis(nav)
    painelId = await nav.vm(PAINEIS, `const d = vm.dashboards.find(d => d.title === ${JSON.stringify(TITULO)}); return d ? d.id : null`)
    // começa sem link (de uma rodada anterior, revoga antes)
    const antes = await nav.vm(PAINEIS, `const d = vm.dashboards.find(d => d.id === ${JSON.stringify(painelId)}); return !!(d && d.kiosk)`)
    if (antes) await api(PANTANAL, 'DELETE', `/iot/projects/${UNIX}/dashboards/${painelId}/kiosk`)
    if (antes) { await abrirPaineis(nav) }
    await abrirEmbed(nav)
    await nav.esperar(`!!window.__vm(vm => ${EMBED})`)
    await sleep(1200)
    await nav.print('70-pantanal-exibir-em-tablet-ou-tv')
    await nav.vm(EMBED, `await vm.generate(); return true`)
    await nav.esperar(`!!(window.__vm(vm => ${EMBED}) || {}).link`, 30000)
    await sleep(1200)
    link = await nav.vm(EMBED, `return vm.link`)
    await nav.print('71-pantanal-link-gerado')
    verifica('K1', 'o pesquisador do Pantanal (Responsável) gera o link pela tela', /\/iot\/screen\/[A-Za-z0-9_-]{12}$/.test(link || ''), link ? 'link gerado' : 'sem link')
  } finally { nav.fechar() }
}
if (!link) process.exit(1)

// --- o integrante da Equipe não gera e não recebe o endereço
{
  const r = await api(INTEGRANTE, 'GET', `/iot/projects/${UNIX}/dashboards`)
  const d = ((r.json && r.json.dashboards) || []).find(x => x.id === painelId)
  verifica('K2', 'o integrante vê que há um link ativo, mas não recebe o endereço', !!d && d.kiosk && d.kiosk.active === true && !d.kiosk.url, JSON.stringify(d && d.kiosk))
  const g = await api(INTEGRANTE, 'POST', `/iot/projects/${UNIX}/dashboards/${painelId}/kiosk`)
  verifica('K3', 'o integrante não consegue gerar nem obter o link', g.status === 403, `${g.status} ${g.json && g.json.code}`)
}

// --- 2. o link abre o painel sem login: tablet e TV
const tablet = await abrirLink(link, 1280, 800)
let tv
try {
  verifica('K4', 'no tablet (1280×800), o link abre o painel sem login', tablet.ok, await tablet.nav.js('location.pathname'))
  await tablet.nav.print('72-tablet-painel-pelo-link')
  tv = await abrirLink(link, 1920, 1080)
  verifica('K5', 'na TV (1920×1080), o mesmo link abre o painel', tv.ok)
  await tv.nav.print('73-tv-painel-pelo-link')
  tv.nav.fechar()

  // --- 3. o que a sessão do link pode fazer
  const caminho = await tablet.nav.js('location.pathname')
  verifica('K6', 'abre na rota do painel sozinho, sem o menu do ThingsBoard', /^\/dashboard\//.test(caminho) && !(await tablet.nav.js(`!!document.querySelector('tb-side-menu, .tb-side-menu')`)), caminho.replace(/[0-9a-f-]{36}/, '<id>'))
  const dev = await comSessao(tablet.nav, '/api/user/devices?pageSize=100&page=0')
  const nomes = ((dev.json && dev.json.data) || []).map(d => d.name).sort()
  verifica('K7', 'a sessão do link vê só os dispositivos da Fazenda Nhumirim', dev.status === 200 && nomes.length === 2 && nomes.every(n => SENSORES_PANTANAL.includes(n)), nomes.join(', '))
  const dash = await comSessao(tablet.nav, '/api/user/dashboards?pageSize=100&page=0')
  const ids = ((dash.json && dash.json.data) || []).map(d => d.id.id)
  verifica('K8', 'vê só painéis da Fazenda Nhumirim', dash.status === 200 && ids.length > 0 && ids.every(id => paineisDaLocalidade.has(id)), `${ids.length} painel(is)`)
  const alheio = await comSessao(tablet.nav, `/api/device/${outraUnidade.id.id}`)
  verifica('K9', 'não vê dispositivo de outra Unidade', alheio.status === 403 || alheio.status === 404, String(alheio.status))
  const perm = await comSessao(tablet.nav, '/api/permissions/allowedPermissions')
  const up = (perm.json && perm.json.userPermissions) || {}
  const operacoes = [...Object.values(up.genericPermissions || {}).flat(), ...Object.values(up.groupPermissions || {}).flatMap(g => g.operations || [])]
  const proibidas = ['RPC_CALL', 'WRITE', 'WRITE_ATTRIBUTES', 'WRITE_TELEMETRY', 'CREATE', 'DELETE', 'ALL', 'READ_CREDENTIALS']
  // PROFILE:ALL é o próprio perfil da conta (idioma, senha), igual ao de qualquer usuário
  const genericas = Object.entries(up.genericPermissions || {}).filter(([recurso]) => recurso !== 'PROFILE').flatMap(([, ops]) => ops)
  const grupos2 = Object.values(up.groupPermissions || {}).flatMap(g => g.operations || [])
  const achadas = [...genericas, ...grupos2].filter(op => proibidas.includes(op))
  verifica('K10', 'só lê: sem comando (RPC), sem escrita e sem credenciais', perm.status === 200 && operacoes.length > 0 && achadas.length === 0, [...new Set(grupos2)].join(', '))

  // --- 4. o Responsável revoga o link pela tela
  const nav = await abrir(PANTANAL, { largura: 1440, altura: 900 })
  try {
    await abrirPaineis(nav)
    await abrirEmbed(nav)
    await nav.esperar(`!!(window.__vm(vm => ${EMBED}) || {}).link`, 20000)
    await nav.vm(EMBED, `vm.confirmRevoke = true; return true`)
    await sleep(1000)
    await nav.print('74-pantanal-revogar-link')
    await nav.vm(EMBED, `await vm.revoke(); return true`)
    await sleep(2500)
  } finally { nav.fechar() }
  const depois = await api(PANTANAL, 'GET', `/iot/projects/${UNIX}/dashboards`)
  const d = ((depois.json && depois.json.dashboards) || []).find(x => x.id === painelId)
  verifica('K11', 'revogado: o painel fica sem link na aba Painéis', !!d && !d.kiosk, JSON.stringify(d && d.kiosk))
  const morta = await comSessao(tablet.nav, '/api/user/devices?pageSize=10&page=0')
  verifica('K12', 'a tela que estava aberta perde a sessão (a conta do link foi apagada)', morta.status === 401 || morta.status === 403, String(morta.status))
} finally { tablet.nav.fechar() }

{
  const nav = await abrir(null, { largura: 1280, altura: 800 })
  try {
    await nav.send('Page.navigate', { url: link })
    await sleep(4000)
    const texto = await nav.js('document.body.innerText')
    await nav.print('75-link-revogado')
    verifica('K13', 'o link revogado não abre mais e explica o motivo', /revogado/.test(texto), texto.trim().slice(0, 80))
  } finally { nav.fechar() }
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `31-tela-tablet-tv-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(resultados, null, 2))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
