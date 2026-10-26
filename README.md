# Mis cuentas

App privada para contabilizar los extractos de BBVA. El código vive en GitHub (Pages); los datos, en una hoja de tu Google Drive. Los ficheros se procesan en tu navegador y no pasan por ningún otro servidor.

## Puesta en marcha (una vez, ~15 min)

1. **GitHub**: crea un repositorio, sube todo el contenido de esta carpeta y activa *Settings → Pages → Deploy from a branch → main / (root)*. Tu URL será `https://TU_USUARIO.github.io/NOMBRE_REPO/`.
2. **Google Cloud** (console.cloud.google.com):
   - Crea un proyecto y activa **Google Sheets API** y **Google Drive API**.
   - *Google Auth Platform / Pantalla de consentimiento*: tipo Externo, pon nombre y tu correo, añade el permiso `.../auth/drive.file` y pulsa **Publicar aplicación** (así la sesión no caduca a los 7 días; este permiso no exige verificación).
   - *Credenciales → Crear → ID de cliente de OAuth → Aplicación web*. En **Orígenes de JavaScript autorizados** pon solo `https://TU_USUARIO.github.io` (sin ruta).
3. Copia el ID de cliente en `config.js` y súbelo a GitHub.
4. Abre tu URL, **Conectar con Google**. La primera vez crea la hoja «Finanzas personales (datos de la app)» en tu Drive.

## Uso

Descarga los movimientos en BBVA (cuentas y tarjeta), pestaña **Importar**, elige los ficheros, indica a qué cuenta corresponde cada uno y pulsa Importar. Puedes solapar fechas: lo ya importado se ignora.

- Los traspasos entre tus cuentas y las recargas de la tarjeta se emparejan solos y **no cuentan** como gasto ni ingreso.
- Lo que no reconoce queda «Sin categoría»: púlsalo en *Movimientos* para asignarle categoría y, si quieres, crear una regla.
- En la hoja puedes editar a mano las pestañas **Reglas** (primera coincidencia gana) y **Cuentas** (nombres).

## Seguridad

- Solo se pide el permiso `drive.file`: la app ve únicamente la hoja que ella misma creó, no el resto de tu Drive.
- El repositorio no contiene datos ni secretos. `.gitignore` bloquea .xlsx/.csv por si acaso: **nunca subas extractos al repo**.
- Se guardan solo los 4 últimos dígitos de tarjetas y cuentas.

## Desarrollo

`core.js` (lógica) se prueba con `node --test tests/core.test.js`. `vendor/xlsx.full.min.js` es SheetJS 0.18.5 (lectura de .xlsx).
