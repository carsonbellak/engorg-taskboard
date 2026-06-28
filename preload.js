const { contextBridge, ipcRenderer } = require('electron');

// nodeIntegrationInSubFrames runs this preload in EVERY subframe (so Split Window
// panes get window.api). But the sandboxed remote-utility / email iframes must
// stay privilege-free — so only expose the bridge in our real app frames
// (the top window and split panes both load `renderer/index.html`).
const __isAppFrame = /\/renderer\/index\.html$/i.test(location.pathname || '');

const __api = {
  loadData: (filename) => ipcRenderer.invoke('data:load', filename),
  saveData: (filename, data) => ipcRenderer.invoke('data:save', filename, data),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // File attachments
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  // Google auth via main process BrowserWindow
  googleSignIn: () => ipcRenderer.invoke('auth:googleSignIn'),
  // Outlook local integration (reads from desktop Outlook via COM)
  outlookFetchLocal: (daysBack, daysForward) => ipcRenderer.invoke('outlook:fetchLocal', daysBack, daysForward),
  // 3D Printer (Moonraker)
  printer: {
    apiGet: (baseUrl, path) => ipcRenderer.invoke('printer:apiGet', baseUrl, path),
    apiPost: (baseUrl, path, body) => ipcRenderer.invoke('printer:apiPost', baseUrl, path, body),
    uploadFile: (baseUrl, filePath) => ipcRenderer.invoke('printer:uploadFile', baseUrl, filePath),
    uploadFileData: (baseUrl, filename, base64Data) => ipcRenderer.invoke('printer:uploadFileData', baseUrl, filename, base64Data),
    selectFile: () => ipcRenderer.invoke('printer:selectFile'),
    webrtcOffer: (printerIp, sdpOffer) => ipcRenderer.invoke('printer:webrtcOffer', printerIp, sdpOffer),
    sendCameraFrame: (jpegDataUrl) => ipcRenderer.invoke('printer:sendCameraFrame', jpegDataUrl),
    setEnabled: (enabled) => ipcRenderer.invoke('printer:setEnabled', enabled),
    resolveUrl: (seedUrl) => ipcRenderer.invoke('printer:resolveUrl', seedUrl)
  },
  // Installer
  installer: {
    build: () => ipcRenderer.invoke('installer:build')
  },
  // Slicer (OrcaSlicer CLI)
  slicer: {
    selectModel: () => ipcRenderer.invoke('slicer:selectModel'),
    getProfiles: () => ipcRenderer.invoke('slicer:getProfiles'),
    slice: (options) => ipcRenderer.invoke('slicer:slice', options)
  },
  // KiCad library importer
  kicad: {
    selectZips: () => ipcRenderer.invoke('kicad:selectZips'),
    selectOutputFolder: () => ipcRenderer.invoke('kicad:selectOutputFolder'),
    selectExistingLibrary: () => ipcRenderer.invoke('kicad:selectExistingLibrary'),
    resolveLibrary: (opts) => ipcRenderer.invoke('kicad:resolveLibrary', opts),
    selectStepFile: () => ipcRenderer.invoke('kicad:selectStepFile'),
    getDigikeyDefaults: () => ipcRenderer.invoke('kicad:getDigikeyDefaults'),
    extractZips: (opts) => ipcRenderer.invoke('kicad:extractZips', opts),
    digikeyLookup: (opts) => ipcRenderer.invoke('kicad:digikeyLookup', opts),
    addStepFile: (opts) => ipcRenderer.invoke('kicad:addStepFile', opts),
    writeLibrary: (opts) => ipcRenderer.invoke('kicad:writeLibrary', opts)
  },
  // WiFi Checker (meter scan over WiFi: ping + SSH, temp shutdown)
  wifi: {
    selectExcel: () => ipcRenderer.invoke('wifi:selectExcel'),
    selectFolder: () => ipcRenderer.invoke('wifi:selectFolder'),
    readExcelBuffer: (filePath) => ipcRenderer.invoke('wifi:readExcelBuffer', filePath),
    hasNmap: () => ipcRenderer.invoke('wifi:hasNmap'),
    connectWifi: (opts) => ipcRenderer.invoke('wifi:connectWifi', opts),
    discoverIps: () => ipcRenderer.invoke('wifi:discoverIps'),
    ping: (ip) => ipcRenderer.invoke('wifi:ping', ip),
    ssh: (ip) => ipcRenderer.invoke('wifi:ssh', ip),
    setTemp: (opts) => ipcRenderer.invoke('wifi:setTemp', opts),
    writeFile: (opts) => ipcRenderer.invoke('wifi:writeFile', opts)
  },
  // UART Bridge — Web Serial port-picker relay + FTDI bit-bang
  serial: {
    onPortList: (cb) => ipcRenderer.on('serial:portList', (e, ports) => cb(ports)),
    selectPort: (portId) => ipcRenderer.send('serial:selectPort', portId)
  },
  ftdi: {
    list: () => ipcRenderer.invoke('ftdi:list'),
    open: (index) => ipcRenderer.invoke('ftdi:open', index),
    bitmode: (index, mask, mode) => ipcRenderer.invoke('ftdi:bitmode', index, mask, mode),
    baud: (index, baud) => ipcRenderer.invoke('ftdi:baud', index, baud),
    write: (index, bytes) => ipcRenderer.invoke('ftdi:write', index, bytes),
    close: (index) => ipcRenderer.invoke('ftdi:close', index)
  },
  uartProg: {
    list: () => ipcRenderer.invoke('uartprog:list'),
    save: (name, data) => ipcRenderer.invoke('uartprog:save', { name, data }),
    load: (name) => ipcRenderer.invoke('uartprog:load', name),
    remove: (name) => ipcRenderer.invoke('uartprog:delete', name),
    exportPython: (opts) => ipcRenderer.invoke('uartprog:exportPython', opts),
    importPython: () => ipcRenderer.invoke('uartprog:importPython')
  },
  // Custom title bar — window controls + menu actions (see renderer/titlebar.js)
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('win:maximizeToggle'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximized: (cb) => ipcRenderer.on('win:maximized', (e, v) => cb(v))
  },
  menu: {
    action: (name) => ipcRenderer.invoke('appmenu:action', name)
  },
  // App updates — check the canonical repo for newer commits on startup
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    version: () => ipcRenderer.invoke('updates:version'),
    apply: () => ipcRenderer.invoke('updates:apply'),
    pull: () => ipcRenderer.invoke('updates:pull'),
    skip: (sha) => ipcRenderer.invoke('updates:skip', sha),
    openRepo: () => ipcRenderer.invoke('updates:openRepo'),
    download: () => ipcRenderer.invoke('updates:download'),
    runInstaller: (p) => ipcRenderer.invoke('updates:runInstaller', p),
    onProgress: (cb) => ipcRenderer.on('updates:progress', (e, d) => cb(d)),
    restart: () => ipcRenderer.invoke('updates:restart')
  },
  // Contribute — submit local changes to the canonical repo as a GitHub PR
  contribute: {
    getChanges: () => ipcRenderer.invoke('contribute:getChanges'),
    status: () => ipcRenderer.invoke('contribute:status'),
    signInStart: () => ipcRenderer.invoke('contribute:signInStart'),
    signInPoll: (deviceCode) => ipcRenderer.invoke('contribute:signInPoll', deviceCode),
    signOut: () => ipcRenderer.invoke('contribute:signOut'),
    submit: (opts) => ipcRenderer.invoke('contribute:submit', opts),
    submitFeature: (opts) => ipcRenderer.invoke('contribute:submitFeature', opts)
  },
  // Utility store (GitHub-backed)
  store: {
    fetchCatalog: (url) => ipcRenderer.invoke('store:fetchCatalog', url),
    downloadUtility: (entry) => ipcRenderer.invoke('store:downloadUtility', entry),
    removeUtility: (id) => ipcRenderer.invoke('store:removeUtility', id),
    getLocalPath: (id) => ipcRenderer.invoke('store:getLocalPath', id)
  },
  // File viewer
  files: {
    selectFolder: () => ipcRenderer.invoke('files:selectFolder'),
    readdir: (dirPath) => ipcRenderer.invoke('files:readdir', dirPath),
    readText: (filePath) => ipcRenderer.invoke('files:readText', filePath),
    readBinary: (filePath) => ipcRenderer.invoke('files:readBinary', filePath),
    getFileUrl: (filePath) => ipcRenderer.invoke('files:getFileUrl', filePath),
    stat: (filePath) => ipcRenderer.invoke('files:stat', filePath),
    getHome: () => ipcRenderer.invoke('files:getHome'),
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
    exportKicad: (filePath) => ipcRenderer.invoke('files:exportKicad', filePath),
    exportKicadGlb: (filePath) => ipcRenderer.invoke('files:exportKicadGlb', filePath),
    hasKicadCli: () => ipcRenderer.invoke('files:hasKicadCli'),
    rename: (oldPath, newPath) => ipcRenderer.invoke('files:rename', oldPath, newPath),
    deleteFile: (filePath) => ipcRenderer.invoke('files:delete', filePath),
    batchRename: (dirPath, find, replace, options) => ipcRenderer.invoke('files:batchRename', dirPath, find, replace, options),
    writeText: (filePath, content) => ipcRenderer.invoke('files:writeText', filePath, content),
    mkdir: (dirPath) => ipcRenderer.invoke('files:mkdir', dirPath),
    copyFile: (src, dest) => ipcRenderer.invoke('files:copyFile', src, dest),
    moveFile: (src, dest) => ipcRenderer.invoke('files:moveFile', src, dest),
    exists: (filePath) => ipcRenderer.invoke('files:exists', filePath),
    searchContent: (rootDir, query, options) => ipcRenderer.invoke('files:searchContent', rootDir, query, options),
    readHead: (filePath, bytes) => ipcRenderer.invoke('files:readHead', filePath, bytes),
    watch: (dirPath) => ipcRenderer.invoke('files:watch', dirPath),
    unwatch: (dirPath) => ipcRenderer.invoke('files:unwatch', dirPath),
    onFileChange: (callback) => ipcRenderer.on('files:changed', (event, dir) => callback(dir)),
    removeFileChangeListener: () => ipcRenderer.removeAllListeners('files:changed')
  },
  // Email hub (IMAP/SMTP)
  email: {
    listProviders: () => ipcRenderer.invoke('email:listProviders'),
    oauthConfigured: () => ipcRenderer.invoke('email:oauthConfigured'),
    listAccounts: () => ipcRenderer.invoke('email:listAccounts'),
    testConnection: (cfg, password) => ipcRenderer.invoke('email:testConnection', cfg, password),
    addAccount: (cfg, password) => ipcRenderer.invoke('email:addAccount', cfg, password),
    addOAuthAccount: (opts) => ipcRenderer.invoke('email:addOAuthAccount', opts),
    updateAccount: (id, updates, password) => ipcRenderer.invoke('email:updateAccount', id, updates, password),
    removeAccount: (id) => ipcRenderer.invoke('email:removeAccount', id),
    listFolders: (accountId) => ipcRenderer.invoke('email:listFolders', accountId),
    listMessages: (accountId, folder, opts) => ipcRenderer.invoke('email:listMessages', accountId, folder, opts),
    listUnified: (opts) => ipcRenderer.invoke('email:listUnified', opts),
    getMessage: (accountId, folder, uid) => ipcRenderer.invoke('email:getMessage', accountId, folder, uid),
    search: (accountId, folder, query) => ipcRenderer.invoke('email:search', accountId, folder, query),
    setFlags: (accountId, folder, uid, flags, add) => ipcRenderer.invoke('email:setFlags', accountId, folder, uid, flags, add),
    move: (accountId, folder, uid, target) => ipcRenderer.invoke('email:move', accountId, folder, uid, target),
    deleteMessage: (accountId, folder, uid) => ipcRenderer.invoke('email:delete', accountId, folder, uid),
    sendMessage: (payload) => ipcRenderer.invoke('email:sendMessage', payload),
    scanInvites: () => ipcRenderer.invoke('email:scanInvites'),
    saveAttachment: (accountId, folder, uid, index, open) => ipcRenderer.invoke('email:saveAttachment', accountId, folder, uid, index, open),
  },
  // External calendar feeds (ICS): Brightspace, Google, iCloud, Outlook, etc.
  calendar: {
    fetchFeed: (url, source) => ipcRenderer.invoke('calendar:fetchFeed', url, source),
  },
  // Offline spell checker for note fields (see ipc/spell.js + renderer/spellcheck.js).
  spell: {
    check: (text) => ipcRenderer.invoke('spell:check', text),
    suggest: (word) => ipcRenderer.invoke('spell:suggest', word),
    add: (word) => ipcRenderer.invoke('spell:add', word),
  },
  // GitHub account link → commits on owned repos surface on the Timeline.
  github: {
    status: () => ipcRenderer.invoke('github:status'),
    connect: (token) => ipcRenderer.invoke('github:connect', token),
    disconnect: () => ipcRenderer.invoke('github:disconnect'),
    fetchActivity: (days) => ipcRenderer.invoke('github:fetchActivity', days),
  },
  // Git integration
  git: {
    // inspection
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    branches: (dir) => ipcRenderer.invoke('git:branches', dir),
    log: (dir, limit) => ipcRenderer.invoke('git:log', dir, limit),
    remotes: (dir) => ipcRenderer.invoke('git:remotes', dir),
    isRepo: (dir) => ipcRenderer.invoke('git:isRepo', dir),
    diff: (path) => ipcRenderer.invoke('git:diff', path),
    diffPath: (dir, relPath, staged) => ipcRenderer.invoke('git:diffPath', dir, relPath, staged),
    // staging
    stage: (path) => ipcRenderer.invoke('git:stage', path),
    unstage: (path) => ipcRenderer.invoke('git:unstage', path),
    stagePaths: (dir, paths) => ipcRenderer.invoke('git:stagePaths', dir, paths),
    unstagePaths: (dir, paths) => ipcRenderer.invoke('git:unstagePaths', dir, paths),
    stageAll: (dir) => ipcRenderer.invoke('git:stageAll', dir),
    unstageAll: (dir) => ipcRenderer.invoke('git:unstageAll', dir),
    discardPaths: (dir, paths) => ipcRenderer.invoke('git:discardPaths', dir, paths),
    discardAll: (dir) => ipcRenderer.invoke('git:discardAll', dir),
    // commit / history
    commit: (dir, msg, opts) => ipcRenderer.invoke('git:commit', dir, msg, opts),
    undoLastCommit: (dir) => ipcRenderer.invoke('git:undoLastCommit', dir),
    // branching
    createBranch: (dir, name, checkout) => ipcRenderer.invoke('git:createBranch', dir, name, checkout),
    checkout: (dir, name) => ipcRenderer.invoke('git:checkout', dir, name),
    deleteBranch: (dir, name, force) => ipcRenderer.invoke('git:deleteBranch', dir, name, force),
    renameBranch: (dir, oldName, newName) => ipcRenderer.invoke('git:renameBranch', dir, oldName, newName),
    merge: (dir, branch) => ipcRenderer.invoke('git:merge', dir, branch),
    // stash
    stash: (dir, msg) => ipcRenderer.invoke('git:stash', dir, msg),
    stashList: (dir) => ipcRenderer.invoke('git:stashList', dir),
    stashApply: (dir, ref, drop) => ipcRenderer.invoke('git:stashApply', dir, ref, drop),
    stashDrop: (dir, ref) => ipcRenderer.invoke('git:stashDrop', dir, ref),
    // network
    fetch: (dir) => ipcRenderer.invoke('git:fetch', dir),
    pull: (dir, opts) => ipcRenderer.invoke('git:pull', dir, opts),
    push: (dir, opts) => ipcRenderer.invoke('git:push', dir, opts),
    sync: (dir) => ipcRenderer.invoke('git:sync', dir),
    // lifecycle
    init: (dir) => ipcRenderer.invoke('git:init', dir),
    clone: (parentDir, url, dirName) => ipcRenderer.invoke('git:clone', parentDir, url, dirName),
    addRemote: (dir, name, url) => ipcRenderer.invoke('git:addRemote', dir, name, url),
    // in-progress ops / conflict resolution
    mergeStatus: (dir) => ipcRenderer.invoke('git:mergeStatus', dir),
    resolvePaths: (dir, paths, side) => ipcRenderer.invoke('git:resolvePaths', dir, paths, side),
    abort: (dir, state) => ipcRenderer.invoke('git:abort', dir, state),
    continueOp: (dir, state) => ipcRenderer.invoke('git:continueOp', dir, state),
    // commit-level operations
    revert: (dir, hash) => ipcRenderer.invoke('git:revert', dir, hash),
    cherryPick: (dir, hash) => ipcRenderer.invoke('git:cherryPick', dir, hash),
    reset: (dir, hash, mode) => ipcRenderer.invoke('git:reset', dir, hash, mode),
    checkoutCommit: (dir, hash) => ipcRenderer.invoke('git:checkoutCommit', dir, hash),
    branchAt: (dir, name, hash) => ipcRenderer.invoke('git:branchAt', dir, name, hash),
    lastCommitMessage: (dir) => ipcRenderer.invoke('git:lastCommitMessage', dir),
    // tags
    tags: (dir) => ipcRenderer.invoke('git:tags', dir),
    tagAt: (dir, name, hash, message) => ipcRenderer.invoke('git:tagAt', dir, name, hash, message),
    deleteTag: (dir, name) => ipcRenderer.invoke('git:deleteTag', dir, name),
    pushTag: (dir, name) => ipcRenderer.invoke('git:pushTag', dir, name),
    // remotes (write)
    removeRemote: (dir, name) => ipcRenderer.invoke('git:removeRemote', dir, name),
    renameRemote: (dir, oldN, newN) => ipcRenderer.invoke('git:renameRemote', dir, oldN, newN),
    setRemoteUrl: (dir, name, url) => ipcRenderer.invoke('git:setRemoteUrl', dir, name, url),
    // folder upload / download
    uploadFolder: (repoDir, srcFolder, opts) => ipcRenderer.invoke('git:uploadFolder', repoDir, srcFolder, opts),
    publishFolder: (srcFolder, remoteUrl, opts) => ipcRenderer.invoke('git:publishFolder', srcFolder, remoteUrl, opts),
    extractFolder: (srcFolder, destParent) => ipcRenderer.invoke('git:extractFolder', srcFolder, destParent),
    sparseDownload: (remoteUrl, subfolder, destParent, opts) => ipcRenderer.invoke('git:sparseDownload', remoteUrl, subfolder, destParent, opts),
    listFolders: (dir) => ipcRenderer.invoke('git:listFolders', dir),
    // raw cli
    raw: (dir, commandLine) => ipcRenderer.invoke('git:raw', dir, commandLine),
  }
};

if (__isAppFrame) contextBridge.exposeInMainWorld('api', __api);
