using System.Net;
using System.Windows;
using System.Windows.Threading;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Security;
using TheSpot.CandidateClient.Core.Storage;
using TheSpot.CandidateClient.Kiosk;

namespace TheSpot.CandidateClient;

public sealed record DiscoveredItem(DiscoverInfo Info)
{
    public string Title => Info.CenterName ?? Info.CenterCode ?? "Center Server";
    public string Address => $"{Info.LanIp}:{Info.Port}   ·   {CertificatePin.Normalize(Info.CertFingerprint)[..23]}…";
}

/// <summary>Connect → Login → Exam → Finished. Connection/login logic here; exam UI in MainWindow.Exam.cs.</summary>
public partial class MainWindow : Window
{
    private readonly ClientConfig _cfg;
    private readonly MachineStore _machine;
    private readonly ExamCache _cache;
    private readonly KioskController _kiosk;
    private readonly string _machineId = MachineIdentity.Get();
    private readonly DispatcherTimer _toastTimer = new() { Interval = TimeSpan.FromSeconds(3) };
    private CenterApiClient? _api;
    private (string host, int port, string fp, string? name)? _candidatePin;
    private Action? _invigilatorOk;
    private bool _allowClose;

    public MainWindow(ClientConfig cfg, string dataDir)
    {
        _cfg = cfg;
        var store = new SecureStore(dataDir);
        _machine = new MachineStore(store).Load();
        _cache = new ExamCache(store);
        InitializeComponent();
        _kiosk = new KioskController(this, cfg.Kiosk);
        _kiosk.Violation += OnViolation;
        _kiosk.ExitRequested += () => AskInvigilator("Exit kiosk mode and close the exam client on this PC?", ExitApp);
        _toastTimer.Tick += (_, _) => { Toast.Visibility = Visibility.Collapsed; _toastTimer.Stop(); };
        _uiTimer.Tick += (_, _) => RefreshStatus();
        SourceInitialized += (_, _) => _kiosk.Engage();
        Loaded += (_, _) => Start();
        Closing += OnClosing;
        if (_machine.LoadWarning != null) Log(_machine.LoadWarning);
    }

    private static void Log(string s) => ((App)Application.Current).Log(s);

    private void Start()
    {
        var s = _machine.State;
        if (_cfg.ServerHost != null && _cfg.ServerFingerprint != null &&
            (s.ServerHost != _cfg.ServerHost || s.ServerFingerprint != CertificatePin.Normalize(_cfg.ServerFingerprint)))
        {
            SavePin(_cfg.ServerHost, _cfg.ServerPort, CertificatePin.Normalize(_cfg.ServerFingerprint), null);
        }
        if (_machine.State.ServerHost != null && _machine.State.ServerFingerprint != null) ShowLogin();
        else
        {
            ShowView(ConnectView);
            if (_cfg.ServerHost != null) HostBox.Text = _cfg.ServerHost;
            PortBox.Text = _cfg.ServerPort.ToString();
            Discover_Click(this, new RoutedEventArgs());
        }
    }

    private void ShowView(FrameworkElement v)
    {
        foreach (var x in new FrameworkElement[] { ConnectView, LoginView, ExamView, FinishedView })
            x.Visibility = x == v ? Visibility.Visible : Visibility.Collapsed;
    }

    // ---------- connect ----------
    private async void Discover_Click(object sender, RoutedEventArgs e)
    {
        DiscoverButton.IsEnabled = false;
        DiscoverStatus.Text = "  Searching…";
        ConnectStatus.Text = "";
        try
        {
            var found = await UdpDiscovery.DiscoverAsync(_cfg.DiscoveryPort, TimeSpan.FromSeconds(2));
            DiscoveredList.ItemsSource = found.Select(f => new DiscoveredItem(f)).ToList();
            DiscoveredList.Visibility = found.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            DiscoverStatus.Text = found.Count > 0 ? $"  Found {found.Count} server(s)" : "  No Center Server answered";
            if (found.Count == 1) DiscoveredList.SelectedIndex = 0;
        }
        catch (Exception ex)
        {
            DiscoverStatus.Text = "  Discovery failed: " + ex.Message;
        }
        finally
        {
            DiscoverButton.IsEnabled = true;
        }
    }

    private void Discovered_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (DiscoveredList.SelectedItem is not DiscoveredItem d) return;
        HostBox.Text = d.Info.LanIp;
        PortBox.Text = d.Info.Port.ToString();
        OfferPin(d.Info.LanIp, d.Info.Port, CertificatePin.Normalize(d.Info.CertFingerprint), d.Info.CenterName, "Fingerprint announced by LAN discovery");
    }

    private async void Probe_Click(object sender, RoutedEventArgs e)
    {
        ConnectStatus.Text = "";
        var host = HostBox.Text.Trim();
        if (host.Length == 0 || !int.TryParse(PortBox.Text.Trim(), out var port))
        {
            ConnectStatus.Text = "Enter the server IP address and port.";
            return;
        }
        try
        {
            var fp = await CenterApiClient.ProbeFingerprintAsync(host, port);
            OfferPin(host, port, fp, null, "Certificate presented by " + host);
        }
        catch (Exception ex)
        {
            ConnectStatus.Text = "Cannot reach the Center Server: " + ex.Message;
        }
    }

    private void OfferPin(string host, int port, string fp, string? name, string source)
    {
        if (fp.Length == 0)
        {
            ConnectStatus.Text = "The server did not provide a valid certificate fingerprint.";
            return;
        }
        _candidatePin = (host, port, fp, name);
        FingerprintSource.Text = source;
        FingerprintText.Text = fp;
        PinPasswordRow.Visibility = _cfg.InvigilatorPasswordHash != null ? Visibility.Visible : Visibility.Collapsed;
        FingerprintPanel.Visibility = Visibility.Visible;
    }

    private async void ConfirmPin_Click(object sender, RoutedEventArgs e)
    {
        if (_candidatePin is not { } p) return;
        if (_cfg.InvigilatorPasswordHash != null && !PasswordHasher.Verify(PinPasswordBox.Password, _cfg.InvigilatorPasswordHash))
        {
            ConnectStatus.Text = "Invigilator password is incorrect.";
            return;
        }
        PinPasswordBox.Clear();
        ConfirmPinButton.IsEnabled = false;
        try
        {
            // First pinned request: proves the server really holds the confirmed certificate.
            using var probe = new CenterApiClient(p.host, p.port, p.fp, _machineId);
            var info = await probe.DiscoverAsync();
            SavePin(p.host, p.port, p.fp, info.CenterName ?? p.name);
            ShowLogin();
        }
        catch (PinMismatchException ex)
        {
            ConnectStatus.Text = $"Refused: the server presented a different certificate ({ex.Presented ?? "none"}).";
        }
        catch (Exception ex)
        {
            ConnectStatus.Text = "Cannot connect: " + ex.Message;
        }
        finally
        {
            ConfirmPinButton.IsEnabled = true;
        }
    }

    private void SavePin(string host, int port, string fp, string? name)
    {
        _machine.Update(s =>
        {
            var same = s.ServerHost == host && s.ServerPort == port && s.ServerFingerprint == fp;
            if (!same) s.MachineToken = null; // a token belongs to one Center Server
            s.ServerHost = host;
            s.ServerPort = port;
            s.ServerFingerprint = fp;
            s.CenterName = name ?? s.CenterName;
        });
        _api?.Dispose();
        _api = null;
        Log($"pinned {host}:{port} {fp}");
    }

    private void ChangeServer_Click(object sender, RoutedEventArgs e) =>
        AskInvigilator("Forget the pinned Center Server on this PC and choose another?", () =>
        {
            _machine.Update(s => { s.ServerHost = null; s.ServerFingerprint = null; s.MachineToken = null; });
            FingerprintPanel.Visibility = Visibility.Collapsed;
            ShowView(ConnectView);
        });
}
