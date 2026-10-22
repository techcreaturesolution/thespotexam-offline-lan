using System.Text.Json;
using TheSpot.CandidateClient.Core.Security;

namespace TheSpot.CandidateClient.Core.Storage;

public sealed class MachineState
{
    public string? ServerHost { get; set; }
    public int ServerPort { get; set; }
    public string? ServerFingerprint { get; set; }
    public string? CenterName { get; set; }
    public string? MachineToken { get; set; }
    /// <summary>Last candidate on this PC, so a restart can find their cache (and their session for late sync).</summary>
    public string? LastExamId { get; set; }
    public string? LastRollNumber { get; set; }
    /// <summary>Violations raised while no candidate is logged in (e.g. at the login screen).</summary>
    public List<CachedViolation> PendingViolations { get; set; } = [];
}

/// <summary>Per-PC state (server pin, machine token) in an encrypted file (AES-GCM, key under DPAPI).</summary>
public sealed class MachineStore(SecureStore store)
{
    private const string FileName = "machine.bin";
    private readonly object _lock = new();

    public SecureStore Store { get; } = store;
    public MachineState State { get; private set; } = new();
    public string? LoadWarning { get; private set; }

    public MachineStore Load()
    {
        lock (_lock)
        {
            try
            {
                var json = Store.ReadText(FileName);
                State = json == null ? new MachineState() : JsonSerializer.Deserialize<MachineState>(json, CacheJson.Options) ?? new MachineState();
            }
            catch (Exception e) when (e is CacheTamperedException or JsonException)
            {
                LoadWarning = $"Machine state was unreadable and has been reset ({e.Message}); kept as {Path.GetFileName(Store.Quarantine(FileName))}";
                State = new MachineState();
            }
            return this;
        }
    }

    public void Update(Action<MachineState> change)
    {
        lock (_lock)
        {
            change(State);
            Store.WriteText(FileName, JsonSerializer.Serialize(State, CacheJson.Options));
        }
    }
}

internal static class CacheJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}
