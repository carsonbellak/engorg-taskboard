// Purchasing Kanban Board - renders into #view-purchasing

class PurchasingBoard {
  constructor(dm) {
    this.data = dm;
    this.editingId = null;
  }

  init() {
    this._bindPurchaseModal();
    this._bindTrackingModal();
  }

  render() {
    const container = document.getElementById('view-purchasing');
    const statuses = [
      { key: 'toPlace', label: 'Orders to Place', showAdd: true },
      { key: 'waiting', label: 'Waiting to Arrive', showAdd: false },
      { key: 'arrived', label: 'Arrived', showAdd: false }
    ];

    container.innerHTML = `<div class="purchasing-board">${statuses.map(s => `
      <div class="kanban-column" data-status="${s.key}">
        <div class="kanban-header">
          <h3>${s.label}</h3>
          <span class="kanban-count" data-count="${s.key}">0</span>
        </div>
        <div class="kanban-cards" data-status="${s.key}"></div>
        ${s.showAdd ? '<button class="kanban-add-btn" id="btn-add-purchase">+ Add Order</button>' : ''}
      </div>
    `).join('')}</div>`;

    // Render cards per status
    statuses.forEach(s => {
      const cardsEl = container.querySelector(`.kanban-cards[data-status="${s.key}"]`);
      const countEl = container.querySelector(`.kanban-count[data-count="${s.key}"]`);
      const purchases = this.data.getPurchasesByStatus(s.key);
      countEl.textContent = purchases.length;

      purchases.forEach(p => cardsEl.appendChild(this._createCard(p)));
    });

    // Drag and drop
    container.querySelectorAll('.kanban-column').forEach(col => {
      const cards = col.querySelector('.kanban-cards');
      cards.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
      cards.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
      cards.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        if (id && id.startsWith('pur_')) {
          await this.data.updatePurchaseStatus(id, col.dataset.status);
          window.dispatchEvent(new CustomEvent('purchases-changed'));
        }
      });
    });

    // Add button
    const addBtn = container.querySelector('#btn-add-purchase');
    if (addBtn) addBtn.addEventListener('click', () => this._openPurchaseModal());
  }

  _createCard(purchase) {
    const proj = this.data.projects.find(p => p.id === purchase.projectId);
    const card = document.createElement('div');
    card.className = 'purchase-card';
    card.draggable = true;
    card.dataset.purchaseId = purchase.id;

    let trackingHtml = '';
    if (purchase.trackingNumber) {
      const carrier = purchase.carrier || detectCarrier(purchase.trackingNumber);
      const url = getTrackingUrl(carrier, purchase.trackingNumber);
      trackingHtml = `<div class="tracking-row">
        <span class="carrier-badge ${carrier.toLowerCase()}">${carrier}</span>
        <a href="#" class="tracking-link" data-url="${url || '#'}">${escapeHtml(purchase.trackingNumber)}</a>
      </div>`;
    } else if (purchase.status === 'waiting') {
      trackingHtml = `<button class="btn-add-tracking-inline" data-id="${purchase.id}">+ Add Tracking</button>`;
    }

    let productLinkHtml = '';
    if (purchase.productLink) {
      productLinkHtml = `<div class="purchase-link-row">
        <a href="#" class="purchase-product-link" data-url="${escapeHtml(purchase.productLink)}" title="${escapeHtml(purchase.productLink)}">&#128279; Product Link</a>
      </div>`;
    }

    card.innerHTML = `
      <div class="purchase-card-header">
        <div class="purchase-item-name">${escapeHtml(purchase.itemDescription)}</div>
        <div class="purchase-card-actions">
          <button class="purchase-card-btn edit-btn" data-id="${purchase.id}" title="Edit">&#9998;</button>
          <button class="purchase-card-btn del-btn" data-id="${purchase.id}" title="Delete">&times;</button>
        </div>
      </div>
      <div class="purchase-details">
        ${purchase.supplier ? `<span class="purchase-supplier">${escapeHtml(purchase.supplier)}</span>` : ''}
        <span>Qty: ${purchase.quantity || 1}</span>
        ${purchase.cost ? `<span class="purchase-cost">$${Number(purchase.cost).toFixed(2)}</span>` : ''}
        ${proj ? `<span class="purchase-proj">${escapeHtml(proj.name)}</span>` : ''}
      </div>
      ${productLinkHtml}
      ${trackingHtml}
      ${purchase.notes ? `<div class="purchase-notes-text">${escapeHtml(purchase.notes)}</div>` : ''}
    `;

    // Drag
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', purchase.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Product link
    card.querySelectorAll('.purchase-product-link').forEach(l => {
      l.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(l.dataset.url); });
    });

    // Tracking link
    card.querySelectorAll('.tracking-link').forEach(l => {
      l.addEventListener('click', (e) => { e.preventDefault(); if (l.dataset.url !== '#') window.api.openExternal(l.dataset.url); });
    });

    // Add tracking
    card.querySelectorAll('.btn-add-tracking-inline').forEach(b => {
      b.addEventListener('click', () => this._openTrackingModal(b.dataset.id));
    });

    // Edit
    card.querySelector('.edit-btn').addEventListener('click', () => this._openPurchaseModal(purchase));

    // Delete
    card.querySelector('.del-btn').addEventListener('click', async () => {
      if (confirm(`Delete "${purchase.itemDescription}"?`)) {
        await this.data.deletePurchase(purchase.id);
        window.dispatchEvent(new CustomEvent('purchases-changed'));
      }
    });

    return card;
  }

  // === Purchase Modal ===
  _bindPurchaseModal() {
    const modal = document.getElementById('modal-purchase');
    document.getElementById('btn-cancel-purchase').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('btn-save-purchase').addEventListener('click', () => this._savePurchase());

    document.getElementById('purchase-tracking').addEventListener('input', (e) => {
      const tn = e.target.value.trim();
      const hint = document.getElementById('carrier-detect-hint');
      if (tn.length > 5) {
        const c = detectCarrier(tn);
        hint.textContent = c !== 'Unknown' ? 'Detected: ' + c : '';
      } else { hint.textContent = ''; }
    });
  }

  _openPurchaseModal(purchase = null) {
    this.editingId = purchase ? purchase.id : null;
    const title = purchase ? 'Edit Order' : '&#128230; New Order';
    document.getElementById('modal-purchase-title').innerHTML = title;

    const projSel = document.getElementById('purchase-project');
    projSel.innerHTML = '<option value="">-- None --</option>' +
      this.data.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    if (purchase) {
      document.getElementById('purchase-item').value = purchase.itemDescription || '';
      document.getElementById('purchase-supplier').value = purchase.supplier || '';
      projSel.value = purchase.projectId || '';
      document.getElementById('purchase-quantity').value = purchase.quantity || 1;
      document.getElementById('purchase-cost').value = purchase.cost || '';
      document.getElementById('purchase-link').value = purchase.productLink || '';
      document.getElementById('purchase-tracking').value = purchase.trackingNumber || '';
      document.getElementById('purchase-notes').value = purchase.notes || '';
      document.getElementById('purchase-status').value = purchase.status || 'toPlace';
    } else {
      document.getElementById('purchase-item').value = '';
      document.getElementById('purchase-supplier').value = '';
      if (this.data.settings.lastProjectId) projSel.value = this.data.settings.lastProjectId;
      document.getElementById('purchase-quantity').value = 1;
      document.getElementById('purchase-cost').value = '';
      document.getElementById('purchase-link').value = '';
      document.getElementById('purchase-tracking').value = '';
      document.getElementById('purchase-notes').value = '';
      document.getElementById('purchase-status').value = 'toPlace';
    }
    document.getElementById('carrier-detect-hint').textContent = '';
    document.getElementById('modal-purchase').classList.remove('hidden');
    document.getElementById('purchase-item').focus();
  }

  async _savePurchase() {
    const item = document.getElementById('purchase-item').value.trim();
    if (!item) return;

    const data = {
      itemDescription: item,
      supplier: document.getElementById('purchase-supplier').value.trim(),
      projectId: document.getElementById('purchase-project').value || null,
      quantity: parseInt(document.getElementById('purchase-quantity').value) || 1,
      cost: parseFloat(document.getElementById('purchase-cost').value) || null,
      productLink: document.getElementById('purchase-link').value.trim() || null,
      trackingNumber: document.getElementById('purchase-tracking').value.trim() || null,
      notes: document.getElementById('purchase-notes').value.trim(),
      status: document.getElementById('purchase-status').value
    };

    if (this.editingId) {
      await this.data.updatePurchase(this.editingId, data);
    } else {
      await this.data.addPurchase(data);
    }

    document.getElementById('modal-purchase').classList.add('hidden');
    this.editingId = null;
    window.dispatchEvent(new CustomEvent('purchases-changed'));
  }

  // === Tracking Modal ===
  _bindTrackingModal() {
    const modal = document.getElementById('modal-tracking');
    document.getElementById('btn-cancel-tracking').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('btn-save-tracking').addEventListener('click', () => this._saveTracking());

    document.getElementById('tracking-number-input').addEventListener('input', (e) => {
      const tn = e.target.value.trim();
      const hint = document.getElementById('tracking-carrier-hint');
      if (tn.length > 5) {
        const c = detectCarrier(tn);
        hint.textContent = c !== 'Unknown' ? 'Detected: ' + c : '';
      } else { hint.textContent = ''; }
    });
  }

  _openTrackingModal(purchaseId) {
    document.getElementById('tracking-purchase-id').value = purchaseId;
    document.getElementById('tracking-number-input').value = '';
    document.getElementById('tracking-carrier-hint').textContent = '';
    document.getElementById('modal-tracking').classList.remove('hidden');
    document.getElementById('tracking-number-input').focus();
  }

  async _saveTracking() {
    const id = document.getElementById('tracking-purchase-id').value;
    const tn = document.getElementById('tracking-number-input').value.trim();
    if (id && tn) {
      await this.data.updatePurchase(id, { trackingNumber: tn, carrier: detectCarrier(tn) });
      document.getElementById('modal-tracking').classList.add('hidden');
      window.dispatchEvent(new CustomEvent('purchases-changed'));
    }
  }
}
