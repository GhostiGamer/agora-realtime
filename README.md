# ÁGORA · servidor de tiempo real (Contabo + Coolify)

Hace que la sala vaya fluida: el movimiento de los demás llega en unos 100 ms en vez de ~1,5 s, el chat de sala es instantáneo, las carreras se sincronizan al momento y las llamadas conectan antes. No guarda nada en disco: si se reinicia, los navegadores se reconectan solos.

Si este servidor no está o se cae, **la web sigue funcionando como antes** (por Netlify), solo que menos fluida. Puedes montarlo y desmontarlo sin miedo.

## Qué consume

Muy poco. Es un único proceso de Node y el contenedor está limitado a **256 MB de RAM y media CPU**, así que nunca se come el VPS. En reposo usa unos 60–70 MB. Además tiene límites: 1.500 conexiones en total, 12 por IP, 40 mensajes por segundo por conexión, mensajes de 64 KB como máximo y un historial de 60 mensajes por sala. Las conexiones muertas se cierran solas.

## Montarlo en Coolify (unos 10 minutos)

1. **Sube esta carpeta a GitHub** (puede ser un repositorio privado), por ejemplo como `agora-realtime`.
2. **DNS**: crea un registro `A` de `rt.agoraai.dev` que apunte a la IP de tu VPS de Contabo.
3. **Coolify** → tu proyecto → *New Resource* → *Private Repository (with GitHub App)* o *Public Repository* → elige el repositorio.
   - Build Pack: **Dockerfile**.
   - Ports Exposes: **8080**.
   - Domains: **https://rt.agoraai.dev** (Coolify pide el certificado HTTPS solo).
4. **Variables de entorno** en Coolify:
   - `RT_SECRET`: una clave larga (genera una con `openssl rand -hex 32`).
   - `ALLOWED_ORIGINS`: `https://agoraai.dev,https://www.agoraai.dev`
5. **Limita los recursos** en Coolify → *Resource Limits*: memoria 256 MB y CPU 0.5. El contenedor ya arranca con un tope de memoria para Node, pero así queda doble seguro.
6. *Deploy*. Comprueba que va abriendo `https://rt.agoraai.dev/health`; debe responder `{"ok":true,...}`.

## Conectarlo con la web

1. En **Netlify** → Environment variables, añade `RT_SECRET` con **la misma clave** que en Coolify y vuelve a desplegar. Netlify firma con ella un «billete» que dice quién eres y en qué grupos estás, y este servidor lo comprueba. Así nadie puede hacerse pasar por otro ni colarse en la llamada de un grupo ajeno.
2. La web ya apunta a `wss://rt.agoraai.dev` (etiqueta `<meta name="agora-rt">` de `index.html`). Si usas otro dominio, cámbialo ahí.

Para comprobarlo, entra en la sala desde dos dispositivos y muévete: el otro te verá moverte al instante.

## Llamadas de voz: ¿TURN en Contabo o en Cloudflare?

Las llamadas ya usan este servidor para conectarse (la señalización). Lo que viaja en la llamada es el audio, que va directo entre navegadores; solo cuando la red no lo permite pasa por un servidor TURN.

**Recomendado: el TURN gratuito de Cloudflare** (pasos en el README de Netlify). Es gratis hasta 1.000 GB al mes, está cerca de cada usuario y no carga tu VPS.

**Alternativa en Contabo** (también gratis): la carpeta `turn/` trae un coturn listo y con límites (como mucho unas 20 llamadas retransmitidas a la vez a ~96 kbps cada una).
1. En el VPS: `cd turn && TURN_SECRET=<otra clave> PUBLIC_IP=<IP del VPS> docker compose up -d`. Va fuera de Coolify porque necesita UDP directo.
2. Abre en el cortafuegos del VPS (y en el panel de Contabo si lo usas) los puertos **3478 UDP/TCP** y **49160–49200 UDP**.
3. En Netlify: `TURN_URLS=turn:<IP del VPS>:3478?transport=udp,turn:<IP del VPS>:3478?transport=tcp` y `TURN_SECRET=<la misma clave>`. Las credenciales se generan solas y caducan cada día.

No te recomiendo montar un servidor de vídeo o voz completo (tipo LiveKit) por ahora: pide más configuración y recursos, y solo compensa con grupos de más de 5–6 personas hablando a la vez.
