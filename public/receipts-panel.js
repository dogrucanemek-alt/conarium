/**
 * Makbuzlar tab view-state. Fetch'ten ÖNCE çağrılır — aksi halde ilk tık
 * boş (hepsi hidden) kalır ve ikinci tıkta dolu görünür.
 */
(function (root) {
  function showLoading(ui) {
    ui.chain.hidden = true
    ui.table.hidden = true
    ui.detail.hidden = true
    ui.empty.hidden = false
    ui.empty.textContent = 'Yükleniyor…'
  }

  function showError(ui, message) {
    ui.chain.hidden = true
    ui.table.hidden = true
    ui.detail.hidden = true
    ui.empty.hidden = false
    ui.empty.textContent = message
  }

  function showEmpty(ui, message) {
    ui.chain.hidden = true
    ui.table.hidden = true
    ui.detail.hidden = true
    ui.empty.hidden = false
    ui.empty.textContent = message || 'henüz makbuz yok'
  }

  function showList(ui, data, make) {
    const items = Array.isArray(data.items) ? data.items : []
    const chain = data.chain || {}
    ui.empty.hidden = true
    ui.table.hidden = false
    ui.tbody.textContent = ''
    if (chain.ok === false) {
      ui.chain.hidden = false
      ui.chain.className = 'receipt-chain broken'
      ui.chain.textContent = 'kırık (satır ' + chain.brokenAt + ')'
    } else {
      ui.chain.hidden = false
      ui.chain.className = 'receipt-chain ok'
      ui.chain.textContent = 'zincir sağlam'
    }
    items.forEach(function (row) {
      const tr = make.tr()
      tr.className = 'receipt-table-row'
      tr.dataset.id = row.id
      function td(v) {
        const cell = make.td()
        cell.textContent = v == null ? '' : String(v)
        return cell
      }
      tr.appendChild(td(row.ts ? make.formatTime(row.ts) : ''))
      tr.appendChild(td(row.actor || 'unknown'))
      tr.appendChild(td(row.tool || ''))
      const dec = make.td()
      const badge = make.span()
      badge.className =
        'status-badge-sm ' +
        (row.decision === 'deny' ? 'status-rejected' : row.decision === 'partial' ? 'status-partial' : 'status-success')
      badge.textContent = row.decision || ''
      dec.appendChild(badge)
      tr.appendChild(dec)
      tr.appendChild(td(row.maskedCount == null ? '' : String(row.maskedCount)))
      tr.appendChild(td(row.seq == null ? '' : String(row.seq)))
      if (make.onRow) make.onRow(tr, row)
      ui.tbody.appendChild(tr)
    })
  }

  function render(ui, data, make) {
    if (!data || data.error) {
      showError(ui, (data && data.error) || 'Makbuz listesi alınamadı.')
      return 'error'
    }
    const items = Array.isArray(data.items) ? data.items : []
    if (items.length === 0) {
      showEmpty(ui, data.empty)
      return 'empty'
    }
    showList(ui, data, make)
    return 'list'
  }

  root.ConariumReceiptsPanel = { showLoading, showError, showEmpty, showList, render }
})(typeof window !== 'undefined' ? window : globalThis)
