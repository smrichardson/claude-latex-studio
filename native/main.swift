// LaTeX · Claude Studio — native macOS wrapper.
//
// A minimal WKWebView app: it starts the local studio server if needed, then
// shows http://localhost:4319 in a real window with its own Dock icon. The
// WKUIDelegate methods matter — the web UI uses prompt()/confirm() (project
// switching, tidy/rewind confirmations) and <input type=file> (paper/image
// upload), none of which work in a bare WKWebView without them.
import Cocoa
import WebKit

let studioURL = URL(string: "http://localhost:4319/")!
let healthURL = URL(string: "http://localhost:4319/api/project")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var webView: WKWebView!

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled") // right-click → Inspect
    webView = WKWebView(frame: .zero, configuration: config)
    webView.uiDelegate = self
    webView.navigationDelegate = self

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1640, height: 1020),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "LaTeX · Claude Studio"
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("LCSMainWindow")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    webView.loadHTMLString(
      "<html><body style=\"font-family:-apple-system;background:#f6f4ee;color:#232019;"
        + "display:flex;align-items:center;justify-content:center;height:100vh\">"
        + "<div>Starting LaTeX · Claude Studio…</div></body></html>",
      baseURL: nil)
    ensureServerThenLoad(attempt: 0)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  // --- server lifecycle ---------------------------------------------------

  func ensureServerThenLoad(attempt: Int) {
    checkServer { up in
      DispatchQueue.main.async {
        if up {
          self.webView.load(URLRequest(url: studioURL))
        } else if attempt < 100 {
          if attempt == 0 { self.startServer() }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.ensureServerThenLoad(attempt: attempt + 1)
          }
        } else {
          self.webView.loadHTMLString(
            "<html><body style=\"font-family:-apple-system;padding:40px\">"
              + "<h3>The studio server did not start.</h3><p>Check /tmp/latex-claude-studio.server.log"
              + " or run <code>npm start</code> in the repo.</p></body></html>",
            baseURL: nil)
        }
      }
    }
  }

  func checkServer(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: healthURL)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      done((resp as? HTTPURLResponse)?.statusCode == 200)
    }.resume()
  }

  func startServer() {
    // serveScriptPath comes from the generated Config.swift (baked at build
    // time). The server is intentionally left running when the app quits, so
    // the next launch is instant.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [serveScriptPath]
    try? p.run()
  }

  // --- menu (needed so Cmd+C/V/X/Z work inside the web view) ----------------

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(
      withTitle: "Quit LaTeX Claude Studio", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit

    let viewItem = NSMenuItem()
    main.addItem(viewItem)
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
    viewItem.submenu = view

    NSApp.mainMenu = main
  }

  @objc func reloadPage() { webView.reload() }

  // --- JS dialogs + file pickers -------------------------------------------

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.runModal()
    completionHandler()
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    let a = NSAlert()
    a.messageText = prompt
    let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 24))
    tf.stringValue = defaultText ?? ""
    a.accessoryView = tf
    a.window.initialFirstResponder = tf
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = false
    completionHandler(p.runModal() == .OK ? p.urls : nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
