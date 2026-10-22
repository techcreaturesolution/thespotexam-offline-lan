using System.Text.Json;

namespace TheSpot.CandidateClient.Core.Storage;

public sealed record KioskOptions
{
    /// <summary>Fullscreen, topmost, borderless window; refuses to close without the invigilator.</summary>
    public bool Enabled { get; init; } = true;
    /// <summary>Low-level keyboard hook blocking Alt+Tab, Win, Alt+F4, Alt/Ctrl+Esc, PrintScreen, copy/paste keys.</summary>
    public bool BlockKeys { get; init; } = true;
    /// <summary>SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE): the exam window is black in screenshots/recordings.</summary>
    public bool ExcludeFromCapture { get; init; } = true;
    public bool ClearClipboard { get; init; } = true;
}

/// <summary>
/// client.json: looked up at %THESPOT_CLIENT_CONFIG%, then %ProgramData%\TheSpotExam\CandidateClient\client.json,
/// then next to the executable. Contains no secrets: the invigilator password is stored as a PBKDF2 hash.
/// </summary>
public sealed record ClientConfig
{
    /// <summary>Optional preset server (e.g. pushed by the center's imaging); otherwise chosen on the Connect screen.</summary>
    public string? ServerHost { get; init; }
    public int ServerPort { get; init; } = 8443;
    /// <summary>Optional preset pin. When set, the client never asks to confirm a fingerprint.</summary>
    public string? ServerFingerprint { get; init; }
    public int DiscoveryPort { get; init; } = 41234;
    public int AutosaveSeconds { get; init; } = 5;
    public int DebounceMilliseconds { get; init; } = 800;
    /// <summary>PBKDF2 hash ("pbkdf2-sha256$…") for invigilator actions: exit kiosk, change/confirm server pin.</summary>
    public string? InvigilatorPasswordHash { get; init; }
    public string? DataDir { get; init; }
    public KioskOptions Kiosk { get; init; } = new();

    public string? LoadedFrom { get; private init; }

    private static readonly JsonSerializerOptions Opts = new(JsonSerializerDefaults.Web) { ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    public static IEnumerable<string> CandidatePaths()
    {
        var env = Environment.GetEnvironmentVariable("THESPOT_CLIENT_CONFIG");
        if (!string.IsNullOrWhiteSpace(env)) yield return env;
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TheSpotExam", "CandidateClient", "client.json");
        yield return Path.Combine(AppContext.BaseDirectory, "client.json");
    }

    public static ClientConfig Load()
    {
        foreach (var p in CandidatePaths())
        {
            if (File.Exists(p)) return Parse(File.ReadAllText(p)) with { LoadedFrom = p };
        }
        return new ClientConfig();
    }

    public static ClientConfig Parse(string json) => JsonSerializer.Deserialize<ClientConfig>(json, Opts) ?? new ClientConfig();

    public string ResolveDataDir()
    {
        var env = Environment.GetEnvironmentVariable("THESPOT_CLIENT_DATA");
        if (!string.IsNullOrWhiteSpace(env)) return env;
        if (!string.IsNullOrWhiteSpace(DataDir)) return Environment.ExpandEnvironmentVariables(DataDir);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TheSpotExam", "CandidateClient");
    }
}
