(function () {
  'use strict';
  const C = window.Core;
  const { CLIENT_ID, SHEET_NAME } = window.CONFIG;
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const ESQUEMA = 2;
  const $ = (id) => document.getElementById(id);
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const fdate = (iso) => String(iso).slice(8, 10) + '/' + String(iso).slice(5, 7) + '/' + String(iso).slice(0, 4);
  const mesLabel = (m) => new Date(m + '-15').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) { /* idem */ } },
  };

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }
  const bar = (pct) => { const i = document.createElement('i'); i.style.width = pct + '%'; return i; };
  const money = (n, signed) => el('span', { class: signed ? (n < 0 ? 'neg' : 'pos') : '' }, eur.format(n));

  // ---------- Estado ----------
  const S = { token: null, sheetId: null, rows: [], reglas: [], cuentas: [], presup: [], ambito: 'all', pend: [], limite: 200 };
  const cuentaDe = (key) => S.cuentas.find((c) => c.key === key);
  const ambitoDe = (key) => (cuentaDe(key) || {}).ambito || 'Personal';
  const nombreCuenta = (key) => (cuentaDe(key) || {}).nombre || key;
  const ambitos = () => [...new Set(S.cuentas.map((c) => c.ambito))];

  function say(text, err) {
    const m = $('msg');
    m.hidden = !text; m.textContent = text || ''; m.className = err ? 'err' : '';
  }

  /** Filas del ámbito elegido. Los traspasos entre ámbitos cuentan en cada ámbito y se anulan en «Todo». */
  function vista() {
    const sel = S.ambito, out = [];
    for (const r of S.rows) {
      if (sel !== 'all' && ambitoDe(r.cuenta) !== sel) continue;
      out.push(r.tipo === 'traspaso' ? { ...r, tipo: sel === 'all' ? 'neutro' : r.importe < 0 ? 'gasto' : 'ingreso', _o: r } : r);
    }
    return out;
  }

  // ---------- Google ----------
  class AuthError extends Error {}
  let tokenClient;
  function initAuth() {
    if (!window.google || !google.accounts) return setTimeout(initAuth, 200);
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE,
      callback: async (r) => {
        if (r.error) return say('No se pudo conectar: ' + r.error, true);
        S.token = r.access_token;
        resetIdle();
        await run(start);
      },
    });
    $('connect').disabled = false;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401) { S.token = null; throw new AuthError(); }
    if (!res.ok) throw new Error('Google respondió ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.json();
  }
  const SH = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const writeValues = (data) => post(`${SH}${S.sheetId}/values:batchUpdate`, { valueInputOption: 'RAW', data });
  const append = (range, values) => post(`${SH}${S.sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values });
  const getValues = async (range) => (await api(`${SH}${S.sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`)).values || [];

  async function run(fn) {
    try { await fn(); }
    catch (e) {
      if (e instanceof AuthError) { say('La sesión ha caducado. Pulsa «Conectar con Google».', true); $('connect').hidden = false; }
      else { console.error(e); say(e.message, true); }
    }
  }

  // ---------- Hoja: creación y migración ----------
  const CABECERA_CUENTAS = ['clave', 'nombre', 'ambito', 'tipo', 'saldo', 'saldo_fecha', 'esquema'];

  async function ensureSheet() {
    const q = encodeURIComponent(`name='${SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
    const found = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    if (found.files.length) return found.files[0].id;
    const created = await post(SH.slice(0, -1), {
      properties: { title: SHEET_NAME, locale: 'es_ES' },
      sheets: ['Movimientos', 'Reglas', 'Cuentas', 'Presupuestos'].map((title) => ({ properties: { title, gridProperties: { frozenRowCount: 1 } } })),
    });
    S.sheetId = created.spreadsheetId;
    await writeValues([
      { range: 'Movimientos!A1', values: [C.COLS] },
      { range: 'Reglas!A1', values: [['patron', 'categoria', 'tipo', 'ambito'], ...C.REGLAS_INICIALES.map((r) => [...r, ''])] },
      { range: 'Cuentas!A1', values: [CABECERA_CUENTAS, ...C.CUENTAS_INICIALES.map((c, i) => [c.key, c.nombre, c.ambito, c.tarjeta ? 'tarjeta' : 'cuenta', '', '', i === 0 ? ESQUEMA : ''])] },
      { range: 'Presupuestos!A1', values: [['ambito', 'categoria', 'mensual']] },
    ]);
    return S.sheetId;
  }

  /** Pasa una hoja creada con la versión anterior al esquema actual (ámbitos, presupuestos, traspasos). */
  async function migrar() {
    const meta = await api(`${SH}${S.sheetId}?fields=sheets.properties.title`);
    if (!meta.sheets.some((x) => x.properties.title === 'Presupuestos')) {
      await post(`${SH}${S.sheetId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: 'Presupuestos', gridProperties: { frozenRowCount: 1 } } } }] });
      await writeValues([{ range: 'Presupuestos!A1', values: [['ambito', 'categoria', 'mensual']] }]);
    }
    const cu = await getValues('Cuentas!A1:G20');
    if ((cu[1] || [])[6] === ESQUEMA) return;
    say('Actualizando tu hoja a la nueva versión…');

    // Deducimos qué cuenta es de empresa y cuál personal por lo que contiene.
    const mv = await getValues('Movimientos!C2:E');
    const hits = {};
    for (const [cuenta, conc, det] of mv) {
      const t = C.norm(String(conc || '') + ' ' + String(det || ''));
      const h = (hits[cuenta] = hits[cuenta] || { p: 0, e: 0 });
      if (/hipoteca/.test(t)) h.p++;
      if (/tgss|seguretat social|agroseguro|talenom|amortitzacio/.test(t)) h.e++;
    }
    const inferir = (key, def) => {
      const h = hits[key];
      if (h && h.e > 0 && h.p === 0) return 'Empresa';
      if (h && h.p > 0 && h.e === 0) return 'Personal';
      return def;
    };
    const viejo = Object.fromEntries(cu.slice(1).map((r) => [r[0], r]));
    const nombresPorDefecto = ['Cuenta A', 'Cuenta B', 'Tarjeta prepago'];
    const filas = C.CUENTAS_INICIALES.map((d, i) => {
      const amb = d.tarjeta ? 'Personal' : inferir(d.key, d.ambito);
      const old = viejo[d.key] && viejo[d.key][1];
      const nombre = old && !nombresPorDefecto.includes(old) ? old : d.tarjeta ? 'Tarjeta online' : amb === 'Empresa' ? 'Empresa (A)' : 'Personal (B)';
      return [d.key, nombre, amb, d.tarjeta ? 'tarjeta' : 'cuenta', '', '', i === 0 ? ESQUEMA : ''];
    });

    const rg = await getValues('Reglas!A2:D500');
    const trasp = ['traspas a compte', 'traspas des de compte', 'traspaso a cuenta', 'traspaso desde cuenta'];
    const reglas = rg.filter((r) => r[0]).map((r) => (trasp.includes(String(r[0])) ? [r[0], C.TRASPASO, 'traspaso', r[3] || ''] : [r[0], r[1] || '', r[2] || '', r[3] || '']));
    const tengo = new Set(reglas.map((r) => C.norm(r[0])));
    for (const [p, c, t] of C.REGLAS_INICIALES) if (!tengo.has(C.norm(p))) reglas.push([p, c, t, '']);

    await writeValues([
      { range: 'Cuentas!A1', values: [CABECERA_CUENTAS, ...filas] },
      { range: 'Reglas!A1', values: [['patron', 'categoria', 'tipo', 'ambito'], ...reglas] },
    ]);
  }

  async function load() {
    const g = await api(`${SH}${S.sheetId}/values:batchGet?ranges=Movimientos!A2:K&ranges=Reglas!A2:D&ranges=Cuentas!A2:F&ranges=Presupuestos!A2:C&ranges=Movimientos!K1&valueRenderOption=UNFORMATTED_VALUE`);
    const [mov, reg, cue, pre, hdr] = g.valueRanges.map((v) => v.values || []);
    if (!hdr.length) await writeValues([{ range: 'Movimientos!K1', values: [['nota']] }]);
    S.rows = mov.map((r, i) => C.fromRow(r, i + 2)).filter((r) => r.id);
    S.reglas = reg.filter((r) => r[0]).map((r) => ({ patron: String(r[0]), categoria: r[1] || C.SIN_CAT, tipo: r[2] || 'auto', ambito: r[3] ? String(r[3]) : '' }));
    S.cuentas = cue.map((r, i) => ({
      key: String(r[0] || ''), nombre: String(r[1] || r[0] || ''), ambito: String(r[2] || 'Personal'), tarjeta: r[3] === 'tarjeta',
      saldo: r[4] === '' || r[4] == null ? null : Number(r[4]), saldoFecha: r[5] ? String(r[5]) : '', fila: i + 2,
    })).filter((c) => c.key);
    S.presup = pre.map((r, i) => ({ ambito: String(r[0] || ''), categoria: String(r[1] || ''), mensual: Number(r[2]), fila: i + 2 })).filter((p) => p.ambito && p.categoria && p.mensual > 0);
    if (S.ambito !== 'all' && !ambitos().includes(S.ambito)) S.ambito = 'all';
  }

  /** Empareja traspasos/recargas y decide su tratamiento; guarda solo lo que cambia. */
  async function reconciliar() {
    const cambios = C.reconcile(S.rows, ambitoDe);
    if (!cambios.length) return 0;
    const byId = new Map(S.rows.map((r) => [r.id, r]));
    await writeValues(cambios.map((c) => { const r = byId.get(c.id); return { range: `Movimientos!H${r.fila}:J${r.fila}`, values: [[c.categoria, c.tipo, c.pareja]] }; }));
    for (const c of cambios) Object.assign(byId.get(c.id), c);
    return cambios.length;
  }

  async function start() {
    say('Abriendo tu hoja…');
    S.sheetId = await ensureSheet();
    await migrar();
    await load();
    const guardado = store.get('mc_ambito');
    if (guardado && (guardado === 'all' || ambitos().includes(guardado))) S.ambito = guardado;
    else S.ambito = ambitos()[0] || 'all';
    await reconciliar();
    say('');
    $('connect').hidden = true; $('welcome').hidden = true; $('tabs').hidden = false; $('pie').hidden = false;
    $('user').textContent = '';
    $('user').append(el('a', { href: 'https://docs.google.com/spreadsheets/d/' + S.sheetId, target: '_blank', rel: 'noopener' }, 'Abrir hoja'));
    show(S.rows.length ? 'resumen' : 'importar');
    render();
  }

  // ---------- Sesión: cerrar, bloqueo, clave ----------
  function signOut(texto) {
    const t = S.token;
    if (t && window.google) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignorar */ } }
    Object.assign(S, { token: null, sheetId: null, rows: [], reglas: [], cuentas: [], presup: [], pend: [] });
    for (const id of ['resumen', 'movs', 'importar', 'contexto', 'tabs', 'pie']) $(id).hidden = true;
    $('welcome').hidden = false; $('connect').hidden = false; $('user').textContent = '';
    say(texto || '');
  }
  $('lock').addEventListener('click', () => signOut('Sesión cerrada.'));

  let idle;
  function resetIdle() {
    clearTimeout(idle);
    if (S.token) idle = setTimeout(() => signOut('Sesión cerrada por inactividad.'), 10 * 60 * 1000);
  }
  for (const ev of ['click', 'keydown', 'touchstart', 'mousemove']) addEventListener(ev, resetIdle, { passive: true });

  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  let pinModo = null, pinCb = null;
  function abrirPin(modo, cb) {
    pinModo = modo; pinCb = cb;
    $('pin-title').textContent = modo === 'check' ? 'Clave de acceso' : 'Clave de acceso de esta app';
    $('pin-ayuda').textContent = modo === 'check' ? 'Introduce tu clave' : 'Nueva clave (déjala vacía para quitarla). Solo se guarda en este navegador.';
    $('pin-val').value = ''; $('pin-err').hidden = true;
    $('dlg-pin').showModal();
  }
  $('pin-cancel').addEventListener('click', () => $('dlg-pin').close());
  $('pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('pin-val').value;
    if (pinModo === 'check') {
      const g = JSON.parse(store.get('mc_pin') || '{}');
      if ((await sha(g.s + v)) !== g.h) { $('pin-err').textContent = 'Clave incorrecta.'; $('pin-err').hidden = false; return; }
      $('dlg-pin').close(); pinCb && pinCb();
    } else {
      if (!v) { store.del('mc_pin'); say('Clave quitada en este navegador.'); }
      else { const s = Math.random().toString(36).slice(2); store.set('mc_pin', JSON.stringify({ s, h: await sha(s + v) })); say('Clave guardada en este navegador.'); }
      $('dlg-pin').close();
    }
  });
  $('pinbtn').addEventListener('click', () => abrirPin('set'));
  $('connect').addEventListener('click', () => {
    const pedir = () => tokenClient.requestAccessToken({ prompt: '' });
    if (store.get('mc_pin')) abrirPin('check', pedir); else pedir();
  });

  // ---------- Pestañas y contexto ----------
  function show(tab) {
    for (const t of ['resumen', 'movs', 'importar']) $(t).hidden = t !== tab;
    $('contexto').hidden = tab === 'importar';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  }
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) { show(e.target.dataset.tab); render(); } });

  function render() { renderContexto(); renderResumen(); renderMovs(); renderLista(); renderCuentas(); }

  function renderContexto() {
    const opciones = [...ambitos(), 'all'];
    $('ambitos').replaceChildren(...opciones.map((a) => el('button', {
      class: a === S.ambito ? 'on' : '', role: 'tab', 'aria-selected': a === S.ambito ? 'true' : 'false',
      onclick: () => { S.ambito = a; store.set('mc_ambito', a); S.limite = 200; render(); },
    }, a === 'all' ? 'Todo' : a)));
    const cs = S.cuentas.filter((c) => !c.tarjeta && (S.ambito === 'all' || c.ambito === S.ambito));
    const items = cs.map((c) => {
      const s = c.saldo != null ? { saldo: c.saldo, fecha: c.saldoFecha } : C.saldoAproximado(S.rows, c.key);
      return s ? { c, s } : null;
    }).filter(Boolean);
    const chips = items.map(({ c, s }) => el('div', { class: 'chip', title: s.fecha ? 'Saldo a ' + fdate(s.fecha) : '' }, el('small', {}, c.nombre), el('b', {}, eur.format(s.saldo))));
    if (items.length > 1) chips.push(el('div', { class: 'chip tot' }, el('small', {}, 'Total'), el('b', {}, eur.format(items.reduce((a, x) => a + x.s.saldo, 0)))));
    $('saldos').replaceChildren(...chips);
  }

  const sinCat = () => vista().filter((r) => r.categoria === C.SIN_CAT);
  const presupuestoDe = (cat) => S.presup.find((p) => p.ambito === S.ambito && p.categoria === cat);

  // ---------- Resumen ----------
  const corto = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'k' : String(Math.round(n)));
  const mesCorto = (m) => new Date(m + '-15').toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
  const perLabel = (p) => (p === 'all' ? 'Todo el histórico' : p.length === 4 ? 'Año ' + p : mesLabel(p));

  function chartMeses(lista, sel, onPick) {
    const datos = lista.slice(0, 12).reverse();
    if (!datos.length) return el('p', { class: 'sub' }, 'Importa algún fichero para ver el gráfico.');
    const W = 720, H = 240, L = 40, T = 12, B = 28, R = 8;
    const max = Math.max(1, ...datos.flatMap((d) => [d.ingresos, d.gastos]));
    const p10 = Math.pow(10, Math.floor(Math.log10(max)));
    const techo = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => k * p10).find((v) => v >= max);
    const y = (v) => T + (H - T - B) * (1 - v / techo);
    const bw = (W - L - R) / datos.length;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Ingresos y gastos por mes' });
    for (let i = 0; i <= 4; i++) {
      const v = (techo / 4) * i;
      g.append(svg('line', { class: 'gl', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg('text', { class: 'ax', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, corto(v)));
    }
    datos.forEach((d, i) => {
      const x = L + i * bw, w = Math.min(14, bw * 0.34);
      if (d.mes === sel) g.append(svg('rect', { class: 'sel', x, y: T, width: bw, height: H - T - B, rx: 4 }));
      g.append(
        svg('rect', { class: 'b-ing', x: x + bw / 2 - w - 1, y: y(d.ingresos), width: w, height: Math.max(0, y(0) - y(d.ingresos)), rx: 2 }),
        svg('rect', { class: 'b-gas', x: x + bw / 2 + 1, y: y(d.gastos), width: w, height: Math.max(0, y(0) - y(d.gastos)), rx: 2 }),
        svg('text', { class: 'ax', x: x + bw / 2, y: H - 9, 'text-anchor': 'middle' }, mesCorto(d.mes)));
      const hit = svg('rect', { class: 'hit', x, y: T, width: bw, height: H - T - B }, svg('title', {}, `${mesLabel(d.mes)}\nIngresos ${eur.format(d.ingresos)}\nGastos ${eur.format(d.gastos)}\nNeto ${eur.format(d.neto)}`));
      hit.addEventListener('click', () => onPick(d.mes));
      g.append(hit);
    });
    return el('div', {}, g, el('div', { class: 'leg' }, el('span', {}, el('i', { class: 'f-ing' }), 'Ingresos'), el('span', {}, el('i', { class: 'f1' }), 'Gastos')));
  }

  function donut(items, total, per) {
    if (!items.length) return el('p', { class: 'sub' }, 'Sin gastos en este periodo.');
    const lista = items.slice(0, 7);
    const resto = items.slice(7).reduce((a, x) => a + x.total, 0);
    if (resto > 0) lista.push({ categoria: 'Otros', total: resto, otros: true });
    const R = 38, circ = 2 * Math.PI * R;
    const g = svg('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Gastos por categoría' });
    let off = 0;
    lista.forEach((it, i) => {
      const len = (it.total / total) * circ;
      g.append(svg('circle', { class: 's' + i, cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 14, 'stroke-dasharray': `${Math.max(0, len - 0.6)} ${circ}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 50 50)' }, svg('title', {}, `${it.categoria}: ${eur.format(it.total)}`)));
      off += len;
    });
    g.append(svg('text', { class: 'dn', x: 50, y: 52 }, eur.format(total)), svg('text', { class: 'dn2', x: 50, y: 63 }, 'gastos'));
    const esMes = /^\d{4}-\d{2}$/.test(per), puedePre = esMes && S.ambito !== 'all';
    const lg = el('div', { class: 'lg' }, lista.map((it, i) => {
      const b = puedePre && !it.otros ? presupuestoDe(it.categoria) : null;
      const pct = b ? Math.round((it.total / b.mensual) * 100) : null;
      return el('div', {},
        el('i', { class: 'f' + i }),
        puedePre && !it.otros ? el('button', { class: 'pill', title: 'Presupuesto mensual', onclick: () => abrirPresupuesto(it.categoria) }, it.categoria) : el('span', {}, it.categoria),
        el('span', { class: 'n' }, eur.format(it.total), ' ', el('small', {}, Math.round((it.total / total) * 100) + '%')),
        b ? el('div', { class: 'pre' + (pct > 100 ? ' over' : '') }, el('div', { class: 't' }, bar(Math.min(100, pct))), el('small', {}, `de ${eur.format(b.mensual)} · ${pct}%`)) : null);
    }));
    return el('div', { class: 'donutbox' }, g, lg);
  }

  function renderResumen() {
    const vs = vista();
    const meses = [...new Set(vs.map((r) => String(r.fecha).slice(0, 7)))].sort().reverse();
    const opts = [...meses, ...new Set(meses.map((m) => m.slice(0, 4))), 'all'];
    const sel = $('mes'); const prev = sel.value;
    sel.replaceChildren(...opts.map((p) => el('option', { value: p }, perLabel(p))));
    sel.value = opts.includes(prev) ? prev : opts[0];
    const per = sel.value;
    const s = C.summarize(vs, per), p = s.periodo;
    $('k-ing').replaceChildren(money(p.ingresos)); $('k-gas').replaceChildren(money(p.gastos)); $('k-net').replaceChildren(money(p.neto, true));
    $('k-aho').textContent = p.ahorro == null ? '—' : Math.round(p.ahorro * 100) + '%';
    $('notas').replaceChildren(...C.notas(vs, per, (n) => eur.format(n)).map((t) => el('li', {}, t)));
    $('chart-meses').replaceChildren(chartMeses(s.meses, per, (m) => { $('mes').value = m; renderResumen(); }));
    $('donut').replaceChildren(donut(s.gastos, s.gastos.reduce((a, x) => a + x.total, 0), per));
    $('pre-ayuda').hidden = !(/^\d{4}-\d{2}$/.test(per) && S.ambito !== 'all' && s.gastos.length);
    $('top').tBodies[0].replaceChildren(...s.top.map((r) => el('tr', {},
      el('td', {}, C.titulo(r), el('div', { class: 'sub' }, fdate(r.fecha) + ' · ' + r.categoria)), el('td', { class: 'n' }, eur.format(-r.importe)))));
    $('cats-ingreso').replaceChildren(...(s.ingresos.length ? s.ingresos.map((i) => el('div', { class: 'r' }, el('span', {}, i.categoria), el('span', { class: 'n' }, eur.format(i.total)))) : [el('p', { class: 'sub' }, 'Sin ingresos en este periodo.')]));
    const dv = /^\d{4}-\d{2}$/.test(per) ? C.desvios(vs, per) : [];
    $('sec-desvios').hidden = !dv.length;
    $('desvios').tBodies[0].replaceChildren(...dv.map((d) => el('tr', {}, el('td', {}, d.categoria), el('td', { class: 'n' }, eur.format(d.actual)), el('td', { class: 'n' }, eur.format(d.media)), el('td', { class: 'n neg' }, '+' + eur.format(d.diff)))));
    const fijos = C.recurrentes(vs);
    $('fijos').tBodies[0].replaceChildren(...fijos.map((f) => el('tr', {}, el('td', {}, f.nombre), el('td', {}, f.categoria), el('td', { class: 'n' }, eur.format(f.importe)))));
    $('fijos-total').textContent = fijos.length ? `Total aproximado: ${eur.format(fijos.reduce((a, x) => a + x.importe, 0))} al mes (mismo importe en 3 o más meses).` : 'Aún no hay suficientes meses para detectar gastos fijos.';
    $('meses').tBodies[0].replaceChildren(...s.meses.slice(0, 12).map((m) => el('tr', {},
      el('td', {}, mesLabel(m.mes)), el('td', { class: 'n' }, eur.format(m.ingresos)), el('td', { class: 'n' }, eur.format(m.gastos)), el('td', { class: 'n' }, money(m.neto, true)))));
    const n = sinCat().length;
    $('revisar').hidden = !n; $('revisar').textContent = n + ' sin categoría · revisar';
  }
  $('mes').addEventListener('change', renderResumen);
  $('revisar').addEventListener('click', (e) => { e.preventDefault(); $('f-sin').checked = true; $('q').value = ''; $('f-mes').value = ''; show('movs'); renderMovs(); });

  // ---------- Presupuestos ----------
  let preCat = null;
  function abrirPresupuesto(cat) {
    preCat = cat;
    const b = presupuestoDe(cat);
    $('pre-title').textContent = `${cat} · ${S.ambito}`;
    $('pre-val').value = b ? b.mensual : '';
    $('pre-quitar').hidden = !b;
    $('dlg-pre').showModal();
  }
  $('pre-cancel').addEventListener('click', () => $('dlg-pre').close());
  $('pre-quitar').addEventListener('click', () => run(async () => {
    const b = presupuestoDe(preCat);
    $('dlg-pre').close();
    if (b) { await writeValues([{ range: `Presupuestos!A${b.fila}:C${b.fila}`, values: [['', '', '']] }]); await load(); render(); }
  }));
  $('pre-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Number($('pre-val').value);
    $('dlg-pre').close();
    if (!(v > 0)) return;
    run(async () => {
      const b = presupuestoDe(preCat);
      if (b) await writeValues([{ range: `Presupuestos!C${b.fila}`, values: [[v]] }]);
      else await append('Presupuestos!A:C', [[S.ambito, preCat, v]]);
      await load(); render();
    });
  });

  // ---------- Movimientos ----------
  function renderMovs() {
    const fc = $('f-cuenta'), fm = $('f-mes');
    const pc = fc.value, pm = fm.value;
    const vs = vista();
    fc.replaceChildren(el('option', { value: '' }, 'Todas las cuentas'), ...S.cuentas.filter((c) => S.ambito === 'all' || c.ambito === S.ambito).map((c) => el('option', { value: c.key }, c.nombre)));
    fm.replaceChildren(el('option', { value: '' }, 'Todos los meses'), ...[...new Set(vs.map((r) => String(r.fecha).slice(0, 7)))].sort().reverse().map((m) => el('option', { value: m }, mesLabel(m))));
    fc.value = pc; fm.value = pm;
    const q = C.norm($('q').value);
    const rows = vs.filter((r) =>
      (!fc.value || r.cuenta === fc.value) && (!fm.value || String(r.fecha).startsWith(fm.value)) &&
      (!$('f-sin').checked || r.categoria === C.SIN_CAT) &&
      (!q || C.norm(r.concepto + ' ' + r.detalle + ' ' + r.categoria + ' ' + (r.nota || '')).includes(q)))
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.fila - a.fila);
    $('tabla').tBodies[0].replaceChildren(...rows.slice(0, S.limite).map((r) => el('tr', {},
      el('td', {}, fdate(r.fecha)),
      el('td', {}, nombreCuenta(r.cuenta)),
      el('td', {}, C.titulo(r), C.titulo(r) !== r.concepto ? el('div', { class: 'sub' }, r.concepto) : null),
      el('td', { class: 'n' }, money(r.importe, true)),
      el('td', {}, el('button', { class: 'pill' + (r.categoria === C.SIN_CAT ? ' sin' : ''), onclick: () => editar(r._o || r) }, r.categoria + (r.tipo === 'neutro' ? ' · no computa' : '')), r.nota ? el('div', { class: 'nota' }, r.nota) : null))));
    $('mas').hidden = rows.length <= S.limite;
  }
  for (const id of ['q', 'f-cuenta', 'f-mes', 'f-sin']) $(id).addEventListener('input', () => { S.limite = 200; renderMovs(); });
  $('mas').addEventListener('click', () => { S.limite += 300; renderMovs(); });

  // ---------- Editar categoría ----------
  let editando = null;
  function editar(r) {
    editando = r;
    $('dlg-title').textContent = C.titulo(r) + ' · ' + eur.format(r.importe);
    $('d-cat').value = C.esAuto(r.categoria) || r.categoria === C.SIN_CAT ? '' : r.categoria;
    $('d-pat').value = C.suggestPattern(r);
    $('d-tipo').value = 'auto';
    $('d-nota').value = r.nota || '';
    $('d-solo').checked = true; $('d-amb').textContent = ambitoDe(r.cuenta);
    $('cats-list').replaceChildren(...[...new Set([...S.rows.map((x) => x.categoria), ...S.reglas.map((x) => x.categoria)])].filter((c) => c !== C.SIN_CAT).sort().map((c) => el('option', { value: c })));
    $('dlg').showModal();
  }
  $('d-cancel').addEventListener('click', () => $('dlg').close());
  $('dlg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const categoria = $('d-cat').value.trim(), patron = $('d-pat').value.trim(), tipoSel = $('d-tipo').value, nota = $('d-nota').value.trim();
    const amb = $('d-solo').checked ? ambitoDe(editando.cuenta) : '';
    $('dlg').close();
    if (!categoria) return;
    run(async () => {
      const tipoDe = (r) => (tipoSel === 'auto' ? (r.importe < 0 ? 'gasto' : 'ingreso') : tipoSel);
      const cambios = new Map([[editando.fila, editando]]);
      editando.categoria = categoria; editando.tipo = tipoDe(editando); editando.nota = nota;
      if (patron) {
        const pn = C.norm(patron);
        for (const r of S.rows) {
          if (r.categoria === C.SIN_CAT && C.norm(r.concepto + ' ' + r.detalle).includes(pn) && (!amb || ambitoDe(r.cuenta) === amb)) {
            r.categoria = categoria; r.tipo = tipoDe(r); cambios.set(r.fila, r);
          }
        }
        await append('Reglas!A:D', [[patron, categoria, tipoSel, amb]]);
        S.reglas.push({ patron, categoria, tipo: tipoSel, ambito: amb });
      }
      await writeValues([...cambios.values()].map((r) => ({ range: `Movimientos!H${r.fila}:K${r.fila}`, values: [[r.categoria, r.tipo, r.pareja || '', r.nota || '']] })));
      say(cambios.size > 1 ? `Actualizados ${cambios.size} movimientos y guardada la regla.` : 'Guardado.');
      render();
    });
  });

  // ---------- Importar ----------
  const dropEl = $('drop');
  $('files').addEventListener('change', (e) => addFiles([...e.target.files]));
  dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('over'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
  dropEl.addEventListener('drop', (e) => { e.preventDefault(); dropEl.classList.remove('over'); addFiles([...e.dataTransfer.files]); });

  async function addFiles(files) {
    for (const f of files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
        const p = C.parseBBVA(rows);
        const opciones = S.cuentas.filter((c) => c.tarjeta === (p.kind === 'tarjeta')).map((c) => c.key);
        const sug = opciones.length === 1 ? opciones[0] : C.suggestAccount(p.movs, S.rows, opciones);
        S.pend.push({ name: f.name, p, opciones, cuenta: sug || '' });
      } catch (err) { say(f.name + ': ' + err.message, true); }
    }
    $('files').value = '';
    renderLista();
  }

  function nuevos(pf) {
    if (!pf.cuenta) return null;
    const have = new Set(S.rows.map((r) => r.id));
    return C.assignIds(pf.p.movs, pf.cuenta).filter((m) => !have.has(m.id));
  }

  function renderLista() {
    $('lista').replaceChildren(...S.pend.map((pf, i) => {
      const n = nuevos(pf);
      const fechas = pf.p.movs.map((m) => m.fecha).sort();
      const sel = el('select', { onchange: (e) => { pf.cuenta = e.target.value; renderLista(); } },
        el('option', { value: '' }, 'Elige la cuenta…'),
        ...pf.opciones.map((k) => el('option', { value: k, selected: k === pf.cuenta }, `${nombreCuenta(k)} · ${ambitoDe(k)}`)));
      return el('div', { class: 'file' },
        el('b', {}, pf.name),
        el('span', { class: 'sub' }, `${pf.p.kind === 'tarjeta' ? 'Tarjeta' : 'Cuenta'} · ${pf.p.movs.length} movimientos · ${fechas.length ? fdate(fechas[0]) + ' – ' + fdate(fechas[fechas.length - 1]) : ''}`),
        sel,
        el('span', {}, n == null ? '' : `${n.length} nuevos, ${pf.p.movs.length - n.length} ya estaban`),
        el('button', { onclick: () => { S.pend.splice(i, 1); renderLista(); } }, 'Quitar'));
    }));
    const ok = S.pend.length && S.pend.every((pf) => pf.cuenta);
    const dup = new Set(S.pend.map((pf) => pf.cuenta)).size < S.pend.length;
    $('go').hidden = !S.pend.length;
    $('go').disabled = !ok || dup;
    $('go').title = dup ? 'Dos ficheros apuntan a la misma cuenta' : '';
  }

  $('go').addEventListener('click', () => run(async () => {
    $('go').disabled = true;
    say('Importando…');
    await load(); // por si has tocado la hoja a mano
    const añadidos = [];
    const have = new Set(S.rows.map((r) => r.id));
    for (const pf of S.pend) {
      const amb = ambitoDe(pf.cuenta);
      for (const m of C.assignIds(pf.p.movs, pf.cuenta)) if (!have.has(m.id)) { have.add(m.id); añadidos.push({ ...m, ...C.classify(m, S.reglas, amb), pareja: '' }); }
    }
    añadidos.sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (añadidos.length) {
      await append('Movimientos!A:K', añadidos.map(C.toRow));
      await load();
      await reconciliar();
    }
    // Saldo actual de cada cuenta, tal como lo informa el banco.
    const saldos = [];
    for (const pf of S.pend) {
      const c = cuentaDe(pf.cuenta), us = pf.p.kind === 'cuenta' ? C.ultimoSaldo(pf.p.movs) : null;
      if (c && us && (!c.saldoFecha || us.fecha >= c.saldoFecha)) saldos.push({ range: `Cuentas!E${c.fila}:F${c.fila}`, values: [[us.saldo, us.fecha]] });
    }
    if (saldos.length) { await writeValues(saldos); await load(); }
    S.pend = [];
    const n = sinCat().length;
    say(`Importados ${añadidos.length} movimientos nuevos.` + (n ? ` Hay ${n} sin categoría.` : ''));
    show('resumen'); render();
  }));

  // ---------- Cuentas ----------
  function renderCuentas() {
    $('ambitos-list').replaceChildren(...ambitos().map((a) => el('option', { value: a })));
    $('cuentas').replaceChildren(...S.cuentas.map((c) => {
      const guardar = () => run(async () => {
        c.nombre = nombre.value.trim() || c.nombre; c.ambito = amb.value.trim() || c.ambito;
        await writeValues([{ range: `Cuentas!B${c.fila}:C${c.fila}`, values: [[c.nombre, c.ambito]] }]);
        say('Cuenta actualizada.'); render();
      });
      const nombre = el('input', { value: c.nombre, 'aria-label': 'Nombre', onchange: guardar });
      const amb = el('input', { value: c.ambito, list: 'ambitos-list', 'aria-label': 'Ámbito', onchange: guardar });
      return el('div', { class: 'cuenta' }, nombre, amb, el('small', {}, c.tarjeta ? 'tarjeta' : 'cuenta'));
    }));
  }
  $('nueva').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = $('n-nombre').value.trim(), ambito = $('n-ambito').value.trim(), tipo = $('n-tipo').value;
    if (!nombre || !ambito) return;
    run(async () => {
      await append('Cuentas!A:F', [['c' + Date.now().toString(36), nombre, ambito, tipo, '', '']]);
      await load();
      $('nueva').reset();
      say('Cuenta añadida.'); render();
    });
  });

  $('connect').disabled = true;
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) say('Falta el ID de cliente de Google en config.js (mira el README).', true);
  else initAuth();
})();
