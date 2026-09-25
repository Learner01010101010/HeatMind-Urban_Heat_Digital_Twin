# This app is a WebView shell: no reflection, no JavaScript bridge, nothing to keep
# beyond R8's defaults. If a @JavascriptInterface class is ever added, keep it here
# or R8 will strip the very methods the page calls.
