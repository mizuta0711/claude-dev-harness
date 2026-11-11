#nullable enable
using System;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using {{ROOT_NAMESPACE}}.Services;
using Microsoft.Web.WebView2.Core;

namespace {{ROOT_NAMESPACE}}.Views;

/// <summary>
/// ヘルプ窓。同梱のマニュアルを、仮想ホスト <c>https://{{HELP_HOST}}/</c> として WebView2 に見せる。
/// 専用のスレッドで作られる（<see cref="HelpService"/>）。このクラスの操作は、その窓のスレッドで行う。
/// </summary>
public partial class HelpWindow : Window
{
    /// <summary>同梱物（Help\）を割り当てる仮想ホスト名。</summary>
    public const string VirtualHost = "{{HELP_HOST}}";

    /// <summary>本文側から「閉じて」を知らせるときの合図（<see cref="EscapeScript"/> が送る）。</summary>
    private const string CloseMessage = "help-window:close";

    /// <summary>
    /// 本文にフォーカスがあるときの Esc の受け口（予備）。
    /// ふだんは WebView2 の部品が Esc を WPF のキー入力として送ってくるので <see cref="OnPreviewKeyDown"/> が受けて閉じ、
    /// そのときは本文に Esc が届かない。WPF 側で受けられなかったときだけ、本文のこのスクリプトが合図を送る。
    /// </summary>
    private const string EscapeScript =
        "document.addEventListener('keydown', function (e) {" +
        " if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;" +
        " if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage('" + CloseMessage + "');" +
        "});";

    private readonly CoreWebView2Environment _environment;
    private readonly string _helpRoot;
    private string _pending = HelpTargets.IndexPath;
    private bool _ready;
    private bool _closing;

    /// <summary>窓を出したあとの WebView2 の初期化に失敗した（まれ）。受けた側が窓を閉じて、ブラウザへ切り替える。</summary>
    public event EventHandler? InitializationFailed;

    /// <param name="environment">表示の前に作った WebView2 の環境（作業フォルダはデータのフォルダの下）。</param>
    /// <param name="helpRoot">同梱物（Help\）のフォルダ。</param>
    /// <param name="ownerBounds">中央に合わせるメインウィンドウの範囲。null なら画面の中央。</param>
    public HelpWindow(CoreWebView2Environment environment, string helpRoot, Rect? ownerBounds)
    {
        InitializeComponent();
        _environment = environment;
        _helpRoot = helpRoot;

        var area = ownerBounds ?? new Rect(SystemParameters.WorkArea.Left, SystemParameters.WorkArea.Top,
            SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height);
        var left = area.Left + (area.Width - Width) / 2;
        var top = area.Top + (area.Height - Height) / 2;
        Left = Math.Clamp(left, SystemParameters.VirtualScreenLeft, Math.Max(SystemParameters.VirtualScreenLeft,
            SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - Width));
        Top = Math.Clamp(top, SystemParameters.VirtualScreenTop, Math.Max(SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - Height));

        Loaded += OnLoaded;
        Closing += (_, _) => _closing = true;
        Closed += (_, _) => ManualWebView.Dispose();
        // WebView2 にフォーカスがあるときの Esc・F1 は、WebView2 の部品がアクセラレータ キーの知らせを WPF のキー入力に変えて送ってくる想定。
        // 届かなかったときの予備が EscapeScript（Esc だけ）
        PreviewKeyDown += OnPreviewKeyDown;
    }

    /// <summary>
    /// 同梱物の中のパス（<c>manual/screens/home.html#section</c> の形）へ移る。同じページの別の節でも、節まで動かす。
    /// 初期化の途中なら、終わってから移る。
    /// </summary>
    public void Navigate(string path)
    {
        _pending = path;
        if (!_ready || ManualWebView.CoreWebView2 is not { } core) return;

        var (file, fragment) = HelpTargets.Split(path);
        if (Uri.TryCreate(core.Source, UriKind.Absolute, out var current)
            && string.Equals(current.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
            && string.Equals(current.AbsolutePath.TrimStart('/'), file, StringComparison.OrdinalIgnoreCase))
        {
            // 同じページ。ページ内の移動だけでは動かないことがあるので、節の指定をいったん外して付け直す
            var script = fragment is null
                ? "window.scrollTo(0, 0);"
                : $"location.hash = ''; location.hash = {JsonSerializer.Serialize(fragment)};";
            _ = ExecuteQuietlyAsync(core, script);
            return;
        }
        core.Navigate($"https://{VirtualHost}/{path}");
    }

    private static async Task ExecuteQuietlyAsync(CoreWebView2 core, string script)
    {
        try { await core.ExecuteScriptAsync(script); }
        catch (Exception ex) { HelpService.Log("ヘルプ窓: 節への移動", ex); }
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        try
        {
            await ManualWebView.EnsureCoreWebView2Async(_environment);
            var core = ManualWebView.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping(VirtualHost, _helpRoot, CoreWebView2HostResourceAccessKind.Allow);
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += OnProcessFailed;
            core.WebMessageReceived += OnWebMessageReceived;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(EscapeScript);
            _ready = true;
            Navigate(_pending);
        }
        catch (Exception ex)
        {
            HelpService.Log("ヘルプ窓: WebView2 の初期化", ex);
            InitializationFailed?.Invoke(this, EventArgs.Empty);
        }
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers != ModifierKeys.None) return;
        if (e.Key == Key.Escape)
        {
            e.Handled = true;   // 本文へは渡さない（EscapeScript と二重に閉じない）
            CloseQuietly();
        }
        else if (e.Key == Key.F1)
        {
            // ヘルプ窓の中で F1 は何もしない
            e.Handled = true;
        }
    }

    /// <summary>本文の EscapeScript からの合図。仮想ホストのページから来たものだけを受ける。</summary>
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsInternal(e.Source)) return;
        string? message;
        try { message = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }   // 文字列でない合図は受けない
        if (message == CloseMessage) CloseQuietly();
    }

    /// <summary>閉じる（すでに閉じかけていれば何もしない）。</summary>
    private void CloseQuietly()
    {
        if (_closing) return;
        try { Close(); }
        catch (InvalidOperationException) { /* すでに閉じている */ }
    }

    private static bool IsInternal(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u)
        && u.Scheme == Uri.UriSchemeHttps
        && string.Equals(u.Host, VirtualHost, StringComparison.OrdinalIgnoreCase);

    private static bool IsWeb(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);

    /// <summary>仮想ホストの中は窓の中で移る。http・https で外を指すものだけ既定のブラウザ。それ以外（file:・javascript:・mailto: など）は何もしない。</summary>
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsInternal(e.Uri)) return;
        e.Cancel = true;
        if (IsWeb(e.Uri)) HelpService.OpenInBrowser(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;   // 窓の中に新しい窓は作らない
        if (IsInternal(e.Uri)) ManualWebView.CoreWebView2?.Navigate(e.Uri);
        else if (IsWeb(e.Uri)) HelpService.OpenInBrowser(e.Uri);
    }

    /// <summary>WebView2 のプロセスが落ちたら、ヘルプ窓だけを閉じる（アプリは続く）。</summary>
    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        var closes = e.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessExited;
        HelpService.Log($"ヘルプ窓: WebView2 のプロセスが止まりました（{e.ProcessFailedKind}）。" +
            (closes ? "ヘルプ窓を閉じます。" : "ヘルプ窓は開いたままにします（WebView2 が作り直します）。"), null);
        if (closes) Dispatcher.BeginInvoke(CloseQuietly);
    }
}
