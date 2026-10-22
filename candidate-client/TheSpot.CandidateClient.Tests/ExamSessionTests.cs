using System.Net;
using System.Text.Json.Nodes;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Storage;
using TheSpot.CandidateClient.Core.Sync;

namespace TheSpot.CandidateClient.Tests;

/// <summary>In-memory Center Server stand-in with the same versioning rules as center-server/src/engine.ts.</summary>
public sealed class FakeApi : ICenterApi
{
    public bool Up = true;
    public int Remaining = 600;
    public string Attempt = "in_progress";
    public string ExamPhase = "running";
    public bool LateWindowOpen = true;
    public readonly Dictionary<string, (string? answer, int version)> Server = [];
    public readonly List<ViolationUpload> Violations = [];
    public int Submits;
    public string? SessionToken { get; set; } = "s1";

    private ExamState St() => new() { ExamId = "e1", Phase = ExamPhase, RemainingSeconds = Remaining, AttemptStatus = Attempt, DurationSeconds = 600 };
    private void Check() { if (!Up) throw new CenterUnreachableException("down"); }

    public Task<ExamState> GetStateAsync(CancellationToken ct = default) { Check(); return Task.FromResult(St()); }
    public Task<ExamState> HeartbeatAsync(CancellationToken ct = default) => GetStateAsync(ct);
    public Task<QuestionsResult> GetQuestionsAsync(CancellationToken ct = default)
    {
        Check();
        return Task.FromResult(new QuestionsResult
        {
            Sections = [new SectionDto { Name = "A", Questions = [new QuestionDto { Id = "q1" }, new QuestionDto { Id = "q2" }] }],
            Answers = Server.Select(kv => new ServerAnswer { QuestionId = kv.Key, Answer = kv.Value.answer == null ? null : JsonNode.Parse(kv.Value.answer), Version = kv.Value.version }).ToList(),
            State = St(),
        });
    }

    public Task<SaveResult> SaveAnswersAsync(IReadOnlyList<AnswerUpload> answers, CancellationToken ct = default)
    {
        Check();
        var open = Attempt == "in_progress" || (Attempt == "auto_submitted" && LateWindowOpen);
        if (!open) throw new ApiException(HttpStatusCode.Conflict, "Answers are closed");
        var res = new List<SaveItemResult>();
        foreach (var a in answers)
        {
            var cur = Server.TryGetValue(a.QuestionId, out var c) ? c.version : 0;
            if (a.Version > cur) { Server[a.QuestionId] = (a.Answer?.ToJsonString(), a.Version); res.Add(new(a.QuestionId, a.Version, "saved")); }
            else res.Add(new(a.QuestionId, a.Version, "stale"));
        }
        return Task.FromResult(new SaveResult { Results = res, State = St() });
    }

    public async Task<SubmitResult> SubmitAsync(IReadOnlyList<AnswerUpload>? answers, CancellationToken ct = default)
    {
        Check();
        if (answers?.Count > 0) await SaveAnswersAsync(answers, ct);
        Submits++;
        var already = Attempt != "in_progress";
        if (!already) Attempt = "submitted";
        return new SubmitResult { Status = Attempt, AlreadySubmitted = already };
    }

    public Task LogViolationsAsync(IReadOnlyList<ViolationUpload> violations, CancellationToken ct = default)
    {
        Check();
        Violations.AddRange(violations);
        return Task.CompletedTask;
    }
}

public class ExamSessionTests
{
    private static (ExamSession s, AnswerBook b, ExamCache c) Make(TempDir t, FakeApi api)
    {
        var cache = new ExamCache(t.Store());
        var book = new AnswerBook(cache, new ExamCacheData { ExamId = "e1", RollNumber = "R001", SessionToken = "s1" });
        var st = api.GetStateAsync().Result;
        return (new ExamSession(api, book, new ServerClock(), st, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(1)), book, cache);
    }

    [Fact]
    public async Task Lan_drop_queues_locally_then_flushes_on_reconnect()
    {
        using var t = new TempDir();
        var api = new FakeApi();
        var (s, b, _) = Make(t, api);
        await s.StepAsync(default);
        Assert.NotNull(s.Paper);
        b.SetAnswer("q1", JsonValue.Create(1));
        Assert.True(await s.SyncOnceAsync());
        Assert.Equal(("1", 1), api.Server["q1"]);

        api.Up = false;
        b.SetAnswer("q1", JsonValue.Create(2));
        b.SetAnswer("q2", JsonValue.Create(3));
        s.LogViolation("alt_tab", "blocked");
        Assert.False(await s.SyncOnceAsync());
        Assert.False(s.Online);
        Assert.Equal(2, b.PendingCount);

        api.Up = true;
        Assert.True(await s.SyncOnceAsync());
        Assert.True(s.Online);
        Assert.Equal(0, b.PendingCount);
        Assert.Equal(("2", 2), api.Server["q1"]);
        Assert.Single(api.Violations);
        Assert.Equal(SessionPhase.Running, s.Phase);
    }

    [Fact]
    public async Task Crash_restart_resumes_from_cache_and_merges_server()
    {
        using var t = new TempDir();
        var api = new FakeApi();
        var (s, b, cache) = Make(t, api);
        await s.StepAsync(default);
        b.SetAnswer("q1", JsonValue.Create(1));
        await s.SyncOnceAsync();
        api.Up = false;
        b.SetAnswer("q2", JsonValue.Create(0)); // only in the local cache when the app is killed
        await s.DisposeAsync();

        api.Up = true;
        var b2 = new AnswerBook(cache, cache.Load("e1", "R001", out _)!);
        var s2 = new ExamSession(api, b2, new ServerClock(), await api.GetStateAsync(), TimeSpan.FromSeconds(5), TimeSpan.Zero);
        await s2.StepAsync(default);
        Assert.Equal("1", b2.Get("q1")!.AnswerJson);
        Assert.Equal(0, b2.PendingCount);
        Assert.Equal(("0", 1), api.Server["q2"]);
    }

    [Fact]
    public async Task Auto_submits_when_server_reports_time_up()
    {
        using var t = new TempDir();
        var api = new FakeApi();
        var (s, b, _) = Make(t, api);
        await s.StepAsync(default);
        b.SetAnswer("q1", JsonValue.Create(2));
        api.Remaining = 0;
        await s.SyncOnceAsync();
        Assert.Equal(SessionPhase.TimeUp, s.Phase);
        await s.StepAsync(default);
        Assert.Equal(SessionPhase.Finished, s.Phase);
        Assert.True(s.AutoSubmitted);
        Assert.Equal("submitted", b.Data.FinalStatus);
        Assert.Equal(1, api.Submits);
    }

    [Fact]
    public async Task Server_auto_submitted_while_offline_then_late_sync()
    {
        using var t = new TempDir();
        var api = new FakeApi();
        var (s, b, _) = Make(t, api);
        await s.StepAsync(default);
        api.Up = false;
        b.SetAnswer("q1", JsonValue.Create(3));
        await s.SyncOnceAsync();
        api.Attempt = "auto_submitted"; // server timed out while this PC was disconnected
        api.Up = true;
        await s.SyncOnceAsync();
        Assert.Equal(("3", 1), api.Server["q1"]); // accepted inside the late-sync window
        Assert.Equal(SessionPhase.Finished, s.Phase);
        Assert.Equal("auto_submitted", b.Data.FinalStatus);
        Assert.Equal(0, b.PendingCount);
    }

    [Fact]
    public async Task Manual_submit_waits_for_connectivity_and_is_idempotent()
    {
        using var t = new TempDir();
        var api = new FakeApi();
        var (s, b, _) = Make(t, api);
        await s.StepAsync(default);
        b.SetAnswer("q2", JsonValue.Create(1));
        api.Up = false;
        s.RequestSubmit();
        await s.StepAsync(default);
        Assert.NotEqual(SessionPhase.Finished, s.Phase);
        Assert.True(b.Data.SubmitRequested); // persisted: survives a restart
        api.Up = true;
        await Task.Delay(3100);
        await s.StepAsync(default);
        Assert.Equal(SessionPhase.Finished, s.Phase);
        Assert.Equal(("1", 1), api.Server["q2"]);
        Assert.Equal("submitted", b.Data.FinalStatus);
    }

    [Fact]
    public async Task Countdown_is_frozen_until_the_server_starts_the_exam()
    {
        using var t = new TempDir();
        var api = new FakeApi { ExamPhase = "unlocked", Remaining = 120 };
        var (s, _, _) = Make(t, api);
        await s.SyncOnceAsync();
        Assert.Equal(SessionPhase.Waiting, s.Phase);
        await Task.Delay(1100);
        Assert.Equal(120, s.Clock.RemainingSeconds, 3);

        api.ExamPhase = "running";
        await s.SyncOnceAsync();
        Assert.Equal(SessionPhase.Running, s.Phase);
        await Task.Delay(1100);
        Assert.True(s.Clock.RemainingSeconds < 119.5);
    }
}
