# Third-party notices

This application bundles the following open-source components.

## pdf.js / pdfjs-dist

- Project: https://github.com/mozilla/pdf.js
- License: Apache License 2.0
- Copyright: Mozilla Foundation and contributors

The distributed worker and WASM decoders include components under the
Apache License 2.0 (OpenJPEG, JBIG2, QCMS, QuickJS). Upstream license texts
are shipped in `frontend/node_modules/pdfjs-dist/` and in the built bundle's
`wasm/` directory.

## pdf-lib

- Project: https://github.com/Hopding/pdf-lib
- License: MIT
- Copyright: Andrew Dillon and contributors

## @pdf-lib/fontkit

- Project: https://github.com/Hopding/fontkit
- License: MIT
- Copyright: Devon Govett and contributors

## Noto Sans SC

- Project: https://github.com/notofonts/noto-cjk
- License: SIL Open Font License 1.1
- Copyright: Adobe and Google
- Bundled file: `frontend/public/fonts/NotoSansSC-Regular.ttf`
- License text: `frontend/public/fonts/OFL-NotoSansSC.txt`

The font is embedded only in user-generated print/export PDFs, subsetted to the
characters actually used.

## Wails

- Project: https://github.com/wailsapp/wails
- License: MIT
- Copyright: Wails contributors

## Go standard library

- License: BSD 3-Clause
- Copyright: The Go Authors

## System WebView

- macOS: WKWebView (Apple Inc.)
- Windows: Microsoft Edge WebView2 Runtime (Microsoft Corporation)

These are provided by the operating system and are not redistributed with
this application.
