using System.Net;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Nodes;
using TheSpot.CandidateClient.Core.Security;

namespace TheSpot.CandidateClient.Core.Api;

/// <summary>The Center Server answered with an error (4xx/5xx).</summary>
public sealed class ApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>The Center Server could not be reached (LAN down, server stopped, timeout).</summary>
public sealed class CenterUnreachableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>The server presented a certificate that does not match the pinned fingerprint. Never retried with weaker trust.</summary>
public sealed class PinMismatchException(string expected, string? presented)
    : Exception($"Server certificate does not match the pinned fingerprint (expected {expected}, got {presented ?? "none"})")
{
    public string Expected { get; } = expected;
    public string? Presented { get; } = presented;
}

public interface ICenterApi
{
    string? SessionToken { get; set; }
    Task<ExamState> GetStateAsync(CancellationToken ct = default);
    Task<ExamState> HeartbeatAsync(CancellationToken ct = default);
    Task<QuestionsResult> GetQuestionsAsync(CancellationToken ct = default);
    Task<SaveResult> SaveAnswersAsync(IReadOnlyList<AnswerUpload> answers, CancellationToken ct = default);
    Task<SubmitResult> SubmitAsync(IReadOnlyList<AnswerUpload>? answers, CancellationToken ct = default);
    Task LogViolationsAsync(IReadOnlyList<ViolationUpload> violations, CancellationToken ct = default);
}

/// <summary>
/// HTTPS client for the Center Server LAN API. Trust is the pinned SHA-256 certificate fingerprint only
/// (self-signed LAN cert); a mismatch fails the request. There is no trust-all fallback.
/// </summary>
public sealed class CenterApiClient : ICenterApi, IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly string _pin;
    private string? _presented;

    public Uri BaseUri { get; }
    public string MachineId { get; }
    public string? MachineToken { get; set; }
    public string? SessionToken { get; set; }

    public CenterApiClient(string host, int port, string pinnedFingerprint, string machineId, TimeSpan? timeout = null)
    {
        _pin = CertificatePin.Normalize(pinnedFingerprint);
        if (_pin.Length == 0) throw new ArgumentException("A SHA-256 certificate fingerprint is required", nameof(pinnedFingerprint));
        BaseUri = new UriBuilder("https", host, port).Uri;
        MachineId = machineId;
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(3),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            UseProxy = false, // LAN only: never route through a system proxy
            SslOptions = new SslClientAuthenticationOptions
            {
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                RemoteCertificateValidationCallback = (_, cert, _, _) =>
                {
                    _presented = cert == null ? null : CertificatePin.Of(cert);
                    return CertificatePin.Matches(cert, _pin);
                },
            },
        };
        _http = new HttpClient(handler) { BaseAddress = BaseUri, Timeout = timeout ?? TimeSpan.FromSeconds(6) };
    }

    public Task<DiscoverInfo> DiscoverAsync(CancellationToken ct = default) => SendAsync<DiscoverInfo>(HttpMethod.Get, "/client/discover", null, false, ct);

    public Task<RegisterResult> RegisterAsync(string hostname, string clientVersion, CancellationToken ct = default) =>
        SendAsync<RegisterResult>(HttpMethod.Post, "/client/register", new { machineId = MachineId, hostname, clientVersion }, false, ct);

    public async Task<LoginResult> LoginAsync(string rollNumber, string password, CancellationToken ct = default)
    {
        var r = await SendAsync<LoginResult>(HttpMethod.Post, "/auth/login", new { rollNumber, password }, false, ct);
        SessionToken = r.SessionToken;
        return r;
    }

    public Task<ExamState> GetStateAsync(CancellationToken ct = default) => SendAsync<ExamState>(HttpMethod.Get, "/exam/state", null, true, ct);
    public Task<ExamState> HeartbeatAsync(CancellationToken ct = default) => SendAsync<ExamState>(HttpMethod.Post, "/heartbeat", new { }, true, ct);
    public Task<QuestionsResult> GetQuestionsAsync(CancellationToken ct = default) => SendAsync<QuestionsResult>(HttpMethod.Get, "/exam/questions", null, true, ct);

    public Task<SaveResult> SaveAnswersAsync(IReadOnlyList<AnswerUpload> answers, CancellationToken ct = default) =>
        SendAsync<SaveResult>(HttpMethod.Post, "/answers/save", new { answers }, true, ct);

    public Task<SubmitResult> SubmitAsync(IReadOnlyList<AnswerUpload>? answers, CancellationToken ct = default) =>
        SendAsync<SubmitResult>(HttpMethod.Post, "/exam/submit", new { answers = answers ?? [] }, true, ct);

    public Task LogViolationsAsync(IReadOnlyList<ViolationUpload> violations, CancellationToken ct = default) =>
        SendAsync<JsonNode>(HttpMethod.Post, "/violations/log", new { violations }, SessionToken != null, ct);

    public Task LogoutAsync(CancellationToken ct = default) => SendAsync<JsonNode>(HttpMethod.Post, "/auth/logout", new { }, true, ct);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, bool session, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, path);
        if (MachineToken != null)
        {
            req.Headers.Add("X-Machine-Id", MachineId);
            req.Headers.Add("X-Machine-Token", MachineToken);
        }
        if (session && SessionToken != null) req.Headers.Authorization = new("Bearer", SessionToken);
        if (body != null) req.Content = JsonContent.Create(body, options: Json);
        HttpResponseMessage res;
        try
        {
            res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e) when (e.InnerException is AuthenticationException)
        {
            throw new PinMismatchException(_pin, _presented);
        }
        catch (HttpRequestException e)
        {
            throw new CenterUnreachableException($"Center Server unreachable: {e.Message}", e);
        }
        catch (TaskCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new CenterUnreachableException("Center Server timed out", e);
        }
        using (res)
        {
            JsonNode? env;
            try
            {
                env = await res.Content.ReadFromJsonAsync<JsonNode>(Json, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (e is JsonException or HttpRequestException or IOException)
            {
                if (!res.IsSuccessStatusCode) throw new ApiException(res.StatusCode, $"HTTP {(int)res.StatusCode}");
                throw new CenterUnreachableException("Bad response from Center Server", e);
            }
            if (!res.IsSuccessStatusCode || env?["success"]?.GetValue<bool>() != true)
                throw new ApiException(res.StatusCode, env?["message"]?.GetValue<string>() ?? $"HTTP {(int)res.StatusCode}");
            var data = env["data"];
            return data is null ? default! : data.Deserialize<T>(Json)!;
        }
    }

    /// <summary>
    /// Reads the certificate fingerprint a server presents, without sending any HTTP request or credentials.
    /// Used on first connect so the invigilator can compare it with the one shown on the Center Server before pinning.
    /// </summary>
    public static async Task<string> ProbeFingerprintAsync(string host, int port, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(5));
        using var tcp = new TcpClient();
        try
        {
            await tcp.ConnectAsync(host, port, cts.Token).ConfigureAwait(false);
            string? fp = null;
            await using var ssl = new SslStream(tcp.GetStream(), false, (_, cert, _, _) =>
            {
                fp = cert == null ? null : CertificatePin.Of(cert);
                return false; // never trust during a probe; we only read the fingerprint
            });
            try
            {
                var opts = new SslClientAuthenticationOptions { TargetHost = host, EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13 };
                await ssl.AuthenticateAsClientAsync(opts, cts.Token).ConfigureAwait(false);
            }
            catch (AuthenticationException)
            {
                // expected: the callback rejects every certificate
            }
            return fp ?? throw new CenterUnreachableException("Server did not present a certificate");
        }
        catch (Exception e) when (e is SocketException or OperationCanceledException or IOException)
        {
            throw new CenterUnreachableException($"Cannot reach {host}:{port}: {e.Message}", e);
        }
    }

    public void Dispose() => _http.Dispose();
}
