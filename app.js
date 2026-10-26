(function () {
  'use strict';
  const C = window.Core;
  const { CLIENT_ID, SHEET_NAME } = window.CONFIG;
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const $ = (id) => document.getElementById(id);
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const fdate = (iso) => iso.slice(8) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  const mesLabel = (m) => new Date(m + '-15').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

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
  const bar = (pct) => { const i = document.createElement('i'); i.style.width = pct + '%'; return i; };
  const money = (n, signed) => { const s = eur.format(n); return el('span', { class: signed ? (n < 0 ? 'neg' : 'pos') : '' }, s); };

  // ---------- Estado ----------
  const S = { token: null, sheetId: null, rows: [], reglas: [], cuentas: {}, pend: [], limite: 200 };

  function say(text, err) {
    const m = $('msg');
    m.hidden = !text; m.textContent = text || ''; m.className = err ? 'err' : '';
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
        await run(start);
      },
    });
    $('connect').disabled = false;
  }
  $('connect').addEventListener('click', () => tokenClient.requestAccessToken({ prompt: S.token ? '' : 'select_account' }));

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

  async function run(fn) {
    try { await fn(); }
    catch (e) {
      if (e instanceof AuthError) { say('La sesión ha caducado. Pulsa «Conectar con Google».', true); $('connect').hidden = false; }
      else { console.error(e); say(e.message, true); }
    }
  }

  async function ensureSheet() {
    const q = encodeURIComponent(`name='${SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
    const found = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    if (found.files.length) return found.files[0].id;
    const created = await post(SH.slice(0, -1), {
      properties: { title: SHEET_NAME, locale: 'es_ES' },
      sheets: [
        { properties: { title: 'Movimientos', gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: 'Reglas', gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: 'Cuentas', gridProperties: { frozenRowCount: 1 } } },
      ],
    });
    const id = created.spreadsheetId;
    await post(`${SH}${id}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: [
        { range: 'Movimientos!A1', values: [C.COLS] },
        { range: 'Reglas!A1', values: [['patron', 'categoria', 'tipo'], ...C.REGLAS_INICIALES] },
        { range: 'Cuentas!A1', values: [['clave', 'nombre'], ...C.CUENTAS.map((c) => [c.key, c.nombre])] },
      ],
    });
    return id;
  }

  async function load() {
    const g = await api(`${SH}${S.sheetId}/values:batchGet?ranges=Movimientos!A2:K&ranges=Reglas!A2:C&ranges=Cuentas!A2:B&ranges=Movimientos!K1&valueRenderOption=UNFORMATTED_VALUE`);
    const [mov, reg, cue, hdr] = g.valueRanges.map((v) => v.values || []);
    if (!hdr.length) await post(`${SH}${S.sheetId}/values:batchUpdate`, { valueInputOption: 'RAW', data: [{ range: 'Movimientos!K1', values: [['nota']] }] });
    S.rows = mov.map((r, i) => C.fromRow(r, i + 2)).filter((r) => r.id);
    S.reglas = reg.filter((r) => r[0]).map((r) => ({ patron: String(r[0]), categoria: r[1] || C.SIN_CAT, tipo: r[2] || 'auto' }));
    S.cuentas = Object.fromEntries(C.CUENTAS.map((c) => [c.key, c.nombre]));
    for (const r of cue) if (S.cuentas[r[0]] !== undefined && r[1]) S.cuentas[r[0]] = String(r[1]);
  }

  async function start() {
    say('Abriendo tu hoja…');
    S.sheetId = await ensureSheet();
    await load();
    say('');
    $('connect').hidden = true; $('welcome').hidden = true; $('tabs').hidden = false;
    $('user').textContent = '';
    $('user').append(el('a', { href: 'https://docs.google.com/spreadsheets/d/' + S.sheetId, target: '_blank', rel: 'noopener' }, 'Abrir hoja'));
    show(S.rows.length ? 'resumen' : 'importar');
    render();
  }

  // ---------- Pestañas ----------
  function show(tab) {
    for (const t of ['resumen', 'movs', 'importar']) $(t).hidden = t !== tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  }
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) { show(e.target.dataset.tab); render(); } });

  function render() { renderResumen(); renderMovs(); renderLista(); }

  const mesesDisponibles = () => [...new Set(S.rows.map((r) => String(r.fecha).slice(0, 7)))].sort().reverse();
  const sinCat = () => S.rows.filter((r) => r.categoria === C.SIN_CAT);

  // ---------- Resumen ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }
  const corto = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'k' : String(Math.round(n)));
  const mesCorto = (m) => new Date(m + '-15').toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
  const perLabel = (p) => (p === 'all' ? 'Todo el histórico' : p.length === 4 ? 'Año ' + p : mesLabel(p));

  function periodos() {
    const meses = mesesDisponibles();
    const años = [...new Set(meses.map((m) => m.slice(0, 4)))];
    return [...meses, ...años, 'all'];
  }

  function chartMeses(lista, sel, onPick) {
    const datos = lista.slice(0, 12).reverse(); // cronológico
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

  function donut(items, total) {
    if (!items.length) return el('p', { class: 'sub' }, 'Sin gastos en este periodo.');
    let lista = items.slice(0, 7);
    const resto = items.slice(7).reduce((a, x) => a + x.total, 0);
    if (resto > 0) lista.push({ categoria: 'Otros', total: resto });
    const R = 38, circ = 2 * Math.PI * R;
    const g = svg('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Gastos por categoría' });
    let off = 0;
    lista.forEach((it, i) => {
      const len = (it.total / total) * circ;
      g.append(svg('circle', { class: 's' + i, cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 14, 'stroke-dasharray': `${Math.max(0, len - 0.6)} ${circ}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 50 50)' }, svg('title', {}, `${it.categoria}: ${eur.format(it.total)}`)));
      off += len;
    });
    g.append(svg('text', { class: 'dn', x: 50, y: 52 }, eur.format(total).replace(/\s?€/, ' €')), svg('text', { class: 'dn2', x: 50, y: 63 }, 'gastos'));
    const lg = el('div', { class: 'lg' }, lista.map((it, i) => el('div', {}, el('i', { class: 'f' + i }), el('span', {}, it.categoria), el('span', { class: 'n' }, eur.format(it.total), ' ', el('small', {}, Math.round((it.total / total) * 100) + '%')))));
    return el('div', { class: 'donutbox' }, g, lg);
  }

  function renderResumen() {
    const opts = periodos();
    const sel = $('mes'); const prev = sel.value;
    sel.replaceChildren(...opts.map((p) => el('option', { value: p }, perLabel(p))));
    sel.value = opts.includes(prev) ? prev : opts[0] || 'all';
    const per = sel.value;
    const s = C.summarize(S.rows, per), p = s.periodo;
    $('k-ing').replaceChildren(money(p.ingresos)); $('k-gas').replaceChildren(money(p.gastos)); $('k-net').replaceChildren(money(p.neto, true));
    $('k-aho').textContent = p.ahorro == null ? '—' : Math.round(p.ahorro * 100) + '%';
    $('notas').replaceChildren(...C.notas(S.rows, per, (n) => eur.format(n)).map((t) => el('li', {}, t)));
    $('chart-meses').replaceChildren(chartMeses(s.meses, per, (m) => { $('mes').value = m; renderResumen(); }));
    $('donut').replaceChildren(donut(s.gastos, s.gastos.reduce((a, x) => a + x.total, 0)));
    $('top').tBodies[0].replaceChildren(...(s.top.length ? s.top : []).map((r) => el('tr', {},
      el('td', {}, C.titulo(r), el('div', { class: 'sub' }, fdate(String(r.fecha)) + ' · ' + r.categoria)), el('td', { class: 'n' }, eur.format(-r.importe)))));
    $('cats-ingreso').replaceChildren(...(s.ingresos.length ? s.ingresos : [el('p', { class: 'sub' }, 'Sin ingresos en este periodo.')]).map((i) => i.categoria === undefined ? i
      : el('div', { class: 'r' }, el('span', {}, i.categoria), el('span', { class: 'n' }, eur.format(i.total)))));
    const fijos = C.recurrentes(S.rows);
    $('fijos').tBodies[0].replaceChildren(...fijos.map((f) => el('tr', {}, el('td', {}, f.nombre), el('td', {}, f.categoria), el('td', { class: 'n' }, eur.format(f.importe)))));
    $('fijos-total').textContent = fijos.length ? `Total aproximado: ${eur.format(fijos.reduce((a, x) => a + x.importe, 0))} al mes (conceptos con el mismo importe en 3 o más meses).` : 'Aún no hay suficientes meses para detectar gastos fijos.';
    $('meses').tBodies[0].replaceChildren(...s.meses.slice(0, 12).map((m) => el('tr', {},
      el('td', {}, mesLabel(m.mes)), el('td', { class: 'n' }, eur.format(m.ingresos)), el('td', { class: 'n' }, eur.format(m.gastos)), el('td', { class: 'n' }, money(m.neto, true)))));
    const n = sinCat().length;
    $('revisar').hidden = !n; $('revisar').textContent = n + ' sin categoría · revisar';
  }
  $('mes').addEventListener('change', renderResumen);
  $('revisar').addEventListener('click', (e) => { e.preventDefault(); $('f-sin').checked = true; $('q').value = ''; $('f-mes').value = ''; show('movs'); renderMovs(); });

  // ---------- Movimientos ----------
  function renderMovs() {
    const fc = $('f-cuenta'), fm = $('f-mes');
    const pc = fc.value, pm = fm.value;
    fc.replaceChildren(el('option', { value: '' }, 'Todas las cuentas'), ...Object.entries(S.cuentas).map(([k, v]) => el('option', { value: k }, v)));
    fm.replaceChildren(el('option', { value: '' }, 'Todos los meses'), ...mesesDisponibles().map((m) => el('option', { value: m }, mesLabel(m))));
    fc.value = pc; fm.value = pm;
    const q = C.norm($('q').value);
    const rows = S.rows.filter((r) =>
      (!fc.value || r.cuenta === fc.value) && (!fm.value || String(r.fecha).startsWith(fm.value)) &&
      (!$('f-sin').checked || r.categoria === C.SIN_CAT) &&
      (!q || C.norm(r.concepto + ' ' + r.detalle + ' ' + r.categoria + ' ' + (r.nota || '')).includes(q)))
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.fila - a.fila);
    $('tabla').tBodies[0].replaceChildren(...rows.slice(0, S.limite).map((r) => el('tr', {},
      el('td', {}, fdate(String(r.fecha))),
      el('td', {}, S.cuentas[r.cuenta] || r.cuenta),
      el('td', {}, C.titulo(r), C.titulo(r) !== r.concepto ? el('div', { class: 'sub' }, r.concepto) : null),
      el('td', { class: 'n' }, money(r.importe, true)),
      el('td', {}, el('button', { class: 'pill' + (r.categoria === C.SIN_CAT ? ' sin' : ''), onclick: () => editar(r) }, r.categoria + (r.tipo === 'neutro' ? ' · no computa' : '')), r.nota ? el('div', { class: 'nota' }, r.nota) : null))));
    $('mas').hidden = rows.length <= S.limite;
  }
  for (const id of ['q', 'f-cuenta', 'f-mes', 'f-sin']) $(id).addEventListener('input', () => { S.limite = 200; renderMovs(); });
  $('mas').addEventListener('click', () => { S.limite += 300; renderMovs(); });

  // ---------- Editar categoría ----------
  let editando = null;
  function editar(r) {
    editando = r;
    $('dlg-title').textContent = (C.titulo(r)) + ' · ' + eur.format(r.importe);
    $('d-cat').value = r.categoria === C.SIN_CAT ? '' : r.categoria;
    $('d-pat').value = C.suggestPattern(r);
    $('d-tipo').value = 'auto';
    $('d-nota').value = r.nota || '';
    $('cats-list').replaceChildren(...[...new Set([...S.rows.map((x) => x.categoria), ...S.reglas.map((x) => x.categoria)])].filter((c) => c !== C.SIN_CAT).sort().map((c) => el('option', { value: c })));
    $('dlg').showModal();
  }
  $('d-cancel').addEventListener('click', () => $('dlg').close());
  $('dlg-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value !== 'ok') return;
    const categoria = $('d-cat').value.trim(), patron = $('d-pat').value.trim(), tipoSel = $('d-tipo').value;
    if (!categoria) return;
    run(async () => {
      const tipoDe = (r) => (tipoSel === 'auto' ? (r.importe < 0 ? 'gasto' : 'ingreso') : tipoSel);
      const cambios = new Map([[editando.fila, editando]]);
      editando.categoria = categoria; editando.tipo = tipoDe(editando); editando.nota = $('d-nota').value.trim();
      if (patron) {
        const p = C.norm(patron);
        for (const r of S.rows) if (r.categoria === C.SIN_CAT && C.norm(r.concepto + ' ' + r.detalle).includes(p)) {
          r.categoria = categoria; r.tipo = tipoDe(r); cambios.set(r.fila, r);
        }
        await post(`${SH}${S.sheetId}/values/Reglas!A:C:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[patron, categoria, tipoSel]] });
        S.reglas.push({ patron, categoria, tipo: tipoSel });
      }
      await post(`${SH}${S.sheetId}/values:batchUpdate`, {
        valueInputOption: 'RAW',
        data: [...cambios.values()].map((r) => ({ range: `Movimientos!H${r.fila}:K${r.fila}`, values: [[r.categoria, r.tipo, r.pareja || '', r.nota || '']] })),
      });
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
        const cuentasKind = C.CUENTAS.filter((c) => c.tarjeta === (p.kind === 'tarjeta')).map((c) => c.key);
        const sug = cuentasKind.length === 1 ? cuentasKind[0] : C.suggestAccount(p.movs, S.rows, cuentasKind);
        S.pend.push({ name: f.name, p, opciones: cuentasKind, cuenta: sug || '' });
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
        ...pf.opciones.map((k) => el('option', { value: k, selected: k === pf.cuenta }, S.cuentas[k])));
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
    let añadidos = [];
    const have = new Set(S.rows.map((r) => r.id));
    for (const pf of S.pend) {
      for (const m of C.assignIds(pf.p.movs, pf.cuenta)) if (!have.has(m.id)) { have.add(m.id); añadidos.push({ ...m, ...C.classify(m, S.reglas), pareja: '' }); }
    }
    añadidos.sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (añadidos.length) {
      await post(`${SH}${S.sheetId}/values/Movimientos!A:K:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: añadidos.map(C.toRow) });
      await load();
      const cambios = C.pairInternal(S.rows);
      if (cambios.length) {
        const byId = new Map(S.rows.map((r) => [r.id, r]));
        await post(`${SH}${S.sheetId}/values:batchUpdate`, {
          valueInputOption: 'RAW',
          data: cambios.map((c) => { const r = byId.get(c.id); return { range: `Movimientos!H${r.fila}:J${r.fila}`, values: [[c.categoria, c.tipo, c.pareja]] }; }),
        });
        await load();
      }
    }
    S.pend = [];
    const n = sinCat().length;
    say(`Importados ${añadidos.length} movimientos nuevos.` + (n ? ` Hay ${n} sin categoría.` : ''));
    show('resumen'); render();
  }));

  $('connect').disabled = true;
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) say('Falta el ID de cliente de Google en config.js (mira el README).', true);
  else initAuth();
})();
