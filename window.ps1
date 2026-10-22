param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [int]$Width = 425,
  [int]$PosX = -1,
  [int]$PosY = -1,
  [int]$Pinned = 1,
  [int]$DeferResize = 0
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CompactWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@

[void][CompactWin]::SetProcessDPIAware()

$WS_THICKFRAME = 0x00040000
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$SWP_NOSENDCHANGING = 0x0400
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SW_RESTORE = 9
$SW_MAXIMIZE = 3

function Get-Rect([IntPtr]$h) {
  $r = New-Object CompactWin+RECT
  [void][CompactWin]::GetWindowRect($h, [ref]$r)
  return @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

# Ease the window from one rect to another so entering and leaving compact mode is not abrupt.
function Animate-Rect([IntPtr]$h, $from, $to, [int]$frames = 12) {
  for ($i = 1; $i -le $frames; $i++) {
    $t = $i / [double]$frames
    $e = 1 - [Math]::Pow(1 - $t, 3)
    $x = [int][Math]::Round($from.x + ($to.x - $from.x) * $e)
    $y = [int][Math]::Round($from.y + ($to.y - $from.y) * $e)
    $w = [int][Math]::Round($from.w + ($to.w - $from.w) * $e)
    $hh = [int][Math]::Round($from.h + ($to.h - $from.h) * $e)
    [void][CompactWin]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, ($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_NOSENDCHANGING))
    Start-Sleep -Milliseconds 16
  }
}

function Get-ImagePath([int]$procId) {
  $handle = [CompactWin]::OpenProcess(0x1000, $false, $procId)
  if ($handle -eq [IntPtr]::Zero) { return '' }
  try {
    $sb = New-Object System.Text.StringBuilder 1024
    $size = 1024
    if ([CompactWin]::QueryFullProcessImageName($handle, 0, $sb, [ref]$size)) { return $sb.ToString() }
    return ''
  }
  finally {
    [void][CompactWin]::CloseHandle($handle)
  }
}

function Find-Target([int]$procId) {
  if ($procId -gt 0) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
      return @{ hwnd = [IntPtr]$p.MainWindowHandle; visible = $true; matched = 'pid-main' }
    }
  }

  $script:collected = @()
  $cb = [CompactWin+EnumProc] {
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][CompactWin]::GetWindowText($h, $sb, 512)
    $owner = 0
    [void][CompactWin]::GetWindowThreadProcessId($h, [ref]$owner)
    $r = New-Object CompactWin+RECT
    [void][CompactWin]::GetWindowRect($h, [ref]$r)
    $script:collected += [pscustomobject]@{
      hwnd = $h
      pid = [int]$owner
      title = $sb.ToString()
      visible = [CompactWin]::IsWindowVisible($h)
      area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
    }
    return $true
  }
  [void][CompactWin]::EnumWindows($cb, [IntPtr]::Zero)

  $bestVisible = $null
  $bestAny = $null
  foreach ($c in $script:collected) {
    if ($c.title.Length -eq 0 -or $c.area -le 20000) { continue }
    $isTarget = $false
    if ($procId -gt 0 -and $c.pid -eq $procId) {
      $isTarget = $true
    }
    else {
      $image = Get-ImagePath $c.pid
      if ($image -like '*DSH NEXT.exe') { $isTarget = $true }
    }
    if (-not $isTarget) { continue }
    if ($c.visible) {
      if ($null -eq $bestVisible -or $c.area -gt $bestVisible.area) { $bestVisible = $c }
    }
    if ($null -eq $bestAny -or $c.area -gt $bestAny.area) { $bestAny = $c }
  }
  if ($bestVisible) { return @{ hwnd = $bestVisible.hwnd; visible = $true; matched = 'scan' } }
  if ($bestAny) { return @{ hwnd = $bestAny.hwnd; visible = $false; matched = 'scan-hidden' } }
  return @{ hwnd = [IntPtr]::Zero; visible = $false; matched = 'none' }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-State($value) {
  $dir = Split-Path -Parent $StateFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Remove-State {
  if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
}

$result = [ordered]@{ ok = $false; mode = 'normal' }

try {
  $target = Find-Target $ParentPid
  $hwnd = $target.hwnd
  $visible = $target.visible
  if ($hwnd -eq [IntPtr]::Zero) {
    $result.error = 'window not found'
    $result.available = $false
    $result | ConvertTo-Json -Compress
    return
  }
  $result.hwnd = $hwnd.ToInt64()
  $result.available = [bool]$visible
  $result.matched = $target.matched

  $state = Read-State
  $rect = Get-Rect $hwnd
  $dpi = [CompactWin]::GetDpiForWindow($hwnd)
  $scale = if ($dpi -gt 0) { $dpi / 96.0 } else { 1.0 }

  if ($Action -eq 'status') {
    $result.mode = if ($state -and $state.mode -eq 'compact') { 'compact' } else { 'normal' }
    $result.rect = $rect
    $result.scale = [Math]::Round($scale, 3)
    $ex = [CompactWin]::GetWindowLong($hwnd, -20)
    $result.pinned = [bool]($ex -band 0x8)
    $result.ok = $true
    $result | ConvertTo-Json -Compress
    return
  }

  if ($Action -eq 'cleanup') {
    if ($state -and $state.mode -eq 'compact' -and $rect.w -gt ([int]$state.targetW + 24)) {
      Remove-State
    }
    $result.ok = $true
    $result.mode = if (Test-Path -LiteralPath $StateFile) { 'compact' } else { 'normal' }
    $result | ConvertTo-Json -Compress
    return
  }

  if ($Action -eq 'setPin') {
    $after = if ($Pinned -eq 1) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
    [void][CompactWin]::SetWindowPos($hwnd, $after, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
    if ($state -and $state.mode -eq 'compact') {
      $state | Add-Member -NotePropertyName pinned -NotePropertyValue ([bool]($Pinned -eq 1)) -Force
      Write-State $state
    }
    $result.ok = $true
    $result.pinned = [bool]($Pinned -eq 1)
    $result.mode = if ($state -and $state.mode -eq 'compact') { 'compact' } else { 'normal' }
    $result | ConvertTo-Json -Compress
    return
  }

  if ($Action -eq 'toggle') {
    $Action = if ($state -and $state.mode -eq 'compact') { 'exit' } else { 'enter' }
  }

  if ($Action -eq 'enter') {
    if (-not $visible) {
      $result.error = 'desktop window is hidden'
      $result | ConvertTo-Json -Compress
      return
    }
    if ($state -and $state.mode -eq 'compact' -and [Math]::Abs($rect.w - [int]$state.targetW) -le 24) {
      $result.ok = $true
      $result.mode = 'compact'
      $result.rect = $rect
      $result | ConvertTo-Json -Compress
      return
    }

    $wasZoomed = [CompactWin]::IsZoomed($hwnd)
    if ($wasZoomed) {
      [void][CompactWin]::ShowWindow($hwnd, $SW_RESTORE)
      Start-Sleep -Milliseconds 250
      $rect = Get-Rect $hwnd
    }

    $style = [CompactWin]::GetWindowLong($hwnd, -16)
    $exstyle = [CompactWin]::GetWindowLong($hwnd, -20)

    $targetW = [int][Math]::Round($Width * $scale)
    $targetH = $rect.h

    $monitor = [CompactWin]::MonitorFromWindow($hwnd, 2)
    $info = New-Object CompactWin+MONITORINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    [void][CompactWin]::GetMonitorInfo($monitor, [ref]$info)
    $margin = [int][Math]::Round(16 * $scale)
    if ($PosX -ge 0 -and $PosY -ge 0) {
      $x = [Math]::Max($info.rcWork.Left + $margin, [Math]::Min($PosX, $info.rcWork.Right - $targetW - $margin))
      $y = [Math]::Max($info.rcWork.Top + $margin, [Math]::Min($PosY, $info.rcWork.Bottom - $targetH - $margin))
    }
    else {
      $x = $info.rcWork.Right - $targetW - $margin
      $y = [Math]::Max($info.rcWork.Top + $margin, [Math]::Min($rect.y, $info.rcWork.Bottom - $targetH - $margin))
    }

    Write-State ([ordered]@{
      mode = 'compact'
      hwnd = $hwnd.ToInt64()
      x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h
      style = $style
      exstyle = $exstyle
      targetW = $targetW
      targetH = $targetH
      wasZoomed = [bool]$wasZoomed
      pinned = [bool]($Pinned -eq 1)
    })

    [void][CompactWin]::SetWindowLong($hwnd, -16, ($style -band (-bnot $WS_THICKFRAME)))
    [void][CompactWin]::SetWindowLong($hwnd, -20, (($exstyle -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)))

    $flags = $SWP_NOSENDCHANGING -bor $SWP_FRAMECHANGED -bor $SWP_NOACTIVATE
    $after = if ($Pinned -eq 1) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
    [void][CompactWin]::SetWindowPos($hwnd, $after, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
    if ($DeferResize -eq 1) {
      $result.target = @{ x = $x; y = $y; w = $targetW; h = $targetH }
    }
    else {
      Animate-Rect $hwnd (Get-Rect $hwnd) @{ x = $x; y = $y; w = $targetW; h = $targetH }
    }
    Start-Sleep -Milliseconds 30

    $result.ok = $true
    $result.mode = 'compact'
    $result.pinned = [bool]($Pinned -eq 1)
    $result.rect = Get-Rect $hwnd
    $result | ConvertTo-Json -Compress
    return
  }

  if ($Action -eq 'exit') {
    if (-not $state -or $state.mode -ne 'compact') {
      $result.ok = $true
      $result.mode = 'normal'
      $result | ConvertTo-Json -Compress
      return
    }

    $style = [CompactWin]::GetWindowLong($hwnd, -16)
    $exstyle = [CompactWin]::GetWindowLong($hwnd, -20)
    [void][CompactWin]::SetWindowLong($hwnd, -16, ($style -bor $WS_THICKFRAME))
    [void][CompactWin]::SetWindowLong($hwnd, -20, $state.exstyle)

    $flags = $SWP_NOSENDCHANGING -bor $SWP_FRAMECHANGED -bor $SWP_NOACTIVATE
    [void][CompactWin]::SetWindowPos($hwnd, $HWND_NOTOPMOST, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
    if ($DeferResize -eq 1) {
      $result.target = @{ x = [int]$state.x; y = [int]$state.y; w = [int]$state.w; h = [int]$state.h }
      $result.wasZoomed = [bool]$state.wasZoomed
    }
    else {
      Animate-Rect $hwnd (Get-Rect $hwnd) @{ x = [int]$state.x; y = [int]$state.y; w = [int]$state.w; h = [int]$state.h }
      if ($state.wasZoomed) {
        Start-Sleep -Milliseconds 150
        [void][CompactWin]::ShowWindow($hwnd, $SW_MAXIMIZE)
      }
    }
    Remove-State

    $result.ok = $true
    $result.mode = 'normal'
    $result.pinned = $false
    $result.rect = Get-Rect $hwnd
    $result | ConvertTo-Json -Compress
    return
  }

  $result.error = "unknown action: $Action"
  $result | ConvertTo-Json -Compress
}
catch {
  $result.error = $_.Exception.Message
  $result | ConvertTo-Json -Compress
}
