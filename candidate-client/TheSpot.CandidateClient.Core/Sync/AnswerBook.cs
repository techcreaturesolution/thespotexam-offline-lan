using System.Text.Json.Nodes;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Storage;

namespace TheSpot.CandidateClient.Core.Sync;

/// <summary>
/// Thread-safe answer sheet over the encrypted cache. Every change bumps the question's version and is written to disk
/// before returning, so a crash or LAN drop loses nothing. Pending = local version newer than the server's ack.
/// </summary>
public sealed class AnswerBook(ExamCache cache, ExamCacheData data)
{
    private readonly object _lock = new();

    public ExamCacheData Data => data;
    public string ExamId => data.ExamId;
    public string RollNumber => data.RollNumber;

    public CachedAnswer? Get(string questionId)
    {
        lock (_lock) return data.Answers.TryGetValue(questionId, out var a) ? Clone(a) : null;
    }

    public void SetAnswer(string questionId, JsonNode? answer) =>
        Mutate(questionId, a => { a.AnswerJson = answer?.ToJsonString(); a.Visited = true; }, bump: true);

    public void SetFlag(string questionId, bool flagged) => Mutate(questionId, a => { a.Flagged = flagged; a.Visited = true; }, bump: true);

    public void MarkVisited(string questionId)
    {
        lock (_lock)
        {
            data.CurrentQuestionId = questionId;
            var a = GetOrAdd(questionId);
            if (a.Visited) { Persist(); return; }
            a.Visited = true;
            Persist();
        }
    }

    /// <summary>Accumulates time on a question; uploaded with the question's next versioned save.</summary>
    public void AddTime(string questionId, int seconds)
    {
        if (seconds <= 0) return;
        lock (_lock) GetOrAdd(questionId).TimeTakenSeconds += seconds;
    }

    public void Update(Action<ExamCacheData> change)
    {
        lock (_lock)
        {
            change(data);
            Persist();
        }
    }

    /// <summary>
    /// Merges answers the server already holds (resume after crash/restart). Whichever side has the higher version wins;
    /// local answers newer than the server's stay pending and are uploaded on the next sync.
    /// </summary>
    public void MergeServer(IEnumerable<ServerAnswer> server)
    {
        lock (_lock)
        {
            foreach (var s in server)
            {
                var a = GetOrAdd(s.QuestionId);
                if (s.Version >= a.Version)
                {
                    a.AnswerJson = s.Answer?.ToJsonString();
                    a.Flagged = s.Flagged;
                    a.Version = s.Version;
                    a.AckedVersion = s.Version;
                    a.Visited = true;
                }
                else a.AckedVersion = s.Version;
            }
            // Anything the server does not hold (e.g. a replaced or restored Center Server) is uploaded again.
            var held = server.Select(x => x.QuestionId).ToHashSet();
            foreach (var (id, a) in data.Answers)
                if (!held.Contains(id) && a.Version > 0) a.AckedVersion = 0;
            Persist();
        }
    }

    public int PendingCount { get { lock (_lock) return data.Answers.Values.Count(a => a.Pending); } }

    public int AnsweredCount { get { lock (_lock) return data.Answers.Values.Count(a => a.AnswerJson != null); } }

    public List<AnswerUpload> PendingUploads(int max = 500)
    {
        lock (_lock)
        {
            return data.Answers.Where(kv => kv.Value.Pending).Take(max).Select(kv => new AnswerUpload
            {
                QuestionId = kv.Key,
                Answer = kv.Value.AnswerJson == null ? null : JsonNode.Parse(kv.Value.AnswerJson),
                Flagged = kv.Value.Flagged,
                Version = kv.Value.Version,
                TimeTakenSeconds = kv.Value.TimeTakenSeconds,
            }).ToList();
        }
    }

    /// <summary>Applies server results. saved/stale/invalid all mean "the server has decided on this version": stop resending it.</summary>
    public void Ack(IEnumerable<SaveItemResult> results)
    {
        lock (_lock)
        {
            foreach (var r in results)
            {
                if (data.Answers.TryGetValue(r.QuestionId, out var a) && r.Version <= a.Version) a.AckedVersion = Math.Max(a.AckedVersion, r.Version);
            }
            Persist();
        }
    }

    public void AckUploads(IEnumerable<AnswerUpload> sent) => Ack(sent.Select(u => new SaveItemResult(u.QuestionId, u.Version, "saved")));

    public void AddViolation(string type, string? detail)
    {
        lock (_lock)
        {
            data.Violations.Add(new CachedViolation { Id = data.NextViolationId++, Type = type, Detail = detail, At = DateTime.UtcNow.ToString("O") });
            Persist();
        }
    }

    public List<CachedViolation> PendingViolations(int max = 100)
    {
        lock (_lock) return data.Violations.Take(max).Select(v => new CachedViolation { Id = v.Id, Type = v.Type, Detail = v.Detail, At = v.At }).ToList();
    }

    public int PendingViolationCount { get { lock (_lock) return data.Violations.Count; } }

    public void AckViolations(long upToId)
    {
        lock (_lock)
        {
            data.Violations.RemoveAll(v => v.Id <= upToId);
            Persist();
        }
    }

    public void Save()
    {
        lock (_lock) Persist();
    }

    private void Mutate(string questionId, Action<CachedAnswer> change, bool bump)
    {
        lock (_lock)
        {
            var a = GetOrAdd(questionId);
            change(a);
            if (bump) a.Version = Math.Max(a.Version, a.AckedVersion) + 1;
            Persist();
        }
    }

    private CachedAnswer GetOrAdd(string questionId)
    {
        if (!data.Answers.TryGetValue(questionId, out var a)) data.Answers[questionId] = a = new CachedAnswer();
        return a;
    }

    private void Persist() => cache.Save(data);

    private static CachedAnswer Clone(CachedAnswer a) => new()
    {
        AnswerJson = a.AnswerJson, Flagged = a.Flagged, Visited = a.Visited, Version = a.Version, AckedVersion = a.AckedVersion, TimeTakenSeconds = a.TimeTakenSeconds,
    };
}
