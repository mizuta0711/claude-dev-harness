#nullable enable
using System;
using System.Collections.Generic;

namespace {{ROOT_NAMESPACE}}.Services;

/// <summary>
/// F1・「ヘルプ」ボタンの飛び先。飛び先の名前（アプリ側）と、同梱のマニュアルの中のパスの対応を、ここ 1 か所に置く。
/// すべて副作用の無い関数（ヘルプ窓を開く処理は <see cref="HelpService"/>）。
/// <para>
/// 約束: 下の <c>Paths</c> の値と <see cref="IndexPath"/> は、マニュアルのパスを
/// 二重引用符の文字列リテラル（manual/ で始まり .html で終わり、節があれば #id つき）でそのまま書く。
/// 配布サイトの検査（tools/check-web.mjs）がこのファイルからその形の文字列を拾い、
/// web/ に同じファイルと id があるかを確かめる。定数の連結・文字列補間・別ファイルへの移動をすると検査から漏れる。
/// </para>
/// <para>マニュアルのページ名や節の id を変えたら、ここも同じコミットで直す（直し漏れは検査が止める）。</para>
/// </summary>
public static class HelpTargets
{
    // 飛び先の名前。画面（とその中の状態）ごとに 1 つ。下は例（add-distribution-site の枠にある画面のページ）。
    // プロジェクトの画面に合わせて足す・消す（例: Home = "home"、Settings = "settings"）
    public const string Main = "main";

    /// <summary>飛び先が分からないとき。</summary>
    public const string Index = "index";

    /// <summary>入口のパス。飛び先が分からないとき・同梱物に無いときの落ち先。</summary>
    public const string IndexPath = "manual/index.html";

    private static readonly Dictionary<string, string> Paths = new(StringComparer.Ordinal)
    {
        // [名前] = マニュアルの中のパス（節は #id）。マニュアルに実在するページと id だけを書く。
        // 節まで飛ばすときは、パスの末尾に #id を付ける（例: 設定の画面の詳細の節 → manual/screens/settings.html#advanced）
        [Main] = "manual/screens/main.html",
    };

    /// <summary>飛び先の名前に対応する、同梱物の中のパス（節があれば <c>#節</c> つき）。知らない名前は入口。</summary>
    public static string PathOf(string? target) =>
        target is not null && Paths.TryGetValue(target, out var path) ? path : IndexPath;

    /// <summary>知っている名前の一覧（表の照合・テスト用）。</summary>
    public static IReadOnlyCollection<string> Names => Paths.Keys;

    /// <summary>パスを、ファイルの部分と節（<c>#</c> のあと。無ければ null）に分ける。</summary>
    public static (string File, string? Fragment) Split(string path)
    {
        var i = path.IndexOf('#');
        return i < 0 ? (path, null) : (path[..i], i + 1 < path.Length ? path[(i + 1)..] : null);
    }

    /// <summary>
    /// メインウィンドウでいま表示している画面から飛び先を決める（F1・「ヘルプ」ボタンが使う）。
    /// 引数は、プロジェクトが「いまの画面」を表すもの（表示中の ViewModel・ページの要素・画面のキーなど）。
    /// </summary>
    public static string ForPage(object? page) => page switch
    {
        // プロジェクトの画面の型（またはキー）に合わせて書き換える。例:
        // MainViewModel => Main,
        // SettingsViewModel => Settings,
        // 同じ画面の中で状態ごとに節を分けるなら、その状態を見て別の名前を返す
        string key when Paths.ContainsKey(key) => key,
        _ => Index,
    };
}
