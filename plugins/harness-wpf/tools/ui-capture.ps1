<#
.SYNOPSIS
  WPF アプリの「ウィンドウ撮影」と「UIAutomation 操作」を行う再利用ライブラリ。
  Claude Code から実機スクリーンショットを撮る／画面を操作するときに dot-source して使う。

.DESCRIPTION
  WPF はハードウェアレンダリング時に GDI キャプチャ（CopyFromScreen/PrintWindow）が
  「タイトルバーだけ写って中身が真っ白」になる。これを回避するため、撮影前に
  WPF をソフトウェアレンダリングへ切り替える（DisableHWAcceleration=1）のが必須。
  撮影後は必ず Restore-WpfHwAccel で元に戻すこと。

  ■ 重要な運用ルール（★プライバシー保護は撮影のたびに必須チェック）
   - ★ファイルを開く/保存ダイアログ（エクスプローラ）は絶対に撮影しない（プライバシー）。
     → ダイアログを閉じてからアプリ本体のウィンドウだけを撮る。
   - ★アプリ画面内に個人フォルダパスを写さない。デモ用データ（ログ/プロジェクト等）は
     C:\Users\<名前>\…（C:\Users\Public 含む）ではなく中立パス（例 D:\Demo\）に置く。
     アプリが表示するパス文字列にも個人フォルダ名が出るため。
   - ★撮影後は画像を目視し、ユーザー名・個人フォルダ・個人情報が写っていないか確認してから採用する。
   - 撮影は software レンダリング中のみ成功する。終わったら HW アクセラレーションを戻す。
   - フォアグラウンド化は AttachThreadInput を使う（背景プロセスからの SetForegroundWindow は拒否される）。

  ■ 使い方（例）
    . "$PSScriptRoot\ui-capture.ps1"
    Set-WpfSoftwareRender                       # 撮影前に必須
    Start-Process $exe -ArgumentList '"<arg>"'; Start-Sleep 8
    Invoke-MenuItem 'メインウィンドウ' 'ファイル' 'エクスポート'   # メニュー操作
    Capture-AppWindow 'メインウィンドウ' "$env:TEMP\shot.png"        # ダイアログが無い状態で撮る
    Restore-WpfHwAccel                          # 撮影後に必ず戻す

  ■ ファイル選択ダイアログにファイルを読み込ませる（撮らない）
    Invoke-Button 'メインウィンドウ' 'ファイルを開く'
    Load-OpenFileDialog @("C:\a.csv","C:\b.csv")   # WM_SETTEXT + 開くボタン押下
#>

Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase

if (-not ([System.Management.Automation.PSTypeName]'UiCap').Type) {
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;using System.Drawing;
public class UiCap{
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumWindowsProc f, IntPtr l);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int a,out RECT r,int s);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h,int m,IntPtr w,string l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,int m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int Left,Top,Right,Bottom;}

 // タイトルに sub を含む可視トップレベルウィンドウの HWND
 public static IntPtr Find(string sub){ IntPtr res=IntPtr.Zero;
  EnumWindows((h,l)=>{ if(IsWindowVisible(h)){ int n=GetWindowTextLength(h); if(n>0){ var s=new StringBuilder(n+1); GetWindowText(h,s,s.Capacity); var t=s.ToString(); if(t.Contains(sub) && !t.Contains("Visual Studio Code")){ res=h; return false; } } } return true; }, IntPtr.Zero); return res; }

 // フォアグラウンド化（AttachThreadInput で前面ロックを回避）
 public static void Foreground(IntPtr h){ ShowWindow(h,9);
  uint fg=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero); uint me=GetCurrentThreadId();
  AttachThreadInput(me,fg,true); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me,fg,false); }

 // DWM 実枠（影を除く）で GDI 撮影。software レンダリング中のみ中身が写る。
 public static string Capture(string sub,string path){ IntPtr h=Find(sub); if(h==IntPtr.Zero) return "NOTFOUND";
  Foreground(h); System.Threading.Thread.Sleep(900);
  RECT r; DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT))); int w=r.Right-r.Left, hg=r.Bottom-r.Top;
  var bmp=new Bitmap(w,hg); using(var g=Graphics.FromImage(bmp)){ g.CopyFromScreen(r.Left,r.Top,0,0,bmp.Size); }
  bmp.Save(path,System.Drawing.Imaging.ImageFormat.Png); bmp.Dispose(); return "OK "+w+"x"+hg; }

 // ダイアログ内の「最下部の Edit」(=ファイル名欄) と Button を class/位置で特定
 public static IntPtr BottomEdit(IntPtr dlg){ IntPtr best=IntPtr.Zero; int bestY=-1;
  EnumChildWindows(dlg,(h,l)=>{ var cn=new StringBuilder(64); GetClassName(h,cn,64); if(cn.ToString()=="Edit"){ RECT r; GetWindowRect(h,out r); if(r.Top>bestY){ bestY=r.Top; best=h; } } return true; }, IntPtr.Zero); return best; }
 public static IntPtr FindButton(IntPtr dlg,string text){ IntPtr res=IntPtr.Zero;
  EnumChildWindows(dlg,(h,l)=>{ var cn=new StringBuilder(64); GetClassName(h,cn,64); if(cn.ToString()=="Button"){ int n=GetWindowTextLength(h); var t=new StringBuilder(n+1); GetWindowText(h,t,t.Capacity); if(t.ToString().Contains(text)){ res=h; return false; } } return true; }, IntPtr.Zero); return res; }
 public static void SetText(IntPtr h,string s){ SendMessageW(h,0x000C,IntPtr.Zero,s); }   // WM_SETTEXT(Unicode)
 public static void Click(IntPtr h){ SendMessage(h,0x00F5,IntPtr.Zero,IntPtr.Zero); }      // BM_CLICK

 // 画面座標の左クリック（自前描画コントロール＝UIA 非露出の要素を叩く用）
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 public static void ClickAt(int x,int y){ SetCursorPos(x,y); System.Threading.Thread.Sleep(150);
   mouse_event(0x02,0,0,0,IntPtr.Zero); mouse_event(0x04,0,0,0,IntPtr.Zero); }   // LEFTDOWN|LEFTUP

 // タイトルに sub を含む可視ウィンドウの DWM 実枠（影除く・物理px）。{L,T,R,B}。
 public static int[] Rect(string sub){ IntPtr h=Find(sub); if(h==IntPtr.Zero) return null;
   RECT r; DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT))); return new int[]{r.Left,r.Top,r.Right,r.Bottom}; }

 // ウィンドウの位置・サイズを変更（撮影時の見切れ回避用・物理px）。
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hh,bool repaint);
 public static void Resize(string sub,int x,int y,int w,int hh){ IntPtr h=Find(sub); if(h!=IntPtr.Zero) MoveWindow(h,x,y,w,hh,true); }
}
"@ -ReferencedAssemblies System.Drawing, System.Text.RegularExpressions
}

# ── WPF レンダリング切替（撮影の前後で必ず使う） ──────────────────────────
function Set-WpfSoftwareRender {
  $k = "HKCU:\SOFTWARE\Microsoft\Avalon.Graphics"
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  New-ItemProperty -Path $k -Name DisableHWAcceleration -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Output "WPF software render ON（撮影後 Restore-WpfHwAccel を忘れずに）"
}
function Restore-WpfHwAccel {
  Remove-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Avalon.Graphics" -Name DisableHWAcceleration -ErrorAction SilentlyContinue
  Write-Output "WPF hardware accel restored"
}

# ── 撮影（ダイアログが出ていない状態で呼ぶこと） ──────────────────────────
function Capture-AppWindow([string]$TitleContains, [string]$OutPath) { [UiCap]::Capture($TitleContains, $OutPath) }

# ── UIAutomation 操作ヘルパ ───────────────────────────────────────────────
$script:AE = [System.Windows.Automation.AutomationElement]
$script:TS = [System.Windows.Automation.TreeScope]
$script:CT = [System.Windows.Automation.ControlType]
function _ae([IntPtr]$h) { $script:AE::FromHandle($h) }
function _byType($el, $ct) { $el.FindAll($script:TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($script:AE::ControlTypeProperty, $ct))) }

# トップメニュー → サブ項目（部分一致）を実行
function Invoke-MenuItem([string]$WinContains, [string]$TopMenu, [string]$SubItem) {
  $win = _ae ([UiCap]::Find($WinContains))
  $top = _byType $win $script:CT::MenuItem | Where-Object { $_.Current.Name -like "*$TopMenu*" } | Select-Object -First 1
  $top.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 700
  $sub = $script:AE::RootElement.FindAll($script:TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($script:AE::ControlTypeProperty, $script:CT::MenuItem))) | Where-Object { $_.Current.Name -like "*$SubItem*" } | Select-Object -First 1
  $sub.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
# ボタン（部分一致）を押す
function Invoke-Button([string]$WinContains, [string]$ButtonText) {
  $win = _ae ([UiCap]::Find($WinContains))
  $b = _byType $win $script:CT::Button | Where-Object { $_.Current.Name -like "*$ButtonText*" } | Select-Object -First 1
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
# トグルボタン（完全一致）を切り替える
function Toggle-Button([string]$WinContains, [string]$ButtonText) {
  $win = _ae ([UiCap]::Find($WinContains))
  $b = _byType $win $script:CT::Button | Where-Object { $_.Current.Name -eq $ButtonText } | Select-Object -First 1
  $b.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
}

# 画面座標を左クリック（物理ピクセル）
function Invoke-ClickPoint([int]$X, [int]$Y) { [UiCap]::ClickAt($X, $Y) }

# 自前描画コントロール（AutomationPeer 無しで UIA に出ない要素、例: 独自 Canvas 描画のタイムライン/グラフ等）を、
# ウィンドウ実枠からの相対オフセットで叩くための「型」。BaseY/ItemH/OffsetX はコントロールごとに実測して渡すこと
# （下記の値はサンプル。対象コントロールのレイアウトに合わせて呼び出し側で調整する）。
function Click-RelativePoint([string]$WinContains, [int]$ItemIndex = 0, [int]$BaseY = 200, [int]$ItemH = 30, [int]$OffsetX = 50) {
  $h = [UiCap]::Find($WinContains)
  if ($h -eq [IntPtr]::Zero) { Write-Output 'window not found'; return $false }
  $rc = [UiCap]::Rect($WinContains)        # L,T,R,B（物理px）
  $dpi = [UiCap]::GetDpiForWindow($h); if ($dpi -le 0) { $dpi = 96 }
  $s = $dpi / 96.0
  $x = [int]($rc[0] + $OffsetX * $s)
  $y = [int]($rc[1] + ($BaseY + $ItemH * $ItemIndex) * $s)
  [UiCap]::Foreground($h); Start-Sleep -Milliseconds 400
  [UiCap]::ClickAt($x, $y)
  return $true
}

# ── ファイルを開くダイアログにパス群を読み込ませる（★ダイアログは撮らない） ──
# 直前に Invoke-Button '…' 'ファイルを開く' 等でダイアログを出しておくこと。
function Load-OpenFileDialog([string[]]$Paths, [string]$DialogTitle = '開く', [string]$OpenButton = '開く') {
  Start-Sleep -Seconds 2
  $dh = [UiCap]::Find($DialogTitle)
  if ($dh -eq [IntPtr]::Zero) { Write-Output "dialog '$DialogTitle' not found"; return $false }
  $edit = [UiCap]::BottomEdit($dh)          # 最下部 Edit = ファイル名欄
  $btn  = [UiCap]::FindButton($dh, $OpenButton)
  $val  = ($Paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
  [UiCap]::SetText($edit, $val); Start-Sleep -Milliseconds 500
  [UiCap]::Click($btn); Start-Sleep -Seconds 3
  $closed = ([UiCap]::Find($DialogTitle) -eq [IntPtr]::Zero)
  Write-Output "loaded=$closed"
  return $closed
}

Write-Output "ui-capture.ps1 loaded. 関数: Set-WpfSoftwareRender / Capture-AppWindow / Invoke-MenuItem / Invoke-Button / Toggle-Button / Invoke-ClickPoint / Click-RelativePoint / Load-OpenFileDialog / Restore-WpfHwAccel"
