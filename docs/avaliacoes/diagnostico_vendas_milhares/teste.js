// Lê o arquivo como o importador do V2 (raw:true) e como uma leitura de texto formatado (raw:false), só a coluna de valor.
const fs = require('fs'); const path = require('path');
const vm = require('vm'); const caixa = { console, Uint8Array, ArrayBuffer, Date, Math }; caixa.self = caixa; vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'lib', 'xlsx.bundle.js'), 'utf8'), caixa); const XLSX = caixa.XLSX; // como no navegador
const buf = fs.readFileSync(process.argv[2]);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
const ws = wb.Sheets[wb.SheetNames[0]];
for (const raw of [true, false]) {
  const m = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw });
  const hi = m.findIndex(r => r.filter(c => typeof c === 'string' && c.trim()).length >= 5);
  const iv = m[hi].map(String).map(s => s.trim()).indexOf('Valor Venda');
  const vals = m.slice(hi + 1).map(r => r[iv]).filter(v => v !== '' && v != null);
  const asNum = v => { if (typeof v === 'number') return v; let s = String(v).trim().replace('R$','').trim(); const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
    if (c > -1 && d > -1) s = c > d ? s.replace(/\./g,'').replace(',','.') : s.replace(/,/g,''); else if (c > -1) s = s.replace(',','.'); return Number(s); };
  const n = vals.map(asNum);
  console.log(`raw:${raw} -> ${vals.length} valores | tipos: ${[...new Set(vals.map(v => typeof v))]} | abaixo de 1.000 depois do gbAsNumber: ${n.filter(x => x < 1000).length} | exemplo texto: ${vals.find(v => typeof v === 'string') || '-'}`);
}
