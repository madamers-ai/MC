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
    const g = await api(`${SH}${S.sheetId}/values:batchGet?ranges=Movimientos!A2:J&ranges=Reglas!A2:C&ranges=Cuentas!A2:B&valueRenderOption=UNFORMATTED_VALUE`);
    const [mov, reg, cue] = g.valueRanges.map((v) => v.values || []);
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
  function renderResumen() {
    const meses = mesesDisponibles();
    const sel = $('mes'); const prev = sel.value;
    sel.replaceChildren(...meses.map((m) => el('option', { value: m }, mesLabel(m))));
    sel.value = meses.includes(prev) ? prev : meses[0] || '';
    const mes = sel.value;
    const s = C.summarize(S.rows, mes);
    const cur = s.meses.find((x) => x.mes === mes) || { ingresos: 0, gastos: 0, neto: 0 };
    $('k-ing').replaceChildren(money(cur.ingresos)); $('k-gas').replaceChildren(money(cur.gastos)); $('k-net').replaceChildren(money(cur.neto, true));
    const lista = (id, items) => {
      const max = Math.max(1, ...items.map((i) => Math.abs(i.total)));
      $(id).replaceChildren(...(items.length ? items : [el('p', { class: 'sub' }, 'Nada este mes.')]).map((i) => i.categoria === undefined ? i
        : el('div', { class: 'r' }, el('span', {}, i.categoria), el('span', { class: 'n' }, eur.format(i.total)), el('div', { class: 't' }, bar(Math.max(2, Math.abs(i.total) / max * 100))))));
    };
    lista('cats-gasto', s.gastos); lista('cats-ingreso', s.ingresos);
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
      (!q || C.norm(r.concepto + ' ' + r.detalle + ' ' + r.categoria).includes(q)))
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.fila - a.fila);
    $('tabla').tBodies[0].replaceChildren(...rows.slice(0, S.limite).map((r) => el('tr', {},
      el('td', {}, fdate(String(r.fecha))),
      el('td', {}, S.cuentas[r.cuenta] || r.cuenta),
      el('td', {}, r.detalle || r.concepto, r.detalle ? el('div', { class: 'sub' }, r.concepto) : null),
      el('td', { class: 'n' }, money(r.importe, true)),
      el('td', {}, el('button', { class: 'pill' + (r.categoria === C.SIN_CAT ? ' sin' : ''), onclick: () => editar(r) }, r.categoria + (r.tipo === 'neutro' ? ' · no computa' : ''))))));
    $('mas').hidden = rows.length <= S.limite;
  }
  for (const id of ['q', 'f-cuenta', 'f-mes', 'f-sin']) $(id).addEventListener('input', () => { S.limite = 200; renderMovs(); });
  $('mas').addEventListener('click', () => { S.limite += 300; renderMovs(); });

  // ---------- Editar categoría ----------
  let editando = null;
  function editar(r) {
    editando = r;
    $('dlg-title').textContent = (r.detalle || r.concepto) + ' · ' + eur.format(r.importe);
    $('d-cat').value = r.categoria === C.SIN_CAT ? '' : r.categoria;
    $('d-pat').value = C.suggestPattern(r);
    $('d-tipo').value = 'auto';
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
      editando.categoria = categoria; editando.tipo = tipoDe(editando);
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
        data: [...cambios.values()].map((r) => ({ range: `Movimientos!H${r.fila}:J${r.fila}`, values: [[r.categoria, r.tipo, r.pareja || '']] })),
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
      await post(`${SH}${S.sheetId}/values/Movimientos!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: añadidos.map(C.toRow) });
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
