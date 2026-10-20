// EngInk "Attach & submit to assignment" — desktop side.
//
// The tablet can't log in to Gradescope (the password lives here, in main), so it hands the work to
// this PC through the signed-in account: it writes the notebook PDF in chunks plus a request doc to
// users/{uid}/data/inkSubmit/requests/{id}, then waits. Here we claim the request (a transaction, so
// a request the tablet gave up on is never submitted), upload it with gradescope:submitPdf, mark the
// assignment note done, and write the result back. When the assignment needs pages matched to
// questions, the select-pages screen opens in the browser.
//
// Requests: { type: 'submit' | 'done', status: 'pending' → 'uploading' → 'submitted' | 'failed' |
// 'expired' (or 'cancelled' by the tablet), taskId, title, courseId, assignmentId, filename, chunks,
// createdAt }. Only fresh submit requests are honored, so a PC that comes online later never submits
// something the user already handled another way.

const assignmentSubmit = (() => {
  const FRESH_MS = 2 * 60 * 1000;
  let unsub = null, started = false;
  const busy = new Set();

  function requests() {
    return firebaseSync.db.collection('users').doc(firebaseSync.user.uid).collection('data').doc('inkSubmit').collection('requests');
  }

  function markDone(taskId) {
    const t = (dataManager.tasks || []).find(x => x.id === taskId);
    if (!t || t.completed) return;
    dataManager.updateTaskStatus(taskId, 'done').then(() => {
      window.dispatchEvent(new CustomEvent('tasks-changed'));
    }).catch(e => console.warn('Mark done failed', e));
  }

  async function claim(ref) {
    return firebaseSync.db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      if (!d.exists || d.data().status !== 'pending') return false;
      tx.update(ref, { status: 'uploading', claimedAt: Date.now() });
      return true;
    });
  }

  async function process(doc) {
    const r = doc.data() || {};
    if (busy.has(doc.id)) return;
    busy.add(doc.id);
    try {
      if (r.type === 'done') {
        markDone(r.taskId);
        await doc.ref.update({ status: 'done', doneAt: Date.now() });
        return;
      }
      if (r.type !== 'submit') return;
      if (Date.now() - (r.createdAt || 0) > FRESH_MS) { await doc.ref.update({ status: 'expired' }).catch(() => {}); return; }
      if (!(await claim(doc.ref))) return;
      let chunkDocs = [];
      try {
        const snap = await doc.ref.collection('chunks').get();
        chunkDocs = snap.docs;
        if (chunkDocs.length !== (r.chunks || 0)) throw new Error('The PDF didn’t arrive complete — try again.');
        const b64 = chunkDocs.map(d => d.data()).sort((a, b) => a.i - b.i).map(c => c.d).join('');
        const res = await window.api.gradescope.submitPdf(r.courseId, r.assignmentId, b64, r.filename || 'notebook.pdf');
        if (!res || res.error) throw new Error((res && res.error) || 'Upload failed');
        markDone(r.taskId);
        await doc.ref.update({ status: 'submitted', needsMatching: !!res.needsMatching, openUrl: res.url || '', doneAt: Date.now() });
        if (res.needsMatching && res.url) window.api.openExternal(res.url);
        card(res.needsMatching ? 'Match your pages' : 'Submitted to Gradescope',
          res.needsMatching
            ? `<b>${esc(r.title || 'Assignment')}</b> is uploaded. Gradescope is open so you can assign pages to questions.`
            : `<b>${esc(r.title || 'Assignment')}</b> was submitted and marked done.`,
          res.url);
      } catch (e) {
        await doc.ref.update({ status: 'failed', message: String(e.message || e) }).catch(() => {});
        card('Couldn’t submit', `<b>${esc(r.title || 'Assignment')}</b>: ${esc(e.message || String(e))} The tablet saved the PDF and opened the assignment instead.`, null);
      } finally {
        for (const d of chunkDocs) d.ref.delete().catch(() => {});
      }
    } catch (e) {
      console.warn('EngInk submit request failed', e);
    } finally {
      busy.delete(doc.id);
    }
  }

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  // Bottom-right card (same look as the EngInk mirror's), with an Open button when there's a link.
  let el = null, hideT = null;
  function card(title, html, url) {
    if (!el || !document.body.contains(el)) {
      el = document.createElement('div');
      el.className = 'engink-connect-card';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="engink-connect-head"><span class="engink-connect-icon">📤</span><span class="engink-connect-title">${esc(title)}</span>
        <button class="engink-connect-x" data-act="x" title="Dismiss">×</button></div>
      <div class="engink-connect-body">${html}</div>
      ${url ? '<div class="engink-connect-actions"><button class="engink-connect-btn primary" data-act="open">Open in Gradescope</button></div>' : ''}`;
    el.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'open' && url) window.api.openExternal(url);
      el.classList.remove('show');
    };
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(hideT); hideT = setTimeout(() => el && el.classList.remove('show'), 20000);
  }

  function attach() {
    detach();
    if (typeof firebaseSync === 'undefined' || !firebaseSync.user || !firebaseSync.db) return;
    unsub = requests().where('status', '==', 'pending').onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => { if (ch.type !== 'removed') process(ch.doc); });
    }, (err) => console.warn('EngInk submit listener:', err && err.code));
  }
  function detach() { if (unsub) { unsub(); unsub = null; } }

  return {
    /** Start listening for the tablet's requests (main window only). */
    start() {
      if (started) return; started = true;
      window.addEventListener('auth-changed', (e) => { if (e.detail && e.detail.signedIn) attach(); else detach(); });
      attach();
    },
  };
})();
