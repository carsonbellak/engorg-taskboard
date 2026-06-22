const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
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
  // Git integration
  git: {
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    stage: (path) => ipcRenderer.invoke('git:stage', path),
    unstage: (path) => ipcRenderer.invoke('git:unstage', path),
    commit: (dir, msg) => ipcRenderer.invoke('git:commit', dir, msg),
    diff: (path) => ipcRenderer.invoke('git:diff', path),
    isRepo: (dir) => ipcRenderer.invoke('git:isRepo', dir)
  }
});
