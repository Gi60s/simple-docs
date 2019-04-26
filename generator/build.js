'use strict'
const ejs = require('ejs')
const { EOL } = require('os')
const files = require('./files')
const marked = require('marked')
const path = require('path')
const sass = require('sass')

const rxHttp = /^https?:\/\//
const rxMarkdownFilePath = /\.md$/i

// TODO: delete build destination contents prior to each build
// TODO: do not let source and destination be the same
// TODO: fix table of contents to have valid link references
// TODO: document SCSS in template creation
// TODO: update documented default colors for default template

module.exports = async function (source, destination, template) {
  const stats = await files.stat(source)
  if (!stats.isDirectory()) throw Error('Source must be a directory')

  // get the build configuration
  const configFilePath = path.resolve(source, 'simple-docs.js')
  let config
  try {
    delete require.cache[configFilePath]
    config = require(configFilePath)
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      throw Error('Missing required configuration file "simple-docs.js" in source directory')
    } else {
      throw err
    }
  }

  // locate the template directory to use
  if (!template) template = path.resolve(__dirname, '..', 'templates', 'default')
  const layouts = await (async () => {
    const layoutsDir = path.resolve(template, 'layouts')
    const fileNames = await files.readdir(layoutsDir)
    const result = {}
    const promises = fileNames.map(async fileName => {
      const content = await files.readFile(path.resolve(layoutsDir, fileName), 'utf8')
      const key = path.basename(fileName, path.extname(fileName))
      result[key] = ejs.compile(content)
    })
    await Promise.all(promises)
    return result
  })()

  // acquire the site structure
  const structure = await getSiteStructure({
    destination,
    map: {},
    root: source,
    source
  })
  // console.log(JSON.stringify(structure, (key, value) => key === 'parent' ? undefined : value, 2))

  // organize navigation
  const nav = organizeNavigation(structure, source, true)
  // console.log(JSON.stringify(navigation, (key, value) => key === 'parent' ? undefined : value, 2))

  // flatten the structure
  const map = flattenSiteStructure(structure, {})

  // copy over all assets except css directory
  const assetsDir = path.resolve(template, 'assets')
  if (await files.isDirectory(assetsDir)) {
    const dest = path.resolve(destination, 'assets')
    await files.ensureDirectoryExists(dest)
    await files.copy(assetsDir, dest, source => {
      const rel = path.relative(assetsDir, source)
      return rel !== 'css'
    })
  }

  // build the template css
  const sassDirectoryPath = path.resolve(assetsDir, 'css')
  const sassMain = path.resolve(sassDirectoryPath, 'main.scss')
  if (await files.isFile(sassMain)) await new Promise(async (resolve, reject) => {
    const vars = config.cssVars
    const rxVariables = /^(\$\S+) *([\s\S]+?); *(?:\/\/ *VAR *(\w+))?$/gm
    const content = await files.readFile(sassMain, 'utf8')
    let data = ''
    let index = 0
    let match
    while ((match = rxVariables.exec(content))) {
      const key = match[3]
      data += content.substring(index, match.index) + match[1] + ' ' +
        (key && vars[key] ? vars[key] : match[2]) + ';'
      index = match.index + match[0].length
    }
    data += content.substring(index)

    const options = {
      data,
      includePaths: [ sassDirectoryPath ]
    }
    sass.render(options, async function (err, result) {
      if (err) return reject(err)
      const dest = path.resolve(destination, 'assets', 'css')
      await files.ensureDirectoryExists(dest)
      await files.writeFile(path.resolve(dest, 'main.css'), result.css)
      resolve()
    })
  })

  // build the static site
  await build({ destination, layouts, map, nav, root: source, site: config, source })
}

async function build ({ destination, layouts, map, nav, root, site, source }) {
  const stats = await files.stat(source)
  const rel = path.relative(root, source)
  // const dest = path.resolve(destination, rel)

  if (stats.isDirectory()) {
    await files.ensureDirectoryExists(destination)
    const fileNames = await files.readdir(source)
    const promises = fileNames.map(async fileName => {
      return build({
        destination: path.resolve(destination, fileName),
        layouts,
        map,
        nav,
        root,
        site,
        source: path.resolve(source, fileName)
      })
    })
    return Promise.all(promises)

  } else if (stats.isFile()) {
    const ext = path.extname(source)
    const data = map[rel]
    if (data) {
      if (ext.toLowerCase() === '.md') {
        const params = {
          content: marked(data.content),
          navigation: createNavHtml(nav, rel, 0),
          page: Object.assign({}, data.page, {
            description: site.description || data.page.description || '',
            directory: path.dirname(data.path),
            fileName: path.basename(data.path),
            path: data.path
          }),
          site: Object.assign({}, site, {
            basePath: '/' + (site.url || '/').replace(/^https?:\/\/[\s\S]+?(?:\/|$)/, ''),
            navigation: site.hasOwnProperty('navigation') ? site.navigation : true
          }),
          toc: buildToc(data.content, data.page.toc)
        }
        const html = layouts[data.page.layout || 'default'](params)
        const destinationPath = path.resolve(path.dirname(destination), path.basename(destination, ext) + '.html')
        await files.writeFile(destinationPath, html)
      } else if (source !== path.resolve(root, 'simple-docs.js')) {
        await files.copy(source, destination)
      }
    } else if (source !== path.resolve(root, 'simple-docs.js')) {
      await files.copy(source, destination)
    }
  }
}

function buildToc (content, tocDepth) {
  const root = { level: 0, children: [] }
  const rxHeadings = /(?:^(#{1,6}) +([\s\S]+?)$|^(\S+)(?:\r\n|\r|\n)([=-])+$)/gm

  content = content.replace(/^`{3}[\s\S]+?```/gm, '')
  tocDepth = tocDepth === 'true' ? 6 : +tocDepth
  if (isNaN(tocDepth) || tocDepth <= 0) return ''

  let match
  let last = root
  while ((match = rxHeadings.exec(content))) {
    const next = {
      children: [],
      level: match[4]
        ? match[4] === '=' ? 1 : 2
        : match[1].length,
      title: match[2] || match[3]
    }

    if (next.level > last.level) {
      next.parent = last
      last.children.push(next)
    } else if (next.level === last.level) {
      next.parent = last.parent
      next.parent.children.push(next)
    } else {
      let p = last.parent
      while (p.level !== next.level) p = p.parent
      next.parent = p.parent
      next.parent.children.push(next)
    }

    last = next
  }

  return root.children.length ? '<ul class="toc">' + buildTocHtml(root.children, tocDepth, 1) + '</ul>' : ''
}

function buildTocHtml (children, allowedDepth, depth) {
  let html = ''
  children.forEach(child => {
    html += '<li><a href="#">' + child.title + '</a>'
    if (child.children.length > 0 && allowedDepth > depth) {
      html += '<ul>' + buildTocHtml(child.children, allowedDepth, depth + 1) + '</ul>'
    }
    html += '</li>'
  })
  return html
}

function createNavHtml (nav, currentPath, depth) {
  let html = ''
  if (depth > 0) {
    html += '<li' + (nav.path === currentPath ? ' class="current-page"' : '') + '>'
    let route = '/' + nav.path.replace(/(?:^|\/)index.md/i, '').replace(/\.md$/, '')
    html += '<a href="' + route + '">' + nav.title + '</a>'
  }
  if (nav.links) {
    html += '<ul>'
    nav.links.forEach(link => {
      html += createNavHtml(link, currentPath, depth + 1)
    })
    html += '</ul>'
  }
  if (depth > 0) html += '</li>'
  return html
}

function flattenSiteStructure (structure, map) {
  if (!structure.ignore) {
    if (structure.path) map[structure.path] = structure;
    if (structure.links) {
      structure.links.forEach(item => flattenSiteStructure(item, map))
    }
  }
  return map;
}

async function getSiteStructure (options) {
  const { source } = options
  const stats = await files.stat(source)
  if (stats.isDirectory()) {
    const fileNames = await files.readdir(source)
    options.map.links = []
    const promises = fileNames
      .map(async fileName => {
        const map = { parent: options.map }
        options.map.fileName = path.basename(source)
        options.map.path = path.relative(options.root, source)
        options.map.links.push(map)
        return getSiteStructure({
          destination: path.resolve(options.destination, fileName),
          map,
          root: options.root,
          source: path.resolve(source, fileName)
        })
      })
    await Promise.all(promises)
  } else if (stats.isFile()) {
    const ext = path.extname(source)
    if (ext.toLowerCase() === '.md') {
      let rawContent = await files.readFile(source, 'utf8')

      // convert internal links that end in .md to their correct navigation equivalent
      const rxFixLinks = /(\[[^\]]+?]) *(: *([\s\S]+?)$|\(([\s\S]+?)\))/gm
      let content = ''
      let index = 0
      let match
      while ((match = rxFixLinks.exec(rawContent))) {
        const link = match[3] || match[4]
        if (!rxHttp.test(link) && rxMarkdownFilePath.test(link)) {
          const newLink = link.substring(0, link.length - 3)
          content += rawContent.substring(index, match.index) + match[1] +
            (match[2].startsWith(':') ? ': ' + newLink : '(' + newLink + ')')
        } else {
          content += rawContent.substring(index, match.index) + match[0]
        }
        index = match.index + match[0].length
      }
      content += rawContent.substring(index)
      if (source.indexOf('default.md') !== -1) console.log(content)

      // pull off the headers and read them
      match = /(?:^---([\s\S]+?)---$\s*)?([\s\S]+)?/gm.exec(content)
      if (match && match[1]) {
        const params = { toc: 'true' }
        match[1]
          .split(EOL)
          .forEach(line => {
            const index = line.indexOf(':')
            const key = index !== -1 ? line.substring(0, index).trim() : line
            if (key) params[key] = index !== -1 ? line.substring(index + 1).trim() : ''
          })
        options.map.fileName = path.basename(source, ext)
        options.map.path = path.relative(options.root, source)
        options.map.page = params
        options.map.content = (match[2] || '').trim()
        options.map.navMenu = params.navMenu ? parseMetaString(params.navMenu) : true
        if (path.basename(source, ext) === 'index') {
          options.map.index = true
          options.map.parent.navMenu = options.map.navMenu
          if (params.navOrder) options.map.navOrder = params.navOrder.split(/ +/)
        }
      }
    } else if (path.basename(source) !== 'simple-docs.js') {
      options.map.copy = true
      options.map.navMenu = false
      options.map.path = path.relative(options.root, source)
    } else {
      options.map.ignore = true
      options.map.navMenu = false
    }
  }
  return options.map
}

function organizeNavigation (structure, source, isRoot) {
  const index = structure.links.find(v => v.index)
  if (!index) throw Error('Missing required index.md file in directory: ' + path.resolve(source, structure.path))
  const result = {
    fileName: index.fileName,
    navName: index.fileName === 'index' ? index.path.replace(/\/?index\.md$/, '').split(path.sep).pop() : index.fileName,
    path: index.path,
    title: index.page.title
  }

  const filteredLinks = structure.links.filter(item => item.navMenu && !item.index && !item.ignore)
  if (filteredLinks.length) {
    result.links = filteredLinks.map(item => {
      if (item.links) {
        return organizeNavigation(item, source, false)
      } else {
        return {
          fileName: item.fileName,
          navName: item.fileName === 'index' ? item.path.replace(/\/?index\.md$/, '').split(path.sep).pop() : item.fileName,
          path: item.path,
          title: item.page.title
        }
      }
    })

    result.links.sort((a, b) => {
      if (index.navOrder) {
        const i = index.navOrder.indexOf(a.navName)
        const j = index.navOrder.indexOf(b.navName)
        if (i === -1 && j === -1) return a.title < b.title ? -1 : 1
        if (i !== -1 && j === -1) return -1
        if (i === -1 && j !== -1) return 1
        return i < j ? -1 : 1
      } else {
        return a.title < b.title ? -1 : 1
      }
    })
  }

  if (isRoot) {
    if (!result.links) result.links = []
    result.links.unshift({
      fileName: index.fileName,
      navName: index.fileName === 'index' ? index.path.replace(/\/?index\.md$/, '').split(path.sep).pop() : index.fileName,
      path: index.path,
      title: index.page.title
    })
  }

  return result
}

function parseMetaString (value) {
  if (value === 'false') return false
  if (value === 'true') return true
  return value
}
