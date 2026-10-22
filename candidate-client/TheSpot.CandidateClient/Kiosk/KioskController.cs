using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using TheSpot.CandidateClient.Core.Kiosk;
using TheSpot.CandidateClient.Core.Storage;
using static TheSpot.CandidateClient.Kiosk.NativeMethods;

namespace TheSpot.CandidateClient.Kiosk;

/// <summary>
/// Best-effort user-mode lockdown: borderless topmost full-screen window, low-level keyboard hook,
/// capture exclusion, clipboard clearing, copy/paste commands disabled and focus-loss detection.
/// It cannot stop Ctrl+Alt+Del / Win+L (secure attention sequence) or an administrator; see README.
/// </summary>
public sealed class KioskController : IDisposable
{
    private readonly Window _w;
    private readonly KioskOptions _o;
    private readonly LowLevelKeyboardProc _proc;
    private readonly DispatcherTimer _clip = new() { Interval = TimeSpan.FromSeconds(2) };
    private IntPtr _hook;
    private int _heldBlockedVk = -1;
    private bool _engaged;

    /// <summary>(type, detail) — raised on the UI thread for every blocked key / focus loss.</summary>
    public event Action<string, string?>? Violation;
    public event Action? ExitRequested;

    public string CaptureProtection { get; private set; } = "off";
    public bool HookInstalled => _hook != IntPtr.Zero;
    public bool Enabled => _o.Enabled;

    public KioskController(Window w, KioskOptions o)
    {
        _w = w;
        _o = o;
        _proc = HookProc; // keep the delegate alive for the lifetime of the hook
        _clip.Tick += (_, _) => ClearClipboard();
    }

    public void Engage()
    {
        if (_engaged) return;
        _engaged = true;
        // Copy/paste is disabled in the UI even when full kiosk mode is off.
        CommandManager.AddPreviewExecutedHandler(_w, OnPreviewExecuted);
        CommandManager.AddPreviewCanExecuteHandler(_w, OnPreviewCanExecute);
        DataObject.AddPastingHandler(_w, (_, e) => e.CancelCommand());
        DataObject.AddCopyingHandler(_w, (_, e) => e.CancelCommand());
        if (!_o.Enabled) return;

        _w.WindowStyle = WindowStyle.None;
        _w.ResizeMode = ResizeMode.NoResize;
        _w.Topmost = true;
        _w.WindowState = WindowState.Normal;
        _w.Left = 0;
        _w.Top = 0;
        _w.Width = SystemParameters.PrimaryScreenWidth;
        _w.Height = SystemParameters.PrimaryScreenHeight;
        _w.ShowInTaskbar = false;
        _w.Deactivated += OnDeactivated;

        if (_o.BlockKeys)
        {
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero) Violation?.Invoke("kiosk_degraded", "keyboard hook failed: " + Marshal.GetLastWin32Error());
        }
        if (_o.ExcludeFromCapture) ApplyCaptureProtection();
        if (_o.ClearClipboard)
        {
            ClearClipboard();
            _clip.Start();
        }
    }

    private void ApplyCaptureProtection()
    {
        var hwnd = new WindowInteropHelper(_w).EnsureHandle();
        if (SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) CaptureProtection = "exclude-from-capture";
        else if (SetWindowDisplayAffinity(hwnd, WDA_MONITOR)) CaptureProtection = "monitor-only (older Windows: captures show black)";
        else
        {
            CaptureProtection = "failed";
            Violation?.Invoke("kiosk_degraded", "SetWindowDisplayAffinity failed: " + Marshal.GetLastWin32Error());
        }
    }

    private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var k = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var msg = (int)wParam;
            var down = msg is WM_KEYDOWN or WM_SYSKEYDOWN;
            // LLKHF_ALTDOWN is not set while Ctrl is also held (Ctrl+Alt is delivered as WM_KEYDOWN).
            var alt = (k.flags & LLKHF_ALTDOWN) != 0 || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
            var ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
            var shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
            var vk = (int)k.vkCode;
            switch (KeyPolicy.Evaluate(vk, alt, ctrl, shift, out var violation))
            {
                case KeyDecision.Block:
                    if (down && _heldBlockedVk != vk)
                    {
                        _heldBlockedVk = vk; // log once per press, not per auto-repeat
                        var detail = $"blocked {KeyPolicy.Describe(vk, alt, ctrl, shift)}";
                        _w.Dispatcher.BeginInvoke(() => Violation?.Invoke(violation!, detail));
                    }
                    else if (!down && _heldBlockedVk == vk) _heldBlockedVk = -1;
                    return 1;
                case KeyDecision.InvigilatorExit:
                    if (down) _w.Dispatcher.BeginInvoke(() => ExitRequested?.Invoke());
                    return 1;
            }
            if (!down && _heldBlockedVk == vk) _heldBlockedVk = -1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private void OnDeactivated(object? sender, EventArgs e)
    {
        if (!_engaged) return;
        Violation?.Invoke("focus_lost", "exam window lost focus");
        _w.Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (!_engaged) return;
            _w.Topmost = true;
            _w.Activate();
            SetForegroundWindow(new WindowInteropHelper(_w).Handle);
        });
    }

    private static bool IsClipboardCommand(ICommand c) =>
        c == ApplicationCommands.Copy || c == ApplicationCommands.Cut || c == ApplicationCommands.Paste;

    private void OnPreviewExecuted(object sender, ExecutedRoutedEventArgs e)
    {
        if (!IsClipboardCommand(e.Command)) return;
        e.Handled = true;
        if (!HookInstalled) Violation?.Invoke(e.Command == ApplicationCommands.Paste ? "paste" : "copy", "blocked in UI");
    }

    private static void OnPreviewCanExecute(object sender, CanExecuteRoutedEventArgs e)
    {
        if (!IsClipboardCommand(e.Command)) return;
        e.CanExecute = false;
        e.Handled = true;
    }

    private static void ClearClipboard()
    {
        try
        {
            Clipboard.Clear();
        }
        catch (COMException)
        {
            // clipboard busy; next tick
        }
    }

    /// <summary>Invigilator exit or shutdown: release every hook so the PC is usable again.</summary>
    public void Dispose()
    {
        _engaged = false;
        _clip.Stop();
        _w.Deactivated -= OnDeactivated;
        if (_hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
        }
    }
}
