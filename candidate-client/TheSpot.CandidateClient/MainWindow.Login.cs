using System.ComponentModel;
using System.Net;
using System.Windows;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Security;
using TheSpot.CandidateClient.Core.Storage;
using TheSpot.CandidateClient.Core.Sync;

namespace TheSpot.CandidateClient;

public partial class MainWindow
{
    private ExamSession? _session;

    private void ShowLogin(string? message = null)
    {
        var s = _machine.State;
        CenterNameText.Text = $"{s.CenterName ?? "Center Server"}  ·  {s.ServerHost}:{s.ServerPort}";
        MachineText.Text = $"PC {_machineId}  ·  pinned {s.ServerFingerprint?[..23]}…";
        LoginStatus.Text = message ?? "";
        ShowView(LoginView);
        RollBox.Focus();
    }

    private CenterApiClient Api()
    {
        var s = _machine.State;
        return _api ??= new CenterApiClient(s.ServerHost!, s.ServerPort, s.ServerFingerprint!, _machineId) { MachineToken = s.MachineToken };
    }

    private async Task RegisterAsync(CenterApiClient api)
    {
        if (api.MachineToken != null) return;
        var r = await api.RegisterAsync(Environment.MachineName, typeof(App).Assembly.GetName().Version?.ToString() ?? "");
        api.MachineToken = r.MachineToken;
        _machine.Update(s => s.MachineToken = r.MachineToken);
        Log($"registered machine {_machineId}");
    }

    private async void Login_Click(object sender, RoutedEventArgs e)
    {
        var roll = RollBox.Text.Trim().ToUpperInvariant();
        var pw = PasswordBox.Password;
        if (roll.Length == 0 || pw.Length == 0)
        {
            LoginStatus.Text = "Enter your roll number and password.";
            return;
        }
        LoginButton.IsEnabled = false;
        LoginStatus.Text = "";
        try
        {
            var api = Api();
            await RegisterAsync(api);
            LoginResult r;
            try
            {
                r = await api.LoginAsync(roll, pw);
            }
            catch (ApiException ex) when (ex.Status == HttpStatusCode.Unauthorized && ex.Message.Contains("machine", StringComparison.OrdinalIgnoreCase))
            {
                // Invigilator reset this PC on the server: register again (same machine id) and retry once.
                api.MachineToken = null;
                _machine.Update(s => s.MachineToken = null);
                await RegisterAsync(api);
                r = await api.LoginAsync(roll, pw);
            }
            PasswordBox.Clear();
            StartExam(api, r);
        }
        catch (ApiException ex) when (ex.Status == HttpStatusCode.Conflict && ex.Message.Contains("Machine already registered"))
        {
            LoginStatus.Text = $"This PC is already registered with the Center Server. Invigilator: reset machine {_machineId} in the admin console, then try again.";
        }
        catch (ApiException ex)
        {
            LoginStatus.Text = ex.Message;
        }
        catch (PinMismatchException ex)
        {
            LoginStatus.Text = "Refused: the Center Server certificate does not match the pinned fingerprint. Call the invigilator.";
            Log($"pin mismatch expected={ex.Expected} presented={ex.Presented}");
        }
        catch (CenterUnreachableException)
        {
            LoginStatus.Text = "Cannot reach the Center Server. Check the LAN cable and try again.";
        }
        finally
        {
            LoginButton.IsEnabled = true;
        }
    }

    private void OnSessionExpired()
    {
        if (_session == null) return;
        var s = _session;
        _session = null;
        _uiTimer.Stop();
        _ = s.DisposeAsync().AsTask();
        ShowLogin("Your session was closed by the Center Server (for example the invigilator reset it). Please log in again.");
    }

    // ---------- kiosk / invigilator ----------
    private void OnViolation(string type, string? detail)
    {
        Log($"violation {type} {detail}");
        if (_session != null) _session.LogViolation(type, detail);
        else
        {
            _machine.Update(s => s.PendingViolations.Add(new CachedViolation
            {
                Id = s.PendingViolations.Count + 1, Type = type, Detail = detail, At = DateTime.UtcNow.ToString("O"),
            }));
        }
        if (type == "kiosk_exit") return;
        ShowToast(type == "focus_lost"
            ? "Leaving the exam window is not allowed — this has been recorded"
            : $"{detail ?? type} — not allowed, recorded");
    }

    private void ShowToast(string text)
    {
        ToastText.Text = text;
        Toast.Visibility = Visibility.Visible;
        _toastTimer.Stop();
        _toastTimer.Start();
    }

    private void AskInvigilator(string prompt, Action ok)
    {
        if (_cfg.InvigilatorPasswordHash == null)
        {
            ShowToast("No invigilator password is configured in client.json — action disabled");
            return;
        }
        _invigilatorOk = ok;
        InvigilatorPrompt.Text = prompt;
        InvigilatorStatus.Text = "";
        InvigilatorPassword.Clear();
        InvigilatorOverlay.Visibility = Visibility.Visible;
        InvigilatorPassword.Focus();
    }

    private void InvigilatorOk_Click(object sender, RoutedEventArgs e)
    {
        if (!PasswordHasher.Verify(InvigilatorPassword.Password, _cfg.InvigilatorPasswordHash))
        {
            InvigilatorPassword.Clear();
            InvigilatorStatus.Text = "Incorrect password.";
            OnViolation("invigilator_password_failed", "wrong invigilator password");
            return;
        }
        InvigilatorPassword.Clear();
        InvigilatorOverlay.Visibility = Visibility.Collapsed;
        var ok = _invigilatorOk;
        _invigilatorOk = null;
        ok?.Invoke();
    }

    private void InvigilatorCancel_Click(object sender, RoutedEventArgs e)
    {
        InvigilatorPassword.Clear();
        InvigilatorOverlay.Visibility = Visibility.Collapsed;
        _invigilatorOk = null;
    }

    private async void ExitApp()
    {
        _allowClose = true;
        var s = _session;
        _session = null;
        if (s != null)
        {
            s.Book.AddViolation("kiosk_exit", "invigilator exited the client");
            await s.DisposeAsync();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            try
            {
                await s.SyncOnceAsync(cts.Token); // last flush; anything left stays in the encrypted cache
            }
            catch (Exception ex)
            {
                Log("final flush: " + ex.Message);
            }
        }
        _kiosk.Dispose();
        Log("invigilator exit");
        Close();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_allowClose || !_kiosk.Enabled)
        {
            _kiosk.Dispose();
            return;
        }
        e.Cancel = true;
        OnViolation("close_attempt", "window close blocked");
    }
}
