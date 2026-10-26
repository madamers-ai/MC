/* Lógica pura: parseo de ficheros BBVA, ids, reglas, emparejado de traspasos y resumen.
   No toca el DOM ni la red, así se puede probar con Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIN_CAT = 'Sin categoría';
  const INTERNA = 'Transferencia interna';

  // Las claves no cambian nunca; los nombres se editan en la pestaña "Cuentas" de la hoja.
  const CUENTAS = [
    { key: 'cuenta_a', nombre: 'Cuenta A', tarjeta: false },
    { key: 'cuenta_b', nombre: 'Cuenta B', tarjeta: false },
    { key: 'tarjeta', nombre: 'Tarjeta prepago', tarjeta: true },
  ];

  // [patrón (sin tildes, minúsculas), categoría, tipo]. Gana la primera que coincida.
  // tipo: gasto | ingreso | neutro (no computa) | auto (según el signo del importe)
  const REGLAS_INICIALES = [
    ['recarrega de targetes', INTERNA, 'neutro'],
    ['recarga de tarjetas', INTERNA, 'neutro'],
    ['carga tjt', INTERNA, 'neutro'],
    ['traspas a compte', INTERNA, 'neutro'],
    ['traspas des de compte', INTERNA, 'neutro'],
    ['traspaso a cuenta', INTERNA, 'neutro'],
    ['traspaso desde cuenta', INTERNA, 'neutro'],
    ['prestec provisional', 'Préstamo a 9metall', 'neutro'],
    ['retorn prestec', 'Préstamo a 9metall', 'neutro'],
    ['amortitzacio de prestec', 'Préstamo (cuota)', 'gasto'],
    ['hipoteca', 'Hipoteca', 'gasto'],
    ['nomina h9mw', 'Nómina', 'ingreso'],
    ['seguretat social', 'Seguridad Social', 'gasto'],
    ['tgss', 'Seguridad Social', 'gasto'],
    ['agroseguro', 'Seguros', 'gasto'],
    ['occident', 'Seguros', 'gasto'],
    ['talenom', 'Gestoría', 'gasto'],
    ["pagament d'impostos", 'Impuestos', 'gasto'],
    ['agricola y ganadera', 'Agrícola y ganadera', 'gasto'],
    ['subv', 'Ayudas y subvenciones', 'ingreso'],
    ['ajut', 'Ayudas y subvenciones', 'ingreso'],
    ['pagament fr', 'Facturas proveedores', 'gasto'],
    ['pagament factura', 'Facturas proveedores', 'gasto'],
    ['anthropic', 'Suscripciones IA', 'auto'],
    ['google one', 'Suscripciones', 'auto'],
    ['youtube', 'Suscripciones', 'auto'],
    ['suno', 'Suscripciones', 'auto'],
    ['blizzard', 'Ocio', 'auto'],
    ['bizum', 'Bizum', 'auto'],
  ];

  /** Texto corto para mostrar: el detalle, salvo que sea solo una referencia. */
  const titulo = (r) => {
    const d = r.detalle || '';
    return !d || /^(?:n\s)?\d{8,}|^(?:cuenta|tarjeta|iban) \*|^c[aà]rrec n[uú]m/i.test(d) ? r.concepto || d : d;
  };

  const norm = (s) =>
    String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  // Nada de números de tarjeta o cuenta completos en la hoja: solo los 4 últimos.
  function maskSensitive(s) {
    return s
      .replace(/\b[3-6]\d{11}(\d{4})\b(?:\s\d{8}\s\d{3})?/g, (_, l4) => 'tarjeta *' + l4)
      .replace(/\b\d{4}-\d{4}-\d{2}-\d{6}(\d{4})\b/g, (_, l4) => 'cuenta *' + l4)
      .replace(/\bES\d{2}(?:\s?\d{4}){4}\s?\d{2}(\d{2})\b/gi, (_, l2) => 'IBAN *' + l2);
  }
  const clean = (v) => maskSensitive(String(v == null ? '' : v).replace(/\s+/g, ' ').trim());

  // ---------- Parseo ----------
  const HEAD = {
    fecha: ['data', 'fecha'],
    fvalor: ['d. valor', 'f. valor', 'd.valor', 'f.valor', 'data valor', 'fecha valor'],
    concepto: ['concepte', 'concepto'],
    movimiento: ['moviment', 'movimiento'],
    importe: ['import', 'importe'],
    saldo: ['disponible'],
    tarjeta: ['targeta', 'tarjeta'],
  };

  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  function parseAmount(v) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    if (v == null) return null;
    let s = String(v).replace(/[€\s]|EUR/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }

  /** rows: array de arrays (hoja completa). Devuelve {kind:'cuenta'|'tarjeta', movs, omitidas}. */
  function parseBBVA(rows) {
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 40) && hi < 0; i++) {
      const cells = (rows[i] || []).map(norm);
      const m = {};
      for (const [k, names] of Object.entries(HEAD)) {
        const idx = cells.findIndex((c) => names.includes(c));
        if (idx >= 0) m[k] = idx;
      }
      if (m.importe != null && m.concepto != null && (m.fecha != null || m.fvalor != null)) {
        hi = i; map = m;
      }
    }
    if (hi < 0) throw new Error('No reconozco el formato: no encuentro las columnas Data / Concepte / Import.');
    const kind = map.tarjeta != null ? 'tarjeta' : 'cuenta';
    const movs = [];
    let omitidas = 0;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (r.every((c) => c == null || c === '')) continue;
      const fecha = parseDate(kind === 'cuenta' && map.fvalor != null && r[map.fvalor] ? r[map.fvalor] : r[map.fecha]);
      const importe = parseAmount(r[map.importe]);
      if (!fecha || importe == null) { omitidas++; continue; }
      const saldo = map.saldo != null ? parseAmount(r[map.saldo]) : null;
      movs.push({
        fecha,
        concepto: clean(r[map.concepto]),
        detalle: map.movimiento != null ? clean(r[map.movimiento]) : '',
        importe,
        saldo,
      });
    }
    return { kind, movs, omitidas };
  }

  // ---------- Identidad / duplicados ----------
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const contentKey = (m) => [m.fecha, m.importe.toFixed(2), norm(m.concepto + ' ' + m.detalle)].join('|');

  /** El banco no da ID. Id = hash(cuenta+contenido) + nº de ocurrencia dentro del fichero,
      así dos movimientos idénticos el mismo día no se confunden ni se pierden. */
  function assignIds(movs, cuenta) {
    const seen = new Map();
    return movs.map((m) => {
      const k = cuenta + '|' + contentKey(m);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      return { ...m, cuenta, id: hash(k) + '-' + n };
    });
  }

  /** Cuál de las cuentas existentes se parece más al fichero (por movimientos en común). */
  function suggestAccount(movs, existentes, candidatas) {
    const sets = new Map(candidatas.map((c) => [c, new Set()]));
    for (const r of existentes) if (sets.has(r.cuenta)) sets.get(r.cuenta).add(contentKey(r));
    let best = null, bestN = 0;
    for (const [c, set] of sets) {
      const n = movs.reduce((a, m) => a + (set.has(contentKey(m)) ? 1 : 0), 0);
      if (n > bestN) { best = c; bestN = n; }
    }
    return best;
  }

  // ---------- Categorías ----------
  function classify(m, reglas) {
    const txt = norm(m.concepto + ' ' + m.detalle);
    for (const r of reglas) {
      const p = norm(r.patron);
      if (p && txt.includes(p)) {
        const tipo = r.tipo && r.tipo !== 'auto' ? r.tipo : m.importe < 0 ? 'gasto' : 'ingreso';
        return { categoria: r.categoria, tipo };
      }
    }
    return { categoria: SIN_CAT, tipo: m.importe < 0 ? 'gasto' : 'ingreso' };
  }

  /** Patrón sugerido para crear una regla a partir de un movimiento. */
  function suggestPattern(m) {
    const base = norm(titulo(m)).split(/[\d*+]/)[0].replace(/[^a-z' ]+$/g, '').trim();
    return base.length >= 3 ? base : '';
  }

  const transferLike = (r) => /traspas|transfer|recar|carga tjt/.test(norm(r.concepto + ' ' + r.detalle));
  const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

  /** Empareja salidas y entradas del mismo importe entre cuentas distintas (±5 días):
      recargas de la tarjeta, traspasos entre cuentas. Devuelve solo los cambios. */
  function pairInternal(rows, maxDias = 5) {
    const libres = rows.filter((r) => !r.pareja && (r.categoria === SIN_CAT || r.categoria === INTERNA));
    const porCent = new Map();
    for (const r of libres) {
      const c = Math.round(r.importe * 100);
      if (!porCent.has(c)) porCent.set(c, []);
      porCent.get(c).push(r);
    }
    const cand = [];
    for (const [c, list] of porCent) {
      if (c <= 0) continue;
      const neg = porCent.get(-c) || [];
      for (const a of list) for (const b of neg) {
        if (a.cuenta === b.cuenta) continue;
        const esTarjeta = a.cuenta === 'tarjeta' || b.cuenta === 'tarjeta';
        if (!esTarjeta && !(transferLike(a) && transferLike(b))) continue;
        const d = Math.abs(dayNum(a.fecha) - dayNum(b.fecha));
        if (d <= maxDias) cand.push({ a, b, d });
      }
    }
    cand.sort((x, y) => x.d - y.d);
    const usados = new Set(), cambios = [];
    for (const { a, b } of cand) {
      if (usados.has(a.id) || usados.has(b.id)) continue;
      usados.add(a.id); usados.add(b.id);
      cambios.push({ id: a.id, categoria: INTERNA, tipo: 'neutro', pareja: b.id });
      cambios.push({ id: b.id, categoria: INTERNA, tipo: 'neutro', pareja: a.id });
    }
    return cambios;
  }

  // ---------- Resumen ----------
  const r2 = (x) => Math.round(x * 100) / 100;
  const inPer = (fecha, per) => per === 'all' || String(fecha).startsWith(per);

  /** per: 'all' | 'YYYY' | 'YYYY-MM' */
  function summarize(rows, per) {
    const meses = new Map();
    const cat = { gasto: new Map(), ingreso: new Map() };
    const periodo = { ingresos: 0, gastos: 0, n: 0 };
    const gastosRows = [];
    for (const r of rows) {
      if (r.tipo !== 'gasto' && r.tipo !== 'ingreso') continue;
      const m = String(r.fecha).slice(0, 7);
      if (!meses.has(m)) meses.set(m, { mes: m, ingresos: 0, gastos: 0 });
      const o = meses.get(m);
      if (r.tipo === 'ingreso') o.ingresos += r.importe; else o.gastos += -r.importe; // reembolsos restan
      if (inPer(r.fecha, per)) {
        const v = r.tipo === 'ingreso' ? r.importe : -r.importe;
        cat[r.tipo].set(r.categoria, (cat[r.tipo].get(r.categoria) || 0) + v);
        if (r.tipo === 'ingreso') periodo.ingresos += v; else periodo.gastos += v;
        periodo.n++;
        if (r.tipo === 'gasto' && r.importe < 0) gastosRows.push(r);
      }
    }
    periodo.ingresos = r2(periodo.ingresos); periodo.gastos = r2(periodo.gastos);
    periodo.neto = r2(periodo.ingresos - periodo.gastos);
    periodo.ahorro = periodo.ingresos > 0 ? periodo.neto / periodo.ingresos : null;
    const lista = [...meses.values()].sort((a, b) => b.mes.localeCompare(a.mes))
      .map((o) => ({ mes: o.mes, ingresos: r2(o.ingresos), gastos: r2(o.gastos), neto: r2(o.ingresos - o.gastos) }));
    const top = (m) => [...m].map(([categoria, total]) => ({ categoria, total: r2(total) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
    return {
      meses: lista, periodo, gastos: top(cat.gasto), ingresos: top(cat.ingreso),
      top: gastosRows.sort((a, b) => a.importe - b.importe).slice(0, 5),
    };
  }

  /** Gastos que se repiten: misma categoría e importe exacto en >=3 meses distintos y aún activos. */
  function recurrentes(rows) {
    const grupos = new Map();
    let ultimoMes = '';
    for (const r of rows) {
      const m = String(r.fecha).slice(0, 7);
      if (m > ultimoMes) ultimoMes = m;
      if (r.tipo !== 'gasto' || r.importe >= 0) continue;
      const k = r.categoria + '|' + Math.round(-r.importe * 100);
      if (!grupos.has(k)) grupos.set(k, { categoria: r.categoria, importe: -r.importe, meses: new Set(), textos: new Map() });
      const g = grupos.get(k);
      g.meses.add(m);
      const t = titulo(r);
      g.textos.set(t, (g.textos.get(t) || 0) + 1);
    }
    if (!ultimoMes) return [];
    const [y, mm] = ultimoMes.split('-').map(Number);
    const limite = new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7); // activo: visto el último mes o el anterior
    return [...grupos.values()]
      .filter((g) => g.meses.size >= 3 && [...g.meses].some((m) => m >= limite))
      .map((g) => ({
        nombre: g.textos.size === 1 && !/\*\d/.test([...g.textos.keys()][0]) ? [...g.textos.keys()][0] : g.categoria,
        categoria: g.categoria, importe: r2(g.importe), meses: g.meses.size,
      }))
      .sort((a, b) => b.importe - a.importe);
  }

  /** Frases con lo más llamativo del periodo. fmt formatea euros. */
  function notas(rows, per, fmt) {
    const out = [];
    const s = summarize(rows, per), p = s.periodo;
    if (!p.n) return out;
    if (/^\d{4}-\d{2}$/.test(per)) {
      const [y, m] = per.split('-').map(Number);
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      const pm = s.meses.find((x) => x.mes === prev);
      if (pm && pm.gastos > 0 && p.gastos > 0) {
        const d = ((p.gastos - pm.gastos) / pm.gastos) * 100;
        out.push(`Gastas ${fmt(p.gastos)}, un ${Math.abs(Math.round(d))}% ${d >= 0 ? 'más' : 'menos'} que el mes anterior (${fmt(pm.gastos)}).`);
      }
    }
    if (s.gastos.length && p.gastos > 0) {
      const g = s.gastos[0];
      out.push(`Tu mayor gasto es «${g.categoria}»: ${fmt(g.total)}, el ${Math.round((g.total / p.gastos) * 100)}% del total.`);
    }
    if (s.top.length) {
      const t = s.top[0], f = String(t.fecha);
      out.push(`El movimiento más grande: ${titulo(t)} (${fmt(-t.importe)}, ${f.slice(8)}/${f.slice(5, 7)}).`);
    }
    const rec = recurrentes(rows);
    if (rec.length) out.push(`Gastos fijos que se repiten cada mes: unos ${fmt(rec.reduce((a, x) => a + x.importe, 0))} (${rec.length} conceptos).`);
    if (p.ingresos === 0 && p.gastos > 0) out.push('No hay ingresos registrados en este periodo: puede que falte importar alguna cuenta.');
    else if (p.neto < 0) out.push('Los gastos superan a los ingresos registrados.');
    const sin = rows.filter((r) => r.categoria === SIN_CAT && inPer(r.fecha, per)).length;
    if (sin) out.push(`${sin} movimiento${sin > 1 ? 's' : ''} sin categoría en este periodo.`);
    return out;
  }

  // ---------- Hoja <-> objetos ----------
  const COLS = ['id', 'fecha', 'cuenta', 'concepto', 'detalle', 'importe', 'saldo', 'categoria', 'tipo', 'pareja', 'nota'];
  const toRow = (m) => COLS.map((c) => (m[c] == null ? '' : m[c]));
  function fromRow(arr, rowNumber) {
    const o = { fila: rowNumber };
    COLS.forEach((c, i) => (o[c] = arr[i] === undefined ? '' : arr[i]));
    o.importe = Number(o.importe);
    o.saldo = o.saldo === '' ? null : Number(o.saldo);
    return o;
  }

  return {
    SIN_CAT, INTERNA, CUENTAS, REGLAS_INICIALES, COLS,
    norm, parseBBVA, assignIds, suggestAccount, classify, suggestPattern,
    pairInternal, summarize, recurrentes, notas, titulo, toRow, fromRow, contentKey,
  };
});
