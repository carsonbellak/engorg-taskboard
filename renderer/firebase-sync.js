// Firebase Cloud Sync Module
// Handles authentication, Firestore sync, and real-time listeners

class FirebaseSync {
  constructor() {
    this.db = null;
    this.auth = null;
    this.user = null;
    this.listeners = [];
    this.enabled = false;
    this.syncing = false;
    this._skipSync = false;            // Prevents upload loops when receiving cloud data
    this._uploadTimers = {};           // Debounce timers per collection
    this._initialized = false;
  }

  init() {
    try {
      firebase.initializeApp(firebaseConfig);
      this.auth = firebase.auth();
      this.db = firebase.firestore();

      // Enable offline persistence — wait for it before any reads/writes
      this._persistenceReady = this.db
        .enablePersistence({ synchronizeTabs: false })
        .catch(err => {
          console.warn('Firestore persistence unavailable:', err.code);
        });

      // Auth state listener
      this.auth.onAuthStateChanged(user => {
        this.user = user;
        this.enabled = !!user;
        this._updateUI();
        // Drive the mandatory sign-in gate (see app.js). Fires on the initial
        // resolve too, so the gate knows whether a persisted session exists.
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { signedIn: !!user } }));

        if (user) {
          console.log('Firebase: Signed in as', user.email || user.displayName);
          // Wait for persistence to be ready before any Firestore operations
          (this._persistenceReady || Promise.resolve()).then(() => {
            this._initialSync();
            this._setupListeners();
          });
        } else {
          console.log('Firebase: Signed out');
          this._removeListeners();
        }
      });

      this._initialized = true;
    } catch (err) {
      console.error('Firebase init failed:', err);
    }
  }

  // ===================== AUTH =====================

  async signInWithGoogle() {
    try {
      if (window.api && window.api.googleSignIn) {
        // Electron: open hosted auth page in a BrowserWindow
        const result = await window.api.googleSignIn();
        // Sign in using the Google OAuth access token
        const credential = firebase.auth.GoogleAuthProvider.credential(null, result.accessToken);
        await this.auth.signInWithCredential(credential);
      } else {
        // Browser fallback
        const provider = new firebase.auth.GoogleAuthProvider();
        await this.auth.signInWithPopup(provider);
      }
    } catch (err) {
      if (err.message === 'Sign-in window was closed') {
        return; // User cancelled
      }
      throw err;
    }
  }

  async signInWithEmail(email, password) {
    try {
      await this.auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        // User doesn't exist yet — try to create account
        try {
          await this.auth.createUserWithEmailAndPassword(email, password);
        } catch (createErr) {
          if (createErr.code === 'auth/email-already-in-use') {
            throw new Error('Incorrect password. Try again.');
          }
          throw createErr;
        }
      } else if (err.code === 'auth/wrong-password') {
        throw new Error('Incorrect password. Try again.');
      } else {
        throw err;
      }
    }
  }

  async signOut() {
    this._removeListeners();
    await this.auth.signOut();
  }

  // ===================== UPLOAD =====================

  // Upload a collection to Firestore (debounced 1.5s; 300ms for settings)
  upload(collectionName, data) {
    if (!this.enabled || !this.user || this._skipSync) return;

    const delay = collectionName === 'settings' ? 300 : 1500;
    clearTimeout(this._uploadTimers[collectionName]);
    this._uploadTimers[collectionName] = setTimeout(async () => {
      try {
        const docRef = this.db
          .collection('users').doc(this.user.uid)
          .collection('data').doc(collectionName);

        await docRef.set({
          ...data,
          _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          _source: 'desktop'
        });
      } catch (err) {
        console.error(`Sync upload [${collectionName}]:`, err);
      }
    }, delay);
  }

  // Upload all collections immediately (for initial sync)
  async _uploadAll() {
    if (!this.enabled || !this.user) return;

    const batch = this.db.batch();
    const base = this.db.collection('users').doc(this.user.uid).collection('data');

    const collections = {
      tasks: { tasks: dataManager.tasks },
      projects: { projects: dataManager.projects },
      archived_projects: { projects: dataManager.archivedProjects },
      purchases: { purchases: dataManager.purchases },
      schedule: { items: dataManager.scheduleItems },
      todos: { items: dataManager.todos },
      settings: { ...dataManager.settings }
    };

    for (const [name, data] of Object.entries(collections)) {
      batch.set(base.doc(name), {
        ...data,
        _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        _source: 'desktop'
      });
    }

    await batch.commit();
  }

  // ===================== DOWNLOAD =====================

  async _download(collectionName) {
    if (!this.enabled || !this.user) return null;
    try {
      const doc = await this.db
        .collection('users').doc(this.user.uid)
        .collection('data').doc(collectionName)
        .get();

      if (!doc.exists) return null;
      const data = doc.data();
      delete data._updatedAt;
      delete data._source;
      return data;
    } catch (err) {
      console.error(`Sync download [${collectionName}]:`, err);
      return null;
    }
  }

  // ===================== INITIAL SYNC =====================
  // Simple: if cloud has no data, push local up. Otherwise let real-time
  // listeners adopt cloud state. Firestore's offline persistence flushes any
  // queued local writes before listeners fire, so unsynced edits aren't lost.

  async _initialSync() {
    this.syncing = true;
    this._updateUI();

    try {
      const tasksDoc = await this.db
        .collection('users').doc(this.user.uid)
        .collection('data').doc('tasks').get();

      if (!tasksDoc.exists) {
        console.log('Firebase: First sync — uploading local data');
        await this._uploadAll();
      }
    } catch (err) {
      console.error('Initial sync failed:', err.message);
    }

    this.syncing = false;
    this._updateUI();
  }

  // ===================== REAL-TIME LISTENERS =====================

  _setupListeners() {
    this._removeListeners();
    if (!this.user) return;

    const base = this.db.collection('users').doc(this.user.uid).collection('data');

    const mappings = [
      { doc: 'tasks', prop: 'tasks', key: 'tasks', save: '_saveTasks', event: 'tasks-changed' },
      { doc: 'projects', prop: 'projects', key: 'projects', save: '_saveProjects', event: 'projects-changed' },
      { doc: 'purchases', prop: 'purchases', key: 'purchases', save: '_savePurchases', event: 'purchases-changed' },
      { doc: 'schedule', prop: 'scheduleItems', key: 'items', save: '_saveSchedule', event: 'schedule-changed' },
      { doc: 'todos', prop: 'todos', key: 'items', save: '_saveTodos', event: null },
      { doc: 'archived_projects', prop: 'archivedProjects', key: 'projects', save: '_saveArchivedProjects', event: 'projects-changed' },
    ];

    for (const m of mappings) {
      const unsub = base.doc(m.doc).onSnapshot(snapshot => {
        if (!snapshot.exists) return;
        const data = snapshot.data();

        // Skip our own in-flight writes — wait for server-confirmed version
        if (snapshot.metadata.hasPendingWrites) return;

        const items = data[m.key];
        if (!items) return;

        console.log(`Firebase: Received ${m.doc} update from ${data._source || 'unknown'}`);

        // Update local data
        dataManager[m.prop] = Array.isArray(items) ? items : [];

        // Save locally without triggering upload
        this._skipSync = true;
        dataManager[m.save]().then(() => {
          this._skipSync = false;
        });

        // Re-render UI
        if (m.event) {
          window.dispatchEvent(new CustomEvent(m.event));
        }
      });

      this.listeners.push(unsub);
    }

    // Settings — sync only the shared/account-level keys (project groups, categories,
    // note sort/color, display prefs) so they propagate across devices. Device-local
    // keys (printer, installed utilities, hotbar layout, git repos, etc.) are left
    // untouched, and `localTheme`/`splitLayout` live in localStorage by design.
    const SYNCED_SETTINGS = ['projectGroups', 'categories', 'noteSortMode',
      'noteColorMode', 'noteTertiarySort', 'calendarFeeds', 'linkedAccounts', 'alarms'];
    const settingsUnsub = base.doc('settings').onSnapshot(snapshot => {
      if (!snapshot.exists || snapshot.metadata.hasPendingWrites) return;
      const data = snapshot.data();
      let changed = false, catsChanged = false;
      for (const k of SYNCED_SETTINGS) {
        if (!(k in data)) continue;
        if (JSON.stringify(data[k]) !== JSON.stringify(dataManager.settings[k])) {
          dataManager.settings[k] = data[k];
          changed = true;
          if (k === 'categories') catsChanged = true;
        }
      }
      if (!changed) return;
      console.log('Firebase: Received settings update from', data._source || 'unknown');
      this._skipSync = true;
      dataManager._saveSettings().then(() => { this._skipSync = false; });
      // Rebuild the UI that depends on these (sidebar groups/order, category chips).
      if (catsChanged && typeof APP_CATEGORIES !== 'undefined' && Array.isArray(dataManager.settings.categories)) {
        APP_CATEGORIES = dataManager.settings.categories;
      }
      window.dispatchEvent(new CustomEvent('projects-changed'));
      if (catsChanged) window.dispatchEvent(new CustomEvent('categories-changed'));
    });
    this.listeners.push(settingsUnsub);

    // Timers — top-level collection, not nested under users/{uid}/data/.
    // No orderBy: a bare uid equality query uses Firestore's automatic
    // single-field index, so it works even if the composite (uid, expiresAt)
    // index hasn't been deployed. We sort client-side instead.
    const timerUnsub = this.db.collection('timers')
      .where('uid', '==', this.user.uid)
      .onSnapshot(snap => {
        const all = snap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          expiresAt: d.data().expiresAt?.toDate?.() || null,
          startedAt: d.data().startedAt?.toDate?.() || null
        }));
        window._timers = {
          active: all.filter(t => t.status === 'active')
            .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0)),
          recent: all.filter(t => t.status !== 'active')
            .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
            .slice(0, 20)
        };
        window.dispatchEvent(new CustomEvent('timers-changed'));
      }, err => {
        console.warn('Timer listener error:', err);
      });
    this.listeners.push(timerUnsub);
  }

  _removeListeners() {
    this.listeners.forEach(fn => fn());
    this.listeners = [];
  }

  // ===================== UI =====================

  _updateUI() {
    const btn = document.getElementById('btn-cloud-sync');
    const statusDot = document.getElementById('sync-status-dot');
    if (!btn) return;

    if (this.syncing) {
      btn.innerHTML = '&#9729; Syncing...';
      btn.disabled = true;
      if (statusDot) statusDot.className = 'sync-dot syncing';
    } else if (this.enabled) {
      const name = this.user.displayName || this.user.email || 'User';
      btn.innerHTML = `&#9729; ${name.split(' ')[0].split('@')[0]}`;
      btn.disabled = false;
      btn.title = `Signed in as ${this.user.email}\nClick to manage sync`;
      if (statusDot) statusDot.className = 'sync-dot connected';
    } else {
      btn.innerHTML = '&#9729; Sign in';
      btn.disabled = false;
      btn.title = 'Sign in to sync across devices';
      if (statusDot) statusDot.className = 'sync-dot disconnected';
    }
  }

  showSignInModal() {
    const modal = document.getElementById('modal-cloud-signin');
    if (modal) {
      modal.classList.remove('hidden');
      // Update modal content based on auth state
      const content = document.getElementById('cloud-modal-content');
      if (this.enabled) {
        content.innerHTML = `
          <div class="cloud-signed-in">
            <div class="cloud-user-icon">${this.user.photoURL
              ? `<img src="${this.user.photoURL}" class="cloud-user-avatar" />`
              : '&#128100;'}</div>
            <div class="cloud-user-name">${this.user.displayName || this.user.email}</div>
            <div class="cloud-user-email">${this.user.email || ''}</div>
            <div class="cloud-sync-info">Your data syncs automatically across devices</div>
            <button id="btn-cloud-signout" class="btn-modal-cancel" style="margin-top:16px;">Sign Out</button>
          </div>`;
        document.getElementById('btn-cloud-signout').addEventListener('click', async () => {
          await this.signOut();
          modal.classList.add('hidden');
        });
      } else {
        content.innerHTML = `
          <div class="cloud-signin-form">
            <p class="cloud-signin-desc">Sign in to sync your task board to your phone and access it anywhere.</p>
            <button id="btn-google-signin" class="btn-google-signin">
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Sign in with Google
            </button>
            <div class="cloud-signin-divider"><span>or</span></div>
            <input type="email" id="cloud-email" class="cloud-input" placeholder="Email" autocomplete="email" />
            <input type="password" id="cloud-password" class="cloud-input" placeholder="Password" autocomplete="current-password" />
            <button id="btn-email-signin" class="btn-modal-primary" style="width:100%;">Sign in with Email</button>
            <div id="cloud-signin-error" class="cloud-error hidden"></div>
            <p class="cloud-signin-hint">New account? Just enter an email and password — it'll be created automatically.</p>
          </div>`;

        document.getElementById('btn-google-signin').addEventListener('click', async () => {
          try {
            await this.signInWithGoogle();
            modal.classList.add('hidden');
          } catch (err) {
            const errEl = document.getElementById('cloud-signin-error');
            errEl.textContent = err.message;
            errEl.classList.remove('hidden');
          }
        });

        document.getElementById('btn-email-signin').addEventListener('click', async () => {
          const email = document.getElementById('cloud-email').value.trim();
          const password = document.getElementById('cloud-password').value;
          if (!email || !password) return;
          try {
            await this.signInWithEmail(email, password);
            modal.classList.add('hidden');
          } catch (err) {
            const errEl = document.getElementById('cloud-signin-error');
            errEl.textContent = err.message;
            errEl.classList.remove('hidden');
          }
        });

        // Enter key on password field
        document.getElementById('cloud-password')?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') document.getElementById('btn-email-signin').click();
        });
      }
    }
  }
}

const firebaseSync = new FirebaseSync();
