// node --test tests/core.test.js   (datos inventados, nada real)
const test = require('node:test'), assert = require('node:assert');
const C = require('../core.js');
const hdr = [null, 'D. valor', 'Data', 'Concepte', 'Moviment', 'Import', 'Divisa', 'Disponible'];
const reglas = C.REGLAS_INICIALES.map(([patron, categoria, tipo]) => ({ patron, categoria, tipo }));

test('parsea cuenta, enmascara tarjeta y respeta duplicados idénticos', () => {
  const rows = [[null, 'Últims moviments'], hdr,
    [null, '05/10/2026', '06/10/2026', 'Bizum', 'Enviado: cafe', -3, 'EUR', 100],
    [null, '05/10/2026', '06/10/2026', 'Bizum', 'Enviado: cafe', -3, 'EUR', 97],
    [null, '04/10/2026', '04/10/2026', 'Recàrrega de targetes prepagament', '4918500420485338 01827013 128', -50, 'EUR', 47]];
  const p = C.parseBBVA(rows);
  assert.equal(p.kind, 'cuenta'); assert.equal(p.movs[0].fecha, '2026-10-05');
  assert.match(p.movs[2].detalle, /tarjeta \*5338/);
  const ids = C.assignIds(p.movs, 'cuenta_a').map((m) => m.id);
  assert.equal(new Set(ids).size, 3);
});

test('empareja recarga con tarjeta aunque el concepto no se parezca', () => {
  const a = { id: 'a', fecha: '2026-10-25', cuenta: 'cuenta_a', concepto: 'Recàrrega de targetes prepagament', detalle: '', importe: -300, categoria: C.INTERNA, tipo: 'neutro', pareja: '' };
  const t = { id: 't', fecha: '2026-10-25', cuenta: 'tarjeta', concepto: 'Creditos', detalle: '', importe: 300, categoria: C.SIN_CAT, tipo: 'ingreso', pareja: '' };
  const c = C.pairInternal([a, t]);
  assert.equal(c.length, 2); assert.ok(c.every((x) => x.tipo === 'neutro' && x.categoria === C.INTERNA));
});

test('reglas: hipoteca es gasto, bizum según signo', () => {
  assert.equal(C.classify({ concepto: 'Transferència efectuada', detalle: 'Hipoteca octubre', importe: -1500 }, reglas).categoria, 'Hipoteca');
  assert.equal(C.classify({ concepto: 'Bizum', detalle: 'Devuelto', importe: 10 }, reglas).tipo, 'ingreso');
});
