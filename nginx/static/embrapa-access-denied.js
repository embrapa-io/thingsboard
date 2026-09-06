(function (root, factory) {
  'use strict'

  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }

  if (root && root.document && root.MutationObserver) {
    api.start(root.document, root.MutationObserver)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const dialogMarker = 'data-embrapa-access-denied'
  const forbiddenTitles = ['acesso proibido', 'access forbidden']
  const titleText = 'Acesso negado'
  const messageLines = [
    'Você não tem permissão de acesso a este local!',
    'Tente fazer login com outro usuário se ainda deseja obter acesso a este local'
  ]

  const normalizedText = value => String(value || '').trim().toLocaleLowerCase()

  const replaceMessage = (element, documentRef) => {
    while (element.firstChild) {
      element.removeChild(element.firstChild)
    }

    element.appendChild(documentRef.createTextNode(messageLines[0]))
    element.appendChild(documentRef.createElement('br'))
    element.appendChild(documentRef.createTextNode(messageLines[1]))
  }

  const customize = (rootNode, documentRef) => {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return

    rootNode.querySelectorAll('tb-confirm-dialog').forEach(dialog => {
      if (dialog.hasAttribute(dialogMarker)) return

      const title = dialog.querySelector('[mat-dialog-title]')
      if (!title || !forbiddenTitles.includes(normalizedText(title.textContent))) return

      dialog.setAttribute(dialogMarker, '')
      title.textContent = titleText

      const content = dialog.querySelector('[mat-dialog-content]')
      if (content) replaceMessage(content, documentRef)

      const actions = dialog.querySelector('[mat-dialog-actions]')
      const buttons = actions ? Array.from(actions.querySelectorAll('button')) : []
      if (!buttons.length) return

      // O primeiro botão é o antigo "Cancelar". Mantê-lo preserva o fechamento
      // sem executar o logout associado ao antigo botão "Entrar!".
      buttons[0].textContent = 'Ok'
      buttons.slice(1).forEach(button => button.remove())
    })
  }

  const start = (documentRef, MutationObserverClass) => {
    const applyCustomization = () => customize(documentRef, documentRef)
    const observer = new MutationObserverClass(applyCustomization)

    applyCustomization()
    observer.observe(documentRef.documentElement, { childList: true, subtree: true })
    return observer
  }

  return { customize, start }
})
