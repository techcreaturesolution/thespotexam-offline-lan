using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TheSpot.CandidateClient.Core.Security;

namespace TheSpot.CandidateClient.Core.Storage;

public sealed class CachedAnswer
{
    /// <summary>Raw JSON of the answer the server expects (option id, array of option ids, or text); null = cleared.</summary>
    public string? AnswerJson { get; set; }
    public bool Flagged { get; set; }
    public bool Visited { get; set; }
    /// <summary>Local version; strictly increases on every change. The server keeps only the highest version.</summary>
    public int Version { get; set; }
    /// <summary>Highest version the server has confirmed. Version &gt; AckedVersion ⇒ pending upload.</summary>
    public int AckedVersion { get; set; }
    public int TimeTakenSeconds { get; set; }
    public bool Pending => Version > AckedVersion;
}

public sealed class CachedViolation
{
    public long Id { get; set; }
    public string Type { get; set; } = "";
    public string? Detail { get; set; }
    /// <summary>Client wall-clock time, informational only (the server stamps its own time).</summary>
    public string At { get; set; } = "";
}

/// <summary>Everything needed to resume a candidate's attempt: answers with versions, pending queue, violations.</summary>
public sealed class ExamCacheData
{
    public string ExamId { get; set; } = "";
    public string RollNumber { get; set; } = "";
    public string? CandidateName { get; set; }
    /// <summary>Kept so answers queued while offline can still be flushed after the server auto-submitted (late sync).</summary>
    public string? SessionToken { get; set; }
    public Dictionary<string, CachedAnswer> Answers { get; set; } = [];
    public List<CachedViolation> Violations { get; set; } = [];
    public long NextViolationId { get; set; } = 1;
    public string? CurrentQuestionId { get; set; }
    public bool SubmitRequested { get; set; }
    public string? FinalStatus { get; set; }
    public int LastServerRemainingSeconds { get; set; }
}

/// <summary>Encrypted per-candidate cache file (one per exam + roll number).</summary>
public sealed class ExamCache(SecureStore store)
{
    public SecureStore Store { get; } = store;

    public static string FileNameFor(string examId, string rollNumber)
    {
        var h = SHA256.HashData(Encoding.UTF8.GetBytes($"{examId}|{rollNumber.Trim().ToUpperInvariant()}"));
        return $"exam-{Convert.ToHexString(h, 0, 8).ToLowerInvariant()}.bin";
    }

    /// <summary>Loads the cache; a tampered or corrupt file is quarantined and reported via <paramref name="warning"/>.</summary>
    public ExamCacheData? Load(string examId, string rollNumber, out string? warning)
    {
        warning = null;
        var name = FileNameFor(examId, rollNumber);
        try
        {
            var json = Store.ReadText(name);
            if (json == null) return null;
            var d = JsonSerializer.Deserialize<ExamCacheData>(json, CacheJson.Options);
            if (d == null || d.ExamId != examId || !string.Equals(d.RollNumber, rollNumber, StringComparison.OrdinalIgnoreCase)) throw new CacheTamperedException(name);
            return d;
        }
        catch (Exception e) when (e is CacheTamperedException or JsonException)
        {
            warning = $"Local answer cache failed its integrity check and was set aside ({Path.GetFileName(Store.Quarantine(name))}); answers saved on the server are used.";
            return null;
        }
    }

    public void Save(ExamCacheData d) => Store.WriteText(FileNameFor(d.ExamId, d.RollNumber), JsonSerializer.Serialize(d, CacheJson.Options));
}
