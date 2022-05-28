const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const process = require('process')
const glob = require('glob')
const {promisify} = require('util')
const _ = require('lodash')
const AdmZip = require('adm-zip')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const superagent = require('superagent')
require('superagent-proxy')(superagent)

let STORE_PATH = app.getPath('userData')
if (!fs.existsSync(STORE_PATH)) {
  fs.mkdirSync(STORE_PATH)
}

try {
  fs.accessSync(path.join(process.cwd(), 'portable'))
  STORE_PATH = process.cwd()
} catch {
  STORE_PATH = app.getPath('userData')
}

const TEMP_PATH = path.join(STORE_PATH, 'tmp')
const COVER_PATH = path.join(STORE_PATH, 'cover')
const VIEWER_PATH = path.join(STORE_PATH, 'viewer')

fs.mkdir(TEMP_PATH, {recursive: true}, (err) => {
  if (err) throw err
})
fs.mkdir(COVER_PATH, {recursive: true}, (err)=>{
  if (err) throw err
})
fs.mkdir(VIEWER_PATH, {recursive: true}, (err)=>{
  if (err) throw err
})

let setting
try {
  setting = JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'setting.json'), {encoding: 'utf-8'}))
} catch {
  setting = {
    proxy: undefined,
    library: app.getPath('downloads'),
    imageExplorer: 'C:\\Windows\\explorer.exe',
    pageSize: 10,
    loadOnStart: false
  }
  fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), {encoding: 'utf-8'})
}


let mainWindow
function createWindow () {
  const win = new BrowserWindow({
    width: 1560,
    height: 1000,
    webPreferences: {
      // nodeIntegration: true,
      // contextIsolation: false,
      // webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })

  win.loadFile('dist/index.html')
  // win.loadURL('http://localhost:3000')
  // win.webContents.openDevTools()
  win.setMenuBarVisibility(false)
  win.webContents.on('did-finish-load', ()=>{
    let name = "EH漫画管理"
    let version = require('./package.json').version
    win.setTitle(name + " " + version)
  })
  win.once('ready-to-show', () => {
    win.show()
  })
  return win
}
app.disableHardwareAcceleration()
app.whenReady().then(()=>{
  mainWindow = createWindow()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
})

app.on('ready', async () => {
  // await session.defaultSession.loadExtension(path.resolve(__dirname,'./6.0.12_0'))
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
})



ipcMain.handle('load-doujinshi-list', async (event, scan)=>{
  if (scan) {
    let list = await promisify(glob)('**/*.zip', {
      cwd: setting.library
    })
    let existData
    try {
      existData = JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), {encoding: 'utf-8'}))
    } catch {
      existData = []
    }
    for (let i = 0; i < list.length; i++) {
      try {
        let filepath = path.join(setting.library, list[i])
        let foundData = _.find(existData, {filepath: filepath})
        if (!foundData) {
          let id = nanoid()
          let {coverPath, tempCoverPath} = await geneCover(filepath, id)
          if (coverPath && tempCoverPath){
            existData.push({
              title: path.basename(filepath),
              coverPath,
              tempCoverPath,
              filepath,
              id,
              status: 'non-tag',
              exist: true,
              date: Date.now()
            })
            mainWindow.webContents.send('send-message', `load ${i+1} of ${list.length}`)
          }
        } else {
          foundData.exist = true
        }
        if ((i+1) % 100 == 0) mainWindow.webContents.send('send-message', `load ${i+1} of ${list.length}`)
      } catch {
        mainWindow.webContents.send('send-message', `load ${list[i]} failed`)
      }
    }
    existData = _.filter(existData, {exist: true})
    _.forIn(existData, b=>b.exist = undefined)
    fs.promises.writeFile(path.join(STORE_PATH, 'bookList.json'), JSON.stringify(existData, null, '  '), {encoding: 'utf-8'})
    return existData
  } else {
    return JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), {encoding: 'utf-8'}))
  }
})

let geneCover = async (filepath, id) => {
  let zip = new AdmZip(filepath)
  let zipFileList = zip.getEntries()
  let tempCoverPath
  let coverPath
  if (zipFileList[0].isDirectory) {
    zip.extractEntryTo(zipFileList[0], TEMP_PATH)
    let subFileList = await fs.promises.readdir(path.join(TEMP_PATH, zipFileList[0].entryName))
    subFileList = subFileList.sort((a,b)=>a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
    tempCoverPath = path.join(TEMP_PATH, id + path.extname(subFileList[0]))
    await fs.promises.rename(path.join(TEMP_PATH, zipFileList[0].entryName, subFileList[0]), tempCoverPath)
    await fs.promises.rm(path.join(TEMP_PATH, zipFileList[0].entryName), {recursive: true})
    coverPath = path.join(COVER_PATH, id + path.extname(subFileList[0]))
  } else {
    zipFileList = zipFileList.sort((a,b)=>a.entryName.localeCompare(b.entryName, undefined, {numeric: true, sensitivity: 'base'}))
    zip.extractEntryTo(zipFileList[0], TEMP_PATH)
    tempCoverPath = path.join(TEMP_PATH, id + path.extname(zipFileList[0].entryName))
    await fs.promises.rename(path.join(TEMP_PATH, zipFileList[0].entryName), tempCoverPath)
    coverPath = path.join(COVER_PATH, id + path.extname(zipFileList[0].entryName))
  }

  let imageResizeResult = await sharp(tempCoverPath)
  .resize(500, 720, {
    fit: 'contain'
  })
  .toFile(coverPath)
  .catch(()=>{
    fs.promises.rm(tempCoverPath, {recursive: true})
    return false
  })
  if (imageResizeResult){
    return {coverPath, tempCoverPath}
  } else {
    return {coverPath:undefined, tempCoverPath:undefined}
  }

}

ipcMain.handle('force-gene-book-list', async (event, ...arg)=>{
  await fs.promises.rm(TEMP_PATH, {recursive: true, force: true})
  await fs.promises.mkdir(TEMP_PATH, {recursive: true})
  await fs.promises.rm(COVER_PATH, {recursive: true, force: true})
  await fs.promises.mkdir(COVER_PATH, {recursive: true})
  let list = await promisify(glob)('**/*.zip', {
    cwd: setting.library
  })
  let data = []
  for (let i = 0; i < list.length; i++) {
    try {
      filepath = path.join(setting.library, list[i])
      let id = nanoid()
      let {coverPath, tempCoverPath} = await geneCover(filepath, id)
      if (coverPath && tempCoverPath){
        data.push({
          title: path.basename(filepath),
          coverPath,
          tempCoverPath,
          filepath,
          id,
          status: 'non-tag',
          date: Date.now()
        })
      }
      mainWindow.webContents.send('send-message', `load ${i+1} of ${list.length}`)
    } catch {
      mainWindow.webContents.send('send-message', `load ${list[i]} failed`)
    }
  }
  fs.promises.writeFile(path.join(STORE_PATH, 'bookList.json'), JSON.stringify(data, null, '  '), {encoding: 'utf-8'})
  return data
})


ipcMain.handle('open-local-book', async (event, filepath)=>{
  spawn(setting.imageExplorer, [filepath])
})

ipcMain.handle('delete-local-book', async (event, filepath)=>{
  return shell.trashItem(filepath)
})


ipcMain.handle('get-ex-url', async (event, {hash, cookie})=>{
  if (setting.proxy) {
    return await superagent
    .get(`https://exhentai.org/?f_shash=${hash}&fs_exp=on`)
    .set('Cookie', cookie)
    .proxy(setting.proxy)
    .then(res=>{
      return res.text
    })
  } else {
    return await superagent
    .get(`https://exhentai.org/?f_shash=${hash}&fs_exp=on`)
    .set('Cookie', cookie)
    .then(res=>{
      return res.text
    })
  }
})

ipcMain.handle('get-cover-hash', async (event, filepath)=>{
  return createHash('sha1').update(fs.readFileSync(filepath)).digest('hex')
})

ipcMain.handle('save-book-list', async (event, list)=>{
  return await fs.promises.writeFile(path.join(STORE_PATH, 'bookList.json'), JSON.stringify(list, null, '  '), {encoding: 'utf-8'})
})

ipcMain.handle('select-folder', async (event, type)=>{
  let result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('select-file', async (event, type)=>{
  let result = await dialog.showOpenDialog({
    properties: ['openFile']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('load-setting', async (event, arg)=>{
  return JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'setting.json'), {encoding: 'utf-8'}))
})

ipcMain.handle('save-setting', async (event, receiveSetting)=>{
  setting = receiveSetting
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
  return await fs.promises.writeFile(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), {encoding: 'utf-8'})
})

ipcMain.handle('export-database', async (event, arg)=>{
  let bookList = JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), {encoding: 'utf-8'}))
  let database = bookList.map(book=>{
    try {
      if (!book.hash) {
        book.hash = createHash('sha1').update(fs.readFileSync(book.tempCoverPath)).digest('hex')
      }
      return _.pick(book, ['hash', 'tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'url'])
    } catch {
      return {}
    }
  })
  return database
})

ipcMain.handle('load-import-database', async (event, arg)=>{
  let result = await dialog.showOpenDialog({
    properties: ['openFile']
  })
  if (!result.canceled) {
    return JSON.parse(fs.readFileSync(result.filePaths[0], {encoding: 'utf-8'}))
  } else {
    return []
  }
})

ipcMain.handle('open-url', async(event, url)=>{
  shell.openExternal(url)
})

ipcMain.handle('load-manga-image-list', async(event, filepath)=>{
  await fs.promises.rm(VIEWER_PATH, {recursive: true, force: true})
  await fs.promises.mkdir(VIEWER_PATH, {recursive: true})
  let zip = new AdmZip(filepath)
  zip.extractAllTo(VIEWER_PATH, true)
  let list = await promisify(glob)('**/*.@(jpg|jpeg|png|gif|webp)', {
    cwd: VIEWER_PATH,
    nocase: true
  })
  list = list.map(f=>path.join(VIEWER_PATH, f)).sort((a,b)=>a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
  let result = []
  for (let filepath of list) {
    let metadata = await sharp(filepath).metadata()
    result.push({
      id: nanoid(),
      filepath,
      width: metadata.width,
      height: metadata.height
    })
  }
  return result
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

process.on('exit', () => {
  app.quit()
})