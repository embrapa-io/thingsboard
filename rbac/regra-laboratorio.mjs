// Monta a rule chain "Embrapa · Criar laboratório". Ela fica nos perfis de asset das
// localidades (Laboratório, Casa de vegetação, Campo experimental), então só recebe mensagens
// desses assets. Toda mensagem segue também para a raiz, que não é alterada.
//
//   asset criado na unidade  → cria os 4 grupos e os 6 vínculos; grava laboratorioGrupos
//   atributo "responsavel"   → confere se a pessoa é da mesma unidade e a põe em Responsáveis
//
// As chamadas à API usam a chave da conta de serviço (papel mínimo "Serviço · Laboratórios").
import { BASE_INTERNA } from './lib.mjs'

const pos = (i, linha) => ({ layoutX: 340 + 260 * (i % 6), layoutY: 150 + 160 * linha })

export const montarRegra = ({ papeis, defaults, raizId, chave }) => {
  const nodes = []
  const conns = []
  const add = (type, name, configuration, i, linha) => {
    nodes.push({ type, name, configuration, additionalInfo: { description: '', ...pos(i, linha) }, debugMode: false })
    return nodes.length - 1
  }
  const ligar = (de, para, tipo = 'Success') => conns.push({ fromIndex: de, toIndex: para, type: tipo })
  const script = (name, tbelScript, i, linha) =>
    add('org.thingsboard.rule.engine.transform.TbTransformMsgNode', name, { scriptLang: 'TBEL', jsScript: '', tbelScript }, i, linha)
  const filtro = (name, tbelScript, i, linha) =>
    add('org.thingsboard.rule.engine.filter.TbJsFilterNode', name, { scriptLang: 'TBEL', jsScript: '', tbelScript }, i, linha)
  const comutador = (name, tbelScript, i, linha) =>
    add('org.thingsboard.rule.engine.filter.TbJsSwitchNode', name, { scriptLang: 'TBEL', jsScript: '', tbelScript }, i, linha)
  const rest = (name, method, url, body, i, linha) =>
    add('org.thingsboard.rule.engine.rest.TbRestApiCallNode', name, {
      ...defaults.rest,
      restEndpointUrlPattern: BASE_INTERNA + url,
      requestMethod: method,
      headers: { 'Content-Type': 'application/json', 'X-Authorization': chave },
      ignoreRequestBody: body === null,
      requestBodyTemplate: body
    }, i, linha)
  const salvar = (name, i, linha) =>
    add('org.thingsboard.rule.engine.telemetry.TbMsgAttributesNode', name, { ...defaults.salvar, scope: 'SERVER_SCOPE' }, i, linha)
  const ref = (tipo, id) => `{"entityType":"${tipo}","id":"${id}"}`
  const grupoRef = chave => ref('ENTITY_GROUP', '${' + chave + '}')

  // --- erros: qualquer falha grava o motivo no próprio asset
  const erroLab = script('Erro ao criar', `var e = metadata.error != null ? metadata.error : 'falha desconhecida';
return {msg: {"laboratorioStatus": "erro", "laboratorioErro": e}, metadata: metadata, msgType: "POST_ATTRIBUTES_REQUEST"};`, 0, 4)
  const erroResp = script('Erro no responsável', `var e = metadata.erroResponsavel != null ? metadata.erroResponsavel : (metadata.error != null ? metadata.error : 'falha desconhecida');
return {msg: {"responsavelStatus": "erro", "responsavelErro": e}, metadata: metadata, msgType: "POST_ATTRIBUTES_REQUEST"};`, 1, 4)
  const salvarErro = salvar('Gravar erro', 2, 4)
  ligar(erroLab, salvarErro); ligar(erroResp, salvarErro)

  // --- entrada: toda mensagem segue também para a raiz, como se o perfil não tivesse regra própria
  const entrada = script('Entrada', `return {msg: msg, metadata: metadata, msgType: msgType};`, 0, 0)
  const raiz = add('org.thingsboard.rule.engine.flow.TbRuleChainInputNode', 'Seguir para a raiz',
    { ...defaults.raiz, ruleChainId: raizId }, 0, 1)
  const tipo = add('org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode', 'Tipo de mensagem', { version: 0 }, 1, 1)
  ligar(entrada, raiz); ligar(entrada, tipo)

  // --- ramo A: laboratório criado
  const naUnidade = filtro('Pertence a uma unidade?', `return msg.ownerId != null && msg.ownerId.entityType == "CUSTOMER";`, 1, 0)
  ligar(tipo, naUnidade, 'Entity Created')
  const semUnidade = script('Sem unidade', `metadata.error = "o laboratório precisa pertencer a uma unidade";
return {msg: msg, metadata: metadata, msgType: msgType};`, 1, 1)
  ligar(naUnidade, semUnidade, 'False'); ligar(semUnidade, erroLab)
  // o nó REST já escapa os valores ao preencher o corpo, então o nome vai como está
  const prep = script('Preparar nomes', `metadata.lab = msg.name;
metadata.customerId = msg.ownerId.id;
return {msg: {}, metadata: metadata, msgType: msgType};`, 2, 0)
  ligar(naUnidade, prep, 'True')

  let ultimo = prep
  const criarGrupo = (sufixo, tipoGrupo, chave, i) => {
    const body = `{"name":"\${lab} · ${sufixo}","type":"${tipoGrupo}","ownerId":${ref('CUSTOMER', '${customerId}')}}`
    const r = rest('Criar grupo ' + sufixo, 'POST', '/api/entityGroup', body, i, 1)
    const s = script('Guardar id ' + sufixo, `metadata.${chave} = msg.id.id;
return {msg: {}, metadata: metadata, msgType: msgType};`, i, 2)
    ligar(ultimo, r); ligar(r, s); ligar(r, erroLab, 'Failure')
    ultimo = s
  }
  criarGrupo('Dispositivos', 'DEVICE', 'gDisp', 2)
  criarGrupo('Painéis', 'DASHBOARD', 'gPain', 3)
  criarGrupo('Responsáveis', 'USER', 'gResp', 4)
  criarGrupo('Equipe', 'USER', 'gEq', 5)

  const vinculos = [
    ['Responsáveis: Edição nos dispositivos', 'gResp', papeis.edicao, 'gDisp', 'DEVICE'],
    ['Responsáveis: Edição nos painéis', 'gResp', papeis.edicao, 'gPain', 'DASHBOARD'],
    ['Responsáveis: Interface', 'gResp', papeis.interface, null, null],
    ['Equipe: Leitura nos dispositivos', 'gEq', papeis.leitura, 'gDisp', 'DEVICE'],
    ['Equipe: Leitura nos painéis', 'gEq', papeis.leitura, 'gPain', 'DASHBOARD'],
    ['Equipe: Interface', 'gEq', papeis.interface, null, null]
  ]
  vinculos.forEach(([nome, usuarios, papel, entidades, tipoEnt], k) => {
    const body = `{"userGroupId":${grupoRef(usuarios)},"roleId":${ref('ROLE', papel)}` +
      (entidades ? `,"entityGroupId":${grupoRef(entidades)},"entityGroupType":"${tipoEnt}"` : '') + '}'
    const r = rest(nome, 'POST', '/api/groupPermission', body, k, 3)
    ligar(ultimo, r); ligar(r, erroLab, 'Failure')
    ultimo = r
  })
  const ok = script('Laboratório criado', `var grupos = {"dispositivos": metadata.gDisp, "paineis": metadata.gPain, "responsaveis": metadata.gResp, "equipe": metadata.gEq, "unidade": metadata.customerId};
return {msg: {"laboratorioStatus": "criado", "laboratorioErro": "", "laboratorioGrupos": grupos}, metadata: metadata, msgType: "POST_ATTRIBUTES_REQUEST"};`, 0, 5)
  ligar(ultimo, ok)
  const salvarOk = salvar('Gravar grupos', 1, 5)
  ligar(ok, salvarOk)

  // --- ramo B: responsável (também roda logo depois de criar, se o atributo já existir)
  const temResp = filtro('Mudou o responsável?', `return msg.responsavel != null;`, 1, 6)
  ligar(tipo, temResp, 'Attributes Updated')
  const ler = add('org.thingsboard.rule.engine.metadata.TbGetAttributesNode', 'Ler responsável e grupos', {
    ...defaults.ler, fetchTo: 'METADATA', tellFailureIfAbsent: false,
    clientAttributeNames: [], sharedAttributeNames: [], latestTsKeyNames: [],
    serverAttributeNames: ['responsavel', 'laboratorioGrupos']
  }, 2, 6)
  ligar(temResp, ler, 'True'); ligar(salvarOk, ler)
  const situacao = comutador('Situação', `if (metadata.ss_responsavel == null || metadata.ss_responsavel == "") { return ["Sem responsável"]; }
if (metadata.ss_laboratorioGrupos == null || metadata.ss_laboratorioGrupos == "") { return ["Laboratório não criado"]; }
return ["Pronto"];`, 3, 6)
  ligar(ler, situacao)
  const naoCriado = script('Aguardando grupos', `metadata.erroResponsavel = "o laboratório ainda não foi criado";
return {msg: msg, metadata: metadata, msgType: msgType};`, 3, 7)
  ligar(situacao, naoCriado, 'Laboratório não criado'); ligar(naoCriado, erroResp)
  const prepResp = script('Preparar busca', `var g = JSON.parse(metadata.ss_laboratorioGrupos);
metadata.gResp = g.responsaveis;
metadata.customerId = g.unidade;
metadata.email = metadata.ss_responsavel.trim().toLowerCase();
return {msg: {}, metadata: metadata, msgType: msgType};`, 4, 6)
  ligar(situacao, prepResp, 'Pronto')
  const buscar = rest('Buscar usuário', 'GET', '/api/user/users?pageSize=50&page=0&textSearch=${email}', null, 5, 6)
  ligar(prepResp, buscar); ligar(buscar, erroResp, 'Failure')
  const conferir = script('Conferir unidade', `var achou = "";
var outra = false;
foreach (u : msg.data) {
  if (u.email != null && u.email.toLowerCase() == metadata.email) {
    if (u.customerId != null && u.customerId.id == metadata.customerId) { achou = u.id.id; } else { outra = true; }
  }
}
metadata.userId = achou;
if (achou == "") { metadata.erroResponsavel = outra ? "o responsável é de outra unidade" : "nenhum usuário com esse e-mail na unidade"; }
return {msg: {}, metadata: metadata, msgType: msgType};`, 0, 8)
  ligar(buscar, conferir)
  const achou = filtro('Usuário da unidade?', `return metadata.userId != "";`, 1, 8)
  ligar(conferir, achou); ligar(achou, erroResp, 'False')
  const incluir = rest('Pôr em Responsáveis', 'POST', '/api/entityGroup/${gResp}/addEntities', '["${userId}"]', 2, 8)
  ligar(achou, incluir, 'True'); ligar(incluir, erroResp, 'Failure')
  const okResp = script('Responsável definido', `return {msg: {"responsavelStatus": "ok", "responsavelErro": ""}, metadata: metadata, msgType: "POST_ATTRIBUTES_REQUEST"};`, 3, 8)
  ligar(incluir, okResp)
  const salvarResp = salvar('Gravar responsável', 4, 8)
  ligar(okResp, salvarResp)

  return { firstNodeIndex: entrada, nodes, connections: conns }
}
