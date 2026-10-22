using TheSpot.CandidateClient.Core.Security;

namespace TheSpot.CandidateClient.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "thespot-tests-" + Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public SecureStore Store() => new(Path);
    public void Dispose()
    {
        try { Directory.Delete(Path, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Controllable clocks: the monotonic timestamp and the wall clock move independently.</summary>
public sealed class FakeTime : TimeProvider
{
    private long _ticks;
    public DateTimeOffset Wall { get; set; } = new(2026, 10, 22, 10, 0, 0, TimeSpan.Zero);
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    public override long GetTimestamp() => _ticks;
    public override DateTimeOffset GetUtcNow() => Wall;
    public void AdvanceMonotonic(TimeSpan by) => _ticks += by.Ticks;
}
