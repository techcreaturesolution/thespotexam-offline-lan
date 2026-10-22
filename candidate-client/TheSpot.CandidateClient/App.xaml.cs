using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;
using TheSpot.CandidateClient.Core.Security;
using TheSpot.CandidateClient.Core.Storage;

namespace TheSpot.CandidateClient;

public partial class App : Application
{
    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    private string? _logPath;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args.Length >= 2 && e.Args[0] == "--hash-password")
        {
            // Helper for preparing client.json: prints a PBKDF2 hash, never stores the password.
            AttachConsole(-1);
            Console.Out.WriteLine(PasswordHasher.Hash(e.Args[1]));
            Console.Out.Flush();
            Shutdown(0);
            return;
        }

        ClientConfig cfg;
        try
        {
            cfg = ClientConfig.Load();
        }
        catch (System.Text.Json.JsonException ex)
        {
            MessageBox.Show("client.json is invalid: " + ex.Message, "TheSpot Exam", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(2);
            return;
        }
        var dataDir = cfg.ResolveDataDir();
        Directory.CreateDirectory(dataDir);
        _logPath = Path.Combine(dataDir, "client.log");
        Log($"start v{typeof(App).Assembly.GetName().Version} config={cfg.LoadedFrom ?? "(defaults)"}");
        DispatcherUnhandledException += OnUnhandled;
        AppDomain.CurrentDomain.UnhandledException += (_, a) => Log("fatal: " + a.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, a) => { Log("task: " + a.Exception); a.SetObserved(); };

        var w = new MainWindow(cfg, dataDir);
        MainWindow = w;
        w.Show();
    }

    private void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // Keep the exam running: answers are already in the encrypted cache; log and continue.
        Log("ui: " + e.Exception);
        e.Handled = true;
    }

    internal void Log(string line)
    {
        if (_logPath == null) return;
        try
        {
            File.AppendAllText(_logPath, $"{DateTime.UtcNow:O} {line}{Environment.NewLine}");
        }
        catch (IOException)
        {
            // best effort
        }
    }
}
