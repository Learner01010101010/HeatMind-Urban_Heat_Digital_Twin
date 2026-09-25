# HeatMind for Android

A WebView wrapper around the HeatMind web app, so the twin runs as an installed app
on a phone.

It is deliberately thin. The web app is already responsive and already handles
geolocation, storage and layout; what a native shell has to add is the three things
a WebView gets wrong by default — WebGL, geolocation and DOM storage — plus an icon
and a back button. Everything else stays in the web app, where one fix serves both.

## Build it

There is no committed Gradle wrapper binary (`gradlew` / `gradle-wrapper.jar`), so
generate one on first checkout, or just open the folder in Android Studio and let it
sync — either produces the same result.

**Android Studio** (simplest): *Open* → select this `android/` folder → wait for the
Gradle sync → Run.

**Command line:**

```bash
cd android
gradle wrapper          # once, to create ./gradlew and the wrapper jar
./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

Requirements: JDK 17, Android SDK with API 35, and `ANDROID_HOME` (or
`local.properties` with `sdk.dir=...`).

## Point it at a server

The URL is a build property, so the same source runs against a dev server or
production without editing code:

```bash
./gradlew assembleDebug -PheatmindUrl=http://10.0.2.2:3000
```

Which address depends on where the app runs:

| Running on | Use |
|---|---|
| Emulator, dev server on the host | `http://10.0.2.2:3000` (the default — `10.0.2.2` is the emulator's alias for your machine) |
| Physical device, dev server on your laptop | `adb reverse tcp:3000 tcp:3000 && adb reverse tcp:8000 tcp:8000`, then `http://localhost:3000` |
| Physical device, same Wi-Fi | your laptop's LAN address, e.g. `http://192.168.1.42:3000` |
| Deployed | `https://your-host` |

`adb reverse` is the one to reach for on a real device — it tunnels over USB, so it
works regardless of Wi-Fi, captive portals or firewalls.

**The backend has to be reachable too.** The frontend calls the FastAPI server, so
if you point the app at a LAN address, start Next.js with `BACKEND_URL` set to an
address the *device* can resolve — `localhost` on your laptop is not `localhost` on
the phone.

Cleartext HTTP is permitted only to loopback and private ranges
(`res/xml/network_security_config.xml`); a production build over HTTPS is unaffected,
and nothing here weakens a release.

## What the shell actually does

**WebGL.** The twin renders a Three.js scene inside MapLibre's GL context. Without
hardware acceleration the WebView falls back to software and the app is unusable, so
`hardwareAccelerated="true"` is set explicitly on both the application and the
activity rather than relied on as a default.

**Geolocation is a two-key lock.** The page calls `navigator.geolocation`, which
Android refuses unless *both* the app holds `ACCESS_FINE_LOCATION` at runtime *and*
the `WebChromeClient` grants the origin through `onGeolocationPermissionsShowPrompt`.
Miss either and the page sees a silent denial with no way to tell why — and since
onboarding blocks on a position fix, that is the difference between a working app and
a dead first screen. `MainActivity` holds the prompt, asks Android, and answers the
page either way; an unanswered callback leaves the page hanging forever, which looks
like a crash rather than a refusal.

**DOM storage.** Persona, units, accessibility preferences and the Heat Passport
session token all live in `localStorage`. Without `setDomStorageEnabled` the app
re-onboards on every launch and loses the passport history.

Plus: outbound links (OSM attribution, the GitHub link in About) open in the system
browser instead of stranding the user in a chromeless WebView with no address bar;
state is saved across rotation so the ~2.6 MB zone payload is not re-fetched; and
timers pause when backgrounded, because the render loop and the geolocation watch
both run continuously and would otherwise drain the battery.

## Performance on a phone

The web app detects a mobile device and lowers its own rendering budgets — see
`frontend/lib/deviceProfile.ts`. Nothing in this Android project needs to change for
that; it is the same page, deciding for itself.

Briefly, what it does differently on a phone:

- The sun-shadow march renders a 3.4 MP target instead of 13.4 MP (3× the physics
  grid rather than 6×). Supersampling only sharpens a shadow's *edge* — which cells
  are shadowed comes from a 10 m raster and is identical either way.
- Dragging the timeline coarsens the march to one per 2° of sun movement instead of
  one per 0.25°, then lands an exact march when the finger lifts.
- `devicePixelRatio` is capped at 2. Every fragment cost in the scene scales with it,
  and DPR 3 is nine times the work of DPR 1 for a difference nobody resolves on a
  6-inch panel.
- Heavy layers build over successive frames rather than in one block, so the map is
  interactive while buildings and canopy land.

If it still struggles on a particular device, `deviceProfile.ts` is where to lower
`maxExposurePixels` — it is a pixel budget rather than a fixed factor precisely so it
can be tuned without touching the renderer.

## Known limits

- **Not built or run here.** This project was written in a container with no Android
  SDK, so it has never been compiled into an APK or launched on a device. Expect to
  fix a dependency version or an SDK path on first sync; the structure is right but
  it is unproven.
- **No offline mode.** The app needs the server. A `Can't reach HeatMind` screen with
  the attempted URL is shown on failure, which is usually a dev server that is not
  reachable from the device rather than anything being broken.
