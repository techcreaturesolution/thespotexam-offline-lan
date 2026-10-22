namespace TheSpot.CandidateClient.Core.Sync;

/// <summary>
/// Exam countdown driven by the Center Server. Each server reply sets the remaining seconds; between replies we count
/// down with the monotonic timestamp (Stopwatch via <see cref="TimeProvider.GetTimestamp"/>) — never the wall clock,
/// so changing the Windows date/time has no effect.
/// </summary>
public sealed class ServerClock(TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _lock = new();
    private double _serverRemaining;
    private long _syncedAt;
    private bool _paused;

    public bool HasSync { get; private set; }

    public void Sync(int remainingSeconds, bool paused)
    {
        lock (_lock)
        {
            _serverRemaining = Math.Max(0, remainingSeconds);
            _syncedAt = _time.GetTimestamp();
            _paused = paused;
            HasSync = true;
        }
    }

    public bool Paused { get { lock (_lock) return _paused; } }

    /// <summary>Time since the last server sync (monotonic).</summary>
    public TimeSpan SinceSync { get { lock (_lock) return HasSync ? _time.GetElapsedTime(_syncedAt) : TimeSpan.Zero; } }

    public double RemainingSeconds
    {
        get
        {
            lock (_lock)
            {
                if (!HasSync) return 0;
                if (_paused) return _serverRemaining;
                return Math.Max(0, _serverRemaining - _time.GetElapsedTime(_syncedAt).TotalSeconds);
            }
        }
    }

    public static string Format(double seconds)
    {
        var s = (int)Math.Ceiling(Math.Max(0, seconds));
        return s >= 3600 ? $"{s / 3600}:{s / 60 % 60:00}:{s % 60:00}" : $"{s / 60:00}:{s % 60:00}";
    }
}
