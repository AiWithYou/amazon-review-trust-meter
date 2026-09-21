'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const assets = new Set(['scoring-base.js','scoring-features.js','scoring.js','content.js','styles.css']);
http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = pathname === '/dp/B012345678' ? 'tests/fixtures/product.html' : assets.has(pathname.slice(1)) ? pathname.slice(1) : null;
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
  res.end(fs.readFileSync(path.join(root,file)));
}).listen(8766,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:8766/dp/B012345678'));
