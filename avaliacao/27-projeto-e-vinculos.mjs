// Passos 2 e 3 do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md), pela interface do Embrapa I/O:
//   2. o pesquisador do Cerrado cria o projeto (sem repositórios) e convida os pesquisadores do Pampa e do Pantanal;
//   3. cada um abre "Dispositivos IoT", escolhe o campo experimental da própria Unidade e vincula os sensores.
// Tira os prints em relatorio-ponta-a-ponta/img/ e grava o resultado em resultados/. Pode rodar de novo:
// o projeto, os convites e os vínculos já feitos são reaproveitados.
//   node 27-projeto-e-vinculos.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'

const PROJETO = { name: 'Pecuária de Corte Integrada', unix: 'pecuaria-corte' }
const PESQUISADORES = [
  { bioma: 'cerrado', email: 'pesquisador.cerrado@embrapa.br', local: 'Campo experimental da Embrapa Gado de Corte – Campo Grande/MS', sensores: ['Estacao_Meteorologica_Cerrado_01', 'Sensor_Rumen_Cerrado_11'] },
  { bioma: 'pampa', email: 'pesquisador.pampa@embrapa.br', local: 'Campo experimental Fazenda Cinco Cruzes – Bagé/RS', sensores: ['Balanca_Passagem_Pampa_03', 'Colar_GPS_Pampa_07', 'Sensor_Solo_Pastagem_Pampa_04'] },
  { bioma: 'pantanal', email: 'pesquisador.pantanal@embrapa.br', local: 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal', sensores: ['Medidor_Nivel_Reservatorio_Pantanal_02', 'Valvula_Agua_Remota_Pantanal_01'] }
]
const HOME = `typeof vm.projectIot === 'function' && typeof vm.projectTeam === 'function'`
const IOT = `typeof vm.handleAssetChange === 'function' && typeof vm.linkSelected === 'function'`

const resultados = []
const verifica = (id, texto, ok, detalhe) => {
  resultados.push({ id, texto, ok, detalhe })
  console.log(`${ok ? 'PASS' : 'FALHA'} ${id} — ${texto}${detalhe ? ' | ' + detalhe : ''}`)
}
const igual = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const projetoNaHome = nav => nav.vm(HOME, `return (vm.projects || []).some(p => p.unix === ${JSON.stringify(PROJETO.unix)})`)
const abrirDialogo = (nav, metodo) => nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(PROJETO.unix)}); if (!p) return 'sem projeto'; vm.${metodo}(p); return 'ok'`)

// --- 2. o pesquisador do Cerrado cria o projeto e convida os outros dois
{
  const nav = await abrir(PESQUISADORES[0].email)
  try {
    verifica('P0', 'pesquisador do Cerrado entra no Embrapa I/O', await nav.inicio())
    // O formulário é sempre preenchido (para os prints). Só cria se o projeto ainda não existe; senão, cancela.
    const existia = await projetoNaHome(nav)
    if (!existia) await nav.print('01-cerrado-tela-inicial')
    const WIZ = `typeof vm.validateStep1 === 'function'`
    await nav.vm(HOME, `vm.wizard.project = true; return true`)
    await nav.esperar(`!!window.__vm(vm => ${WIZ})`)
    await nav.vm(WIZ, `vm.accept = true; return true`)
    await nav.print('02-cerrado-criar-projeto-aviso')
    await nav.vm(WIZ, `
      vm.step = 2
      Object.assign(vm.project, ${JSON.stringify(PROJETO)}, { web: false, api: false, doc: false, art: false, bin: false, twa: false })
      vm.ecosystems.livestock = true; vm.checkEcosystem('livestock')
      return true`)
    await sleep(800)
    await nav.print('03-cerrado-criar-projeto-dados')
    verifica('P1', 'formulário aceita nome, nome Unix e ecossistema Pecuária, sem repositórios', await nav.vm(WIZ, `return vm.validateStep2()`) === true)
    if (!existia) {
      // clica no botão da tela, que só fica habilitado se a validação passa
      const clicou = await nav.js(`(() => { const b = [...document.querySelectorAll('.v-dialog--active button')].find(b => b.offsetParent && /Criar Projeto/.test(b.textContent) && !b.disabled); if (!b) return false; b.click(); return true })()`)
      verifica('P1b', 'botão "Criar Projeto" habilitado e clicado', clicou)
      await nav.esperar(`!!window.__vm(vm => ${HOME}) && window.__vm(vm => ${HOME}).projects.some(p => p.unix === ${JSON.stringify(PROJETO.unix)})`, 30000)
    } else {
      await nav.vm(WIZ, `vm.cancel(); return true`)
      // acerta o ecossistema de um projeto criado antes sem ele, pela mesma rota que o formulário usa
      const r = await fetch(`http://localhost:8090/ecosystem/${PROJETO.unix}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + nav.token },
        body: JSON.stringify({ agriculture: false, livestock: true, forestry: false, aquaculture: false, industry: false, corporate: false }) })
      verifica('P1c', 'ecossistema Pecuária gravado no projeto existente', r.status === 200, String(r.status))
      await nav.inicio()
    }
    await sleep(2500)
    verifica('P2', 'projeto aparece na tela inicial do pesquisador do Cerrado', await projetoNaHome(nav))
    await nav.print('04-cerrado-projeto-criado')

    // convites
    await abrirDialogo(nav, 'projectTeam')
    await nav.esperar(`!!window.__vm(vm => typeof vm.addMember === 'function' && vm.dialog)`)
    await sleep(1500)
    const convidar = PESQUISADORES.slice(1).map(p => p.email)
    const faltam = await nav.vm(`typeof vm.addMember === 'function'`, `return ${JSON.stringify(convidar)}.filter(e => !vm.team.some(m => m.email === e))`)
    if (faltam.length) {
      for (const [i, email] of faltam.entries()) {
        await nav.vm(`typeof vm.addMember === 'function'`, `vm.editedItem = { email: ${JSON.stringify(email)}, role: 'Developer' }; vm.dialogEdit = true; return true`)
        await sleep(700)
        if (i === 0) await nav.print('05-cerrado-convidar-pesquisador')
        await nav.vm(`typeof vm.addMember === 'function'`, `vm.addMember(); return true`)
      }
      await sleep(700)
      await nav.print('06-cerrado-equipe-antes-de-salvar')
      await nav.vm(`typeof vm.addMember === 'function'`, `vm.save(); return true`)
      await nav.esperar(`!window.__vm(vm => typeof vm.addMember === 'function' && vm.dialog)`, 20000)
      await sleep(1500)
    }
    const projetos = await (await fetch('http://localhost:8090/projects', { headers: { Authorization: 'Bearer ' + nav.token } })).json()
    const projeto = (Array.isArray(projetos) ? projetos : projetos.projects || []).find(x => x.unix === PROJETO.unix)
    const membros = projeto && Array.isArray(projeto.team) ? projeto.team.map(m => m.email) : []
    verifica('P3', 'equipe do projeto tem os três pesquisadores', convidar.every(e => membros.includes(e)), membros.join(', '))
  } finally { nav.fechar() }
}

// --refazer: cada pesquisador desvincula antes os próprios sensores (como criador do vínculo), para os prints
// de "Disponíveis" mostrarem o estado anterior ao vínculo.
if (process.argv.includes('--refazer')) {
  const { login } = await import('./_login.mjs')
  for (const p of PESQUISADORES) {
    const { token } = await login(p.email)
    const h = { Authorization: 'Bearer ' + token }
    const r = await fetch(`http://localhost:8090/iot/devices/linked/${PROJETO.unix}`, { headers: h })
    const lista = await r.json()
    const meus = (Array.isArray(lista) ? lista : lista.devices || []).filter(d => p.sensores.includes(d.name))
    for (const d of meus) {
      const del = await fetch(`http://localhost:8090/iot/devices/${PROJETO.unix}/${encodeURIComponent(d.id)}`, { method: 'DELETE', headers: h })
      console.log(`  (refazer) ${p.bioma} desvincula ${d.name}: ${del.status}`)
    }
  }
}

// --- 3. cada pesquisador vincula os sensores da própria Unidade
for (const [i, p] of PESQUISADORES.entries()) {
  const nav = await abrir(p.email)
  const n = String(7 + i * 3).padStart(2, '0'), n2 = String(8 + i * 3).padStart(2, '0'), n3 = String(9 + i * 3).padStart(2, '0')
  try {
    await nav.inicio()
    verifica(`V${i}a`, `pesquisador do ${p.bioma} vê o projeto na tela inicial`, await projetoNaHome(nav))
    await nav.print(`${n}-${p.bioma}-tela-inicial`)
    await abrirDialogo(nav, 'projectIot')
    await nav.esperar(`!!document.querySelector('.iot-panel')`)
    await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).loadingAssets === false`, 20000)
    await sleep(1500)

    const locais = await nav.vm(IOT, `return vm.assetOptions.map(a => a.name)`)
    verifica(`V${i}b`, `localidades oferecidas ao pesquisador do ${p.bioma} são só as da Unidade dele`, Array.isArray(locais) && locais.includes(p.local), (locais || []).join(' | '))
    await nav.vm(IOT, `vm.tab = 0; const a = vm.assetOptions.find(a => a.name === ${JSON.stringify(p.local)}); if (a) vm.handleAssetChange(a.id); return !!a`)
    await nav.esperar(`(() => { const vm = window.__vm(vm => ${IOT}); return vm && !vm.loadingAvailable && (vm.available.length > 0 || vm.linked.length > 0) })()`, 25000)
    await sleep(2500)
    const disponiveis = await nav.vm(IOT, `return vm.available.map(d => d.name)`)
    // só regrava o print quando há o que vincular (numa nova rodada sem --refazer a lista vem vazia)
    if (disponiveis.length) await nav.print(`${n2}-${p.bioma}-disponiveis`)
    const jaVinculados = await nav.vm(IOT, `return vm.linked.map(d => d.name)`)
    verifica(`V${i}c`, `Disponíveis + Vinculados do ${p.bioma} = sensores da Tabela 3.1 da Unidade`, igual(new Set([...disponiveis, ...jaVinculados.filter(x => p.sensores.includes(x))]), p.sensores), disponiveis.join(', '))
    // a tela vincula pelas caixas de seleção e pelo botão "Vincular" (linkSelected), um ou vários de uma vez
    const marcar = disponiveis.filter(x => p.sensores.includes(x))
    if (marcar.length) {
      await nav.vm(IOT, `vm.selectedForLink = vm.available.filter(d => ${JSON.stringify(marcar)}.includes(d.name)).map(d => d.deviceId); return vm.selectedForLink.length`)
      await sleep(800)
      await nav.vm(IOT, `await vm.linkSelected(); return true`)
      await sleep(1500)
    }
    await nav.vm(IOT, `vm.tab = 1; return true`)
    await sleep(3500)
    const vinculados = await nav.vm(IOT, `return vm.linked.map(d => d.name)`)
    verifica(`V${i}d`, `os sensores do ${p.bioma} ficam vinculados ao projeto`, p.sensores.every(s => vinculados.includes(s)), vinculados.join(', '))
    await nav.print(`${n3}-${p.bioma}-vinculados`)
    if (nav.erros.length) verifica(`V${i}e`, 'sem erro de JavaScript na página', false, nav.erros.slice(0, 2).join(' / '))
  } finally { nav.fechar() }
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `27-projeto-e-vinculos-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(resultados, null, 2))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
