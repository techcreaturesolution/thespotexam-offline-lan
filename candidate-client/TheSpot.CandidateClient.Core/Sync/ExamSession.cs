using System.Diagnostics;
using System.Net;
using TheSpot.CandidateClient.Core.Api;

namespace TheSpot.CandidateClient.Core.Sync;

public enum SessionPhase { Waiting, Running, Paused, TimeUp, Finished }

/// <summary>
/// Drives one candidate's attempt: autosave (interval + debounce), heartbeat, server timer sync, offline queue,
/// violations, submit and auto-submit. UI-agnostic; raises <see cref="Changed"/> from a background thread.
/// </summary>
public sealed class ExamSession : IAsyncDisposable
{
    private readonly ICenterApi _api;
    private readonly TimeSpan _autosave;
    private readonly TimeSpan _debounce;
    private readonly TimeSpan _offlineRetry = TimeSpan.FromSeconds(3);
    private readonly Stopwatch _mono = Stopwatch.StartNew();
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _wake = new(0);
    private TimeSpan _nextSync = TimeSpan.Zero;
    private TimeSpan? _debounceAt;
    private Task? _loop;

    public AnswerBook Book { get; }
    public ServerClock Clock { get; }
    public ExamState State { get; private set; }
    public QuestionsResult? Paper { get; private set; }
    public SessionPhase Phase { get; private set; } = SessionPhase.Waiting;
    public bool Online { get; private set; } = true;
    public string? LastError { get; private set; }
    public bool PinMismatch { get; private set; }
    public bool AutoSubmitted { get; private set; }
    /// <summary>Server refused queued answers (attempt closed and late-sync window over). They stay in the local cache.</summary>
    public bool UploadsClosed { get; private set; }
    public DateTime? LastSavedLocal { get; private set; }

    public event Action? Changed;
    public event Action? PaperLoaded;
    /// <summary>Session token rejected (e.g. invigilator reset the candidate) — the UI should return to login.</summary>
    public event Action? SessionExpired;

    public ExamSession(ICenterApi api, AnswerBook book, ServerClock clock, ExamState initial, TimeSpan autosave, TimeSpan debounce)
    {
        _api = api;
        Book = book;
        Clock = clock;
        _autosave = autosave;
        _debounce = debounce;
        State = initial;
        if (book.Data.FinalStatus != null) Phase = SessionPhase.Finished;
        Apply(initial);
    }

    public void Start() => _loop ??= Task.Run(() => RunAsync(_cts.Token));

    /// <summary>Call after every answer/flag change (already persisted locally); uploads after a short debounce.</summary>
    public void AnswerChanged()
    {
        _debounceAt = _mono.Elapsed + _debounce;
        Changed?.Invoke();
        Wake();
    }

    public void LogViolation(string type, string? detail)
    {
        Book.AddViolation(type, detail);
        _debounceAt ??= _mono.Elapsed + _debounce;
        Wake();
    }

    public void RequestSubmit()
    {
        Book.Update(d => d.SubmitRequested = true);
        _nextSync = TimeSpan.Zero;
        Wake();
    }

    public bool CanAnswer => Phase == SessionPhase.Running && Paper != null && !Book.Data.SubmitRequested;

    private void Wake()
    {
        if (_wake.CurrentCount == 0) _wake.Release();
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await StepAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                LastError = e.Message;
                Changed?.Invoke();
            }
            try
            {
                await _wake.WaitAsync(TimeSpan.FromMilliseconds(250), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    internal async Task StepAsync(CancellationToken ct)
    {
        var now = _mono.Elapsed;
        if (Phase == SessionPhase.Finished)
        {
            var leftovers = !UploadsClosed && (Book.PendingCount > 0 || Book.PendingViolationCount > 0);
            if (leftovers && now >= _nextSync) await SyncOnceAsync(ct).ConfigureAwait(false);
            return;
        }
        if (Paper == null && State.HasStarted && !State.IsFinal) await LoadPaperAsync(ct).ConfigureAwait(false);

        if (Book.Data.SubmitRequested)
        {
            if (now >= _nextSync) await SubmitAsync(ct).ConfigureAwait(false);
            return;
        }
        var due = now >= _nextSync || (_debounceAt is { } d && now >= d);
        if (due) await SyncOnceAsync(ct).ConfigureAwait(false);

        if (Phase == SessionPhase.Running && Clock.RemainingSeconds <= 0)
        {
            // Local countdown says time is up: lock answering, ask the server (it is the authority; may have been paused/extended).
            SetPhase(SessionPhase.TimeUp);
            _nextSync = TimeSpan.Zero;
        }
    }

    private async Task LoadPaperAsync(CancellationToken ct)
    {
        try
        {
            var p = await _api.GetQuestionsAsync(ct).ConfigureAwait(false);
            Book.MergeServer(p.Answers);
            Paper = p;
            SetOnline(true, null);
            Apply(p.State);
            PaperLoaded?.Invoke();
        }
        catch (Exception e) when (e is CenterUnreachableException or PinMismatchException)
        {
            SetOnline(false, e);
        }
        catch (ApiException e) when (e.Status == HttpStatusCode.Unauthorized)
        {
            SessionExpired?.Invoke();
        }
        catch (ApiException e) when (e.Status == (HttpStatusCode)423)
        {
            // not started yet
        }
    }

    /// <summary>One autosave round: violations, then pending answers (or a heartbeat). Returns false when offline.</summary>
    public async Task<bool> SyncOnceAsync(CancellationToken ct = default)
    {
        var now = _mono.Elapsed;
        _debounceAt = null;
        try
        {
            var vs = Book.PendingViolations();
            if (vs.Count > 0)
            {
                await _api.LogViolationsAsync(vs.Select(v => new ViolationUpload(v.Type, v.Detail, v.At)).ToList(), ct).ConfigureAwait(false);
                Book.AckViolations(vs.Max(v => v.Id));
            }
            var pending = Book.PendingUploads();
            ExamState state;
            if (pending.Count > 0 && !UploadsClosed)
            {
                try
                {
                    var r = await _api.SaveAnswersAsync(pending, ct).ConfigureAwait(false);
                    Book.Ack(r.Results);
                    state = r.State;
                }
                catch (ApiException e) when (e.Status == HttpStatusCode.Conflict)
                {
                    // "Answers are closed": time over or attempt final. Find out which.
                    state = await _api.GetStateAsync(ct).ConfigureAwait(false);
                    if (state.IsFinal) UploadsClosed = true;
                }
            }
            else if (Phase == SessionPhase.Finished) state = State;
            else state = await _api.HeartbeatAsync(ct).ConfigureAwait(false);
            LastSavedLocal = DateTime.Now;
            _nextSync = now + _autosave;
            SetOnline(true, null);
            Apply(state);
            return true;
        }
        catch (Exception e) when (e is CenterUnreachableException or PinMismatchException)
        {
            SetOnline(false, e);
            _nextSync = now + _offlineRetry;
            return false;
        }
        catch (ApiException e) when (e.Status == HttpStatusCode.Unauthorized)
        {
            _nextSync = now + _offlineRetry;
            SessionExpired?.Invoke();
            return false;
        }
    }

    private async Task SubmitAsync(CancellationToken ct)
    {
        var now = _mono.Elapsed;
        var pending = Book.PendingUploads();
        try
        {
            SubmitResult r;
            try
            {
                r = await _api.SubmitAsync(pending, ct).ConfigureAwait(false);
                Book.AckUploads(pending);
            }
            catch (ApiException e) when (e.Status == HttpStatusCode.Conflict && pending.Count > 0)
            {
                // The server no longer accepts these answers; still record the submission (idempotent).
                UploadsClosed = true;
                r = await _api.SubmitAsync(null, ct).ConfigureAwait(false);
            }
            SetOnline(true, null);
            Finish(r.Status);
        }
        catch (Exception e) when (e is CenterUnreachableException or PinMismatchException)
        {
            SetOnline(false, e);
            _nextSync = now + _offlineRetry;
        }
        catch (ApiException e) when (e.Status == HttpStatusCode.Unauthorized)
        {
            _nextSync = now + _offlineRetry;
            SessionExpired?.Invoke();
        }
    }

    private void Apply(ExamState s)
    {
        State = s;
        // The server only counts down while the exam is running; freeze the local countdown otherwise.
        Clock.Sync(s.RemainingSeconds, s.Paused || s.Phase != "running");
        if (s.RemainingSeconds > 0 || s.Paused) Book.Data.LastServerRemainingSeconds = s.RemainingSeconds;
        if (Phase == SessionPhase.Finished) return;
        if (s.IsFinal)
        {
            // Finalised by the server (time-up auto-submit, invigilator end) — possibly while we were offline.
            AutoSubmitted = s.AttemptStatus != "submitted";
            Finish(s.AttemptStatus!);
            return;
        }
        if (s.Paused) SetPhase(SessionPhase.Paused);
        else if (!s.HasStarted) SetPhase(SessionPhase.Waiting);
        else if (s.RemainingSeconds <= 0)
        {
            // Server says time is up: auto-submit with everything still queued.
            AutoSubmitted = true;
            SetPhase(SessionPhase.TimeUp);
            if (!Book.Data.SubmitRequested) Book.Update(d => d.SubmitRequested = true);
            _nextSync = TimeSpan.Zero;
        }
        else SetPhase(SessionPhase.Running);
    }

    private void Finish(string status)
    {
        Book.Update(d => { d.FinalStatus = status; d.SubmitRequested = true; });
        _nextSync = TimeSpan.Zero;
        SetPhase(SessionPhase.Finished);
    }

    private void SetPhase(SessionPhase p)
    {
        if (Phase == p) return;
        Phase = p;
        Changed?.Invoke();
    }

    private void SetOnline(bool online, Exception? e)
    {
        var changed = Online != online || (e?.Message ?? null) != LastError;
        Online = online;
        PinMismatch = e is PinMismatchException;
        LastError = e?.Message;
        if (changed || online) Changed?.Invoke();
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop != null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
        _cts.Dispose();
    }
}
