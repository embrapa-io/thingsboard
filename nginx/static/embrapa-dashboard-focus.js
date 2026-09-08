(function (root, factory) {
  'use strict'

  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }

  if (root && root.document && root.location) {
    api.start(root.document, root.location)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const focusParameter = 'embrapaDashboardFocus'
  const focusClass = 'embrapa-dashboard-focus'
  const styleId = 'embrapa-dashboard-focus-style'
  const styleText = `
html.${focusClass} mat-sidenav.tb-site-sidenav {
  display: none !important;
}

html.${focusClass} mat-sidenav-content.tb-site-content {
  margin-left: 0 !important;
}

html.${focusClass} .tb-primary-toolbar {
  display: none !important;
}

html.${focusClass} .tb-main-content {
  overflow: hidden !important;
}
`

  const isEnabled = locationRef => {
    const search = String(locationRef && locationRef.search || '')
    return new URLSearchParams(search).get(focusParameter) === 'true'
  }

  const start = (documentRef, locationRef) => {
    if (!documentRef || !documentRef.documentElement || !isEnabled(locationRef)) return false

    documentRef.documentElement.classList.add(focusClass)

    if (!documentRef.getElementById(styleId)) {
      const style = documentRef.createElement('style')
      style.id = styleId
      style.textContent = styleText
      documentRef.head.appendChild(style)
    }

    return true
  }

  return { isEnabled, start }
})
