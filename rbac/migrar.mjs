// Leva os laboratórios atuais (grupos "LOC · <laboratório>" criados pelo modelo anterior)
// para o modelo por laboratório. Para cada um:
//   1. o asset do laboratório passa do tenant para a unidade;
//   2. "LOC · <lab>" vira "<lab> · Dispositivos" (mesmo grupo: preserva sensores e Edge);
//   3. cria "<lab> · Painéis", "<lab> · Responsáveis" e "<lab> · Equipe" se faltarem;
//   4. troca o papel antigo "Responsável pela localidade" por Edição e acrescenta os demais vínculos;
//   5. grava laboratorioGrupos no asset (usado pelo backend e pela regra do responsável).
// Nos grupos de gestores, troca "Gestor da unidade" por Unidade · Leitura + Criação + Interface.
//
// Não remove configurações feitas à mão: só as aponta no fim. Não mexe nas unidades de
// demonstração (PAVAP · MVP operacional, PAVAP · Piloto de interface).
//
// Sem argumentos só SIMULA. Com --aplicar, grava (faça backup do banco antes).
//
//   node migrar.mjs [--aplicar]
import { T, must, page, list, NOMES, GRUPOS } from './lib.mjs'

const APLICAR = process.argv.includes('--aplicar')
const passo = txt => console.log(`${APLICAR ? '→' : '[simulação]'} ${txt}`)
const avisos = []
const avisar = txt => { avisos.push(txt); console.log('⚠️  ' + txt) }
const DEMONSTRACAO = /^PAVAP · (MVP operacional|Piloto de interface)$/

const papeis = Object.fromEntries(list(await T('GET', `/api/roles${page}`)).map(r => [r.name, r]))
for (const nome of [NOMES.leitura, NOMES.edicao, NOMES.interface, NOMES.leituraUnidade, NOMES.criacao]) {
  if (!papeis[nome]) throw new Error(`papel "${nome}" não existe; rode instalar.mjs --aplicar antes`)
}
const ANTIGOS = ['Responsável pela localidade', 'Membro da localidade', 'Gestor da unidade']
const idPapel = nome => papeis[nome].id.id

const vinculos = async grupo => list(await T('GET', `/api/userGroup/${grupo.id.id}/groupPermissions`))
const garantirVinculo = async (usuarios, nomePapel, entidades, atuais) => {
  const papelId = idPapel(nomePapel)
  const existe = atuais.some(p => p.roleId.id === papelId && (entidades ? p.entityGroupId && p.entityGroupId.id === entidades.id.id : !p.entityGroupId))
  if (existe) return
  passo(`  vincular "${usuarios.name}" → ${nomePapel}${entidades ? ' em "' + entidades.name + '"' : ''}`)
  if (APLICAR && !String(usuarios.id.id).startsWith('novo')) {
    must(await T('POST', '/api/groupPermission', { roleId: { entityType: 'ROLE', id: papelId }, userGroupId: usuarios.id,
      ...(entidades ? { entityGroupId: entidades.id, entityGroupType: entidades.type } : {}) }), 'vínculo')
  }
}
const removerAntigos = async (usuarios, atuais) => {
  for (const p of atuais) {
    // papéis de outro dono (ex.: criados dentro de uma unidade) não vêm na lista do tenant
    const nome = Object.values(papeis).find(r => r.id.id === p.roleId.id)?.name ||
      (await T('GET', `/api/role/${p.roleId.id}`)).json?.name || p.roleId.id
    if (ANTIGOS.includes(nome)) {
      passo(`  remover de "${usuarios.name}" o papel antigo "${nome}"`)
      if (APLICAR) must(await T('DELETE', `/api/groupPermission/${p.id.id}`), 'remover vínculo antigo')
    } else if (!Object.values(NOMES).includes(nome)) {
      avisar(`"${usuarios.name}" tem também o papel "${nome}"${p.entityGroupId ? '' : ' (genérico)'}, que não é do modelo; mantido`)
    }
  }
}
let novos = 0
const garantirGrupo = async (unidade, nome, tipo) => {
  const g = list(await T('GET', `/api/entityGroups/CUSTOMER/${unidade.id.id}/${tipo}${page}`)).find(x => x.name === nome)
  if (g) return g
  passo(`  criar grupo ${tipo} "${nome}"`)
  if (!APLICAR) return { id: { id: `novo-${++novos}`, entityType: 'ENTITY_GROUP' }, name: nome, type: tipo }
  return must(await T('POST', '/api/entityGroup', { name: nome, type: tipo, ownerId: unidade.id }), 'grupo ' + nome)
}

const unidades = list(await T('GET', `/api/customers${page}`)).filter(c => c.title !== 'Public' && !DEMONSTRACAO.test(c.title))
const assets = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`))

for (const unidade of unidades) {
  console.log(`\n# ${unidade.title}`)
  const gruposDisp = list(await T('GET', `/api/entityGroups/CUSTOMER/${unidade.id.id}/DEVICE${page}`))

  for (const loc of gruposDisp.filter(g => g.name.startsWith('LOC · '))) {
    const lab = loc.name.slice('LOC · '.length)
    const nomes = GRUPOS(lab)
    console.log(`\n## ${lab}`)
    const asset = assets.find(a => a.name === lab)
    if (!asset) { avisar(`não há asset com o nome "${lab}"; laboratório ignorado`); continue }

    if (!asset.customerId || asset.customerId.id !== unidade.id.id) {
      passo(`  passar o asset "${lab}" para a unidade`)
      if (APLICAR) must(await T('POST', `/api/owner/CUSTOMER/${unidade.id.id}/ASSET/${asset.id.id}`), 'troca de dono do asset')
    }
    passo(`  renomear "${loc.name}" para "${nomes.dispositivos}"`)
    if (APLICAR) must(await T('POST', '/api/entityGroup', { ...loc, name: nomes.dispositivos }), 'renomear grupo')
    const disp = { ...loc, name: nomes.dispositivos }
    const paineis = await garantirGrupo(unidade, nomes.paineis, 'DASHBOARD')
    const resp = await garantirGrupo(unidade, nomes.responsaveis, 'USER')
    const equipe = await garantirGrupo(unidade, nomes.equipe, 'USER')

    for (const [usuarios, papel] of [[resp, NOMES.edicao], [equipe, NOMES.leitura]]) {
      const atuais = String(usuarios.id.id).startsWith('novo') ? [] : await vinculos(usuarios)
      await removerAntigos(usuarios, atuais)
      await garantirVinculo(usuarios, papel, disp, atuais)
      await garantirVinculo(usuarios, papel, paineis, atuais)
      await garantirVinculo(usuarios, NOMES.interface, null, atuais)
    }

    // grupos de usuários de outras unidades (colaboradores) que tinham o papel antigo neste laboratório
    for (const outra of unidades.filter(u => u.id.id !== unidade.id.id)) {
      for (const ug of list(await T('GET', `/api/entityGroups/CUSTOMER/${outra.id.id}/USER${page}`))) {
        const atuais = await vinculos(ug)
        const aqui = atuais.filter(p => p.entityGroupId && p.entityGroupId.id === loc.id.id)
        if (!aqui.length) continue
        console.log(`  colaboradores de ${outra.title}: "${ug.name}"`)
        await removerAntigos(ug, aqui)
        await garantirVinculo(ug, NOMES.leitura, disp, atuais)
        await garantirVinculo(ug, NOMES.leitura, paineis, atuais)
        await garantirVinculo(ug, NOMES.interface, null, atuais)
      }
    }

    const grupos = { dispositivos: loc.id.id, paineis: paineis.id.id, responsaveis: resp.id.id, equipe: equipe.id.id, unidade: unidade.id.id }
    passo(`  gravar laboratorioGrupos no asset`)
    if (APLICAR) must(await T('POST', `/api/plugins/telemetry/ASSET/${asset.id.id}/attributes/SERVER_SCOPE`,
      { laboratorioGrupos: grupos, laboratorioStatus: 'migrado', laboratorioErro: '' }), 'atributos do asset')
  }

  // gestores da unidade
  for (const ug of list(await T('GET', `/api/entityGroups/CUSTOMER/${unidade.id.id}/USER${page}`)).filter(g => /^Gestor(es)?$/.test(g.name))) {
    console.log(`\n## Gestores: "${ug.name}"`)
    const atuais = await vinculos(ug)
    await removerAntigos(ug, atuais)
    for (const papel of [NOMES.leituraUnidade, NOMES.criacao, NOMES.interface]) await garantirVinculo(ug, papel, null, atuais)
  }

  // pontos de atenção que o modelo não decide sozinho
  const usuariosUnidade = list(await T('GET', `/api/customer/${unidade.id.id}/users${page}`))
  for (const ug of list(await T('GET', `/api/entityGroups/CUSTOMER/${unidade.id.id}/USER${page}`)).filter(g => g.name === 'Customer Administrators' || g.name === 'Customer Users')) {
    const membros = list(await T('GET', `/api/entityGroup/${ug.id.id}/entities${page}`))
    if (membros.length) avisar(`${unidade.title}: "${ug.name}" tem ${membros.length} membro(s) (${membros.map(m => m.email).join(', ')}); esse grupo dá acesso amplo à unidade inteira`)
  }
  if (!usuariosUnidade.length) continue
}

console.log(`\n${APLICAR ? 'Migração concluída.' : 'Simulação concluída. Rode com --aplicar para gravar (depois de um backup).'}`)
if (avisos.length) console.log(`${avisos.length} ponto(s) de atenção acima, não alterados.`)
