using System.Text.Json.Nodes;
using TheSpot.CandidateClient.Core.Api;
using TheSpot.CandidateClient.Core.Storage;
using TheSpot.CandidateClient.Core.Sync;

namespace TheSpot.CandidateClient.Tests;

public class ServerClockTests
{
    [Fact]
    public void Counts_down_on_monotonic_time_only()
    {
        var t = new FakeTime();
        var c = new ServerClock(t);
        c.Sync(600, paused: false);
        t.AdvanceMonotonic(TimeSpan.FromSeconds(10));
        Assert.Equal(590, c.RemainingSeconds, 3);
        t.Wall = t.Wall.AddHours(1);   // user moves the Windows clock forward
        Assert.Equal(590, c.RemainingSeconds, 3);
        t.Wall = t.Wall.AddHours(-2);  // …and back
        Assert.Equal(590, c.RemainingSeconds, 3);
        t.AdvanceMonotonic(TimeSpan.FromSeconds(5));
        Assert.Equal(585, c.RemainingSeconds, 3);
    }

    [Fact]
    public void Server_sync_is_authoritative_and_pause_freezes()
    {
        var t = new FakeTime();
        var c = new ServerClock(t);
        c.Sync(100, false);
        t.AdvanceMonotonic(TimeSpan.FromSeconds(30));
        c.Sync(120, true); // invigilator extended + paused
        t.AdvanceMonotonic(TimeSpan.FromSeconds(30));
        Assert.Equal(120, c.RemainingSeconds, 3);
        c.Sync(120, false);
        t.AdvanceMonotonic(TimeSpan.FromSeconds(200));
        Assert.Equal(0, c.RemainingSeconds);
        Assert.Equal("01:05", ServerClock.Format(64.2));
        Assert.Equal("1:00:00", ServerClock.Format(3600));
    }
}

public class AnswerBookTests
{
    private static (AnswerBook book, ExamCache cache) NewBook(TempDir t)
    {
        var cache = new ExamCache(t.Store());
        return (new AnswerBook(cache, new ExamCacheData { ExamId = "e1", RollNumber = "R001" }), cache);
    }

    [Fact]
    public void Every_change_bumps_version_and_is_pending_until_acked()
    {
        using var t = new TempDir();
        var (b, _) = NewBook(t);
        b.SetAnswer("q1", JsonValue.Create(2));
        b.SetAnswer("q1", JsonValue.Create(3));
        b.SetFlag("q2", true);
        Assert.Equal(2, b.Get("q1")!.Version);
        Assert.Equal(2, b.PendingCount);
        var up = b.PendingUploads();
        Assert.Equal("3", up.Single(u => u.QuestionId == "q1").Answer!.ToJsonString());
        b.SetAnswer("q1", JsonValue.Create(1)); // changed while the upload was in flight
        b.Ack(up.Select(u => new SaveItemResult(u.QuestionId, u.Version, "saved")));
        Assert.True(b.Get("q1")!.Pending);       // v3 still pending
        Assert.False(b.Get("q2")!.Pending);
        b.Ack([new SaveItemResult("q1", 1, "stale")]); // out-of-order old ack can't regress
        Assert.Equal(2, b.Get("q1")!.AckedVersion);
    }

    [Fact]
    public void Survives_restart_from_encrypted_cache()
    {
        using var t = new TempDir();
        var (b, cache) = NewBook(t);
        b.SetAnswer("q1", JsonValue.Create(2));
        b.SetAnswer("q2", new JsonArray(0, 3));
        b.AddViolation("alt_tab", "blocked");
        var loaded = cache.Load("e1", "R001", out var warn)!;
        Assert.Null(warn);
        var b2 = new AnswerBook(cache, loaded);
        Assert.Equal("[0,3]", b2.Get("q2")!.AnswerJson);
        Assert.Equal(2, b2.PendingCount);
        Assert.Single(b2.PendingViolations());
    }

    [Fact]
    public void Tampered_cache_is_quarantined_not_trusted()
    {
        using var t = new TempDir();
        var (b, cache) = NewBook(t);
        b.SetAnswer("q1", JsonValue.Create(2));
        var p = cache.Store.PathFor(ExamCache.FileNameFor("e1", "R001"));
        var raw = File.ReadAllBytes(p);
        raw[40] ^= 0xFF;
        File.WriteAllBytes(p, raw);
        Assert.Null(cache.Load("e1", "R001", out var warn));
        Assert.NotNull(warn);
    }

    [Fact]
    public void Merge_with_server_keeps_highest_version()
    {
        using var t = new TempDir();
        var (b, _) = NewBook(t);
        b.SetAnswer("q1", JsonValue.Create(1));
        b.SetAnswer("q1", JsonValue.Create(2));
        b.SetAnswer("q1", JsonValue.Create(3)); // local v3, never uploaded (crashed offline)
        b.MergeServer([
            new ServerAnswer { QuestionId = "q1", Answer = JsonValue.Create(0), Version = 1 },
            new ServerAnswer { QuestionId = "q2", Answer = JsonValue.Create(2), Version = 4, Flagged = true },
        ]);
        Assert.Equal("3", b.Get("q1")!.AnswerJson);
        Assert.True(b.Get("q1")!.Pending);
        Assert.Equal(1, b.Get("q1")!.AckedVersion);
        Assert.Equal("2", b.Get("q2")!.AnswerJson);
        Assert.False(b.Get("q2")!.Pending);
        b.SetAnswer("q2", JsonValue.Create(1));
        Assert.Equal(5, b.Get("q2")!.Version); // continues above the server's version
    }

    [Fact]
    public void Merge_reuploads_answers_the_server_does_not_hold()
    {
        using var t = new TempDir();
        var (b, _) = NewBook(t);
        b.SetAnswer("q1", JsonValue.Create(1));
        b.SetAnswer("q2", JsonValue.Create(2));
        b.AckUploads(b.PendingUploads());
        Assert.Equal(0, b.PendingCount);
        // A replaced Center Server only holds q1 (at an older version).
        b.MergeServer([new ServerAnswer { QuestionId = "q1", Answer = JsonValue.Create(0), Version = 0 }]);
        var up = b.PendingUploads().OrderBy(u => u.QuestionId).ToList();
        Assert.Equal(["q1", "q2"], up.Select(u => u.QuestionId));
        Assert.Equal("1", b.Get("q1")!.AnswerJson);
    }
}
