#nullable enable
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using {{ROOT_NAMESPACE}}.Views;
using Microsoft.Web.WebView2.Core;

namespace {{ROOT_NAMESPACE}}.Services;

/// <summary>
/// ヘルプ窓を開く・前に出す・閉じる窓口（F1・「ヘルプ」ボタン・メインウィンドウを閉じる処理が使う。呼ぶのはメインの UI スレッド）。
/// <list type="bullet">
/// <item>ヘルプ窓は専用の背景 STA スレッドで動かす。メインの UI スレッドでモーダルな窓が開いている間も操作でき、
/// メインが終わればプロセスとともに消える。そのスレッドの未処理の例外は自分で受けて記録し、窓だけ閉じる。</item>
/// <item>WebView2 の環境は、データのフォルダの下の <c>webview2\</c> を作業フォルダにして、窓を出す前に作る（exe の隣に作らない）。
/// 作れなければ窓を出さず、同梱物の同じページを <c>file:///</c> で既定のブラウザに開かせる。</item>
/// <item>同梱物（出力フォルダの <c>Help\</c>）が無いときは、知らせを出し、配布サイトの同じページをブラウザで開く。</item>
/// </list>
/// </summary>
public static class HelpService
{
    /// <summary>配布サイトのトップ（末尾 <c>/</c>）。同梱物が無いときの落ち先。</summary>
    private const string WebManualBase = "{{SITE_URL}}";

    private static readonly object Gate = new();
    private static Session? _session;
    private static string _dataDirectory = "";
    private static Action<string>? _notify;
    private static Action<string, Exception?> _log = DefaultLog;
    private static bool _shuttingDown;

    /// <summary>ヘルプ窓のスレッドと窓の状態。窓のスレッドからだけ触る（<see cref="CloseRequested"/> を除く）。</summary>
    private sealed class Session
    {
        public Session(string pending) => Pending = pending;

        public Dispatcher Dispatcher = null!;
        public HelpWindow? Window;
        public string Pending;
        public volatile bool CloseRequested;
    }

    /// <summary>
    /// 起動時に 1 回、メインウィンドウを出す前に呼ぶ。
    /// <paramref name="dataDirectory"/> はアプリのデータの置き場（起動時に解決した値をそのまま渡す。ここで計算し直さない）。
    /// WebView2 の作業フォルダはこの下の <c>webview2\</c> にできる。
    /// </summary>
    /// <param name="notify">同梱物が無いときの知らせ（メインの UI スレッドで呼ぶ）。null なら知らせずにブラウザで開く。</param>
    /// <param name="log">記録の出し先（どのスレッドからも呼ばれる）。null なら <see cref="Trace"/> に出す。</param>
    public static void Configure(string dataDirectory, Action<string>? notify = null, Action<string, Exception?>? log = null)
    {
        _dataDirectory = dataDirectory;
        _notify = notify;
        _log = log ?? DefaultLog;
    }

    /// <summary>同梱物（Help\）のフォルダ。</summary>
    public static string HelpRoot => Path.Combine(AppContext.BaseDirectory, "Help");

    /// <summary>飛び先（<see cref="HelpTargets"/> の名前）を開く。すでに開いていれば、同じ窓を前に出して該当ページへ移る。メインの UI スレッドで呼ぶ。</summary>
    public static void Open(string target)
    {
        if (_shuttingDown) return;
        var path = HelpTargets.PathOf(target);

        if (!Directory.Exists(HelpRoot))
        {
            _notify?.Invoke("利用マニュアルが同梱されていないため、配布サイトのマニュアルを既定のブラウザで開きます。");
            OpenInBrowser(WebManualBase + path);
            return;
        }
        path = ExistingPath(HelpRoot, path);
        if (string.IsNullOrEmpty(_dataDirectory))
        {
            // Configure の前。WebView2 の作業フォルダを相対パス（exe の隣になりうる）に作らない
            OpenFallback(path);
            return;
        }

        Session session;
        lock (Gate)
        {
            if (_session is { } running)
            {
                // 動いている窓へ頼む（窓のスレッドで、前に出してページを変える）
                running.Dispatcher.BeginInvoke(() => Show(running, path));
                return;
            }
            session = new Session(path);
        }

        var owner = OwnerBounds();
        // using にしない: 待ちが切れた後に窓のスレッドが Set() するので、ここで破棄すると破棄済みのものを触らせる
        // （ManualResetEventSlim は WaitHandle を取り出さない限り、破棄しなくても資源を残さない）
        var ready = new ManualResetEventSlim();
        var thread = new Thread(() => Run(session, owner, ready)) { IsBackground = true, Name = "{{APP_NAME}}.Help" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        // 窓のスレッドが、頼みを受けられる状態になるまで（短い）。来なければブラウザで開く（無期限に待たない）
        if (!ready.Wait(TimeSpan.FromSeconds(10)))
        {
            Log("ヘルプ窓: 窓のスレッドが準備できませんでした。同梱物を既定のブラウザで開きます", null);
            // 窓のスレッドが後から動き出しても、窓は出さずに終わらせる（ブラウザと二重に出さない）
            session.CloseRequested = true;
            OpenFallback(path);
        }
    }

    /// <summary>
    /// ヘルプ窓へ閉じるよう頼む（待たない）。メインウィンドウを閉じることが決まったとき
    /// （確認の後・終わるのを待つ処理の前）に 1 回呼ぶ。以後は新しく開かない。
    /// Windows のログオフ・シャットダウン（セッションの終了）のときは呼ばなくてよい（背景スレッドなので、プロセスとともに消える）。
    /// </summary>
    public static void RequestClose()
    {
        Session? session;
        lock (Gate)
        {
            _shuttingDown = true;
            session = _session;
        }
        if (session is null) return;
        session.CloseRequested = true;
        session.Dispatcher.BeginInvoke(() => session.Window?.Close());
    }

    /// <summary>既定のブラウザで URL を開く（失敗は記録して続ける）。</summary>
    public static void OpenInBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log("ヘルプ: 既定のブラウザで開く", ex);
        }
    }

    /// <summary>記録を残す（どのスレッドからでも呼べる。記録の失敗でヘルプを止めない）。</summary>
    internal static void Log(string message, Exception? ex)
    {
        try { _log(message, ex); }
        catch (Exception) { /* 記録に失敗しても、ヘルプの動きは止めない */ }
    }

    private static void DefaultLog(string message, Exception? ex) =>
        Trace.WriteLine(ex is null ? message : $"{message}: {ex}");

    /// <summary>飛び先のファイルが同梱物に無ければ、入口に落とす（節は、ファイルがあるときだけ残す）。</summary>
    private static string ExistingPath(string root, string path)
    {
        var (file, _) = HelpTargets.Split(path);
        return File.Exists(Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar))) ? path : HelpTargets.IndexPath;
    }

    /// <summary>窓を中央に合わせるメインウィンドウの範囲（メインの UI スレッドで読む）。</summary>
    private static Rect? OwnerBounds()
    {
        if (Application.Current?.MainWindow is not { } main) return null;
        return main.WindowState switch
        {
            WindowState.Minimized => main.RestoreBounds,
            WindowState.Maximized => new Rect(SystemParameters.WorkArea.Left, SystemParameters.WorkArea.Top,
                SystemParameters.WorkArea.Width, SystemParameters.WorkArea.Height),
            _ => new Rect(main.Left, main.Top, main.ActualWidth, main.ActualHeight),
        };
    }

    // ---- 以下は、ヘルプ窓のスレッドで動く ----

    private static void Run(Session session, Rect? owner, ManualResetEventSlim ready)
    {
        Dispatcher dispatcher;
        try
        {
            dispatcher = Dispatcher.CurrentDispatcher;
            session.Dispatcher = dispatcher;
            // このスレッドの未処理の例外は、アプリの受け皿（メインのスレッドにしか効かない）ではなくここで受ける
            dispatcher.UnhandledException += (_, e) =>
            {
                Log("ヘルプ窓の未処理の例外", e.Exception);
                e.Handled = true;
                Abort(session);
            };
            lock (Gate) _session = session;
        }
        finally
        {
            ready.Set();   // 失敗しても、メインのスレッドを待たせたままにしない
        }

        dispatcher.BeginInvoke(() => _ = StartAsync(session, owner));
        Dispatcher.Run();
    }

    private static async Task StartAsync(Session session, Rect? owner)
    {
        try
        {
            // 作業フォルダはデータのフォルダの下。窓を出す前に環境を作る（失敗したら窓を出さない）
            var userData = Path.Combine(_dataDirectory, "webview2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            if (session.CloseRequested)
            {
                End(session);
                return;
            }

            var window = new HelpWindow(environment, HelpRoot, owner);
            session.Window = window;
            window.Closed += (_, _) =>
            {
                session.Window = null;   // 閉じた窓へ、後から届いた頼みで Show しない
                End(session);
            };
            window.InitializationFailed += (_, _) =>
            {
                OpenFallback(session.Pending);
                window.Close();
            };
            window.Navigate(session.Pending);
            window.Show();
            BringToFront(window);
        }
        catch (Exception ex)
        {
            Log("ヘルプ窓: WebView2 の環境を作れないか、窓を出せませんでした。同梱物を既定のブラウザで開きます", ex);
            // 窓が出たまま、ブラウザでも開く（二重に出る）ことにしない
            try { session.Window?.Close(); }
            catch (Exception) { /* 閉じられなくても、ブラウザで開く */ }
            OpenFallback(session.Pending);
            End(session);
        }
    }

    /// <summary>窓のスレッドで、前に出してページを移す。</summary>
    private static void Show(Session session, string path)
    {
        session.Pending = path;
        if (session.CloseRequested) return;
        if (session.Window is not { } window) return;   // まだ窓が無い（環境を作っている）か、閉じた後。作ったあとに Pending で開く
        window.Navigate(path);
        BringToFront(window);
    }

    /// <summary>最小化していれば戻し、一時的に最前面にして前に出す。</summary>
    private static void BringToFront(Window window)
    {
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        if (!window.IsVisible) window.Show();
        window.Topmost = true;
        window.Activate();
        window.Topmost = false;
    }

    /// <summary>WebView2 が使えないとき、同梱物の同じページを file:/// で既定のブラウザに開かせる（節は関連付け次第で効かないことがある）。</summary>
    private static void OpenFallback(string path)
    {
        var (file, fragment) = HelpTargets.Split(path);
        var full = Path.Combine(HelpRoot, file.Replace('/', Path.DirectorySeparatorChar));
        var uri = new Uri(full).AbsoluteUri + (fragment is null ? "" : "#" + fragment);
        OpenInBrowser(uri);
    }

    /// <summary>例外のあと。窓があれば閉じて、スレッドを終える。</summary>
    private static void Abort(Session session)
    {
        try { session.Window?.Close(); }
        catch (Exception) { /* 閉じられなくても、スレッドは終える */ }
        End(session);
    }

    /// <summary>このセッションを終える。先に外へ出してから止める（止める途中で届いた次の頼みは、新しい窓で受ける）。</summary>
    private static void End(Session session)
    {
        lock (Gate)
        {
            if (_session == session) _session = null;
        }
        session.Dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
    }
}
