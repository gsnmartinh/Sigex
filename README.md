# SIGEX 2

Aplicación de escritorio para Windows que ayuda a los Juzgados de Policía Local a gestionar **exhortos**: llevar el seguimiento de cada causa, avisar cuándo algo está atrasado y redactar los correos a otros tribunales.

Todos los datos quedan en el computador del usuario (base SQLite local). No hay servidor ni cuenta que crear.

## Qué hace

- **Seguimiento de exhortos**: ficha por causa con etapa, plazos de pago y de sentencia, y alertas de lo vencido o por revisar.
- **Cartas y notificaciones por correo**: abre un borrador en Outlook con la sentencia adjunta; después se confirma en SIGEX para registrar el envío.
- **Recordatorios agrupados por juzgado**: cuando un tribunal no ha informado la sentencia de varias causas, se envía un solo correo con todas, incluyendo número de boleta de citación y código de seguimiento de Correos.
- **Directorio de juzgados de todo el país**: 379 juzgados con región y comuna. Los datos de contacto verificados en la página de cada municipalidad vienen cargados; los demás llevan una pista marcada "sin verificar".
- **Documentos**: adjuntar archivos o escanear directo desde el escáner (se arma un PDF por documento).
- **Respaldo automático**: al cerrar, guarda una copia diaria en la carpeta elegida (por ejemplo, la de OneDrive o Google Drive). La base en uso siempre es local.
- **Plantillas de correo editables** y diseño al estilo Windows 11, con modo claro y oscuro.

## Instalación

1. Entra a [Releases](../../releases) y descarga el instalador `.exe` de la última versión.
2. Ejecútalo y abre SIGEX desde el menú Inicio.

Requisito: Windows 10/11. Para los correos se usa Outlook instalado en el equipo.

## Primeros pasos

1. En el directorio de juzgados, revisa los correos de los tribunales con los que trabajas y completa los marcados "VALIDAR". Se pueden importar y exportar en CSV (separador `;`; las celdas vacías no borran datos existentes).
2. En *Ajustes*, elige la carpeta de respaldo y completa los datos del firmante.
3. Registra tus exhortos.

## Datos y privacidad

- Base de datos: `%APPDATA%\sigex\data\sigex2.sqlite`. Documentos: `%APPDATA%\sigex\documentos\`.
- Contiene datos personales de infractores. Usa una cuenta institucional para el respaldo y no subas la base ni los documentos a repositorios públicos.
- Para restaurar un respaldo: cierra SIGEX y copia la base y la carpeta `documentos` desde la carpeta de respaldo a las rutas de arriba.

## Desarrollo

```bash
npm install
npm start        # abre la app
npm test         # pruebas (datos ficticios)
npm run dist     # genera el instalador de Windows
```

Electron + better-sqlite3. El instalador se compila en GitHub Actions al publicar una release.

## Licencia

MIT
