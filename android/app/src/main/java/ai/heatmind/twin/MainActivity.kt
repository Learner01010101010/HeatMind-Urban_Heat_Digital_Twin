package ai.heatmind.twin

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import ai.heatmind.twin.databinding.ActivityMainBinding

/**
 * HeatMind in a WebView.
 *
 * Three things make or break this wrapper, and none of them are the WebView itself:
 *
 *  1. **WebGL.** The twin renders a Three.js scene inside MapLibre's GL context. A
 *     WebView without hardware acceleration falls back to software and the app is
 *     unusable. Acceleration is on by default from API 14 but is disabled by a
 *     hardwareAccelerated="false" anywhere up the chain, so the manifest sets it
 *     explicitly on both the application and the activity.
 *
 *  2. **Geolocation is a two-key lock.** The page calls navigator.geolocation, which
 *     Android refuses unless *both* the app holds ACCESS_FINE_LOCATION at runtime
 *     *and* the WebChromeClient grants the origin through
 *     onGeolocationPermissionsShowPrompt. Miss either and the page sees a silent
 *     permission denial with no way to tell why. Onboarding blocks on a fix, so this
 *     is the difference between a working app and a dead first screen.
 *
 *  3. **DOM storage.** Persona, units, accessibility prefs and the session token all
 *     live in localStorage. Without setDomStorageEnabled the app re-onboards on
 *     every launch and loses the Heat Passport's session.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    /** Origin waiting on an Android permission decision, if any. */
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    private val locationPermission = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        // Hand the answer back to the page either way. Letting the callback go
        // unanswered leaves navigator.geolocation hanging forever, which looks like
        // a hung app rather than a declined permission.
        pendingGeoCallback?.invoke(pendingGeoOrigin, granted, false)
        pendingGeoOrigin = null
        pendingGeoCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // The map wants the whole screen; the page already honours safe-area insets.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        configureWebView(binding.webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) {
            binding.webView.loadUrl(BuildConfig.HEATMIND_URL)
        } else {
            binding.webView.restoreState(savedInstanceState)
        }
    }

    private fun configureWebView(web: WebView) {
        val settings = web.settings
        settings.javaScriptEnabled = true

        // Persona, units, prefs and the Heat Passport session token.
        settings.domStorageEnabled = true
        settings.databaseEnabled = true

        // The twin fetches a ~2.6 MB gzipped zone payload and re-fetches forecast
        // frames; the default cache mode already honours the server's headers, which
        // is what we want rather than a blanket cache.
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // The page is responsive and sets its own viewport. Letting the WebView
        // apply desktop-width heuristics on top produces a zoomed-out layout with
        // unreadable HUD text.
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false

        // Geolocation, half one. The other half is the runtime permission below.
        settings.setGeolocationEnabled(true)

        settings.mediaPlaybackRequiresUserGesture = false
        settings.javaScriptCanOpenWindowsAutomatically = false

        // Mixed content stays blocked: the dev server is plain HTTP end to end and
        // production is HTTPS end to end, so there is no legitimate mixed case, and
        // allowing it would silently weaken a release build.
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        // Overscroll glow on a full-bleed map reads as a rendering glitch.
        web.overScrollMode = View.OVER_SCROLL_NEVER

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                val base = Uri.parse(BuildConfig.HEATMIND_URL)
                // Keep the app's own pages in the WebView; hand anything else to the
                // system browser. Without this, an outbound link (OpenStreetMap
                // attribution, the GitHub link in About) strands the user in a
                // chromeless WebView with no address bar and no way back.
                return if (url.host != null && url.host != base.host) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }.isSuccess
                } else {
                    false
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                binding.loading.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                // Only the main document is worth surfacing. A failed tile or a
                // cancelled prefetch is not an app-level error and showing one for
                // every such request would bury the real failure.
                if (!request.isForMainFrame) return
                binding.loading.visibility = View.GONE
                binding.errorView.visibility = View.VISIBLE
                binding.errorDetail.text = getString(
                    R.string.error_detail, BuildConfig.HEATMIND_URL, error.description
                )
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String, callback: GeolocationPermissions.Callback
            ) {
                val fine = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val coarse = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED

                if (fine || coarse) {
                    callback.invoke(origin, true, false)
                    return
                }
                // Ask Android first, then answer the page in the result callback.
                pendingGeoOrigin = origin
                pendingGeoCallback = callback
                locationPermission.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    )
                )
            }
        }

        binding.retry.setOnClickListener {
            binding.errorView.visibility = View.GONE
            binding.loading.visibility = View.VISIBLE
            web.loadUrl(BuildConfig.HEATMIND_URL)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // Survives rotation without re-downloading the zone payload or re-running
        // onboarding.
        binding.webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        // Stops the render loop and the geolocation watch while backgrounded; both
        // run continuously in this app and would otherwise drain the battery.
        binding.webView.onPause()
        binding.webView.pauseTimers()
    }

    override fun onResume() {
        super.onResume()
        binding.webView.resumeTimers()
        binding.webView.onResume()
    }

    override fun onDestroy() {
        // Answer any outstanding prompt before tearing down, or the callback leaks
        // a reference to this activity.
        pendingGeoCallback?.invoke(pendingGeoOrigin, false, false)
        pendingGeoCallback = null
        binding.webView.destroy()
        super.onDestroy()
    }
}
