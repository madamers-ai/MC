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

const amb = (c) => (c === 'cuenta_b' ? 'Empresa' : 'Personal');

test('recarga de tarjeta (mismo ámbito) es interna; nómina empresa->personal es traspaso en cada lado', () => {
  const f = (o) => ({ saldo: null, detalle: '', pareja: '', categoria: C.SIN_CAT, tipo: 'ingreso', ...o });
  const rows = [
    f({ id: 'a', fecha: '2026-10-25', cuenta: 'cuenta_a', concepto: 'Recàrrega de targetes prepagament', importe: -300 }),
    f({ id: 't', fecha: '2026-10-25', cuenta: 'tarjeta', concepto: 'Creditos', importe: 300 }),
    f({ id: 'e', fecha: '2026-09-21', cuenta: 'cuenta_b', concepto: 'Traspàs a compte', importe: -2400, categoria: C.TRASPASO, tipo: 'traspaso' }),
    f({ id: 'p', fecha: '2026-09-21', cuenta: 'cuenta_a', concepto: 'Traspàs des de compte', importe: 2400, categoria: C.TRASPASO, tipo: 'traspaso' }),
  ];
  const by = Object.fromEntries(C.reconcile(rows, amb).map((c) => [c.id, c]));
  assert.equal(by.a.categoria, C.INTERNA); assert.equal(by.t.tipo, 'neutro');
  assert.equal(by.e.categoria, 'Traspaso a Personal'); assert.equal(by.p.categoria, 'Traspaso desde Empresa');
  assert.equal(by.p.tipo, 'traspaso');
});

test('desvíos: detecta categoría que sube sobre la media', () => {
  const g = (f, c, i) => ({ fecha: f, categoria: c, importe: -i, tipo: 'gasto' });
  const rows = [g('2026-07-05', 'Ocio', 50), g('2026-08-05', 'Ocio', 60), g('2026-09-05', 'Ocio', 55), g('2026-10-05', 'Ocio', 200)];
  const d = C.desvios(rows, '2026-10');
  assert.equal(d.length, 1); assert.equal(d[0].categoria, 'Ocio');
});

test('último saldo: toma la fila más reciente del fichero', () => {
  const r = C.ultimoSaldo([{ fecha: '2026-10-25', saldo: 100 }, { fecha: '2026-01-04', saldo: 5 }]);
  assert.equal(r.saldo, 100); assert.equal(r.fecha, '2026-10-25');
});

test('reglas: hipoteca es gasto, bizum según signo', () => {
  assert.equal(C.classify({ concepto: 'Transferència efectuada', detalle: 'Hipoteca octubre', importe: -1500 }, reglas).categoria, 'Hipoteca');
  assert.equal(C.classify({ concepto: 'Bizum', detalle: 'Devuelto', importe: 10 }, reglas).tipo, 'ingreso');
});

test('referencias de 16 dígitos no se confunden con tarjetas; el título evita referencias', () => {
  const rows = [[null, 'x'], hdr, [null, '30/09/2026', '30/09/2026', 'Càrrec talenom slu', 'Càrrec núm 2026243001215441', -247.02, 'EUR', 1]];
  const m = C.parseBBVA(rows).movs[0];
  assert.match(m.detalle, /2026243001215441/);
  assert.equal(C.titulo(m), 'Càrrec talenom slu');
});

test('detecta gasto fijo en 3 meses', () => {
  const mk = (f) => ({ fecha: f, importe: -9.99, categoria: 'Suscripciones', tipo: 'gasto', concepto: 'Suno inc.', detalle: '' });
  const r = C.recurrentes([mk('2026-08-01'), mk('2026-09-01'), mk('2026-10-01')]);
  assert.equal(r.length, 1); assert.equal(r[0].nombre, 'Suno inc.');
});
